<template>
  <KaiListItem
    class="kai-chat-room"
    :thumb="thumb"
    :thumb-label="title"
    :primary="title"
    :value="room.id"
    @select="emit('select')"
    @selected="emit('selected', $event)"
  >
    <!-- The unread count is a state, not part of the preview: it renders as
         the red pill, ahead of what was actually said. -->
    <template #secondary>
      <span v-if="unread" class="kai-chat-row__unread">{{ t('chat_unread', { n: unread }) }}</span>
      <span class="kai-chat-row__preview">{{ preview }}</span>
    </template>
  </KaiListItem>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import {
  chatMemberName,
  formatClock,
  stickerPlaceholder,
  type ChatRoom,
  type ChatSummary,
} from '~/src/api/models.js';
import KaiListItem from './KaiListItem.vue';
import { t } from '~/src/kaios/l10n.js';
import { chatRoomTitle } from '~/src/stores/chat.js';

/**
 * One room as a list row: avatar, title, and a preview of what the room is
 * doing — the unread count as a pill, then the last message as `<sender>:
 * <what they said>`, the shape both other clients use (the watch tints the
 * sender, Flutter prints `'$senderNick: '`). Shared by the room list, the
 * search and the invites, so a room renders identically wherever it appears
 * (the Flutter client reuses its room tile the same way).
 *
 * The avatar is the room's picture, or a direct room's peer's; with neither,
 * the row is lettered from the title, so every row keeps the same left edge.
 */
const props = withDefaults(
  defineProps<{
    room: ChatRoom;
    summary?: ChatSummary | null;
    selfAccountId?: string;
  }>(),
  { summary: null, selfAccountId: '' },
);

const emit = defineEmits<{
  select: [];
  /** The highlight landed on this row — echoed with its room id. */
  selected: [roomId: string];
}>();

/** A group by its name, a nameless direct room by its other members. */
const title = computed(() => chatRoomTitle(props.room, props.selfAccountId));

/**
 * The room's avatar: its own picture, or — for a direct room only — the other
 * member's. A group without a picture is lettered from its name rather than
 * borrowing a member's face, which is what the reference clients do
 * (`ChatRoomAvatar` splits the members only for a direct room, and otherwise
 * draws the room's own initials).
 */
const thumb = computed(() => {
  if (props.room.picture) return props.room.picture;
  if (props.room.type !== 1) return '';
  const peer = props.room.members.find((member) => member.accountId !== props.selfAccountId);
  return peer?.account.picture || '';
});

const unread = computed(() => props.summary?.unreadCount || 0);

/**
 * What the room last said, with the sender in front. An event row (a delete,
 * a reaction) carries no content and a picture-only message carries none
 * either — both fall back to the attachment count, so the line is never a
 * bare `sender: `.
 */
const preview = computed(() => {
  const last = props.summary?.lastMessage;
  if (!last) return '';
  const sender = chatMemberName(last.sender);
  // A sticker's content is the `:prefix+slug:` placeholder, which is not
  // something to read; the row names it instead (Flutter labels it the same
  // way, as an attachment-style line rather than the raw placeholder). A voice
  // note has neither content nor attachments, so the row names it too.
  const body = stickerPlaceholder(last.content)
    ? t('chat_sticker')
    : last.content || voiceLabel() || attachmentLabel(last.attachments.length);
  return sender ? sender + ': ' + body : body;
});

/** `Voice message · 0:07`, or '' when the last message is not a voice note. */
function voiceLabel(): string {
  const last = props.summary?.lastMessage;
  if (!last || !last.voiceDurationMs) return '';
  return t('chat_voice') + ' · ' + formatClock(last.voiceDurationMs);
}

/** `2 attachments`, or the singular `Attachment`, the clients' own wording. */
function attachmentLabel(count: number): string {
  if (count === 0) return '';
  return count === 1 ? t('chat_attachment') : t('chat_attachments', { n: count });
}
</script>
