<template>
  <div class="kai-view">
    <KaiHeader :title="t('nav_notifications')" />

    <main class="kai-content">
      <!-- The inbox is the session's own: signed out, explain and offer the
           sign-in screen, the arrangement every account-scoped screen uses. -->
      <template v-if="phase !== 'signed-in'">
        <p class="kai-text">{{ t('notifications_sign_in_intro') }}</p>

        <KaiList class="kai-list--flat">
          <KaiListItem :primary="t('account_sign_in')" @select="push('account')" />
        </KaiList>
      </template>

      <template v-else>
        <KaiSpinner v-if="status === 'loading' && items.length === 0" :label="t('notifications_loading')" />

        <template v-else>
          <p v-if="status === 'error'" class="kai-text kai-text--error">
            {{ t('error_load_failed') }}
          </p>

          <p v-else-if="items.length === 0" class="kai-text kai-text--secondary">
            {{ t('notifications_empty') }}
          </p>

          <p v-if="actionErrorKey" class="kai-text kai-text--error">{{ t(actionErrorKey) }}</p>

          <KaiPager v-if="pages > 1" :page="page" :pages="pages" @go="open" />

          <KaiList v-if="items.length > 0 || status === 'error'" class="kai-list--flat">
            <KaiNotificationRow
              v-for="(item, index) in items"
              :key="item.id"
              :notification="item"
              :initial="index === 0"
              @select="openItem(item)"
              @selected="notifications.selectedId = $event"
            />

            <KaiListItem v-if="status === 'error'" :primary="t('error_retry')" @select="retry" />
          </KaiList>
        </template>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';

import { postIdFromActionUri, type AppNotification } from '~/src/api/models.js';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import KaiNotificationRow from '~/src/components/KaiNotificationRow.vue';
import KaiPager from '~/src/components/KaiPager.vue';
import KaiSpinner from '~/src/components/KaiSpinner.vue';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { push } from '~/src/kaios/views.js';
import { useAccountStore } from '~/src/stores/account.js';
import { NOTIFICATION_TAKE, useNotificationsStore } from '~/src/stores/notifications.js';

// Every screen is mounted with its stack entry's parameters; the inbox takes none.
withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({}) });

const accountStore = useAccountStore();
const notifications = useNotificationsStore();
const { items, total, page, status, unreadCount } = storeToRefs(notifications);

const phase = computed(() => accountStore.phase);
const pages = computed(() => (total.value > 0 ? Math.ceil(total.value / NOTIFICATION_TAKE) : 1));

/** The row the highlight is on — the row the centre key opens. */
const selected = computed(
  () => items.value.find((item) => item.id === notifications.selectedId) || items.value[0] || null,
);

const actionErrorKey = ref('');

/** The explicit reload: what arrived since the loaded page. */
function reload(): void {
  actionErrorKey.value = '';
  void notifications.load(page.value);
}

function retry(): void {
  void notifications.load(notifications.requested);
}

function open(target: number): void {
  actionErrorKey.value = '';
  void notifications.load(target);
}

/**
 * Opens the row under the highlight. The receipt goes out with it — opening a
 * notification is reading it — and the route the server named decides where
 * the screen lands: this app has a post screen, so a notification about a post
 * opens it, and one about anything else (a profile, a realm, a chat room) is
 * only marked read rather than dropped somewhere unrelated.
 */
function openSelected(): void {
  const item = selected.value;
  if (!item) return;

  void notifications.markRead(item.id);

  const postId = postIdFromActionUri(item.actionUri);
  if (postId) push('post', { id: postId });
}

function openItem(item: AppNotification): void {
  notifications.selectedId = item.id;
  openSelected();
}

/** The bulk read, on the right key while anything on the page is unread. */
async function markAllRead(): Promise<void> {
  actionErrorKey.value = '';
  if (!(await notifications.markAllRead())) actionErrorKey.value = 'notifications_read_error';
}

onMounted(() => {
  setBaseSoftkeys(() => ({
    // The read path's own two actions: the loaded page can be asked for again
    // (what arrived since), and everything unread can be taken as read in one
    // call — the inbox's only bulk receipt. Both are account-scoped, so
    // neither is live signed out.
    left: phase.value === 'signed-in' ? { label: t('action_reload'), onPress: reload } : { label: '' },
    center: { label: phase.value === 'signed-in' ? t('action_open') : '' },
    right:
      phase.value === 'signed-in' && unreadCount.value > 0
        ? { label: t('notifications_read_all'), onPress: markAllRead }
        : { label: '' },
  }));

  // A visit loads only when nothing is loaded under this session yet; a plain
  // return keeps the page that is already on screen, scroll anchor included.
  if (status.value !== 'ready' || notifications.loadedPhase !== accountStore.phase) {
    void notifications.load(1);
  }
});
</script>
