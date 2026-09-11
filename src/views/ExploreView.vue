<template>
  <div class="kai-view">
    <KaiHeader :title="t('nav_explore')" />

    <main class="kai-content">
      <KaiProgress v-if="status === 'loading' && !posts.length" :label="t('post_loading')" />

      <p v-if="status === 'error'" class="kai-text kai-text--error">{{ t('error_load_failed') }}</p>

      <KaiList>
        <KaiPostRow
          v-for="post in posts"
          :key="post.id"
          :post="post"
          @select="push('post', { id: post.id })"
        />

        <KaiListItem v-if="canLoadMore" :primary="t('action_load_more')" @select="loadMore" />
        <KaiListItem v-if="status === 'error'" :primary="t('error_retry')" @select="retry" />
      </KaiList>

      <KaiProgress v-if="status === 'loading' && posts.length" :label="t('post_loading')" />
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';

import { listPosts } from '../api/solian.js';
import KaiHeader from '../components/KaiHeader.vue';
import KaiList from '../components/KaiList.vue';
import KaiListItem from '../components/KaiListItem.vue';
import KaiPostRow from '../components/KaiPostRow.vue';
import KaiProgress from '../components/KaiProgress.vue';
import { t } from '../kaios/l10n.js';
import { setBaseSoftkeys } from '../kaios/nav.js';
import { push } from '../kaios/views.js';

// Every screen is mounted with its stack entry's parameters; Explore takes none.
defineProps({
  params: { type: Object, default: () => ({}) },
});

// The API caps `take` at 100; 20 rows is already several screens on a 240x320
// handset.
const TAKE = 20;

const posts = ref([]);
const total = ref(0);
/** Offset of the page being requested — a failed load is retried at this same offset. */
const offset = ref(0);
/** 'loading' | 'ready' | 'error' */
const status = ref('loading');

const canLoadMore = computed(() => status.value === 'ready' && posts.value.length < total.value);

async function load(next) {
  offset.value = next;
  status.value = 'loading';

  try {
    const page = await listPosts({ take: TAKE, offset: next });
    posts.value = next === 0 ? page.posts : posts.value.concat(page.posts);
    total.value = page.total;
    status.value = 'ready';
  } catch (error) {
    status.value = 'error';
  }
}

function loadMore() {
  load(offset.value + TAKE);
}

function retry() {
  load(offset.value);
}

onMounted(() => {
  setBaseSoftkeys(() => ({
    center: { label: t('action_open') },
    // The feed is the top level, so About lives on the right softkey.
    right: { label: t('action_about'), onPress: () => push('about') },
  }));

  load(0);
});
</script>
