<template>
  <div class="kai-view">
    <KaiHeader :title="t('app_title')" />

    <main class="kai-content">
      <KaiList>
        <KaiListItem
          :primary="t('nav_search')"
          :secondary="t('nav_search_desc')"
          @select="push('search')"
        />
        <KaiListItem
          :primary="t('nav_about')"
          :secondary="t('nav_about_desc')"
          @select="push('about')"
        />
      </KaiList>
    </main>
  </div>
</template>

<script setup>
import { onMounted } from 'vue';

import KaiHeader from '../components/KaiHeader.vue';
import KaiList from '../components/KaiList.vue';
import KaiListItem from '../components/KaiListItem.vue';
import { t } from '../kaios/l10n.js';
import { setBaseSoftkeys } from '../kaios/nav.js';
import { push } from '../kaios/views.js';

onMounted(() => {
  setBaseSoftkeys(() => ({
    center: { label: t('action_select') },
  }));
});
</script>
