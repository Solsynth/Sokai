<template>
  <img
    v-if="src"
    class="kai-avatar"
    :class="sizeClass"
    :src="src"
    :alt="alt"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { fileUrl } from '~/src/api/solian.js';

const props = withDefaults(
  defineProps<{
    /** Drive file id; nothing renders when empty. */
    file?: string | null;
    /** xs = feed rows, sm = list rows, md = post detail. */
    size?: 'xs' | 'sm' | 'md';
    alt?: string;
  }>(),
  { file: null, size: 'sm', alt: '' },
);

const src = computed(() => (props.file ? fileUrl(props.file) : ''));
const sizeClass = computed(() => 'kai-avatar--' + props.size);
</script>
