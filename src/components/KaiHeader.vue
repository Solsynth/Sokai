<template>
  <header class="kai-header">
    <span class="kai-header__title">{{ title }}</span>
  </header>
</template>

<script setup lang="ts">
defineProps<{ title: string }>();
</script>
