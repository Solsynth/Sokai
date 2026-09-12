<template>
  <div class="kai-view">
    <KaiHeader :title="t('post_title')" />

    <main class="kai-content kai-content--roomy">
      <!--
        The first attachment is the post: the strip sits above the body, flush
        against it, and is selectable — Enter opens the lightbox, which holds
        the whole set (LEFT/RIGHT to switch, zoom for images, playback for
        videos). The rest are counted under it.
      -->
      <div
        v-if="post && post.attachments.length"
        ref="extras"
        tabindex="-1"
        nav-selectable="true"
        :nav-selected="isExtrasSelected ? 'true' : 'false'"
        class="kai-post-extras"
        @click="openLightbox"
      >
        <KaiAttachmentList :attachments="post.attachments" :limit="1" :show-captions="false" />
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

          <span class="kai-post__author">
            <KaiAvatar :file="post.author.picture" size="md" />
            <span>{{ post.author.display }}</span>
          </span>

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
            <span v-if="post.counts.reactions && !chips.length" class="kai-post__count">
              {{ t('post_count_reactions', { n: post.counts.reactions }) }}
            </span>
            <span v-for="tag in post.tags" :key="tag" class="kai-tag">{{ tag }}</span>
          </span>

          <KaiReactionChips :reactions="post.reactions" />
        </template>
      </div>

      <template v-if="post">
        <p v-if="deleteErrorKey" class="kai-text kai-text--error">{{ t(deleteErrorKey) }}</p>

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

    <KaiOptionMenu
      v-if="menuOpen"
      :title="t('post_options')"
      :options="menuOptions"
      @select="onMenuSelect"
      @cancel="menuOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { bodyHtml } from '~/src/content/markdown.js';
import { reactionChips } from '~/src/content/reactions.js';
import { formatRelativeTime, postKindKey, visibilityKey, type Post } from '~/src/api/models.js';
import { getPost, listReplies, deletePost } from '~/src/api/solian.js';
import KaiAttachmentList from '~/src/components/KaiAttachmentList.vue';
import KaiAvatar from '~/src/components/KaiAvatar.vue';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import KaiOptionMenu, { type Option } from '~/src/components/KaiOptionMenu.vue';
import KaiPager from '~/src/components/KaiPager.vue';
import KaiPostQuote from '~/src/components/KaiPostQuote.vue';
import KaiPostRow from '~/src/components/KaiPostRow.vue';
import KaiReactionChips from '~/src/components/KaiReactionChips.vue';
import KaiSpinner from '~/src/components/KaiSpinner.vue';
import { t } from '~/src/kaios/l10n.js';
import { move, nav, registerSelectable, setBaseSoftkeys, unregisterSelectable } from '~/src/kaios/nav.js';
import { pop, push } from '~/src/kaios/views.js';
import { useAccountStore } from '~/src/stores/account.js';
import { useFeedStore } from '~/src/stores/feed.js';

const props = withDefaults(defineProps<{ params?: Record<string, string> }>(), {
  params: () => ({}),
});

const TAKE = 20;

const body = ref<HTMLElement | null>(null);
const extras = ref<HTMLElement | null>(null);
const uid = ref(0);
const extrasUid = ref(0);

const post = ref<Post | null>(null);
/** 'loading' | 'ready' | 'not-found' | 'error' */
const postStatus = ref<'loading' | 'ready' | 'not-found' | 'error'>('loading');

const replies = ref<Post[]>([]);
const repliesTotal = ref(0);
/** 1-based. The API paginates by offset, so a page is `(page - 1) * TAKE`. */
const repliesPage = ref(1);
/** The page being fetched: a failure is retried at this one, not at `repliesPage`. */
const repliesRequested = ref(1);
/** 'loading' | 'ready' | 'error' */
const repliesStatus = ref<'loading' | 'ready' | 'error'>('loading');

const repliesLoading = computed(() => repliesStatus.value === 'loading');
const repliesPages = computed(() =>
  repliesTotal.value > 0 ? Math.ceil(repliesTotal.value / TAKE) : 1,
);

