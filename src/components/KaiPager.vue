<template>
  <div class="kai-pager">
    <KaiList class="kai-list--flat">
      <KaiListItem v-if="page > 1" :primary="t('action_prev_page')" @select="emit('go', page - 1)" />
      <KaiListItem
        v-if="page < pages"
        :primary="t('action_next_page')"
        @select="emit('go', page + 1)"
      />
    </KaiList>

    <p v-if="pages > 1" class="kai-pager__status">
      {{ t('post_page', { page, pages }) }}
    </p>
  </div>
</template>

<script setup>
import KaiList from './KaiList.vue';
import KaiListItem from './KaiListItem.vue';
import { t } from '../kaios/l10n.js';

/**
 * Page flip controls for an offset-paginated list. Both rows are ordinary
 * selectable rows, so the D-pad reaches them at the end of the list — and the
 * caller can put the same action on a softkey.
 */
defineProps({
  /** 1-based. */
  page: { type: Number, required: true },
  pages: { type: Number, required: true },
});

const emit = defineEmits(['go']);
</script>
