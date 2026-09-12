<template>
  <div class="kai-view">
    <KaiHeader :title="t('nav_search')" />

    <main class="kai-content">
      <!-- The wide box: the search field. Enter commits the platform's text
           entry and runs the search; the field takes the initial highlight, so
           the keyboard is up the moment the screen mounts. -->
      <KaiInput v-model="query" :label="t('search_label')" :placeholder="t('search_hint')" @submit="onSubmit" />

      <KaiSpinner v-if="loading" />

      <template v-else>
        <p v-if="status === 'error'" class="kai-text kai-text--error">
          {{ t('search_error') }}
        </p>

        <p v-else-if="status === 'ready' && posts.length === 0" class="kai-text kai-text--secondary">
          {{ t('search_empty', { q: submitted }) }}
        </p>

        <!-- The page controls sit above the results, like the feed's. -->
        <KaiPager v-if="pages > 1" :page="page" :pages="pages" @go="search" />

        <KaiList v-if="posts.length > 0 || status === 'error'" class="kai-list--flat">
          <KaiPostRow
            v-for="post in posts"
            :key="post.id"
            :post="post"
            @select="push('post', { id: post.id })"
          />

          <KaiListItem v-if="status === 'error'" :primary="t('error_retry')" @select="retry" />
        </KaiList>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { listPosts } from '~/src/api/solian.js';
import type { Post } from '~/src/api/models.js';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiInput from '~/src/components/KaiInput.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import KaiPager from '~/src/components/KaiPager.vue';
import KaiPostRow from '~/src/components/KaiPostRow.vue';
import KaiSpinner from '~/src/components/KaiSpinner.vue';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { push } from '~/src/kaios/views.js';

// Every screen is mounted with its stack entry's parameters; Search takes none.
withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({}) });

// The API caps `take` at 100; 20 rows is already several screens on a 240x320
// handset.
const TAKE = 20;

const query = ref('');
/** The term the current results came from; `query` is what is being typed. */
const submitted = ref('');
const posts = ref<Post[]>([]);
const total = ref(0);
const page = ref(1);
const requested = ref(1);
/** 'idle' (nothing searched yet) | 'loading' | 'ready' | 'error' */
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');

const loading = computed(() => status.value === 'loading');
const pages = computed(() => (total.value > 0 ? Math.ceil(total.value / TAKE) : 1));

async function search(target: number): Promise<void> {
  requested.value = target;
  status.value = 'loading';

  try {
    const result = await listPosts({ take: TAKE, offset: (target - 1) * TAKE, query: submitted.value });
    posts.value = result.posts;
    total.value = result.total;
    page.value = target;
    status.value = 'ready';
  } catch (error) {
    status.value = 'error';
  }
}

function retry(): void {
  search(requested.value);
}

/** Enter commits the field: run the search and leave the platform's text mode. */
function onSubmit(): void {
  const term = query.value.trim();
  if (!term) return;
  submitted.value = term;
  page.value = 1;
  search(1);

  const active = document.activeElement as HTMLElement | null;
  if (active) active.blur();
}

onMounted(() => {
  setBaseSoftkeys(() => ({
    // The hardware Back key leaves the search (the design guide's rule).
    center: { label: t('action_open') },
    // The right key is held for the write actions that follow the read path.
    right: { label: '' },
  }));
});
</script>