const isBodySelected = computed(() => uid.value !== 0 && nav.current === uid.value);
const isExtrasSelected = computed(() => extrasUid.value !== 0 && nav.current === extrasUid.value);

/**
 * The lightbox takes the post's attachments — already in memory, no second
 * fetch — as JSON in the view params, opening on the first one.
 */
function openLightbox(): void {
  const list = post.value?.attachments;
  if (!list || !list.length) return;
  push('lightbox', { index: '0', attachments: JSON.stringify(list) });
}

/**
 * The picture is the content of a picture post, so the highlight lands on it
 * the moment the post arrives — the strip mounts after the fetch, one step
 * above the body in document order, so a single UP hands it the highlight.
 */
function registerExtras(): void {
  if (!post.value || !post.value.attachments.length || !extras.value || extrasUid.value) return;
  extrasUid.value = registerSelectable({ el: extras, onEnter: openLightbox, initial: true });
  move(-1);
}

const rendered = computed(() => (post.value ? bodyHtml(post.value) : ''));

/**
 * A body image that cannot be fetched must not leave a broken frame where the
 * picture should be: it is swapped for the same `[image]` marker an off-device
 * image gets. `v-html` hands Vue no hook for the nodes it inserted, so the
 * listener goes on the element itself.
 */
function guardPhotos(root: HTMLElement | null): void {
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
  return 'key' in relative ? t(relative.key, relative.args) : relative.text;
});

const visibility = computed(() => (post.value ? visibilityKey(post.value.visibility) : null));

const kind = computed(() => (post.value ? postKindKey(post.value.kind) : null));

/** The post's reactions with a bundled sticker; the meta count only covers the rest. */
const chips = computed(() => (post.value ? reactionChips(post.value.reactions) : []));

/** Total individual reactions, for the React row's summary line. */
const reactionTotal = computed(() => {
  if (!post.value) return 0;
  const symbols = Object.keys(post.value.reactions);
  let total = 0;
  for (let index = 0; index < symbols.length; index += 1) {
    total += post.value.reactions[symbols[index]];
  }
  return total;
});

const accountStore = useAccountStore();

/**
 * The post is the signed-in account's own when the author's publisher name is
 * the account's handle — the personal publisher. Managed publishers are not
 * matched here, so their posts never get edit/delete offered.
 */
const isOwned = computed(() => {
  const account = accountStore.account;
  return Boolean(post.value && account && post.value.author.name === account.name);
});

/** Two-step delete: the first press asks, the second acts. */
const confirmDelete = ref(false);
const deleteErrorKey = ref('');

/** The option menu over the post; it owns the D-pad while open. */
const menuOpen = ref(false);

function openMenu(): void {
  confirmDelete.value = false;
  menuOpen.value = true;
}

/** The actions an option menu can run, in the design guide's read-then-write order. */
const menuOptions = computed<Option[]>(() => {
  const options: Option[] = [
    { id: 'reply', label: t('action_reply') },
    { id: 'forward', label: t('action_forward') },
    { id: 'react', label: t('action_react') },
  ];
  if (isOwned.value) {
    options.push({ id: 'edit', label: t('post_edit') });
    options.push({ id: 'delete', label: confirmDelete.value ? t('post_delete_confirm') : t('post_delete') });
  }
  options.push({ id: 'reload', label: t('action_reload') });
  return options;
});

function onMenuSelect(id: string): void {
  if (id === 'reply') {
    menuOpen.value = false;
    openReply();
  } else if (id === 'forward') {
    menuOpen.value = false;
    openForward();
  } else if (id === 'react') {
    menuOpen.value = false;
    openReactions();
  } else if (id === 'edit') {
    menuOpen.value = false;
    openEdit();
  } else if (id === 'delete') {
    void onDelete();
  } else if (id === 'reload') {
    menuOpen.value = false;
    reload();
  }
}

/**
 * The picker takes the post's reactions and the user's own in its params —
 * already in memory, no second fetch — and the post reloads with the fresh
 * counts on return.
 */
