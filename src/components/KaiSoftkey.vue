<template>
  <footer id="softkey" class="kai-softkey">
    <label
      class="kai-softkey__key kai-softkey__key--left"
      @click="pressKey(KEY.SOFT_LEFT)"
      >{{ softkeys.left.label }}</label
    >
    <label
      class="kai-softkey__key kai-softkey__key--center"
      @click="pressKey(KEY.CENTER)"
      >{{ softkeys.center.label }}</label
    >
    <label
      class="kai-softkey__key kai-softkey__key--right"
      @click="pressKey(KEY.SOFT_RIGHT)"
      >{{ softkeys.right.label }}</label
    >
  </footer>
</template>

<script setup lang="ts">
import { KEY } from '~/src/kaios/keys.js';
import { softkeys } from '~/src/kaios/nav.js';

/**
 * The softkey bar answers a tap exactly like the hardware key it stands for —
 * a click dispatches the same keydown. That keeps overlays that intercept
 * keys (the option menu, the lightbox) right under a pointer: clicking
 * "Cancel" while the menu is up runs the menu's cancel, not the press handler
 * of the view underneath.
 */
function pressKey(key: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}
</script>
