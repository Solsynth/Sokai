<template>
  <div class="kai-view">
    <KaiHeader :title="t('nav_search')" />

    <main class="kai-content">
      <KaiInput
        v-model="term"
        :label="t('search_label')"
        :placeholder="t('search_hint')"
        @submit="run"
      />

      <KaiProgress v-if="status === 'loading'" :label="t('searching')" />

      <p v-else-if="status === 'error'" class="kai-text kai-text--error">
        {{ t('search_error') }}
      </p>

      <p v-else-if="status === 'empty'" class="kai-text kai-text--secondary">
        {{ t('search_empty') }}
      </p>

      <div v-else-if="status === 'done'">
        <div v-for="document in documents" :key="document.url" class="kai-result">
          <span>{{ document.title }}</span>
          <span class="kai-result__url">{{ document.url }}</span>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';

import KaiHeader from '../components/KaiHeader.vue';
import KaiInput from '../components/KaiInput.vue';
import KaiProgress from '../components/KaiProgress.vue';
import { t } from '../kaios/l10n.js';
import { setBaseSoftkeys } from '../kaios/nav.js';
import { pop } from '../kaios/views.js';
import { requestJSON } from '../kaios/xhr.js';

// Integration point: replace this with the Solar Network API. Whatever you
// point it at, the request goes through `requestJSON` (systemXHR), so it keeps
// working when the server sends no CORS headers — which is the whole reason the
// app is a *privileged* package. This demo endpoint is a CORS-enabled public
// API so the screen also works in the desktop dev server.
const SEARCH_ENDPOINT = 'https://api.github.com/search/repositories';
const MAX_RESULTS = 15;

const term = ref('');
const status = ref('idle');
const documents = ref([]);

async function run() {
  const query = term.value.trim();
  if (!query) return;

  status.value = 'loading';

  try {
    const url = SEARCH_ENDPOINT + '?per_page=' + MAX_RESULTS + '&q=' + encodeURIComponent(query);

    const payload = await requestJSON(url);
    const found = payload && payload.items ? payload.items : [];

    documents.value = found.slice(0, MAX_RESULTS).map((repository) => ({
      title: repository.full_name,
      url: repository.html_url,
    }));
    status.value = documents.value.length ? 'done' : 'empty';
  } catch (error) {
    status.value = 'error';
  }
}

onMounted(() => {
  setBaseSoftkeys(() => ({
    left: { label: t('action_back'), onPress: pop },
    center: { label: t('action_search') },
  }));
});
</script>
