<template>
  <div class="kai-view">
    <KaiHeader :title="t('post_title')" />

    <main class="kai-content kai-content--roomy">
      <!--
        Attachments sit above the post body, flush against it: the picture is the
        post, the text is what it says. They are also outside the selectable body,
        so the D-pad scrolls the text, not the picture.
      -->
      <div v-if="post && post.attachments.length" class="kai-post-extras">
        <KaiAttachmentList :attachments="post.attachments" />
      </div>

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
        <KaiSpinner v-if="postStatus === 'loading'" :label="t('post_loading')" />

        <p v-else-if="postStatus === 'not-found'" class="kai-text kai-text--error">
          {{ t('post_not_found') }}
        </p>

        <p v-else-if="postStatus === 'error'" class="kai-text kai-text--error">
          {{ t('error_post_failed') }}
        </p>

        <template v-if="post">
          <KaiPostQuote v-if="quote" :quote="quote" :label-key="quoteLabelKey" rich />

          <p v-if="post.title" class="kai-post__title">{{ post.title }}</p>

          <div class="kai-md" v-html="rendered"></div>

          <span class="kai-post__author">{{ post.author.display }}</span>

          <span class="kai-post__meta">
            <span v-if="handle" class="kai-post__handle">@{{ handle }}</span>
            <span v-if="time" class="kai-post__time">{{ time }}</span>
            <span v-if="kind">{{ t(kind) }}</span>
            <span v-if="post.editedAt" class="kai-post__time">{{ t('post_edited') }}</span>
            <span v-if="visibility" class="kai-post__visibility">{{ t(visibility) }}</span>
            <span v-if="post.isTruncated" class="kai-post__time">{{ t('post_truncated') }}</span>
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

        <KaiSpinner v-if="repliesLoading" />

        <template v-else>
          <p v-if="repliesStatus === 'error'" class="kai-text kai-text--error">
            {{ t('error_load_failed') }}
          </p>

          <p v-if="repliesStatus === 'ready' && !replies.length" class="kai-text kai-text--secondary">
            {{ t('post_no_replies') }}
          </p>

          <KaiList class="kai-list--flat">
            <KaiPostRow
              v-for="reply in replies"
              :key="reply.id"
              :post="reply"
              @select="push('post', { id: reply.id })"
            />

            <KaiListItem v-if="repliesStatus === 'error'" :primary="t('error_retry')" @select="retryReplies" />
          </KaiList>

          <KaiPager :page="repliesPage" :pages="repliesPages" @go="loadReplies" />
        </template>
      </template>
    </main>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { bodyHtml } from '../content/markdown.js';
import { formatRelativeTime, postKindKey, visibilityKey } from '../api/models.js';
import { getPost, listReplies } from '../api/solian.js';
import KaiAttachmentList from '../components/KaiAttachmentList.vue';
import KaiHeader from '../components/KaiHeader.vue';
import KaiList from '../components/KaiList.vue';
import KaiListItem from '../components/KaiListItem.vue';
import KaiPager from '../components/KaiPager.vue';
import KaiPostQuote from '../components/KaiPostQuote.vue';
import KaiPostRow from '../components/KaiPostRow.vue';
import KaiSpinner from '../components/KaiSpinner.vue';
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
/** 1-based. The API paginates by offset, so a page is `(page - 1) * TAKE`. */
const repliesPage = ref(1);
/** The page being fetched: a failure is retried at this one, not at `repliesPage`. */
const repliesRequested = ref(1);
/** 'loading' | 'ready' | 'error' */
const repliesStatus = ref('loading');

const repliesLoading = computed(() => repliesStatus.value === 'loading');
const repliesPages = computed(() =>
  repliesTotal.value > 0 ? Math.ceil(repliesTotal.value / TAKE) : 1,
);

const isBodySelected = computed(() => uid.value !== 0 && nav.current === uid.value);

const rendered = computed(() => (post.value ? bodyHtml(post.value) : ''));

/**
 * A body image that cannot be fetched must not leave a broken frame where the
 * picture should be: it is swapped for the same `[image]` marker an off-device
 * image gets. `v-html` hands Vue no hook for the nodes it inserted, so the
 * listener goes on the element itself.
 */
function guardPhotos(root) {
  if (!root) return;

  const images = root.querySelectorAll('img.kai-md__photo');
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    image.addEventListener('error', () => {
      const marker = document.createElement('span');
      marker.className = 'kai-md__image';
      marker.textContent = '[image]';
      if (image.parentNode) image.parentNode.replaceChild(marker, image);
    });
  }
}

// `flush: 'post'` so the nodes exist by the time they are guarded.
watch(rendered, () => guardPhotos(body.value), { flush: 'post' });

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

const kind = computed(() => (post.value ? postKindKey(post.value.kind) : null));

const quote = computed(() =>
  post.value ? post.value.forwardedFrom || post.value.repliedTo : null,
);

const quoteLabelKey = computed(() =>
  post.value && post.value.forwardedFrom ? 'post_forwarded_from' : 'post_replied_to',
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

async function loadReplies(target) {
  repliesRequested.value = target;
  repliesStatus.value = 'loading';

  try {
    const result = await listReplies(props.params.id, { take: TAKE, offset: (target - 1) * TAKE });
    replies.value = result.posts;
    repliesTotal.value = result.total;
    repliesPage.value = target;
    repliesStatus.value = 'ready';
  } catch (error) {
    // The page already on screen stays; only the flip failed.
    repliesStatus.value = 'error';
  }
}

function retryReplies() {
  loadReplies(repliesRequested.value);
}

/** Both loaders run at once: neither needs the other's result. */
function reload() {
  loadPost();
  loadReplies(1);
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
