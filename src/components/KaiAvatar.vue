<template>
  <img
    v-if="src"
    class="kai-avatar"
    :class="sizeClass"
    :src="src"
    :alt="alt"
  />
  <!-- No picture: the name's initials in a circle, so a row that has one keeps
       the list's left edge straight instead of starting its text at the screen
       edge. Decorative — the name is always beside it. -->
  <span
    v-else-if="initials"
    class="kai-avatar kai-avatar--letter"
    :class="sizeClass"
    aria-hidden="true"
  >{{ initials }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { fileUrl } from '~/src/api/solian.js';

const props = withDefaults(
  defineProps<{
    /** Drive file id; nothing renders when empty and no label is given. */
    file?: string | null;
    /** The name to letter the fallback with, when there is no file. */
    label?: string;
    /** xs = feed rows, sm = list rows, md = post detail. */
    size?: 'xs' | 'sm' | 'md';
    alt?: string;
  }>(),
  { file: null, label: '', size: 'sm', alt: '' },
);

const src = computed(() => (props.file ? fileUrl(props.file) : ''));
const sizeClass = computed(() => 'kai-avatar--' + props.size);
const initials = computed(() => (props.file ? '' : avatarInitials(props.label)));

/** Anything outside Latin and Latin Extended-B — CJK, kana, hangul, Greek,
 *  Cyrillic, emoji. Enumerating those scripts would need Unicode property
 *  escapes (`\p{...}`), which Gecko 48 does not have. */
const NON_LATIN = /[^\u0000-\u024F]/;

/**
 * The letters inside a fallback avatar, following the Flutter client's
 * `avatarFallbackText` — the rule behind its room tile: one glyph for a
 * non-Latin name, otherwise up to two initials (`SN Notes` → `SN`, `Alice` →
 * `AL`). `Array.from` iterates by code point, so a surrogate pair is never cut
 * in half; full grapheme clustering would be `Intl.Segmenter`, which Gecko 48
 * does not have (a ZWJ emoji sequence letters as its first glyph).
 */
function avatarInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';

  const chars = Array.from(trimmed);
  if (NON_LATIN.test(chars[0])) return chars[0].toUpperCase();

  const words = trimmed.split(/\s+/).filter((word) => word.length > 0);
  if (words.length >= 2) {
    return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
  }
  return chars.slice(0, 2).join('').toUpperCase();
}
</script>
