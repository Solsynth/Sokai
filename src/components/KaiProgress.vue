<template>
  <div class="kai-progress" role="progressbar" :aria-label="label">
    <div class="kai-progress__bar"></div>
  </div>
</template>

<script setup>
defineProps({
  label: { type: String, required: true },
});
</script>
