<template>
  <div class="kai-field">
    <input
      ref="root"
      class="kai-field__input"
      type="text"
      nav-selectable="true"
      :nav-selected="isSelected ? 'true' : 'false'"
      :value="modelValue"
      :placeholder="placeholder"
      @click="nav.current = uid"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <span class="kai-field__label" :class="{ 'kai-field__label--raised': raised }">{{ label }}</span>
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
  submit: [];
}>();

const root = ref<HTMLElement | null>(null);
const uid = ref(0);

const isSelected = computed(() => uid.value !== 0 && nav.current === uid.value);

// The floating label is driven by selection + value, because `:placeholder-shown`
// is unavailable on Gecko 48.
const raised = computed(() => isSelected.value || props.modelValue.length > 0);

onMounted(() => {
  uid.value = registerSelectable({
    el: root,
    onEnter: () => emit('submit'),
    // On a search screen the field is the primary control: the highlight (and
    // so the platform's keyboard) starts here.
    initial: true,
  });
});

onBeforeUnmount(() => {
  unregisterSelectable(uid.value);
});
</script>
