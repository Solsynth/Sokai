<template>
  <div class="kai-view">
    <KaiHeader :title="t('nav_explore')" />

    <main class="kai-content">
      <KaiSpinner v-if="loading" />

      <template v-else>
        <p v-if="status === 'error'" class="kai-text kai-text--error">
          {{ t('error_load_failed') }}
        </p>

        <!-- The searchbar: a row that reads as a field, pushing the Search
             screen. The pager and the posts follow, so the top of the feed is
             the sketched layout: searchbar over the page controls. -->
        <KaiListItem class="kai-searchbar" :primary="t('search_hint')" @select="push('search')" />

        <KaiPager v-if="pages > 1" :page="page" :pages="pages" @go="load" />

        <KaiList class="kai-list--flat">
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

<script setup>
import { computed, onMounted, ref } from 'vue';

import { listPosts } from '../api/solian.js';
import KaiHeader from '../components/KaiHeader.vue';
import KaiList from '../components/KaiList.vue';
import KaiListItem from '../components/KaiListItem.vue';
import KaiPager from '../components/KaiPager.vue';
import KaiPostRow from '../components/KaiPostRow.vue';
import KaiSpinner from '../components/KaiSpinner.vue';
import { t } from '../kaios/l10n.js';
import { setBaseSoftkeys } from '../kaios/nav.js';
import { pop, push } from '../kaios/views.js';

// Every screen is mounted with its stack entry's parameters; Explore takes none.
defineProps({
  params: { type: Object, default: () => ({}) },
});

// The API caps `take` at 100; 20 rows is already several screens on a 240x320
// handset.
const TAKE = 20;

const posts = ref([]);
const total = ref(0);
/** 1-based. The API paginates by offset, so a page is `(page - 1) * TAKE`. */
const page = ref(1);
/** The page being fetched: a failure is retried at this one, not at `page`. */
const requested = ref(1);
/** 'loading' | 'ready' | 'error' */
const status = ref('loading');

const loading = computed(() => status.value === 'loading');
const pages = computed(() => (total.value > 0 ? Math.ceil(total.value / TAKE) : 1));

async function load(target) {
  requested.value = target;
  status.value = 'loading';

  try {
    const result = await listPosts({ take: TAKE, offset: (target - 1) * TAKE });
    posts.value = result.posts;
    total.value = result.total;
    page.value = target;
    status.value = 'ready';
  } catch (error) {
    // The page already on screen stays; only the flip failed.
    status.value = 'error';
  }
}

function retry() {
  load(requested.value);
}

onMounted(() => {
  setBaseSoftkeys(() => ({
    // Explore is reached from the dashboard, so Back is the way up; About is a
    // dashboard entry now, not a softkey here.
    left: { label: t('action_back'), onPress: pop },
    center: { label: t('action_open') },
    // The right key is held for the write actions that follow the read path
    // (reply, reactions); page flips live in the pager rows above the feed.
    right: { label: '' },
  }));

  load(1);
});
</script>
