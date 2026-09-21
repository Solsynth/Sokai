<template>
  <div class="kai-view">
    <KaiHeader :title="t('nav_settings')" />

    <main class="kai-content">
      <!-- The media cache: what it holds, and the way to free it. The figures
           come from the cache itself (the meta rows — no blobs are read), so
           the page shows the truth of what the app has pinned on disk. -->
      <p class="kai-separator">{{ t('settings_media_cache') }}</p>
      <p class="kai-text kai-text--secondary">{{ usageLabel }}</p>

      <KaiList class="kai-list--flat">
        <KaiListItem
          :primary="t('settings_clear_media_cache')"
          :secondary="t('settings_clear_media_cache_desc')"
          @select="confirmClear"
        />
      </KaiList>
    </main>

    <!-- Clearing is destructive, so it asks once more before the bytes go. -->
    <KaiOptionMenu
      v-if="clearMenu"
      :title="t('settings_clear_media_cache_confirm')"
      :options="clearOptions"
      @select="onClearChoice"
      @cancel="clearMenu = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { formatBytes } from '~/src/api/models.js';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import KaiOptionMenu, { type Option } from '~/src/components/KaiOptionMenu.vue';
import { t } from '~/src/kaios/l10n.js';
import { clearMediaCache, mediaCacheStats } from '~/src/kaios/media-cache.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';

// Every screen is mounted with its stack entry's parameters; Settings takes none.
withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({}) });

const clearMenu = ref(false);

const clearOptions: Option[] = [
  { id: 'clear', label: t('settings_clear_media_cache') },
  { id: 'keep', label: t('action_cancel') },
];

/** The cache's footprint; `null` until the first read resolves. */
const stats = ref<{ count: number; bytes: number } | null>(null);
/** The stats read failed (or a host with no cache at all): say so plainly. */
const statsFailed = ref(false);

/**
 * The cache line: its size across its files, the empty state when it holds
 * nothing, or the failure state when the footprint could not be read.
 */
const usageLabel = computed(() => {
  if (statsFailed.value) return t('settings_cache_unavailable');
  if (!stats.value || stats.value.count === 0) return t('settings_media_cache_empty');
  const size = formatBytes(stats.value.bytes) || '0 B';
  return t('settings_media_cache_usage', { size, count: stats.value.count });
});

async function loadStats(): Promise<void> {
  statsFailed.value = false;
  try {
    stats.value = await mediaCacheStats();
  } catch (error) {
    statsFailed.value = true;
  }
}

/** The destructive path asks once more before the cache goes. */
function confirmClear(): void {
  clearMenu.value = true;
}

async function onClearChoice(choice: string): Promise<void> {
  clearMenu.value = false;
  if (choice !== 'clear') return;
  try {
    await clearMediaCache();
  } catch (error) {
    // Clearing is best-effort: a cache that cannot be wiped stays as it was.
  }
  await loadStats();
}

onMounted(() => {
  // The hardware Back key is the way up (the design guide's Back/Clear rule);
  // the centre key activates the highlighted row, as on the dashboard.
  setBaseSoftkeys(() => ({
    center: { label: t('action_open') },
  }));
  void loadStats();
});
</script>
