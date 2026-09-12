<template>
  <div class="kai-view">
    <KaiHeader :title="t('compose_publisher_title')" />

    <main class="kai-content">
      <KaiSpinner v-if="publisherStatus === 'loading'" />

      <template v-else-if="publisherStatus === 'error'">
        <p class="kai-text kai-text--error">{{ t(publisherErrorKey) }}</p>

        <KaiList class="kai-list--flat">
          <KaiListItem :primary="t('error_retry')" @select="store.loadPublishers" />
        </KaiList>
      </template>

      <KaiList v-else class="kai-list--flat">
        <KaiListItem
          v-for="publisher in store.publishers"
          :key="publisher.name"
          :primary="publisher.display"
          :secondary="
            publisher.name === currentName ? t('compose_current') + ' · @' + publisher.name : '@' + publisher.name
          "
          :thumb="publisher.picture || ''"
          @select="choose(publisher)"
        />
      </KaiList>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';

import type { Publisher } from '~/src/api/models.js';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import KaiSpinner from '~/src/components/KaiSpinner.vue';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { pop } from '~/src/kaios/views.js';
import { useComposeStore } from '~/src/stores/compose.js';

// Every screen is mounted with its stack entry's parameters; the picker takes none.
withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({}) });

const store = useComposeStore();

const publisherStatus = computed(() => store.publisherStatus);
const publisherErrorKey = computed(() => store.publisherErrorKey);
const currentName = computed(() => (store.publisher ? store.publisher.name : ''));

/** Applies the choice and returns to the draft. */
function choose(publisher: Publisher): void {
  store.selectPublisher(publisher.name);
  pop();
}

onMounted(() => {
  setBaseSoftkeys(() => ({
    // The hardware Back key leaves the picker (the design guide's rule).
    center: { label: t('action_open') },
    right: { label: '' },
  }));
});
</script>
