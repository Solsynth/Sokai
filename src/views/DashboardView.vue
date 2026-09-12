<template>
  <div class="kai-view">
    <KaiHeader :title="t('app_title')" />

    <main class="kai-content">
      <!--
        The hero is the clock. It needs nothing from the network, so the screen
        has something alive on it before any request resolves — and it sits on
        the background, not on a card. The mark and time share one baseline;
        the date is a quiet caption under them. Below the dawn line — a hairline
        with one accent dot straddling it, the sun on the horizon — the
        countdown names the next event; it is fetched separately so the clock
        never waits on it.
      -->
      <div class="kai-hero">
        <div class="kai-hero__line">
          <img class="kai-hero__mark" src="/img/icons/icon-mark-dark.png" alt="" />
          <p class="kai-hero__time">{{ time }}</p>
        </div>
        <p class="kai-hero__date">{{ date }}</p>
        <p v-if="countdown" class="kai-hero__countdown">
          <span class="kai-hero__dawn"></span>{{ countdown.title }} · {{ countdownText }}
        </p>
      </div>

      <!-- Everything the app can do that is not the post list. Adding a screen
           means adding a row here and a view to `App.vue`. -->
      <KaiList class="kai-list--flat">
        <KaiListItem
          v-for="entry in ENTRIES"
          :key="entry.view"
          :primary="t(entry.title)"
          :secondary="entry.view === 'account' ? accountDescription : t(entry.description)"
          @select="push(entry.view)"
        />
      </KaiList>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import { countdownLabel, type Countdown } from '~/src/api/models.js';
import { listCountdowns } from '~/src/api/solian.js';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { useAccountStore } from '~/src/stores/account.js';
import { push } from '~/src/kaios/views.js';

// Every screen is mounted with its stack entry's parameters; the dashboard takes none.
withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({}) });

interface DashboardEntry {
  view: string;
  title: string;
  description: string;
}

const ENTRIES: DashboardEntry[] = [
  { view: 'explore', title: 'nav_explore', description: 'nav_explore_desc' },
  { view: 'account', title: 'nav_account', description: 'nav_account_desc' },
  { view: 'about', title: 'nav_about', description: 'nav_about_desc' },
];

const accountStore = useAccountStore();

/**
 * The account row reports the session: the signed-in identity when there is
 * one, the plain description when there is not.
 */
const accountDescription = computed(() => {
  if (accountStore.phase === 'signed-in' && accountStore.account) {
    return t('account_signed_in_as', { name: accountStore.account.display });
  }
  return t('nav_account_desc');
});

const SECOND_MS = 1000;
const MINUTE_MS = 60000;

const time = ref('');
const date = ref('');
/** The countdown label is derived from this, so it advances on the same minute tick. */
const nowMs = ref(Date.now());
/** The soonest event, normalised; `null` until it loads or when the load fails. */
const countdown = ref<Countdown | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

const countdownText = computed(() => {
  if (!countdown.value) return '';
  const label = countdownLabel(countdown.value, nowMs.value);
  return label ? t(label.key, label.args) : '';
});

function pad(value: number): string {
  return value < 10 ? '0' + value : '' + value;
}

/** No `Intl` on Gecko 48: the date is written the way the API writes its own. */
function tick(): void {
  const now = new Date();
  nowMs.value = now.getTime();
  time.value = pad(now.getHours()) + ':' + pad(now.getMinutes());
  date.value = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

/**
 * One wake-up per minute, armed on the minute, instead of one per second: the
 * displayed time only changes when the minute does, so the sixty ticks in
 * between would spend battery to repaint the same two digits. This is why the
 * clock shows `HH:MM` and not seconds.
 *
 * Nothing is armed while the app is not visible: the timer is dropped on the way
 * out and re-armed, with a fresh reading, on the way back in.
 */
function schedule(): void {
  if (timer) clearTimeout(timer);
  tick();

  const now = new Date();
  const intoMinute = now.getSeconds() * SECOND_MS + now.getMilliseconds();
  timer = setTimeout(schedule, MINUTE_MS - intoMinute);
}

function onVisibilityChange(): void {
  if (document.hidden) {
    if (timer) clearTimeout(timer);
  } else {
    schedule();
  }
}

/** The countdown is decoration, so a failure hides the line rather than erroring. */
async function loadCountdown(): Promise<void> {
  try {
    const items = await listCountdowns();
    countdown.value = items[0] || null;
  } catch (error) {
    countdown.value = null;
  }
}

onMounted(() => {
  schedule();
  document.addEventListener('visibilitychange', onVisibilityChange);
  loadCountdown();

  // The dashboard is the top level: Back is the platform's to take, which is
  // what leaves the app (design-guide/key).
  setBaseSoftkeys(() => ({
    center: { label: t('action_open') },
  }));
});

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});
</script>
