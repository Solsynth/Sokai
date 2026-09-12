import { ref } from 'vue';
import { defineStore } from 'pinia';

import { type Post } from '~/src/api/models.js';
import { listPosts } from '~/src/api/solian.js';
import { type AccountPhase, useAccountStore } from '~/src/stores/account.js';

/**
 * The Explore timeline's state, kept across navigation so Back restores the
 * feed instead of refetching it: the loaded page, the selection that anchors
 * the scroll, and a `stale` flag that says a write changed the timeline since
 * the last load (a post went out, a reaction landed), so the next visit
 * refetches. Only the top of the view stack is mounted, so a view-local copy
 * would be destroyed with the feed — the same reason the compose store exists.
 */

/** The API caps `take` at 100; 20 rows is already several screens on a handset. */
export const FEED_TAKE = 20;

export const useFeedStore = defineStore('feed', () => {
  const posts = ref<Post[]>([]);
  const total = ref(0);
  /** 1-based. The API paginates by offset, so a page is `(page - 1) * TAKE`. */
  const page = ref(1);
  /** The page being fetched: a failure is retried at this one, not at `page`. */
  const requested = ref(1);
  /** 'loading' | 'ready' | 'error' */
  const status = ref<'loading' | 'ready' | 'error'>('loading');
  /** The account phase the loaded feed was fetched under, so a sign-in or
   *  sign-out makes the next visit fetch the right user's feed. */
  const loadedPhase = ref<AccountPhase | ''>('');
  /** The highlighted row's post id — the scroll anchor on a restored visit. */
  const selectedId = ref('');
  /** A write since the last load: the next visit must refetch. */
  const stale = ref(true);

  async function load(target: number): Promise<void> {
    requested.value = target;
    status.value = 'loading';
    selectedId.value = '';
    loadedPhase.value = useAccountStore().phase;

    try {
      const result = await listPosts({ take: FEED_TAKE, offset: (target - 1) * FEED_TAKE });
      posts.value = result.posts;
      total.value = result.total;
      page.value = target;
      status.value = 'ready';
      stale.value = false;
    } catch (error) {
      // The page already on screen stays; only the flip failed.
      status.value = 'error';
    }
  }

  /** The timeline changed under a write; the next visit must refetch. */
  function markStale(): void {
    stale.value = true;
  }

  return {
    posts,
    total,
    page,
    requested,
    status,
    loadedPhase,
    selectedId,
    stale,
    load,
    markStale,
  };
});
