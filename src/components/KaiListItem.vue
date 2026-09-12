<template>
  <li
    ref="root"
    tabindex="-1"
    nav-selectable="true"
    :nav-selected="isSelected ? 'true' : 'false'"
    class="kai-list-item"
    :class="{ 'kai-list-item--thumb': Boolean(thumb || thumbLabel) }"
    @click="emit('select')"
  >
    <!-- With an icon the row is glyph-only (the pager's direction cells): the
         name lives in `aria-label`, since the icon carries no text. -->
    <component v-if="icon" :is="icon" class="kai-list-item__icon" aria-hidden="true" />
    <template v-else-if="thumb || thumbLabel">
      <KaiAvatar class="kai-list-item__thumb" :file="thumb" :label="thumbLabel" size="xs" />
      <span class="kai-list-item__text">
        <span class="kai-list-item__primary"><slot name="primary">{{ primary }}</slot></span>
        <span v-if="secondary || $slots.secondary" class="kai-list-item__secondary">
          <slot name="secondary">{{ secondary }}</slot>
        </span>
      </span>
    </template>
    <template v-else>
      <span class="kai-list-item__primary"><slot name="primary">{{ primary }}</slot></span>
      <span v-if="secondary || $slots.secondary" class="kai-list-item__secondary">
        <slot name="secondary">{{ secondary }}</slot>
      </span>
    </template>
  </li>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue';

import KaiAvatar from './KaiAvatar.vue';
import { nav, registerSelectable, unregisterSelectable } from '~/src/kaios/nav.js';

const props = withDefaults(
  defineProps<{
    primary?: string;
    secondary?: string;
    /** Drive file id of an avatar to lead the row with. */
    thumb?: string;
    /** The name a fallback avatar is lettered with, when `thumb` is empty. */
    thumbLabel?: string;
    /** A lucide icon for a glyph-only row (the pager's direction cells). */
    icon?: Component;
    /** Echoed with `selected` — for views whose softkeys act on the
     *  highlighted row (the invites screen's accept/decline). */
    value?: string;
    /** Eligible for the highlight when the screen mounts. Chrome rows (a
     *  pager, a searchbar) leave this off; the dashboard's first entry is the
     *  screen's primary list and takes it. */
    initial?: boolean;
  }>(),
  { primary: '', secondary: '', thumb: '', thumbLabel: '', icon: undefined, value: '', initial: false },
);

const emit = defineEmits<{ select: []; selected: [value: string] }>();

const root = ref<HTMLElement | null>(null);
const uid = ref(0);

const isSelected = computed(() => uid.value !== 0 && nav.current === uid.value);

// A view that arms softkey actions on the highlighted row needs to know when
// the highlight lands here — the same contract `KaiPostRow` has for the feed's
// react/reply actions.
watch(isSelected, (selected) => {
  if (selected) emit('selected', props.value);
});

onMounted(() => {
  uid.value = registerSelectable({
    el: root,
    onEnter: () => emit('select'),
    initial: props.initial,
  });
});

onBeforeUnmount(() => {
  unregisterSelectable(uid.value);
});
</script>
