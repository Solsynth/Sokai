<template>
  <li
    ref="root"
    tabindex="-1"
    nav-selectable="true"
    :nav-selected="isSelected ? 'true' : 'false'"
    class="kai-list-item"
    @click="emit('select')"
  >
    <span class="kai-list-item__primary">{{ primary }}</span>
    <span v-if="secondary" class="kai-list-item__secondary">{{ secondary }}</span>
  </li>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { nav, registerSelectable, unregisterSelectable } from '~/src/kaios/nav.js';

const props = defineProps<{
  primary: string;
  secondary?: string;
}>();

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
