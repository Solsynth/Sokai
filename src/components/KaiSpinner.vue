<template>
  <div class="kai-spinner" role="progressbar" :aria-label="label">
    <span class="kai-spinner__ring"></span>
    <p v-if="label" class="kai-spinner__label">{{ label }}</p>
  </div>
</template>

<script setup>
defineProps({
  /** Optional caption under the ring; a spinner alone reads fine too. */
  label: { type: String, default: '' },
});
</script>
