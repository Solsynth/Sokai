<template>
  <div class="kai-scrim" @click="emit('cancel')">
    <section class="kai-option-menu" @click.stop>
      <header class="kai-option-menu__header">{{ title }}</header>

      <div class="kai-option-menu__list">
        <button
          v-for="(option, index) in options"
          :key="option.id"
          type="button"
          class="kai-option-menu__item"
          :class="{ 'kai-option-menu__item--selected': index === cursor }"
          @click.stop="emit('select', option.id)"
        >
          {{ option.label }}
        </button>
      </div>

      <footer class="kai-option-menu__softkey">
        <span class="kai-option-menu__key kai-option-menu__key--left" @click="emit('cancel')">
          {{ cancelLabel }}
        </span>
        <span class="kai-option-menu__key kai-option-menu__key--center" @click="selectCurrent">
          {{ selectLabel }}
        </span>
        <span class="kai-option-menu__key kai-option-menu__key--right"></span>
      </footer>
    </section>
  </div>
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
  if (event.key === KEY.UP) {
    move(-1);
  } else if (event.key === KEY.DOWN) {
    move(1);
  } else if (event.key === KEY.CENTER) {
    selectCurrent();
  } else if (event.key === KEY.SOFT_LEFT || event.key === KEY.BACK) {
    emit('cancel');
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
