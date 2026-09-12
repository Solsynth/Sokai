<template>
  <div class="kai-view">
    <KaiHeader :title="t('nav_explore')" />

    <main class="kai-content">
      <KaiSpinner v-if="loading" />

      <template v-else>
        <p v-if="status === 'error'" class="kai-text kai-text--error">
          {{ t('error_load_failed') }}
        </p>

        <!-- The read entry (search) leads the feed; the write entry (compose)
             lives on the left softkey, so the feed keeps its rows. The pager
             and the posts follow. -->
        <KaiListItem class="kai-searchbar" :primary="t('search_hint')" @select="push('search')" />

        <KaiPager v-if="pages > 1" :page="page" :pages="pages" @go="feed.load" />

        <KaiList class="kai-list--flat">
          <KaiPostRow
            v-for="post in posts"
            :key="post.id"
            :post="post"
            :initial="feed.selectedId === '' || post.id === feed.selectedId"
            @select="push('post', { id: post.id })"
            @selected="feed.selectedId = $event"
          />

          <KaiListItem v-if="status === 'error'" :primary="t('error_retry')" @select="retry" />
        </KaiList>

        <p v-if="deleteErrorKey" class="kai-text kai-text--error">{{ t(deleteErrorKey) }}</p>
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
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';

import { deletePost } from '~/src/api/solian.js';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import KaiOptionMenu, { type Option } from '~/src/components/KaiOptionMenu.vue';
import KaiPager from '~/src/components/KaiPager.vue';
import KaiPostRow from '~/src/components/KaiPostRow.vue';
import KaiSpinner from '~/src/components/KaiSpinner.vue';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { push } from '~/src/kaios/views.js';
import { useAccountStore } from '~/src/stores/account.js';
import { FEED_TAKE, useFeedStore } from '~/src/stores/feed.js';

// Every screen is mounted with its stack entry's parameters; Explore takes none.
withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({}) });

const accountStore = useAccountStore();
const feed = useFeedStore();
const { posts, total, status, page } = storeToRefs(feed);

const loading = computed(() => status.value === 'loading');
const pages = computed(() => (total.value > 0 ? Math.ceil(total.value / FEED_TAKE) : 1));

/** The highlighted row's post id — the scroll anchor for a restored visit. */
const selectedPost = computed(
  () => posts.value.find((post) => post.id === feed.selectedId) ?? null,
);

/** The row's actions live in an option sheet behind the right softkey. */
const menuOpen = ref(false);
const confirmDelete = ref(false);
const deleteErrorKey = ref('');

function openMenu(): void {
  confirmDelete.value = false;
  menuOpen.value = true;
}

/** The write path: the left softkey pushes the composer. */
function openCompose(): void {
  push('compose');
}

/** A row under the account's own publisher offers edit and delete. */
const isOwned = computed(() => {
  const account = accountStore.account;
  const post = selectedPost.value;
  return Boolean(account && post && post.author.name === account.name);
});

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
  }
}

/** The picker takes the row's reactions in its params; the feed reloads on return. */
function openReactions(): void {
  const post = selectedPost.value;
  if (!post) return;
  push('reactions', {
    id: post.id,
    reactions: JSON.stringify(post.reactions),
    made: JSON.stringify(post.reactionsMade),
  });
}

function openReply(): void {
  const post = selectedPost.value;
  if (!post) return;
  push('compose', { mode: 'reply', id: post.id, author: post.author.display });
}

function openForward(): void {
  const post = selectedPost.value;
  if (!post) return;
  push('compose', { mode: 'forward', id: post.id, forwarded: JSON.stringify(post) });
}

function openEdit(): void {
  const post = selectedPost.value;
  if (!post) return;
  push('compose', {
    mode: 'edit',
    id: post.id,
    content: post.content,
    attachments: JSON.stringify(
      post.attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        size: attachment.size,
        kind: attachment.kind,
      })),
    ),
    publisher: post.author.name,
  });
}

/** Deletes the highlighted post on the second press; the row drops in place. */
async function onDelete(): Promise<void> {
  const post = selectedPost.value;
  if (!post || !isOwned.value) return;
  if (!confirmDelete.value) {
    confirmDelete.value = true;
    return;
  }
  confirmDelete.value = false;
  deleteErrorKey.value = '';
  try {
    await deletePost(post.id);
    const index = feed.posts.findIndex((item) => item.id === post.id);
    if (index !== -1) feed.posts.splice(index, 1);
    if (feed.total > 0) feed.total -= 1;
    feed.markStale();
    menuOpen.value = false;
  } catch (error) {
    deleteErrorKey.value = 'post_delete_error';
    menuOpen.value = false;
  }
}

function retry(): void {
  feed.load(feed.requested);
}

onMounted(() => {
  setBaseSoftkeys(() => ({
    // The hardware Back key goes up to the dashboard (the design guide's
    // Back/Clear rule); About is a dashboard entry, not a softkey here. The
    // write path is the left key — compose — and the highlighted row's
    // actions sit in the option sheet on the right. The sheet carries its own
    // title and softkey bar, so the screen's bar reads empty while it is up.
    left: menuOpen.value ? { label: '' } : { label: t('nav_compose'), onPress: openCompose },
    center: { label: menuOpen.value ? '' : t('action_open') },
    right: menuOpen.value
      ? { label: '' }
      : selectedPost.value
        ? { label: t('action_options'), onPress: openMenu }
        : { label: '' },
  }));

  // A return keeps the loaded page, the selection and the scroll; only a
  // write (a post went out, a reaction landed) or an account change makes the
  // next visit fetch again.
  if (feed.stale || feed.loadedPhase !== accountStore.phase) {
    void feed.load(1);
  }
});
</script>
