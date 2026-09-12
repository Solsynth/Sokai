<template>
  <li
    ref="root"
    tabindex="-1"
    nav-selectable="true"
    :nav-selected="isSelected ? 'true' : 'false'"
    class="kai-list-item"
    :class="{ 'kai-list-item--thumb': Boolean(thumb) }"
    @click="emit('select')"
  >
    <!-- With an icon the row is glyph-only (the pager's direction cells): the
         name lives in `aria-label`, since the icon carries no text. -->
    <component v-if="icon" :is="icon" class="kai-list-item__icon" aria-hidden="true" />
    <template v-else-if="thumb">
      <KaiAvatar class="kai-list-item__thumb" :file="thumb" size="xs" />
      <span class="kai-list-item__text">
        <span class="kai-list-item__primary">{{ primary }}</span>
        <span v-if="secondary" class="kai-list-item__secondary">{{ secondary }}</span>
      </span>
    </template>
    <template v-else>
      <span class="kai-list-item__primary">{{ primary }}</span>
      <span v-if="secondary" class="kai-list-item__secondary">{{ secondary }}</span>
    </template>
  </li>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type Component } from 'vue';

import KaiAvatar from './KaiAvatar.vue';
import { nav, registerSelectable, unregisterSelectable } from '~/src/kaios/nav.js';

const props = withDefaults(
  defineProps<{
    primary?: string;
    secondary?: string;
    /** Drive file id of an avatar to lead the row with. */
    thumb?: string;
    /** A lucide icon for a glyph-only row (the pager's direction cells). */
    icon?: Component;
  }>(),
  { primary: '', secondary: '', thumb: '', icon: undefined },
);

const emit = defineEmits<{ select: [] }>();

const root = ref<HTMLElement | null>(null);
const uid = ref(0);

const isSelected = computed(() => uid.value !== 0 && nav.current === uid.value);

onMounted(() => {
  uid.value = registerSelectable({
    el: root,
    onEnter: () => emit('select'),
  });
});

onBeforeUnmount(() => {
  unregisterSelectable(uid.value);
});
</script>
