<template>
  <div class="kai-view">
    <KaiHeader :title="title" />

    <main class="kai-content">
      <KaiSpinner v-if="status === 'loading' && thread.length === 0" />

      <template v-else>
        <p v-if="status === 'error'" class="kai-text kai-text--error">
          {{ t('error_load_failed') }}
        </p>

        <KaiList v-if="status === 'error'" class="kai-list--flat">
          <KaiListItem :primary="t('error_retry')" @select="retry" />
        </KaiList>

        <p v-else-if="thread.length === 0" class="kai-text kai-text--secondary">
          {{ t('chat_no_messages') }}
        </p>

        <template v-else>
          <!--
            Older messages load a page at a time, above the oldest one on
            screen — the thread itself runs oldest to newest downwards, as a
            chat does. The row is an ordinary selectable, so the D-pad reaches
            it by walking up past the oldest message, and it stays mounted
            while its page loads (only the label changes): swapping it for a
            spinner would move the highlight off it mid-press. It is absent
            once the room's history is exhausted.
          -->
          <KaiList v-if="more" class="kai-list--flat">
            <KaiListItem :primary="moreLabel" @select="loadOlder" />
          </KaiList>

          <!--
            The thread fills the screen, oldest at the top. Every message is a
            D-pad stop, so a press moves to the message beside the highlight —
            never over one; the ones that carry media open in the viewer, and a
            text-only bubble is selected without anything to open. The arrows
            scroll the thread when the highlight is at an end.
          -->
          <ul class="kai-chat">
            <KaiChatBubble
              v-for="message in displayMessages"
              :key="message.id"
              :message="message"
              :own="message.senderId === selfAccountId"
              :initial="message.id === initialId"
              @open="openMedia(message)"
              @selected="selectedId = $event"
            />
          </ul>

          <p v-if="deleteErrorKey" class="kai-text kai-text--error">{{ t(deleteErrorKey) }}</p>
        </template>
      </template>
    </main>

    <KaiOptionMenu
      v-if="menuOpen"
      :title="t('chat_options')"
      :options="menuOptions"
      @select="onMenuSelect"
      @cancel="menuOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import {
  chatMemberName,
  formatClock,
  type Attachment,
  type ChatMessage,
} from '~/src/api/models.js';
import { resolveMediaUrl } from '~/src/api/solian.js';
import KaiChatBubble from '~/src/components/KaiChatBubble.vue';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import KaiOptionMenu, { type Option } from '~/src/components/KaiOptionMenu.vue';
import KaiSpinner from '~/src/components/KaiSpinner.vue';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { push } from '~/src/kaios/views.js';
import { chatRoomTitle, useChatStore } from '~/src/stores/chat.js';

/**
 * One room's thread: the messages, newest at the bottom (the chat convention).
 * The thread is a window on the room's history, not the whole of it: opening
 * the room loads the newest page cache-first and marks the room read once the
 * newest message is in, the oldest end carries the Load more row, and the store
 * keeps at most `CHAT_WINDOW` messages — older pages slide the newest out of
 * the view, and the rows are in the cache either way.
 *
 * Writing to the room is the left key's own screen (`chat-compose`), where the
 * field is not sharing the display with the list.
 *
 * Every message is a D-pad stop. A press moves to the message beside the
 * highlight, so the arrows step one message at a time; the ones that carry
 * media open in the lightbox — the same viewer the post's attachments use,
 * which is what plays a voice note back — and the right key opens the
 * highlighted message's options sheet (reply, react, edit, delete, refresh),
 * the same sheet the post screens hang off their highlighted row.
 */

const props = withDefaults(defineProps<{ params?: Record<string, string> }>(), {
  params: () => ({}),
});

const roomId = computed(() => props.params.id || '');
const chat = useChatStore();

/** The store's thread is newest-first (the API's order); display reverses it. */
const thread = computed(() => chat.messages[roomId.value] || []);
const displayMessages = computed(() => thread.value.slice().reverse());
const status = computed(() => chat.messageStatus[roomId.value] || 'idle');
const selfAccountId = computed(() => chat.selfAccountId);

/** The older-page row's state, from the store's per-room bookkeeping. */
const olderStatus = computed(() => chat.olderStatus[roomId.value] || 'idle');
/** Whether there is an older page to offer at all. */
const more = computed(() => !chat.olderEnd[roomId.value] && thread.value.length > 0);
const moreLabel = computed(() => {
  if (olderStatus.value === 'loading') return t('chat_loading_more');
  if (olderStatus.value === 'error') return t('error_retry');
  return t('chat_load_more');
});

