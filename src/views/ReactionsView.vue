<template>
  <div class="kai-view">
    <KaiHeader :title="t('action_react')" />

    <main class="kai-content kai-content--roomy">
      <!-- Reacting is a write action: signed-out callers get the sign-in gate
           (the same shape compose uses), not a dead 401. -->
      <template v-if="!pickable">
        <p class="kai-text">{{ t('reactions_sign_in') }}</p>

        <KaiList class="kai-list--flat">
          <KaiListItem :primary="t('account_sign_in')" @select="push('account')" />
        </KaiList>
      </template>

      <template v-else>
        <p class="kai-text kai-text--secondary">{{ t('reactions_hint') }}</p>

        <!-- One selectable owns the grid; the D-pad moves a 5×3 cursor inside
             it (see `onKeydown`), Enter reacts with the highlighted sticker. -->
        <div
          ref="grid"
          tabindex="-1"
          nav-selectable="true"
          :nav-selected="isSelected ? 'true' : 'false'"
          class="kai-reaction-grid"
        >
          <button
            v-for="(template, index) in REACTION_TEMPLATES"
            :key="template.symbol"
            type="button"
            class="kai-reaction-tile"
            :class="{
              'kai-reaction-tile--selected': index === cursor,
              'kai-reaction-tile--made': made[template.symbol],
            }"
            @click.stop="react(index)"
          >
            <img
              class="kai-reaction-tile__img"
              :src="reactionStickerUrl(template.symbol)"
              :alt="t(template.labelKey)"
            />
            <span v-if="made[template.symbol]" class="kai-reaction-tile__check">✓</span>
            <span v-if="counts[template.symbol]" class="kai-reaction-tile__count">
              {{ counts[template.symbol] }}
            </span>
          </button>
        </div>

        <p v-if="errorKey" class="kai-text kai-text--error">{{ t(errorKey) }}</p>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { reactToPost } from '~/src/api/solian.js';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import { REACTION_TEMPLATES, reactionStickerUrl } from '~/src/content/reactions.js';
import { KEY } from '~/src/kaios/keys.js';
import { t } from '~/src/kaios/l10n.js';
import { nav, registerSelectable, setBaseSoftkeys, unregisterSelectable } from '~/src/kaios/nav.js';
import { push } from '~/src/kaios/views.js';
import { useAccountStore } from '~/src/stores/account.js';
import { useChatStore } from '~/src/stores/chat.js';
import { useFeedStore } from '~/src/stores/feed.js';

const props = withDefaults(defineProps<{ params?: Record<string, string> }>(), {
  params: () => ({}),
});

const accountStore = useAccountStore();
const chat = useChatStore();

/** The grid is five tiles wide; the fifteen templates make exactly three rows. */
const COLS = 5;
const ROWS = 3;

const grid = ref<HTMLElement | null>(null);
const uid = ref(0);
/** Flat index into `REACTION_TEMPLATES`: row-major over the 5×3 grid. */
const cursor = ref(0);
const counts = ref<Record<string, number>>({});
/** The reactions the signed-in user has made, from the post's own read. */
const made = ref<Record<string, boolean>>({});
const errorKey = ref('');
const reacting = ref(false);

const isSelected = computed(() => uid.value !== 0 && nav.current === uid.value);

/** The grid is only for a live session; a 401 mid-flight drops back here. */
const needsSignIn = ref(false);
const pickable = computed(
  () => accountStore.phase === 'signed-in' && !needsSignIn.value,
);

/**
 * The post's reactions and the user's own ride in as JSON in the view params —
 * the caller already holds the post, so there is no second fetch. Only numeric
 * counts and boolean flags are trusted; a hand-written hash link must not be
 * able to wedge the grid.
 */
const rawCounts = props.params.reactions;
if (rawCounts) {
  try {
    const parsed: unknown = JSON.parse(rawCounts);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const clean: Record<string, number> = {};
      const symbols = Object.keys(record);
      for (let index = 0; index < symbols.length; index += 1) {
        const value = record[symbols[index]];
        if (typeof value === 'number') clean[symbols[index]] = value;
      }
      counts.value = clean;
    }
  } catch (error) {
    counts.value = {};
  }
}

