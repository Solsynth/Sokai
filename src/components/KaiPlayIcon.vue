<template>
  <span class="kai-play-icon" :class="size === 'lg' ? 'kai-play-icon--lg' : ''">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  </span>
</template>

<script setup lang="ts">
/**
 * The play badge: a white triangle in a translucent circle. Small on video
 * thumbnails, large as the lightbox's paused indicator.
 */
withDefaults(defineProps<{ size?: 'sm' | 'lg' }>(), { size: 'sm' });
</script>
