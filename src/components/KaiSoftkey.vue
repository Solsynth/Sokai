<template>
  <footer id="softkey" class="kai-softkey">
    <label class="kai-softkey__key kai-softkey__key--left">{{ softkeys.left.label }}</label>
    <label class="kai-softkey__key kai-softkey__key--center">{{ softkeys.center.label }}</label>
    <label class="kai-softkey__key kai-softkey__key--right">{{ softkeys.right.label }}</label>
  </footer>
</template>

<script setup>
import { softkeys } from '../kaios/nav.js';
</script>
