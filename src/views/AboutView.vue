<template>
  <div class="kai-view">
    <KaiHeader :title="t('nav_about')" />

    <main class="kai-content">
      <p class="kai-text">{{ t('app_description') }}</p>

      <p class="kai-separator">{{ t('about_version') }}</p>
      <p class="kai-text kai-text--secondary">{{ version }}</p>

      <p class="kai-separator">{{ t('about_target') }}</p>
      <p class="kai-text kai-text--secondary">{{ target }}</p>

      <p class="kai-separator">{{ t('about_engine') }}</p>
      <p class="kai-text kai-text--secondary">{{ engine }}</p>
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';

import KaiHeader from '~/src/components/KaiHeader.vue';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';

// Every screen is mounted with its stack entry's parameters; About takes none.
withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({}) });

// Replaced at build time by Vite `define` (see vite.config.js).
const version = __APP_VERSION__;
const target = __KAIOS_TARGET__;

// The device's real engine string: the fastest way to confirm what a handset
// actually reports.
const engine = navigator.userAgent;

onMounted(() => {
  // The hardware Back key is the way up (the design guide's Back/Clear rule);
  // no softkey duplicates it.
  setBaseSoftkeys(() => ({}));
});
</script>
