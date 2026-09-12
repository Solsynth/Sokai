<template>
  <div class="kai-view">
    <KaiHeader :title="headerTitle" />

    <main class="kai-content">
      <!-- Chat is account-scoped: signed out, explain and offer the sign-in
           screen, exactly like the compose screen does. -->
      <template v-if="phase !== 'signed-in'">
        <p class="kai-text">{{ t('chat_sign_in_intro') }}</p>

        <KaiList class="kai-list--flat">
          <KaiListItem :primary="t('account_sign_in')" @select="push('account')" />
        </KaiList>
      </template>

      <template v-else>
        <KaiSpinner v-if="status === 'loading' && rooms.length === 0" :label="t('chat_loading')" />

        <template v-else>
          <p v-if="status === 'error'" class="kai-text kai-text--error">
            {{ t('error_load_failed') }}
          </p>

          <p v-else-if="visible.length === 0" class="kai-text kai-text--secondary">
            {{ filter === 'all' ? t('chat_no_rooms') : t('chat_no_rooms_filtered') }}
          </p>

          <!-- The rooms render whole — no pager: a handset's chat list is a
               few screens, and the server's page boundary is not a concept the
               user has. `loadRooms` walks it internally. -->
          <KaiList class="kai-list--flat">
            <KaiChatRoomRow
              v-for="room in visible"
              :key="room.id"
              :room="room"
              :summary="summaries[room.id] || null"
              :self-account-id="selfAccountId"
              @select="push('chat-room', { id: room.id })"
            />

            <KaiListItem v-if="status === 'error'" :primary="t('error_retry')" @select="retry" />
          </KaiList>
        </template>
      </template>
    </main>

    <!-- The write-path menu behind the left key, the design guide's option
         sheet: starting a conversation, invitations, the room filter, and the
         bulk read. -->
    <KaiOptionMenu
      v-if="menu === 'root'"
      :title="t('chat_new')"
      :options="rootOptions"
      @select="onRootSelect"
      @cancel="menu = ''"
    />
    <KaiOptionMenu
      v-else-if="menu === 'filter'"
      :title="t('chat_filter')"
      :options="filterOptions"
      @select="onFilterSelect"
      @cancel="menu = 'root'"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';

import KaiChatRoomRow from '~/src/components/KaiChatRoomRow.vue';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import KaiOptionMenu, { type Option } from '~/src/components/KaiOptionMenu.vue';
import KaiSpinner from '~/src/components/KaiSpinner.vue';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { push } from '~/src/kaios/views.js';
import { useAccountStore } from '~/src/stores/account.js';
import { useChatStore } from '~/src/stores/chat.js';

// Every screen is mounted with its stack entry's parameters; the room list
// takes none.
withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({}) });

const accountStore = useAccountStore();
const chat = useChatStore();
const {
  rooms,
  roomStatus: status,
  stale,
  loadedPhase,
  summaries,
  inviteCount,
  filter,
  visibleRooms,
} = storeToRefs(chat);

const phase = computed(() => accountStore.phase);
const selfAccountId = computed(() => accountStore.account?.id || '');

/**
 * Most-active first — the last message's time, falling back to the room's own
 * updated time — the ordering Solian's room list uses. The whole list is
 * loaded, so the sort orders every room; the filter narrows it further.
 */
const visible = computed(() => {
  const list = visibleRooms.value.slice();
  list.sort((a, b) => {
    const aAt = summaries.value[a.id]?.lastMessage?.createdAt || a.updatedAt || '';
    const bAt = summaries.value[b.id]?.lastMessage?.createdAt || b.updatedAt || '';
    if (aAt === bAt) return 0;
    return aAt > bAt ? -1 : 1;
  });
  return list;
});

const headerTitle = computed(() => {
  if (filter.value === 'direct') return t('chat_tab_direct');
  if (filter.value === 'group') return t('chat_tab_groups');
  return t('nav_chat');
});

/** '' | 'root' | 'filter' — the write-path menu and its filter sub-sheet. */
const menu = ref<'' | 'root' | 'filter'>('');

const rootOptions = computed<Option[]>(() => {
  const options: Option[] = [
    { id: 'new', label: t('chat_new_message') },
    { id: 'invites', label: inviteCount.value ? t('chat_invites_count', { n: inviteCount.value }) : t('chat_invites') },
    { id: 'filter', label: t('chat_filter') },
    { id: 'search', label: t('chat_search') },
  ];
  if (Object.keys(summaries.value).some((roomId) => summaries.value[roomId].unreadCount > 0)) {
    options.push({ id: 'read-all', label: t('chat_read_all') });
  }
  return options;
});

const filterOptions = computed<Option[]>(() => [
  { id: 'all', label: t('chat_tab_all') },
  { id: 'direct', label: t('chat_tab_direct') },
  { id: 'group', label: t('chat_tab_groups') },
]);

function onRootSelect(id: string): void {
  if (id === 'filter') {
    menu.value = 'filter';
    return;
  }
  menu.value = '';
  if (id === 'new') push('chat-new');
  else if (id === 'invites') push('chat-invites');
  else if (id === 'search') push('chat-search');
  else if (id === 'read-all') void chat.readAll();
}

function onFilterSelect(id: string): void {
  menu.value = '';
  if (id === 'all' || id === 'direct' || id === 'group') chat.setFilter(id);
}

function retry(): void {
  void chat.loadRooms();
}

onMounted(() => {
  setBaseSoftkeys(() => ({
    // The write path is the left key, as on Explore — here it opens the
    // conversation menu. It is live only with a session, because every feature
    // behind it is account-scoped. The sheet carries its own bar, so the
    // screen's bar reads empty while it is up.
    left:
      phase.value !== 'signed-in' || menu.value
        ? { label: '' }
        : { label: t('chat_new'), onPress: () => (menu.value = 'root') },
    center: { label: menu.value ? '' : t('action_open') },
  }));

  // Live messages bump the room list's unread badges while it is on screen;
  // opening a room hands the subscription over to the thread.
  chat.setActiveRoom('');

  // A visit refetches only when a write changed the list or the account did;
  // otherwise the loaded list returns as it was, scroll anchor included.
  if (chat.stale || chat.loadedPhase !== accountStore.phase) {
    void chat.loadRooms();
  }
  void chat.loadInvites();
});
</script>
