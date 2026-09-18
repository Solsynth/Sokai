<template>
  <!-- The sheet is an app-level overlay, so it mounts outside the current
       view: the view's enter slide animates a transform, which would make the
       view the containing block for the scrim's `position: fixed` and leave
       the screen's softkey bar uncovered below the sheet. On `body` the scrim
       spans the whole viewport — backdrop and sheet stack over the softkey
       bar, and the sheet's own bar replaces it. -->
  <Teleport to="body">
    <div class="kai-scrim" @click="close(() => emit('cancel'))">
      <section
        class="kai-option-menu"
        :class="{ 'kai-option-menu--closing': closing }"
        @click.stop
      >
        <header class="kai-option-menu__header">{{ title }}</header>

        <div class="kai-option-menu__list">
          <button
            v-for="(option, index) in options"
            :key="option.id"
            type="button"
            class="kai-option-menu__item"
            :class="{ 'kai-option-menu__item--selected': index === cursor }"
            @click.stop="close(() => emit('select', option.id))"
          >
            {{ option.label }}
          </button>
        </div>

        <footer class="kai-option-menu__softkey">
          <span
            class="kai-option-menu__key kai-option-menu__key--left"
            @click="close(() => emit('cancel'))"
          >
            {{ cancelLabel }}
          </span>
          <span
            class="kai-option-menu__key kai-option-menu__key--center"
            @click="close(selectCurrent)"
          >
            {{ selectLabel }}
          </span>
          <span class="kai-option-menu__key kai-option-menu__key--right"></span>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { KEY } from '~/src/kaios/keys.js';
import { t } from '~/src/kaios/l10n.js';

/**
 * The design guide's Option Menu, as a self-contained sheet: a title bar
 * describing the menu, the list of choices, and its own softkey bar
 * (CANCEL | SELECT) — so an action runs without leaving the view underneath.
 *
 * Data-driven so any screen can reuse it: the choices are `options`, the
 * sheet's purpose is `title`. While mounted the menu owns every key — the
 * same capture-phase arrangement the lightbox uses — because the underlying
 * view's highlight is still live underneath: an unclaimed press would activate
 * the post it covers. The sheet's softkey bar is labelled by `selectLabel` /
 * `cancelLabel`, and the presses that matter are turned into `select`/`cancel`
 * here, never dispatched to the view below.
 */
export interface Option {
  id: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    /** What the sheet is for; the title bar's text. */
    title: string;
    /** The choices, in the order the D-pad walks them. */
    options: Option[];
    /** The softkey bar's labels; defaults read from the string table. */
    selectLabel?: string;
    cancelLabel?: string;
  }>(),
  { selectLabel: '', cancelLabel: '' },
);

const emit = defineEmits<{
  select: [id: string];
  cancel: [];
}>();

const cursor = ref(0);

const selectLabel = props.selectLabel || t('action_select');
const cancelLabel = props.cancelLabel || t('action_cancel');

/**
 * Length of the sheet's slide-out in ms. Must stay in sync with the 0.2s
 * animation durations on `.kai-scrim` / `.kai-option-menu` in kaios.css, so
 * the parent sees the close event after the sheet has slid away, not while
 * it is still half-visible.
 */
const CLOSE_MS = 200;

/** True while the slide-out plays; the sheet ignores all input until unmount. */
const closing = ref(false);

/**
 * Closes the sheet. Every close path — scrim tap, softkey tap, D-pad — runs
 * through here: the exit animation plays first (the parent only unmounts us
 * once the deferred action fires), so the sheet slides down instead of
 * disappearing instantly. `closing` is cleared once the action has run, so a
 * press that the parent *keeps the sheet open* for (the two-step delete's
 * first press only arms the confirmation) leaves the sheet usable rather than
 * wedged mid-animation; a press that closes it simply unmounts us.
 */
function close(action?: () => void): void {
  if (closing.value) return;
  closing.value = true;
  window.setTimeout(() => {
    closing.value = false;
    action?.();
  }, CLOSE_MS);
}

function move(delta: number): void {
  const count = props.options.length;
  if (!count) return;
  cursor.value = (cursor.value + delta + count) % count;
}

/** Runs the highlighted choice — the centre key and the SELECT tap share it. */
function selectCurrent(): void {
  const option = props.options[cursor.value];
  if (option) emit('select', option.id);
}

function onKeydown(event: KeyboardEvent): void {
  if (closing.value) return;
  if (event.key === KEY.UP) {
    move(-1);
  } else if (event.key === KEY.DOWN) {
    move(1);
  } else if (event.key === KEY.CENTER) {
    close(selectCurrent);
  } else if (event.key === KEY.SOFT_LEFT || event.key === KEY.BACK) {
    close(() => emit('cancel'));
  } else if (event.key === KEY.SOFT_RIGHT) {
    return;
  } else {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
});
</script>
