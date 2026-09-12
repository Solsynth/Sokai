<template>
  <button
    ref="root"
    type="button"
    tabindex="-1"
    nav-selectable="true"
    :nav-selected="isSelected ? 'true' : 'false'"
    class="kai-icon-button"
    :class="{ 'kai-icon-button--icon-only': !showLabel }"
    :aria-label="label"
    @click="emit('select')"
  >
    <!-- The layout lives on this span, not on the button: Gecko 48 (KaiOS 2.5)
         cannot lay a `<button>` out as a flex container — that arrived in
         Firefox 52 — so centring declared on the button itself is silently
         ignored on device and the glyph sits on the text baseline instead. -->
    <span class="kai-icon-button__inner">
      <component :is="icon" class="kai-icon-button__icon" aria-hidden="true" />
      <span v-if="showLabel" class="kai-icon-button__label">{{ label }}</span>
    </span>
  </button>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type Component } from 'vue';

import { nav, registerSelectable, unregisterSelectable } from '~/src/kaios/nav.js';

/**
 * A toolbar icon button — the design guide's icon button. One of a row of
 * selectables (like the pager's cells), so the D-pad walks the row in document
 * order. The centre key (or a tap) runs the action; the icon comes from
 * `@lucide/vue`, dropped into the component slot by the caller. The label
 * doubles as the accessible name; `showLabel` hides the visible text for an
 * icon-only row.
 */
const props = withDefaults(
  defineProps<{
    /** A lucide icon component to draw. */
    icon: Component;
    /** The accessible name (and the label under the icon when shown). */
    label: string;
    /** Draw the label under the icon; false for an icon-only row. */
    showLabel?: boolean;
  }>(),
  { showLabel: true },
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
