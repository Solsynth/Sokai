<template>
  <div class="kai-view">
    <KaiHeader :title="t('chat_info')" />

    <main class="kai-content kai-content--roomy">
      <!-- The message is read from the loaded thread, so it is always the row
           the sheet was open on; a row that left the window (a page slid it
           out) simply cannot be described. -->
      <template v-if="message">
        <!-- Who sent it: the face and the full name, with the unique handle
             the thread's bubble does not show. -->
        <p class="kai-separator">{{ t('chat_info_sender') }}</p>
        <div class="kai-chat-info__sender">
          <KaiAvatar
            class="kai-chat-info__pfp"
            :file="message.sender.account.picture"
            :label="senderName"
            size="md"
          />
          <div class="kai-chat-info__who">
            <p class="kai-chat-info__name">{{ senderName }}</p>
            <p class="kai-chat-info__handle">@{{ message.sender.account.name }}</p>
          </div>
        </div>

        <!-- What the message holds: its own body, the sticker it is, a voice
             note's length, or its attachments. -->
        <p class="kai-separator">{{ t('chat_info_message') }}</p>
        <img
          v-if="stickerSrc"
          class="kai-chat-info__sticker"
          :src="cachedSticker"
          :alt="message.content"
        />
        <p
          v-if="message.content"
          class="kai-chat-info__body"
          :class="{ 'kai-chat-info__body--caption': stickerSrc }"
        >
          {{ message.content }}
        </p>
        <p v-else-if="message.voiceDurationMs" class="kai-chat-info__body kai-chat-info__body--muted">
          {{ t('chat_voice') }} · {{ formatClock(message.voiceDurationMs) }}
        </p>
        <KaiAttachmentList v-if="message.attachments.length" :attachments="message.attachments" />

        <!-- The facts: exact send time, delivery state, wire type, and the ids
             that identify the row to the server. -->
        <p class="kai-separator">{{ t('chat_info_details') }}</p>
        <p class="kai-chat-info__row">
          <span class="kai-chat-info__label">{{ t('chat_info_sent') }}</span>
          <span class="kai-chat-info__value">{{ sentTime }}</span>
        </p>
        <p v-if="editedTime" class="kai-chat-info__row">
          <span class="kai-chat-info__label">{{ t('chat_info_edited') }}</span>
          <span class="kai-chat-info__value">{{ editedTime }}</span>
        </p>
        <p class="kai-chat-info__row">
          <span class="kai-chat-info__label">{{ t('chat_info_status') }}</span>
          <span class="kai-chat-info__value">{{ statusLabel }}</span>
        </p>
        <p class="kai-chat-info__row">
          <span class="kai-chat-info__label">{{ t('chat_info_type') }}</span>
          <span class="kai-chat-info__value">{{ message.type }}</span>
        </p>
        <p class="kai-chat-info__row">
          <span class="kai-chat-info__label">{{ t('chat_info_account') }}</span>
          <span class="kai-chat-info__value">{{ message.sender.accountId }}</span>
        </p>
        <p class="kai-chat-info__row">
          <span class="kai-chat-info__label">{{ t('chat_info_id') }}</span>
          <span class="kai-chat-info__value">{{ message.id }}</span>
        </p>
        <p v-if="message.clientMessageId" class="kai-chat-info__row">
          <span class="kai-chat-info__label">{{ t('chat_info_client_id') }}</span>
          <span class="kai-chat-info__value">{{ message.clientMessageId }}</span>
        </p>
        <p class="kai-chat-info__row">
          <span class="kai-chat-info__label">{{ t('chat_info_room') }}</span>
          <span class="kai-chat-info__value">{{ roomTitle }}</span>
        </p>
        <p v-if="message.repliedMessageId" class="kai-chat-info__row">
          <span class="kai-chat-info__label">{{ t('chat_info_reply_to') }}</span>
          <span class="kai-chat-info__value">{{ message.repliedMessageId }}</span>
        </p>

        <template v-if="hasReactions">
          <p class="kai-separator">{{ t('chat_info_reactions') }}</p>
          <KaiReactionChips :reactions="message.reactions" :limit="0" />
        </template>
      </template>

      <p v-else class="kai-text kai-text--secondary">{{ t('chat_info_gone') }}</p>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';

import {
  chatMemberName,
  formatClock,
  formatDateTime,
  stickerPlaceholder,
  type ChatMessage,
} from '~/src/api/models.js';
import { fileUrl } from '~/src/api/solian.js';
import KaiAttachmentList from '~/src/components/KaiAttachmentList.vue';
import KaiAvatar from '~/src/components/KaiAvatar.vue';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiReactionChips from '~/src/components/KaiReactionChips.vue';
import { t } from '~/src/kaios/l10n.js';
import { useCachedUrl } from '~/src/kaios/media-cache.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { chatRoomTitle, useChatStore } from '~/src/stores/chat.js';

/**
 * A message's verbose detail: the full sender (name and unique handle), the
 * message as the thread renders it, and the facts a bubble cannot carry — the
 * exact send time, the delivery state, the wire type and the ids. Read-only
 * like About: no D-pad stops, the arrows scroll the page, Back is the way up.
 *
 * The row is looked up in the loaded thread rather than passed over the stack,
 * so the page always describes the row the option sheet acted on — and the
 * same row the store holds, edits and reactions included.
 */

// Every screen is mounted with its stack entry's parameters; this one takes
// the room and the message id the sheet was open on.
const props = withDefaults(defineProps<{ params?: Record<string, string> }>(), {
  params: () => ({}),
});

const chat = useChatStore();
const roomId = computed(() => props.params.room || '');
const messageId = computed(() => props.params.id || '');

/** The message from the loaded thread; null when it left the window. */
const message = computed<ChatMessage | null>(() => {
  const thread = chat.messages[roomId.value] || [];
  return thread.find((item) => item.id === messageId.value) || null;
});

const senderName = computed(() => (message.value ? chatMemberName(message.value.sender) : ''));

/** The room's display title; the raw id while the room list has not loaded. */
const roomTitle = computed(() => {
  const room = chat.rooms.find((item) => item.id === roomId.value);
  return room ? chatRoomTitle(room, chat.selfAccountId) : roomId.value;
});

const sentTime = computed(() => (message.value ? formatDateTime(message.value.createdAt) : ''));
const editedTime = computed(() => (message.value ? formatDateTime(message.value.editedAt) : ''));

/** A server row is sent; only a row the device is still uploading is not. */
const statusLabel = computed(() =>
  message.value?.status === 'pending' ? t('chat_sending') : t('chat_sent'),
);

/** The sticker this message is, as an image — resolved the way the bubble's
 *  is, so a sticker message's page shows the picture, not just the placeholder
 *  caption under it. */
const placeholder = computed(() => (message.value ? stickerPlaceholder(message.value.content) : ''));
const stickerSrc = computed(() => {
  if (!placeholder.value) return '';
  const image = chat.stickerImageFor(placeholder.value);
  return image ? fileUrl(image) : '';
});
const cachedSticker = useCachedUrl(stickerSrc);

watch(placeholder, (value) => {
  if (value) void chat.resolveStickerImage(value);
}, { immediate: true });

const hasReactions = computed(() => {
  const row = message.value;
  return row !== null && Object.keys(row.reactions).length > 0;
});

onMounted(() => {
  // The hardware Back key is the way up (the design guide's Back/Clear rule);
  // no softkey duplicates it.
  setBaseSoftkeys(() => ({}));
});
</script>