const rawMade = props.params.made;
if (rawMade) {
  try {
    const parsed: unknown = JSON.parse(rawMade);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const clean: Record<string, boolean> = {};
      const symbols = Object.keys(record);
      for (let index = 0; index < symbols.length; index += 1) {
        if (record[symbols[index]] === true) clean[symbols[index]] = true;
      }
      made.value = clean;
    }
  } catch (error) {
    made.value = {};
  }
}

/** Moves the cursor, wrapping at the grid's edges like the app's list loops. */
function moveCursor(deltaRow: number, deltaCol: number): void {
  const col = (cursor.value % COLS + deltaCol + COLS) % COLS;
  const row = (Math.floor(cursor.value / COLS) + deltaRow + ROWS) % ROWS;
  cursor.value = row * COLS + col;
}

/**
 * The D-pad belongs to the grid while it is on screen. Registered in the
 * capture phase so it runs before the app-wide handler (the same arrangement
 * the lightbox uses), and only while the grid is actually rendered — with the
 * sign-in gate up, the arrows must keep driving the list.
 */
function onKeydown(event: KeyboardEvent): void {
  if (!pickable.value) return;

  if (event.key === KEY.UP) moveCursor(-1, 0);
  else if (event.key === KEY.DOWN) moveCursor(1, 0);
  else if (event.key === KEY.LEFT) moveCursor(0, -1);
  else if (event.key === KEY.RIGHT) moveCursor(0, 1);
  else return;

  event.preventDefault();
  event.stopPropagation();
}

/**
 * Reacts with the template at `index`. The endpoint toggles, so the local
 * counts follow the answer: added bumps the tile, removed (204) drops it.
 * The caller's feed picks the fresh state up when it reloads on return; a
 * chat reaction updates the thread row in the chat store instead.
 */
async function react(index: number): Promise<void> {
  if (reacting.value || !props.params.id) return;

  const template = REACTION_TEMPLATES[index];
  reacting.value = true;
  errorKey.value = '';
  try {
    // The `room` param makes this the chat message picker: the message id
    // rides in `id`, and the store updates the thread the bubble lives in.
    const added = props.params.room
      ? await chat.react(props.params.room, props.params.id, template.symbol, template.attitude)
      : await reactToPost(props.params.id, template.symbol, template.attitude);
    const next = { ...counts.value };
    if (added) {
      next[template.symbol] = (next[template.symbol] || 0) + 1;
    } else {
      const count = (next[template.symbol] || 0) - 1;
      if (count > 0) next[template.symbol] = count;
      else delete next[template.symbol];
    }
    counts.value = next;

    // The toggle answer also flips the user's own reaction: the tile's
    // highlight follows, the same way the main app marks what you made.
    const nextMade = { ...made.value };
    if (added) nextMade[template.symbol] = true;
    else delete nextMade[template.symbol];
    made.value = nextMade;

    // The post's counts changed; the feed that shows it refetches on return.
    if (!props.params.room) useFeedStore().markStale();
  } catch (error) {
    // A dead session surfaces the sign-in gate; anything else is a network
    // failure the user can retry by pressing the same sticker again.
    needsSignIn.value = (error as { status?: number }).status === 401;
    errorKey.value = needsSignIn.value ? 'reactions_sign_in' : 'reactions_error';
  } finally {
    reacting.value = false;
  }
}

onMounted(() => {
  uid.value = registerSelectable({
    el: grid,
    onEnter: () => void react(cursor.value),
    initial: true,
  });
  document.addEventListener('keydown', onKeydown, true);

  setBaseSoftkeys(() => ({
    // The hardware Back key leaves the picker (the design guide's Back/Clear
    // rule); the centre key reacts with the highlighted sticker.
    center: { label: t('action_react') },
    right: { label: '' },
  }));
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
  unregisterSelectable(uid.value);
});
</script>
