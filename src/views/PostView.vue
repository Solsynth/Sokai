<template>
  <div class="kai-view">
    <KaiHeader :title="t('post_title')" />

    <main class="kai-content">
      <!--
        The body container is always rendered, so it is registered as the first
        selectable entry on mount (see `onMounted`): focus starts at the top of
        the post and the D-pad scrolls the body before it moves on to a reply.
      -->
      <div
        ref="body"
        tabindex="-1"
        nav-selectable="true"
        :nav-selected="isBodySelected ? 'true' : 'false'"
        class="kai-post"
      >
        <KaiProgress v-if="postStatus === 'loading'" :label="t('post_loading')" />

        <p v-else-if="postStatus === 'not-found'" class="kai-text kai-text--error">
          {{ t('post_not_found') }}
        </p>

        <p v-else-if="postStatus === 'error'" class="kai-text kai-text--error">
          {{ t('error_post_failed') }}
        </p>

        <template v-if="post">
          <p v-if="post.title" class="kai-post__title">{{ post.title }}</p>

          <div class="kai-md" v-html="rendered"></div>

          <span class="kai-post__author">{{ post.author.display }}</span>

          <span class="kai-post__meta">
            <span v-if="handle" class="kai-post__handle">@{{ handle }}</span>
            <span v-if="time" class="kai-post__time">{{ time }}</span>
            <span v-if="post.editedAt" class="kai-post__time">{{ t('post_edited') }}</span>
            <span v-if="visibility" class="kai-post__visibility">{{ t(visibility) }}</span>
            <span v-if="post.counts.replies" class="kai-post__count">
              {{ t('post_count_replies', { n: post.counts.replies }) }}
            </span>
            <span v-if="post.counts.boosts" class="kai-post__count">
              {{ t('post_count_boosts', { n: post.counts.boosts }) }}
            </span>
            <span v-if="post.counts.reactions" class="kai-post__count">
              {{ t('post_count_reactions', { n: post.counts.reactions }) }}
            </span>
            <span v-for="tag in post.tags" :key="tag" class="kai-tag">{{ tag }}</span>
          </span>
        </template>
      </div>

      <template v-if="post">
        <p class="kai-separator">{{ t('post_replies') }}</p>

        <KaiProgress v-if="repliesStatus === 'loading'" :label="t('post_loading')" />

        <p v-else-if="repliesStatus === 'error'" class="kai-text kai-text--error">
          {{ t('error_load_failed') }}
        </p>

        <p v-if="repliesStatus === 'ready' && !replies.length" class="kai-text kai-text--secondary">
          {{ t('post_no_replies') }}
        </p>

        <KaiList>
          <KaiPostRow
            v-for="reply in replies"
            :key="reply.id"
            :post="reply"
            @select="push('post', { id: reply.id })"
          />

          <KaiListItem
            v-if="canLoadMoreReplies"
            :primary="t('action_load_more')"
            @select="loadMoreReplies"
          />
        </KaiList>
      </template>
    </main>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { bodyHtml } from '../content/markdown.js';
import { formatRelativeTime, visibilityKey } from '../api/models.js';
import { getPost, listReplies } from '../api/solian.js';
import KaiHeader from '../components/KaiHeader.vue';
import KaiList from '../components/KaiList.vue';
import KaiListItem from '../components/KaiListItem.vue';
import KaiPostRow from '../components/KaiPostRow.vue';
import KaiProgress from '../components/KaiProgress.vue';
import { t } from '../kaios/l10n.js';
import { nav, registerSelectable, setBaseSoftkeys, unregisterSelectable } from '../kaios/nav.js';
import { pop, push } from '../kaios/views.js';

const props = defineProps({
  params: { type: Object, default: () => ({}) },
});

const TAKE = 20;

const body = ref(null);
const uid = ref(0);

const post = ref(null);
/** 'loading' | 'ready' | 'not-found' | 'error' */
const postStatus = ref('loading');

const replies = ref([]);
const repliesTotal = ref(0);
/** Offset of the page being requested — reloaded on demand, not retried inline. */
const repliesOffset = ref(0);
/** 'loading' | 'ready' | 'error' */
const repliesStatus = ref('loading');

const isBodySelected = computed(() => uid.value !== 0 && nav.current === uid.value);

const rendered = computed(() => (post.value ? bodyHtml(post.value) : ''));

const handle = computed(() =>
  post.value && post.value.author.name && post.value.author.name !== post.value.author.display
    ? post.value.author.name
    : '',
);

const time = computed(() => {
  if (!post.value) return '';
  const relative = formatRelativeTime(post.value.publishedAt);
  if (!relative) return '';
  return relative.key ? t(relative.key, relative.args) : relative.text;
});

const visibility = computed(() => (post.value ? visibilityKey(post.value.visibility) : null));

const canLoadMoreReplies = computed(
  () => repliesStatus.value === 'ready' && replies.value.length < repliesTotal.value,
);

async function loadPost() {
  post.value = null;
  postStatus.value = 'loading';

  try {
    const found = await getPost(props.params.id);
    post.value = found;
    postStatus.value = found ? 'ready' : 'not-found';
  } catch (error) {
    postStatus.value = error && error.status === 404 ? 'not-found' : 'error';
  }
}

async function loadReplies(next) {
  repliesOffset.value = next;
  repliesStatus.value = 'loading';

  try {
    const page = await listReplies(props.params.id, { take: TAKE, offset: next });
    replies.value = next === 0 ? page.posts : replies.value.concat(page.posts);
    repliesTotal.value = page.total;
    repliesStatus.value = 'ready';
  } catch (error) {
    repliesStatus.value = 'error';
  }
}

function loadMoreReplies() {
  loadReplies(repliesOffset.value + TAKE);
}

/** Both loaders run at once: neither needs the other's result. */
function reload() {
  replies.value = [];
  loadPost();
  loadReplies(0);
}

// Pushing 'post' onto the stack reuses this component instance and only swaps
// `params`, so the reload has to be driven by the id rather than by mount.
watch(() => props.params.id, reload, { immediate: true });

onMounted(() => {
  uid.value = registerSelectable({
    el: body,
    // A post longer than the screen gets the arrow keys until it is scrolled to
    // the end; the highlight only then moves on to a reply.
    scrollFirst: true,
  });

  setBaseSoftkeys(() => ({
    left: { label: t('action_back'), onPress: pop },
    center: { label: t('action_open') },
    right: { label: t('action_reload'), onPress: reload },
  }));
});

onBeforeUnmount(() => {
  unregisterSelectable(uid.value);
});
</script>
