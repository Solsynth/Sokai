<template>
  <div class="kai-field">
    <textarea
      ref="root"
      class="kai-field__input kai-field__textarea"
      rows="3"
      nav-selectable="true"
      :nav-selected="isSelected ? 'true' : 'false'"
      :value="modelValue"
      :placeholder="placeholder"
      @click="nav.current = uid"
      @input="onInput"
    ></textarea>
    <span class="kai-field__label kai-field__label--raised">{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { nav, registerSelectable, unregisterSelectable } from '~/src/kaios/nav.js';

const props = withDefaults(
  defineProps<{
    modelValue?: string;
    label: string;
    placeholder?: string;
  }>(),
  { modelValue: '', placeholder: '' },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const root = ref<HTMLElement | null>(null);
const uid = ref(0);

const isSelected = computed(() => uid.value !== 0 && nav.current === uid.value);

/**
 * The compose body grows with its content; the view scrolls instead of the
 * field (KaiOS has no wheel to scroll a box, and the selectable is the whole
 * field, so an inner scrollbar would be unreachable).
 */
function grow(el: HTMLElement): void {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function onInput(event: Event): void {
  const el = event.target as HTMLTextAreaElement;
  emit('update:modelValue', el.value);
  grow(el);
}

onMounted(() => {
  uid.value = registerSelectable({
    el: root,
    // No onEnter: in a textarea the centre key is the platform's newline
    // (`keys.ts` leaves Enter to the platform there), and the compose screen's
    // write action is the right softkey, not the centre key.
    initial: true,
  });
  if (root.value) grow(root.value);
});

onBeforeUnmount(() => {
  unregisterSelectable(uid.value);
});
</script>