/** The room's display title from the loaded list; the DM rule names it by its
 *  other members. Falls back to the raw id while the list has not loaded. */
const title = computed(() => {
  const room = chat.rooms.find((item) => item.id === roomId.value);
  return room ? chatRoomTitle(room, chat.selfAccountId) : t('nav_chat');
});

/**
 * Where the highlight starts: the newest message with media, so opening a room
 * lands on something that opens; the newest message when none of them does.
 */
const initialId = computed(() => {
  const list = displayMessages.value;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message.attachments.length > 0 || message.voiceUrl) return message.id;
  }
  return list.length ? list[list.length - 1].id : '';
});

/* --- Message options -----------------------------------------------------
 * The highlighted message's actions live in an option sheet behind the right
 * softkey, exactly as they do on the post screens: the bubble echoes its id
 * when the highlight lands on it, and the sheet acts on that row. Write
 * actions are for rows the server knows — a pending row's id is a local
 * client id, which no endpoint could honour — and edit and delete are for
 * the account's own messages only.
 */

/** The highlighted bubble's message id — '' while none is selected. */
const selectedId = ref('');
const selectedMessage = computed(
  () => displayMessages.value.find((message) => message.id === selectedId.value) ?? null,
);

/* --- Thread scroll: newest message at the bottom -------------------------
 * Landing on the newest message is the chat convention, but the nav layer
 * alone cannot guarantee it: its entry rule selects the newest message *with
 * media* (something the highlight can open), and `scrollIntoViewNearest` then
 * stops with that row at the bottom edge — newer text rows sit below the
 * fold. And a cache-first entry shows the stored page, then merges newer
 * rows the remote page adds beneath it, after the entry scroll has run. So
 * the thread sticks to the absolute bottom while the reader has not moved:
 * any growth at the newest end (the entry paint, the remote merge, a live
 * message) scrolls the newest row into the bottom corner. The first
 * highlight change is the nav layer's entry pick, not a move; anything after
 * it hands the scroll to the reader.
 */

/**
 * The nav layer's entry pick. The first time the highlight lands it is this
 * automatic pick (the initial media/newest row); a later change to a
 * different row is the reader pressing the D-pad.
 */
const entryPick = ref('');
/**
 * True while the thread follows its bottom edge. Turned off the moment the
 * reader moves the highlight, and never back on for the life of the screen.
 */
const stickToBottom = ref(true);

watch(selectedId, (id) => {
  if (!id) return;
  if (entryPick.value === '') {
    entryPick.value = id;
    return;
  }
  if (id !== entryPick.value) stickToBottom.value = false;
});

/** The newest message's id — the thread's bottom edge. */
const newestId = computed(() => {
  const list = displayMessages.value;
  return list.length ? list[list.length - 1].id : '';
});

