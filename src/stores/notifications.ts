import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';

import type { AppNotification } from '~/src/api/models.js';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '~/src/api/solian.js';
import { useAccountStore, type AccountPhase } from '~/src/stores/account.js';

/**
 * The notification inbox's state, kept across navigation the way the feed's is:
 * only the top of the view stack is mounted, so a view-local copy would lose
 * the loaded page and the row the scroll is anchored to on the way back.
 *
 * The inbox is the session's own, so `loadedPhase` is what decides a fetch: a
 * sign-in or sign-out changes the phase and the next visit loads under it,
 * while a plain return keeps the page that is already loaded. The screen's left
 * softkey is the explicit reload for whatever arrived since.
 *
 * Read state lives on the rows themselves (`viewedAt`), so the screen shows the
 * server's answer without refetching anything.
 */

/** The API caps `take` at 100; 20 rows is several screens on a handset. */
export const NOTIFICATION_TAKE = 20;

export type NotificationStatus = 'loading' | 'ready' | 'error';

export const useNotificationsStore = defineStore('notifications', () => {
  const accountStore = useAccountStore();

  const items = ref<AppNotification[]>([]);
  const total = ref(0);
  /** 1-based. The API paginates by offset, so a page is `(page - 1) * TAKE`. */
  const page = ref(1);
  /** The page being fetched: a failure is retried at this one, not at `page`. */
  const requested = ref(1);
  const status = ref<NotificationStatus>('loading');
  /** The phase the loaded page was fetched under — and `''` for "nothing loaded
   *  yet", which is what makes the first visit fetch. */
  const loadedPhase = ref<AccountPhase | ''>('');
  /** The highlighted row's notification id — the scroll anchor on a return. */
  const selectedId = ref('');

  /** Unread rows on the loaded page: what the right softkey's bulk read is for. */
  const unreadCount = computed(() => items.value.filter((item) => !item.viewedAt).length);

  /**
   * Loads one page. A row's dot is the wire's own `viewed_at`, so a page the
   * account has already been through comes back read.
   */
  async function load(target: number): Promise<void> {
    requested.value = target;
    status.value = 'loading';
    selectedId.value = '';
    loadedPhase.value = accountStore.phase;

    try {
      const result = await listNotifications({
        take: NOTIFICATION_TAKE,
        offset: (target - 1) * NOTIFICATION_TAKE,
      });
      items.value = result.notifications;
      total.value = result.total;
      page.value = target;
      status.value = 'ready';
    } catch (error) {
      // The page already on screen stays; only the flip failed.
      status.value = 'error';
    }
  }

  /**
   * Marks one row read. The dot clears as the row opens — the tap's real work
   * is the screen it opens, which is not worth waiting on a request for — and
   * comes back if the server refuses, so the screen never claims a receipt the
   * server did not take.
   */
  async function markRead(id: string): Promise<void> {
    const item = items.value.find((entry) => entry.id === id);
    if (!item || item.viewedAt) return;

    item.viewedAt = new Date().toISOString();

    try {
      await markNotificationRead(id);
    } catch (error) {
      item.viewedAt = '';
    }
  }

  /** The bulk read. `false` when the server refused, so the screen can say so. */
  async function markAllRead(): Promise<boolean> {
    try {
      await markAllNotificationsRead();
    } catch (error) {
      return false;
    }

    // The server took a receipt for the whole inbox, loaded pages and not, so
    // the rows on screen only need their dots cleared.
    const stamp = new Date().toISOString();
    for (let index = 0; index < items.value.length; index += 1) {
      if (!items.value[index].viewedAt) items.value[index].viewedAt = stamp;
    }
    return true;
  }

  /** Drops the account's inbox — the rows are private, so sign-out wipes them. */
  function reset(): void {
    items.value = [];
    total.value = 0;
    page.value = 1;
    requested.value = 1;
    status.value = 'loading';
    loadedPhase.value = '';
    selectedId.value = '';
  }

  // Watched here rather than in the account store, to keep the wipe with the
  // data it clears (the chat cache's rule).
  watch(
    () => accountStore.phase,
    (next, previous) => {
      if (previous === 'signed-in' && next !== 'signed-in') reset();
    },
  );

  return {
    items,
    total,
    page,
    requested,
    status,
    loadedPhase,
    selectedId,
    unreadCount,
    load,
    markRead,
    markAllRead,
  };
});
