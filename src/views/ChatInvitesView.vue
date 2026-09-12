<template>
  <div class="kai-view">
    <KaiHeader :title="t('chat_invites')" />

    <main class="kai-content">
      <KaiSpinner v-if="loading" :label="t('chat_loading')" />

      <template v-else>
        <p v-if="errorKey" class="kai-text kai-text--error">{{ t(errorKey) }}</p>

        <p v-else-if="invites.length === 0" class="kai-text kai-text--secondary">
          {{ t('chat_invites_empty') }}
        </p>

        <KaiList v-else class="kai-list--flat">
          <KaiChatRoomRow
            v-for="invite in invites"
            :key="invite.id"
            :room="invite.room || emptyRoom"
            :self-account-id="selfAccountId"
            @select="selectedId = invite.roomId"
            @selected="selectedId = $event"
          />
        </KaiList>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import type { ChatRoom } from '~/src/api/models.js';
import KaiChatRoomRow from '~/src/components/KaiChatRoomRow.vue';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiSpinner from '~/src/components/KaiSpinner.vue';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { pop } from '~/src/kaios/views.js';
import { useChatStore } from '~/src/stores/chat.js';

/**
 * Room invitations: accept or decline with the softkeys, acting on the
 * highlighted row (the app's rule for per-row actions). The invite row is the
 * same room row the list uses — the Flutter invites sheet does the same.
 *
 * Accepting joins the room, so the screen returns to the list, which refetches
 * because the store marked itself stale.
 */

withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({}) });

const chat = useChatStore();
const invites = computed(() => chat.invites);
const selfAccountId = computed(() => chat.selfAccountId);
const loading = ref(true);
const errorKey = ref('');
/** The highlighted invite's room id; the softkeys act on this one. */
const selectedId = ref('');

/** A stand-in room for an invitation whose payload carried none. */
const emptyRoom: ChatRoom = {
  id: '',
  name: null,
  type: 0,
  picture: null,
  members: [],
  createdAt: null,
  updatedAt: null,
  deletedAt: null,
};

const selectedInvite = computed(
  () => invites.value.find((invite) => invite.roomId === selectedId.value) || invites.value[0] || null,
);

async function accept(): Promise<void> {
  const invite = selectedInvite.value;
  if (!invite) return;
  errorKey.value = '';
  if (!(await chat.acceptInvite(invite.roomId))) {
    errorKey.value = 'chat_invite_failed';
    return;
  }
  pop();
}

async function decline(): Promise<void> {
  const invite = selectedInvite.value;
  if (!invite) return;
  errorKey.value = '';
  if (!(await chat.declineInvite(invite.roomId))) {
    errorKey.value = 'chat_invite_failed';
    return;
  }
  if (invites.value.length === 0) pop();
}

onMounted(() => {
  // Set before the fetch: the factory reads `selectedInvite`, so the labels
  // fill in when the list arrives rather than lagging one render behind.
  setBaseSoftkeys(() => ({
    // Per-row actions: the left key declines, the right key accepts.
    left: selectedInvite.value ? { label: t('chat_decline'), onPress: decline } : { label: '' },
    center: { label: t('action_open') },
    right: selectedInvite.value ? { label: t('chat_accept'), onPress: accept } : { label: '' },
  }));

  chat.loadInvites().then(() => {
    loading.value = false;
    if (invites.value.length) selectedId.value = invites.value[0].roomId;
  });
});
</script>
