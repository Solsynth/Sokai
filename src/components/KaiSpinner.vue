<template>
  <div class="kai-spinner" role="progressbar" :aria-label="label">
    <span class="kai-spinner__ring"></span>
    <p v-if="label" class="kai-spinner__label">{{ label }}</p>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ label?: string }>(), { label: '' });
</script>
