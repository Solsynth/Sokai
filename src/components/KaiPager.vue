<template>
  <div class="kai-pager">
    <div class="kai-pager__nav">
      <!-- Both cells are always present so the row never jumps between pages;
           at a boundary the inert cell is a dim glyph, not a focus target. -->
      <KaiListItem
        v-if="page > 1"
        class="kai-pager__cell"
        :primary="PREV_GLYPH"
        :aria-label="t('action_prev_page')"
        @select="emit('go', page - 1)"
      />
      <span v-else class="kai-pager__cell kai-pager__cell--dim" aria-hidden="true">{{ PREV_GLYPH }}</span>

      <p v-if="pages > 1" class="kai-pager__status">{{ t('post_page', { page, pages }) }}</p>

      <KaiListItem
        v-if="page < pages"
        class="kai-pager__cell"
        :primary="NEXT_GLYPH"
        :aria-label="t('action_next_page')"
        @select="emit('go', page + 1)"
      />
      <span v-else class="kai-pager__cell kai-pager__cell--dim" aria-hidden="true">{{ NEXT_GLYPH }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import KaiList from './KaiList.vue';
import KaiListItem from './KaiListItem.vue';
import { t } from '~/src/kaios/l10n.js';

/** The pager glyphs: typographic arrows every device font carries. */
const PREV_GLYPH = '‹';
const NEXT_GLYPH = '›';

/**
 * Page flip controls for an offset-paginated list, rendered above the feed.
 * One edge-to-edge row: an icon cell for previous, the total page count, an
 * icon cell for next — both always present, dimmed and inert at the ends. The
 * active cells are ordinary selectable rows (the labels live in `aria-label`,
 * since the cells are icon-only), so the D-pad reaches them from the posts (UP
 * from the first post, or the list loop wrapping around the end). The posts
 * mark themselves `initial`, so the highlight does not land on the controls
 * when the screen mounts.
 */
const props = defineProps<{
  /** 1-based. */
  page: number;
  pages: number;
}>();

const emit = defineEmits<{ go: [page: number] }>();
</script>
