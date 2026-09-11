<template>
  <header class="kai-header">
    <span class="kai-header__title">{{ title }}</span>
  </header>
</template>

<script setup>
defineProps({
  title: { type: String, required: true },
});
</script>
