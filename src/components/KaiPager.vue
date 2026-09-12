<template>
  <div class="kai-pager">
    <div class="kai-pager__nav">
      <!-- Both cells are always present so the row never jumps between pages;
           at a boundary the inert cell is a dim icon, not a focus target. -->
      <KaiListItem
        v-if="page > 1"
        class="kai-pager__cell"
        :icon="ChevronLeft"
        :aria-label="t('action_prev_page')"
        @select="emit('go', page - 1)"
      />
      <span v-else class="kai-pager__cell kai-pager__cell--dim" aria-hidden="true">
        <ChevronLeft class="kai-pager__glyph" />
      </span>

      <p v-if="pages > 1" class="kai-pager__status">{{ t('post_page', { page, pages }) }}</p>

      <KaiListItem
        v-if="page < pages"
        class="kai-pager__cell"
        :icon="ChevronRight"
        :aria-label="t('action_next_page')"
        @select="emit('go', page + 1)"
      />
      <span v-else class="kai-pager__cell kai-pager__cell--dim" aria-hidden="true">
        <ChevronRight class="kai-pager__glyph" />
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ChevronLeft, ChevronRight } from '@lucide/vue';

import KaiList from './KaiList.vue';
import KaiListItem from './KaiListItem.vue';
import { t } from '~/src/kaios/l10n.js';

/**
 * Page flip controls for an offset-paginated list, rendered above the feed.
 * One edge-to-edge row: a lucide icon cell for previous, the total page count,
 * a lucide icon cell for next — both always present, dimmed and inert at the
 * ends. The active cells are ordinary selectable rows (the labels live in
 * `aria-label`, since the cells are icon-only), so the D-pad reaches them from
 * the posts (UP from the first post, or the list loop wrapping around the
 * end). The posts mark themselves `initial`, so the highlight does not land on
 * the controls when the screen mounts.
 */
const props = defineProps<{
  /** 1-based. */
  page: number;
  pages: number;
}>();

const emit = defineEmits<{ go: [page: number] }>();
</script>
