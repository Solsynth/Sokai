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
      @input="emit('update:modelValue', $event.target.value)"
    />
    <span class="kai-field__label" :class="{ 'kai-field__label--raised': raised }">{{ label }}</span>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { nav, registerSelectable, unregisterSelectable } from '../kaios/nav.js';

const props = defineProps({
  modelValue: { type: String, default: '' },
  label: { type: String, required: true },
  placeholder: { type: String, default: '' },
});

const emit = defineEmits(['update:modelValue', 'submit']);

const root = ref(null);
const uid = ref(0);

const isSelected = computed(() => uid.value !== 0 && nav.current === uid.value);

// The floating label is driven by selection + value, because `:placeholder-shown`
// is unavailable on Gecko 48.
const raised = computed(() => isSelected.value || props.modelValue.length > 0);

onMounted(() => {
  uid.value = registerSelectable({
    el: root,
    onEnter: () => emit('submit'),
  });
});

onBeforeUnmount(() => {
  unregisterSelectable(uid.value);
});
</script>
