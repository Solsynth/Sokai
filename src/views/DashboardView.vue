<template>
  <div class="kai-view">
    <KaiHeader :title="t('app_title')" />

    <main class="kai-content">
      <!-- The reference dashboard leads with a clock: it needs nothing from the
           network, so the screen has something alive on it before any request
           resolves. Seconds tick only while this screen is mounted. -->
      <p class="kai-clock">
        <span class="kai-clock__time">{{ time }}</span>
        <span class="kai-clock__date">{{ date }}</span>
      </p>

      <!-- Everything the app can do that is not the post list. Adding a screen
           means adding a row here and a view to `App.vue`. -->
      <KaiList>
        <KaiListItem
          v-for="entry in ENTRIES"
          :key="entry.view"
          :primary="t(entry.title)"
          :secondary="t(entry.description)"
          @select="push(entry.view)"
        />
      </KaiList>
    </main>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';

import KaiHeader from '../components/KaiHeader.vue';
import KaiList from '../components/KaiList.vue';
import KaiListItem from '../components/KaiListItem.vue';
import { t } from '../kaios/l10n.js';
import { setBaseSoftkeys } from '../kaios/nav.js';
import { push } from '../kaios/views.js';

// Every screen is mounted with its stack entry's parameters; the dashboard takes none.
defineProps({
  params: { type: Object, default: () => ({}) },
});

const ENTRIES = [
  { view: 'explore', title: 'nav_explore', description: 'nav_explore_desc' },
  { view: 'about', title: 'nav_about', description: 'nav_about_desc' },
];

const CLOCK_INTERVAL_MS = 1000;

const time = ref('');
const date = ref('');
let timer = null;

function pad(value) {
  return value < 10 ? '0' + value : '' + value;
}

/** No `Intl` on Gecko 48: the date is written the way the API writes its own. */
function tick() {
  const now = new Date();
  time.value = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  date.value = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

onMounted(() => {
  tick();
  timer = setInterval(tick, CLOCK_INTERVAL_MS);

  // The dashboard is the top level: Back is the platform's to take, which is
  // what leaves the app (design-guide/key).
  setBaseSoftkeys(() => ({
    center: { label: t('action_open') },
  }));
});

onBeforeUnmount(() => {
  clearInterval(timer);
});
</script>