function openReactions(): void {
  const found = post.value;
  if (!found) return;
  push('reactions', {
    id: found.id,
    reactions: JSON.stringify(found.reactions),
    made: JSON.stringify(found.reactionsMade),
  });
}

/** The reply composer anchors on the post; the feed reloads on return. */
function openReply(): void {
  const found = post.value;
  if (!found) return;
  push('compose', { mode: 'reply', id: found.id, author: found.author.display });
}

/** A forward quotes the post: the composer renders it, the wire gets its id. */
function openForward(): void {
  const found = post.value;
  if (!found) return;
  push('compose', { mode: 'forward', id: found.id, forwarded: JSON.stringify(found) });
}

/**
 * The edit composer is seeded with the post's content, its already-uploaded
 * attachment ids and its publisher; the post reloads with the result on return.
 */
function openEdit(): void {
  const found = post.value;
  if (!found) return;
  push('compose', {
    mode: 'edit',
    id: found.id,
    content: found.content,
    attachments: JSON.stringify(
      found.attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        size: attachment.size,
        kind: attachment.kind,
      })),
    ),
    publisher: found.author.name,
  });
}

/** Deletes the post on the second press; a failure keeps the post on screen. */
async function onDelete(): Promise<void> {
  const found = post.value;
  if (!found || !isOwned.value) return;
  if (!confirmDelete.value) {
    confirmDelete.value = true;
    return;
  }
  confirmDelete.value = false;
  deleteErrorKey.value = '';
  try {
    await deletePost(found.id);
    useFeedStore().markStale();
    menuOpen.value = false;
    pop();
  } catch (error) {
    deleteErrorKey.value = 'post_delete_error';
    menuOpen.value = false;
  }
}

const quote = computed(() =>
  post.value ? post.value.forwardedFrom || post.value.repliedTo : null,
);

const quoteLabelKey = computed(() =>
  post.value && post.value.forwardedFrom ? 'post_forwarded_from' : 'post_replied_to',
);

async function loadPost(): Promise<void> {
  post.value = null;
  postStatus.value = 'loading';

  try {
    const found = await getPost(props.params.id);
    post.value = found;
    postStatus.value = found ? 'ready' : 'not-found';
  } catch (error) {
    postStatus.value = (error as { status?: number }).status === 404 ? 'not-found' : 'error';
  }
}

async function loadReplies(target: number): Promise<void> {
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

function retryReplies(): void {
  loadReplies(repliesRequested.value);
}

/** Both loaders run at once: neither needs the other's result. */
function reload(): void {
  loadPost();
  loadReplies(1);
}

// Pushing 'post' onto the stack reuses this component instance and only swaps
// `params`, so the reload has to be driven by the id rather than by mount.
watch(() => props.params.id, reload, { immediate: true });

// The attachment strip arrives with the post, so its selectable registers when
// the post does, not at mount.
watch([post, postStatus], () => {
  if (post.value) void nextTick(registerExtras);
});

onMounted(() => {
  uid.value = registerSelectable({
    el: body,
    // A post longer than the screen gets the arrow keys until it is scrolled to
    // the end; the highlight only then moves on to a reply. `initial` keeps the
    // highlight on the body when the screen mounts, not on the first reply.
    scrollFirst: true,
    initial: true,
  });

  setBaseSoftkeys(() => ({
    // The hardware Back key goes up (the design guide's Back/Clear rule).
    // The option menu carries its own title bar and softkey bar, so the
    // screen's bar reads empty while it is up — the sheet's own SELECT/CANCEL
    // are the live keys, and the menu intercepts every press itself.
    left: menuOpen.value ? { label: '' } : undefined,
    center: { label: menuOpen.value ? '' : t('action_open') },
    right: menuOpen.value
      ? { label: '' }
      : { label: t('action_options'), onPress: openMenu },
  }));
});

onBeforeUnmount(() => {
  unregisterSelectable(uid.value);
  unregisterSelectable(extrasUid.value);
});
</script>