watch(newestId, (id, previous) => {
  if (!id) return;
  // The first paint needs no guard; a later change follows only while the
  // reader is still on the bottom. Deferred past the nav layer's entry
  // `scrollIntoViewNearest` (which runs in the same tick's microtasks) so
  // this scroll wins.
  if (previous && !stickToBottom.value) return;
  setTimeout(() => {
    const scroller = document.querySelector('.kai-content');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, 0);
});

/** The option sheet over the thread; it owns the D-pad while open. */
const menuOpen = ref(false);
/** Two-step delete: the first press asks, the second acts. */
const confirmDelete = ref(false);
const deleteErrorKey = ref('');

function openMenu(): void {
  confirmDelete.value = false;
  menuOpen.value = true;
}

/** Whether the row is the signed-in account's own and the server holds it: a
 *  pending row's id is a local client id, which no endpoint could honour —
 *  an echoed or fetched row (status `sent` or `''`) is on the server. */
const isOwned = computed(
  () =>
    Boolean(selectedMessage.value) &&
    selectedMessage.value?.status !== 'pending' &&
    selectedMessage.value?.senderId === selfAccountId.value,
);

/** The actions the sheet can run, in the design guide's read-then-write order. */
const menuOptions = computed<Option[]>(() => {
  const message = selectedMessage.value;
  if (!message) return [];
  const options: Option[] = [{ id: 'reply', label: t('action_reply') }];
  if (message.status !== 'pending') options.push({ id: 'react', label: t('action_react') });
  if (isOwned.value) {
    options.push({ id: 'edit', label: t('chat_edit') });
    options.push({
      id: 'delete',
      label: confirmDelete.value ? t('chat_delete_confirm') : t('chat_delete'),
    });
  }
  options.push({ id: 'reload', label: t('action_reload') });
  return options;
});

function onMenuSelect(id: string): void {
  if (id === 'reply') {
    menuOpen.value = false;
    openReply();
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

/** The reply composer anchors on the message; the thread updates on return. */
function openReply(): void {
  const message = selectedMessage.value;
  if (!message) return;
  push('chat-compose', {
    id: roomId.value,
    replyTo: message.id,
    replyName: chatMemberName(message.sender),
  });
}

/**
 * The picker takes the message's reactions and the user's own in its params —
 * already in memory, no second fetch — and the store updates the thread row
 * with the toggle's answer, so the bubble's pills are fresh on return.
 */
function openReactions(): void {
  const message = selectedMessage.value;
  if (!message) return;
  push('reactions', {
    room: roomId.value,
    id: message.id,
    reactions: JSON.stringify(message.reactions),
    made: JSON.stringify(message.reactionsMade),
  });
}

/** The edit composer is seeded with the message's text and attachment ids. */
function openEdit(): void {
  const message = selectedMessage.value;
  if (!message) return;
  push('chat-compose', {
    id: roomId.value,
    edit: message.id,
    content: message.content,
    attachmentIds: JSON.stringify(message.attachments.map((attachment) => attachment.id)),
  });
}

/** Deletes the message on the second press; a failure keeps it on screen. */
async function onDelete(): Promise<void> {
  const message = selectedMessage.value;
  if (!message || !isOwned.value) return;
  if (!confirmDelete.value) {
    confirmDelete.value = true;
    return;
  }
  confirmDelete.value = false;
  deleteErrorKey.value = '';
  const ok = await chat.deleteMessage(roomId.value, message.id);
  if (!ok) deleteErrorKey.value = 'chat_delete_error';
  menuOpen.value = false;
}

/** Refreshes the newest page, merging anything new over the loaded thread. */
function reload(): void {
  void chat.loadNewest(roomId.value);
}

/**
 * Opens a message's media in the lightbox. A voice note has no attachment row
 * — its bytes live behind `meta.voice_url` — so it becomes one for the viewer,
 * named by its length, which is the only thing the sender gave it. It goes
 * first, so the viewer opens on the thing that was asked for.
 */
function openMedia(message: ChatMessage): void {
  const list: Attachment[] = message.attachments.slice();
  if (message.voiceUrl) {
    list.unshift({
      id: 'voice-' + message.id,
      name: message.voiceDurationMs ? formatClock(message.voiceDurationMs) : '',
      mimeType: 'audio/ogg',
      kind: 'audio',
      size: 0,
      width: 0,
      height: 0,
      blurhash: '',
      src: resolveMediaUrl(message.voiceUrl),
    });
  }
  if (!list.length) return;
  push('lightbox', { index: '0', attachments: JSON.stringify(list) });
}

function loadOlder(): void {
  void chat.loadOlder(roomId.value);
}

function retry(): void {
  void chat.loadNewest(roomId.value);
}

// The newest message is the read watermark: opening the room (or landing back
// on it) marks everything up to it read, once the thread has actually loaded.
watch(status, () => {
  if (status.value === 'ready' && thread.value.length > 0) {
    void chat.markRead(roomId.value);
  }
});

onMounted(() => {
  setBaseSoftkeys(() => ({
    // The write path is the left key, as it is on Explore and the room list;
    // the highlighted message's actions sit in the option sheet on the right.
    // The sheet carries its own title bar and softkey bar, so the screen's
    // bar reads empty while it is up — the menu intercepts every press.
    left: menuOpen.value ? { label: '' } : { label: t('chat_write'), onPress: () => push('chat-compose', { id: roomId.value }) },
    center: { label: menuOpen.value ? '' : t('action_open') },
    right: menuOpen.value
      ? { label: '' }
      : selectedMessage.value
        ? { label: t('action_options'), onPress: openMenu }
        : { label: '' },
  }));

  void chat.loadNewest(roomId.value);
  void chat.loadRoom(roomId.value);
  chat.setActiveRoom(roomId.value);
});

onBeforeUnmount(() => {
  chat.setActiveRoom('');
});
</script>
