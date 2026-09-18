<template>
  <span v-if="chips.length" class="kai-reactions">
    <span v-for="chip in chips" :key="chip.symbol" class="kai-reaction">
      <img class="kai-reaction__img" :src="reactionStickerUrl(chip.symbol)" :alt="t(chip.labelKey)" />
      <span class="kai-reaction__count">{{ chip.count }}</span>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { reactionChips, reactionStickerUrl } from '~/src/content/reactions.js';
import { t } from '~/src/kaios/l10n.js';

/**
 * A post's reactions as sticker pills — the bundled sticker and its count,
 * best first, capped at `limit` (`0` renders every reaction). Mirrors the
 * watch app's post-card pills (`reactionPills`); custom `prefix+slug`
 * reactions have no bundled sticker and stay with the plain count text.
 */
const props = withDefaults(
  defineProps<{
    reactions: Record<string, number>;
    limit?: number;
  }>(),
  { limit: 3 },
);

const chips = computed(() => reactionChips(props.reactions, props.limit));
</script>
