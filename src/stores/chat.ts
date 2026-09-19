import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';

import type {
  AttachmentKind,
  ChatAccount,
  ChatInvite,
  ChatMessage,
  ChatRoom,
  ChatSummary,
  Sticker,
  StickerPack,
} from '~/src/api/models.js';
import {
  attachmentKind,
  hasChatMessageContent,
  normalizeChatMessage,
  stickerPlaceholder,
} from '~/src/api/models.js';
import {
  acceptChatInvite,
  declineChatInvite,
  deleteChatMessage,
  editChatMessage,
  getChatRoom,
  getChatSummary,
  listChatInvites,
  listChatMessages,
  listAllChatRooms,
  listStickerPacks,
  lookupStickerImage,
  markAllChatRead,
  reactToChatMessage,
  searchAccounts,
  sendChatMessage,
  sendVoiceMessage,
  startDirectChat,
  uploadFile,
} from '~/src/api/solian.js';
import { openChatDb, type ChatDb } from '~/src/kaios/idb.js';
import {
  closeChatWs,
  connectChatWs,
  onChatWsPacket,
  sendChatReadReceipt,
  subscribeChatRoom,
  unsubscribeChatRoom,
} from '~/src/kaios/ws.js';
import { useAccountStore, type AccountPhase } from '~/src/stores/account.js';

/**
 * The chat store: the room list and each room's message thread, kept across
 * navigation so Back restores a thread instead of refetching it — the same
 * reason the feed and compose stores exist (only the top of the view stack is
 * mounted).
 *
 * Storage follows the KaiOS IndexedDB guidelines (`src/kaios/idb.ts`): the DB
 * is opened removable, writes are error-handled (a full device degrades to the
 * in-memory copy and sets `storageError`), and a room's history is capped.
 * Reads are cache-first, mirroring Solian's `MessageSyncService` — render the
 * local copy immediately, then merge the remote page over it by id — so the
 * thread is alive before the network answers and a failed fetch leaves the
 * cache on screen.
 *
 * A thread is a *window* on the room's history, not the whole of it: the newest
 * page loads on open, older pages load one at a time from the thread's own Load
 * more row, and the window holds at most `CHAT_WINDOW` rows — the newest fall
 * out as older pages come in, the oldest as live messages arrive. Rows leaving
 * the window were already written to the cache, so nothing is lost from the
 * device; only the heap is bounded.
 *
 * Chat is account-scoped: everything is cleared when the session ends, and a
 * host without IndexedDB (jsdom, a locked origin) runs on memory alone.
 */

/**
 * One page of a chat list. The thread loads its newest page on open and one
 * older page per Load more; a room search answers with one page.
 */
export const CHAT_PAGE = 50;

/**
 * The most messages a room's thread keeps in memory. Loading older pages slides
 * the window: the newest rows fall out of the view, the oldest out of the view
 * when live messages arrive — either way into the cache, which holds the room's
 * history (`MAX_MESSAGES_PER_ROOM` in `idb.ts`), so a long conversation cannot
 * grow the heap on a handset.
 */
export const CHAT_WINDOW = 500;

export type ChatLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * A picked-but-unsent file in a room's draft. The bytes are uploaded when the
 * message is sent (the post composer's order), so a discarded draft never
 * leaves a file behind on the drive.
 */
export interface DraftAttachment {
  /** Local id, for the row key. */
  id: string;
  blob: Blob;
  name: string;
  size: number;
  kind: AttachmentKind;
  /** Object-URL preview for a picture, so the row shows what was picked. */
  preview: string;
  /** A recorded take's length; 0 for every other pick. */
  durationMs: number;
}

function uuid(): string {
  // Gecko 48 has no crypto.randomUUID; a Math.random v4 is enough for a
  // client message id (the server does not trust it as a secret).
  const hex = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  return hex.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/** Newest first, the API's own order. ISO timestamps sort lexicographically. */
function byNewest(a: ChatMessage, b: ChatMessage): number {
  if (a.createdAt === b.createdAt) return 0;
  return a.createdAt && b.createdAt && a.createdAt < b.createdAt ? 1 : -1;
}

/**
 * The room's display title. A direct room (type 1) with no name is named by
 * its other members — the same rule Solian's room tile uses; anything else
 * falls back to the room name.
 */
export function chatRoomTitle(room: ChatRoom, selfAccountId: string): string {
  if (room.type === 1 && !room.name) {
    const peers = room.members
      .filter((member) => member.accountId !== selfAccountId)
      .map((member) => member.account.display);
    return peers.length ? peers.join(', ') : 'DM';
  }
  return room.name || 'DM';
}

export const useChatStore = defineStore('chat', () => {
  const accountStore = useAccountStore();

  const rooms = ref<ChatRoom[]>([]);
  const roomStatus = ref<ChatLoadStatus>('idle');
  /** The room list's unread state, keyed by room id. */
  const summaries = ref<Record<string, ChatSummary>>({});
  /** Per-room message threads, newest first, capped at `CHAT_WINDOW` rows. */
  const messages = ref<Record<string, ChatMessage[]>>({});
  const messageStatus = ref<Record<string, ChatLoadStatus>>({});
  /**
   * Per-room newest-first index just past the oldest loaded row: where the next
   * older page starts. It is an absolute position in the room's history, so
   * rows sliding out of the newest end do not disturb it.
   */
  const messageOffsets = ref<Record<string, number>>({});
  /** Per-room state of the older pages behind the thread's Load more row. */
  const olderStatus = ref<Record<string, ChatLoadStatus>>({});
  /** Per-room: the room's history is exhausted — nothing older to load. */
  const olderEnd = ref<Record<string, boolean>>({});
  /** Per-room composer drafts, kept across navigation. */
  const drafts = ref<Record<string, string>>({});
  /** Per-room picked-but-unsent files, kept with the draft for the same reason. */
  const draftAttachments = ref<Record<string, DraftAttachment[]>>({});
  /** Sticker image ids, keyed by their `:prefix+slug:` placeholder. */
  const stickerImages = ref<Record<string, string>>({});
  /** The sticker packs to offer; loaded once per session. */
  const stickerPacks = ref<StickerPack[]>([]);
  const stickerStatus = ref<ChatLoadStatus>('idle');
  /** l10n key for the last send failure; '' while healthy. */
  const sendError = ref('');
  /** A local write failed (device storage full): reads still work, writes don't persist. */
  const storageError = ref(false);
  /** A write changed a room's timeline since the last load. */
  const stale = ref(true);
  /** The account the cached rooms/messages were loaded under. */
  const loadedPhase = ref<AccountPhase | ''>('');
  /** The room whose thread is on screen — the one live messages merge into. */
  const activeRoomId = ref('');
  /** Pending room invitations (`GET /messager/chat/invites`). */
  const invites = ref<ChatInvite[]>([]);
  /** The room-list scope, the watch's own tabs: all, direct (type 1) or group. */
  const filter = ref<'all' | 'direct' | 'group'>('all');

  const phase = computed(() => accountStore.phase);
  const signedIn = computed(() => phase.value === 'signed-in');
  const selfAccountId = computed(() => accountStore.account?.id ?? '');

  let db: ChatDb | null = null;
  let dbPromise: Promise<ChatDb | null> | null = null;

  function ensureDb(): Promise<ChatDb | null> {
    if (!dbPromise) {
      dbPromise = openChatDb().then((handle) => {
        db = handle;
        // A miss is not cached: the open may have been blocked by another
        // connection that is gone by the next visit, and the cache is worth
        // having back. (A host with no IndexedDB answers immediately, so the
        // retry costs nothing there.)
        if (!handle) dbPromise = null;
        return handle;
      });
    }
    return dbPromise;
  }

  /** Best-effort persist; a failure degrades to memory and raises the notice. */
  async function persist(kind: 'rooms' | 'messages' | 'summaries', roomId = ''): Promise<void> {
    try {
      const handle = await ensureDb();
      if (!handle) return;
      let ok = false;
      if (kind === 'rooms') ok = await handle.saveRooms(rooms.value);
      else if (kind === 'messages') ok = await handle.saveMessages(roomId, messages.value[roomId] || []);
      else ok = await handle.saveSummaries(summaries.value);
      if (!ok) storageError.value = true;
    } catch (error) {
      storageError.value = true;
    }
  }

  /**
   * How long a live message's cache write waits before it lands, so a burst of
   * live traffic coalesces into one write instead of one whole-window JSON
   * round trip plus IndexedDB transaction per packet. The window is small:
   * only the realtime path uses this, user actions still persist immediately,
   * and the cache is disposable — a write that loses the race with app exit
   * costs a refetch, never data.
   */
  const PERSIST_COALESCE_MS = 600;
  /** Pending coalesced thread writes, keyed by room id. */
  const pendingMessagePersists = new Map<string, number>();

  /** Schedules a room's thread write; a later live message reschedules it. */
  function scheduleMessagePersist(roomId: string): void {
    const pending = pendingMessagePersists.get(roomId);
    if (pending) window.clearTimeout(pending);
    pendingMessagePersists.set(
      roomId,
      window.setTimeout(() => {
        pendingMessagePersists.delete(roomId);
        void persist('messages', roomId);
      }, PERSIST_COALESCE_MS),
    );
  }

  /**
   * Merges incoming rows into the room's thread, returning whether the thread
   * changed. A merge that changes nothing — every incoming row already present
   * and nothing to replace, e.g. the gateway echoing a row the send already
   * merged — leaves the state alone: the common live-message duplicate must
   * not rebuild, re-sort and repaint a 500-row window.
   */
  function mergeMessages(roomId: string, incoming: ChatMessage[]): boolean {
    if (!incoming.length) return false;
    const existing = messages.value[roomId] || [];
    const byId = new Map<string, ChatMessage>();
    for (let index = 0; index < existing.length; index += 1) {
      byId.set(existing[index].id, existing[index]);
    }
    let changed = false;
    for (let index = 0; index < incoming.length; index += 1) {
      const message = incoming[index];
      // A placeholder or an event row has nothing to draw; it never enters the
      // thread at all (the page it arrived in still counts towards the room's
      // offsets — see `loadOlder`).
      if (!hasChatMessageContent(message)) continue;
      const current = byId.get(message.id);
      // The remote row is fresher; a local pending/failed row is only
      // replaced when the server echo (same client_message_id) arrives.
      if (!current || current.status === '') {
        byId.set(message.id, message);
        changed = true;
      }
    }
    if (!changed) return false;
    const merged = Array.from(byId.values()).sort(byNewest);
    messages.value = { ...messages.value, [roomId]: merged };
    return true;
  }

  /** Whether the room's loaded thread already holds this message. */
  function holdsMessage(roomId: string, messageId: string): boolean {
    const thread = messages.value[roomId] || [];
    for (let index = 0; index < thread.length; index += 1) {
      if (thread[index].id === messageId) return true;
    }
    return false;
  }

  function setOffset(roomId: string, value: number): void {
    messageOffsets.value = { ...messageOffsets.value, [roomId]: value };
  }

  /**
   * Drops the rows past the window's oldest end. Called after a live message
   * lands (the thread slides towards the present) and after the newest page
   * loads. The dropped rows were written to the cache while they were loaded,
   * so the thread loses them from the view, not from the drive.
   */
  function capOldest(roomId: string): void {
    const thread = messages.value[roomId] || [];
    if (thread.length <= CHAT_WINDOW) return;
    const dropped = thread.length - CHAT_WINDOW;
    messages.value = { ...messages.value, [roomId]: thread.slice(0, CHAT_WINDOW) };
    // The rows that fell out are the ones nearest the next older page, so that
    // page now starts `dropped` rows earlier.
    setOffset(roomId, Math.max(0, (messageOffsets.value[roomId] || 0) - dropped));
  }

  /**
   * Drops the rows past the window's newest end. Called after an older page
   * merges: the reader has scrolled away from the newest messages, and the
   * offset of the next older page is measured from the newest end, so it does
   * not move.
   */
  function capNewest(roomId: string): void {
    const thread = messages.value[roomId] || [];
    if (thread.length <= CHAT_WINDOW) return;
    messages.value = { ...messages.value, [roomId]: thread.slice(thread.length - CHAT_WINDOW) };
  }

  /** The stored rows at a page boundary; `[]` when the host has no cache. */
  async function readCachedPage(roomId: string, offset: number): Promise<ChatMessage[]> {
    const handle = await ensureDb();
    if (!handle) return [];
    const rows = await handle.loadMessagePage(roomId, offset, CHAT_PAGE);
    return rows || [];
  }

  /**
   * Loads the whole room list and its unread summaries, cache-first. The list
   * is presented whole — a chat list is a few screens on a handset, so the
   * server's page boundary is walked here rather than exposed as a pager. The
   * room list and the summary arrive together (the list without the unread
   * state would render a wrong badge), so both are resolved before `ready`.
   */
  async function loadRooms(): Promise<void> {
    if (!signedIn.value) {
      roomStatus.value = 'idle';
      return;
    }
    loadedPhase.value = phase.value;
    roomStatus.value = 'loading';

    // Cache-first: paint the stored list immediately, then fetch.
    let cachedRooms: ChatRoom[] | null = null;
    let cachedSummaries: Record<string, ChatSummary> | null = null;
    try {
      const handle = await ensureDb();
      if (handle) {
        cachedRooms = await handle.loadRooms();
        cachedSummaries = await handle.loadSummaries();
      }
    } catch (error) {
      // No persistence: fall through to remote only.
    }
    // An empty cached array is not a cache: the first launch (or a wiped
    // removable DB) must still surface a failed refresh as an error rather
    // than as "no chats yet".
    const hasCache = Boolean(cachedRooms && cachedRooms.length);
    if (hasCache) rooms.value = cachedRooms as ChatRoom[];
    if (cachedSummaries) summaries.value = cachedSummaries;

    try {
      const [loaded, summaryMap] = await Promise.all([listAllChatRooms(), getChatSummary()]);
      rooms.value = loaded;
      // A summary row with no unread still carries the last message; rooms
      // without a row keep their cached summary (the server's map is sparse).
      summaries.value = { ...summaries.value, ...summaryMap };
      roomStatus.value = 'ready';
      stale.value = false;
      void persist('rooms');
      void persist('summaries');
    } catch (error) {
      // The cached list stays on screen; only the refresh failed.
      roomStatus.value = hasCache ? 'ready' : 'error';
    }
  }

  /**
   * Loads a room's newest messages, cache-first — the stored page paints, then
   * the remote page merges over it by id, exactly as the room list does. Only
   * the newest page is fetched: everything older is the thread's Load more row,
   * which the reader asks for a page at a time (`loadOlder`).
   */
  async function loadNewest(roomId: string): Promise<void> {
    if (!signedIn.value) return;
    messageStatus.value = { ...messageStatus.value, [roomId]: 'loading' };
    // A thread already on screen is kept: Back into a room must not throw away
    // the pages the reader loaded, only refresh the newest ones.
    const fresh = !(messages.value[roomId] || []).length;

    let cached: ChatMessage[] = [];
    try {
      cached = await readCachedPage(roomId, 0);
    } catch (error) {
      // No persistence: fall through to remote only.
    }
    if (cached.length) mergeMessages(roomId, cached);

    try {
      const result = await listChatMessages(roomId, { take: CHAT_PAGE, offset: 0 });
      mergeMessages(roomId, result.messages);
      messageStatus.value = { ...messageStatus.value, [roomId]: 'ready' };
      olderStatus.value = { ...olderStatus.value, [roomId]: 'idle' };
      // A short page is the end of the history; a page that reaches the room's
      // own total is too (the count only counts when the server sent one).
      olderEnd.value = {
        ...olderEnd.value,
        [roomId]:
          result.messages.length < CHAT_PAGE ||
          (result.total > 0 && result.messages.length >= result.total),
      };
      // A fresh thread holds the newest page (the cache's prefix and the remote
      // page, whichever reaches deeper), so the next older page starts right
      // after it. A thread that was already loaded keeps its position.
      if (fresh) setOffset(roomId, Math.max(cached.length, result.messages.length));
      capOldest(roomId);
      void persist('messages', roomId);
    } catch (error) {
      messageStatus.value = {
        ...messageStatus.value,
        [roomId]: cached.length ? 'ready' : 'error',
      };
      // The stored prefix is the whole thread: Load more continues from it.
      if (fresh && cached.length) setOffset(roomId, cached.length);
    }
  }

  /**
   * Loads the next older page of a room's thread, cache-first like the newest
   * page: the stored rows paint, and a cache read that comes up short falls
   * through to the remote page at the same offset. Past `CHAT_WINDOW` rows the
   * newest slide out of the view — they stay in the cache.
   */
  async function loadOlder(roomId: string): Promise<void> {
    if (!signedIn.value) return;
    if (olderStatus.value[roomId] === 'loading' || olderEnd.value[roomId]) return;
    const offset = messageOffsets.value[roomId] || 0;
    olderStatus.value = { ...olderStatus.value, [roomId]: 'loading' };

    let cached: ChatMessage[] = [];
    try {
      cached = await readCachedPage(roomId, offset);
    } catch (error) {
      // No persistence: fall through to remote only.
    }
    if (cached.length) mergeMessages(roomId, cached);

    if (cached.length < CHAT_PAGE) {
      try {
        const result = await listChatMessages(roomId, { take: CHAT_PAGE, offset });
        mergeMessages(roomId, result.messages);
        // The page covers [offset, offset + rows), so the next older one starts
        // past it. The wire's own row count advances the offset: a row the
        // thread filters out still occupies its place in the room's history.
        setOffset(roomId, offset + result.messages.length);
        olderStatus.value = { ...olderStatus.value, [roomId]: 'ready' };
        olderEnd.value = {
          ...olderEnd.value,
          [roomId]:
            result.messages.length < CHAT_PAGE ||
            (result.total > 0 && offset + result.messages.length >= result.total),
        };
      } catch (error) {
        // Whatever the cache held is on screen; the row offers the retry.
        olderStatus.value = {
          ...olderStatus.value,
          [roomId]: cached.length ? 'ready' : 'error',
        };
      }
    } else {
      setOffset(roomId, offset + cached.length);
      olderStatus.value = { ...olderStatus.value, [roomId]: 'ready' };
    }

    capNewest(roomId);
    void persist('messages', roomId);
  }

  /**
   * Loads one room into the list (without disturbing the list's pager state),
   * for the thread header when the room is not in the loaded page — a direct
   * entry, or a room beyond the list page. Best-effort: a failure leaves the
   * header on its fallback title.
   */
  async function loadRoom(roomId: string): Promise<void> {
    try {
      const room = await getChatRoom(roomId);
      if (!room) return;
      if (!rooms.value.some((item) => item.id === roomId)) {
        rooms.value = [...rooms.value, room];
      }
    } catch (error) {
      // Fallback title stays.
    }
  }

  /**
   * Sends a message. The row appears immediately as pending, is replaced by
   * the server's echo (matched on `client_message_id`), and a failure leaves
   * no half-sent row: the draft and its files come back and `sendError` says
   * why — the same retention contract the post composer uses.
   *
   * A draft's files upload first (each yields its drive id) and the message
   * then carries those ids, the order both other clients use: a failed upload
   * fails the whole message rather than posting one that points at nothing.
   *
   * `replyToId` is the message this one answers (`replied_message_id`); ''
   * sends a plain message.
   */
  async function send(
    roomId: string,
    content: string,
    attachments: DraftAttachment[] = [],
    replyToId = '',
  ): Promise<void> {
    const text = content.trim();
    if ((!text && !attachments.length) || !signedIn.value) return;
    sendError.value = '';

    // A lone in-app voice take is a voice message, not an audio attachment:
    // the take is the only pick whose length is measured, and the server's
    // voice endpoint uploads the bytes and answers with `meta.voice_url` +
    // `meta.duration_ms`. A take sent beside text or other files stays an
    // attachment — the voice endpoint carries no content, and one send is
    // one message.
    const voiceTake =
      text || attachments.length !== 1 || !attachments[0] || attachments[0].durationMs <= 0
        ? null
        : attachments[0];

    const clientMessageId = uuid();
    const pending: ChatMessage = {
      id: 'pending-' + clientMessageId,
      roomId,
      type: voiceTake ? 'voice' : 'text',
      content: text,
      senderId: selfAccountId.value,
      sender: {
        id: '',
        chatRoomId: roomId,
        accountId: selfAccountId.value,
        account: accountStore.account
          ? {
              id: accountStore.account.id,
              name: accountStore.account.name,
              nick: accountStore.account.nick,
              display: accountStore.account.display,
              picture: accountStore.account.profile?.picture?.id || null,
            }
          : { id: '', name: '', nick: null, display: '', picture: null },
        nick: null,
        lastReadAt: null,
      },
      clientMessageId,
      repliedMessageId: replyToId || null,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
      // The picked files render in the optimistic row straight away; the
      // server's echo replaces this whole row with one carrying the uploaded
      // metadata. A voice take carries no attachment rows — the bubble shows
      // its length, and the echo's `meta.voice_url` is what plays.
      voiceDurationMs: voiceTake ? voiceTake.durationMs : 0,
      voiceUrl: '',
      reactions: {},
      reactionsMade: {},
      attachments: voiceTake ? [] : attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.blob.type || '',
        kind: attachment.kind,
        size: attachment.size,
        width: 0,
        height: 0,
        blurhash: '',
        // The bytes are still local, so there is nothing to point at yet; the
        // echo carries the uploaded row and replaces this one.
        src: '',
      })),
      status: 'pending',
    };
    mergeMessages(roomId, [pending]);
    drafts.value = { ...drafts.value, [roomId]: '' };

    try {
      let sent: ChatMessage | null;
      if (voiceTake) {
        sent = await sendVoiceMessage(
          roomId,
          voiceTake.blob,
          voiceTake.name,
          voiceTake.durationMs,
          clientMessageId,
        );
      } else {
        const uploaded: string[] = [];
        for (let index = 0; index < attachments.length; index += 1) {
          const attachment = attachments[index];
          const id = await uploadFile(attachment.blob, attachment.name);
          if (!id) throw new Error('upload-failed');
          uploaded.push(id);
        }
        sent = await sendChatMessage(roomId, text, clientMessageId, uploaded, replyToId);
      }
      if (sent) {
        mergeMessages(roomId, [{ ...sent, status: 'sent' }]);
        // The echo is in (matched by client_message_id inside the merge); drop
        // the optimistic row — its id is never a server id.
        const thread = (messages.value[roomId] || []).filter(
          (message) => message.id !== pending.id,
        );
        messages.value = { ...messages.value, [roomId]: thread };
        const summary = summaries.value[roomId];
        if (summary) {
          summaries.value = {
            ...summaries.value,
            [roomId]: { ...summary, lastMessage: { ...sent, status: 'sent' } },
          };
        }
      }
      clearDraft(roomId);
      void persist('messages', roomId);
      void persist('summaries');
      stale.value = true;
    } catch (error) {
      // The compose contract: a failure leaves no half-sent row. The optimistic
      // bubble goes, the draft and its files come back (unless the user typed
      // on), and the error line explains — the right softkey is the retry.
      sendError.value = 'chat_send_failed';
      const thread = (messages.value[roomId] || []).filter(
        (message) => message.id !== pending.id,
      );
      messages.value = { ...messages.value, [roomId]: thread };
      if (!drafts.value[roomId]) drafts.value = { ...drafts.value, [roomId]: text };
      void persist('messages', roomId);
    }
  }

  /** Sends a sticker as its own message: the content *is* the placeholder. */
  async function sendSticker(roomId: string, pack: StickerPack, sticker: Sticker): Promise<boolean> {
    if (!signedIn.value || !pack.prefix || !sticker.slug) return false;
    const placeholder = pack.prefix + '+' + sticker.slug;
    // Remember the image now: the message that comes back carries only the
    // placeholder, and the bubble would otherwise look it up over the network.
    if (sticker.image) {
      stickerImages.value = { ...stickerImages.value, [placeholder]: sticker.image };
    }
    await send(roomId, ':' + placeholder + ':');
    return sendError.value === '';
  }

  /**
   * Reacts to a message. The endpoint toggles, so the local counts follow the
   * answer: an added reaction bumps the tile, a taken-back one (204) drops it —
   * the same contract the post picker's `reactToPost` keeps. The thread row is
   * updated here so the bubble's pills reflect the toggle without a refetch; a
   * failure changes nothing and rethrows for the picker's error path.
   */
  async function react(
    roomId: string,
    messageId: string,
    symbol: string,
    attitude: number,
  ): Promise<boolean> {
    const added = await reactToChatMessage(roomId, messageId, symbol, attitude);
    const thread = (messages.value[roomId] || []).map((message) => {
      if (message.id !== messageId) return message;
      const reactions = { ...message.reactions };
      const reactionsMade = { ...message.reactionsMade };
      if (added) {
        reactions[symbol] = (reactions[symbol] || 0) + 1;
        reactionsMade[symbol] = true;
      } else {
        const count = (reactions[symbol] || 0) - 1;
        if (count > 0) reactions[symbol] = count;
        else delete reactions[symbol];
        delete reactionsMade[symbol];
      }
      return { ...message, reactions, reactionsMade };
    });
    messages.value = { ...messages.value, [roomId]: thread };
    void persist('messages', roomId);
    return added;
  }

  /**
   * Edits a message's text. The message's own attachment ids are sent back
   * with the new content, so the media stays on the row. The server's updated
   * row merges into the thread (a live `messages.update` would too); a failure
   * leaves the message untouched and says so in `sendError`, keeping the
   * composer up for the retry — the send contract.
   */
  async function edit(
    roomId: string,
    messageId: string,
    content: string,
    attachmentIds: string[] = [],
  ): Promise<boolean> {
    sendError.value = '';
    try {
      const updated = await editChatMessage(roomId, messageId, content, attachmentIds);
      if (updated) {
        mergeMessages(roomId, [{ ...updated, status: 'sent' }]);
        void persist('messages', roomId);
      }
      return true;
    } catch (error) {
      sendError.value = 'chat_edit_failed';
      return false;
    }
  }

  /**
   * Deletes a message on the server and drops it from the loaded threads (the
   * realtime handler's `messages.delete` does the same for the room it arrives
   * in). The room list is marked stale so a deleted preview does not linger on
   * the next visit.
   */
  async function deleteMessage(roomId: string, messageId: string): Promise<boolean> {
    try {
      await deleteChatMessage(roomId, messageId);
    } catch (error) {
      return false;
    }
    dropMessage(messageId);
    void persist('messages', roomId);
    stale.value = true;
    return true;
  }

  /**
   * Marks a room read. The receipt is the `messages.read` WebSocket packet —
   * the server exposes no HTTP route for a single room — so it is best-effort
   * by nature: with the socket down the badge simply stays until a later
   * summary. The local unread state clears either way, because the thread is
   * on screen.
   */
  async function markRead(roomId: string): Promise<void> {
    const thread = messages.value[roomId];
    const summary = summaries.value[roomId];
    if (!thread || !thread.length) return;
    const newest = thread[0];
    if (!newest || newest.status === 'pending') return;

    sendChatReadReceipt(roomId);
    if (summary && summary.unreadCount > 0) {
      summaries.value = {
        ...summaries.value,
        [roomId]: { ...summary, unreadCount: 0, hasUnread: false },
      };
      void persist('summaries');
    }
  }

  function draftFor(roomId: string): string {
    return drafts.value[roomId] || '';
  }

  function setDraft(roomId: string, value: string): void {
    drafts.value = { ...drafts.value, [roomId]: value };
  }

  /** The room's unsent files; `[]` when there are none. */
  function attachmentsFor(roomId: string): DraftAttachment[] {
    return draftAttachments.value[roomId] || [];
  }

  let attachmentSeq = 0;

  /**
   * Adds a picked file to the room's draft; the bytes upload on send.
   * `durationMs` is set for a recorded take, which is the only pick whose
   * length the sender knows before it is sent.
   */
  function addAttachment(roomId: string, blob: Blob, name: string, durationMs = 0): void {
    attachmentSeq += 1;
    const mimeType = blob.type || '';
    const row: DraftAttachment = {
      id: 'chat-attachment-' + attachmentSeq,
      blob,
      name,
      size: blob.size || 0,
      kind: attachmentKind(mimeType, name),
      // A picture shows what was picked; the object URL is revoked when the
      // row goes, so a long drafting session does not leak it.
      preview: /^image\//.test(mimeType) ? URL.createObjectURL(blob) : '',
      durationMs,
    };
    draftAttachments.value = {
      ...draftAttachments.value,
      [roomId]: attachmentsFor(roomId).concat([row]),
    };
  }

  function revoke(row: DraftAttachment): void {
    if (row.preview) URL.revokeObjectURL(row.preview);
  }

  function removeAttachment(roomId: string, id: string): void {
    const rows = attachmentsFor(roomId);
    const kept: DraftAttachment[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index].id === id) revoke(rows[index]);
      else kept.push(rows[index]);
    }
    draftAttachments.value = { ...draftAttachments.value, [roomId]: kept };
  }

  /** Drops a room's draft: text and files, after a send or a leave. */
  function clearDraft(roomId: string): void {
    const rows = attachmentsFor(roomId);
    for (let index = 0; index < rows.length; index += 1) revoke(rows[index]);
    const nextText = { ...drafts.value };
    const nextFiles = { ...draftAttachments.value };
    delete nextText[roomId];
    delete nextFiles[roomId];
    drafts.value = nextText;
    draftAttachments.value = nextFiles;
  }

  /** Every room's draft — sign-out wipes them the same way it wipes the data. */
  function clearDrafts(): void {
    const roomIds = Object.keys(draftAttachments.value);
    for (let index = 0; index < roomIds.length; index += 1) {
      const rows = draftAttachments.value[roomIds[index]];
      for (let row = 0; row < rows.length; row += 1) revoke(rows[row]);
    }
    drafts.value = {};
    draftAttachments.value = {};
  }

  /* --- Stickers ---------------------------------------------------------- */

  /** Loads the pack list once per session (or after a failure). */
  async function loadStickerPacks(): Promise<void> {
    if (stickerStatus.value === 'loading' || stickerStatus.value === 'ready') return;
    stickerStatus.value = 'loading';
    try {
      stickerPacks.value = await listStickerPacks();
      stickerStatus.value = 'ready';
    } catch (error) {
      stickerStatus.value = 'error';
    }
  }

  /**
   * The drive file id behind a sticker placeholder, resolving it once and
   * remembering it — a thread of the same sticker pays for one lookup. `''`
   * while unknown, so a bubble can leave the image out rather than show a
   * broken frame.
   */
  function stickerImageFor(placeholder: string): string {
    return stickerImages.value[placeholder] || '';
  }

  async function resolveStickerImage(placeholder: string): Promise<void> {
    if (!placeholder || stickerImages.value[placeholder]) return;
    // Mark it in-flight so a thread of several copies asks once.
    stickerImages.value = { ...stickerImages.value, [placeholder]: '' };
    try {
      const id = await lookupStickerImage(placeholder);
      if (id) stickerImages.value = { ...stickerImages.value, [placeholder]: id };
    } catch (error) {
      // Unknown or private sticker: the bubble keeps its text fallback.
    }
  }

  /* --- Invites, new messages, membership --------------------------------- */

  /** Rooms matching the current filter: all, direct (type 1) or groups. */
  const visibleRooms = computed(() => {
    const list = rooms.value;
    if (filter.value === 'direct') return list.filter((room) => room.type === 1);
    if (filter.value === 'group') return list.filter((room) => room.type !== 1);
    return list;
  });

  const inviteCount = computed(() => invites.value.length);

  function setFilter(next: 'all' | 'direct' | 'group'): void {
    filter.value = next;
  }

  /** Loads pending invitations, best-effort — a failure leaves the last list. */
  async function loadInvites(): Promise<void> {
    if (!signedIn.value) return;
    try {
      invites.value = await listChatInvites();
    } catch (error) {
      // Keep whatever is already known.
    }
  }

  /** Accepts an invite: the room joins the list, the invite drops. */
  async function acceptInvite(roomId: string): Promise<boolean> {
    try {
      await acceptChatInvite(roomId);
    } catch (error) {
      return false;
    }
    invites.value = invites.value.filter((invite) => invite.roomId !== roomId);
    stale.value = true;
    await loadRooms();
    return true;
  }

  /** Declines an invite; the row drops locally either way. */
  async function declineInvite(roomId: string): Promise<boolean> {
    try {
      await declineChatInvite(roomId);
    } catch (error) {
      return false;
    }
    invites.value = invites.value.filter((invite) => invite.roomId !== roomId);
    return true;
  }

  /**
   * Opens the one-to-one room with an account, creating it when none exists,
   * and returns it for the caller to push. `null` when the server refused.
   */
  async function startDirect(accountId: string): Promise<ChatRoom | null> {
    try {
      const room = await startDirectChat(accountId);
      if (!room) return null;
      if (!rooms.value.some((item) => item.id === room.id)) {
        rooms.value = [...rooms.value, room];
      }
      stale.value = true;
      return room;
    } catch (error) {
      return null;
    }
  }

  /** Account search for the new-message picker; `[]` on failure. */
  async function findAccounts(query: string): Promise<ChatAccount[]> {
    if (!query.trim()) return [];
    try {
      return await searchAccounts(query.trim());
    } catch (error) {
      return [];
    }
  }

  /** Clears every unread badge (the bulk HTTP read path). */
  async function readAll(): Promise<boolean> {
    try {
      await markAllChatRead();
    } catch (error) {
      return false;
    }
    const next: Record<string, ChatSummary> = {};
    const roomIds = Object.keys(summaries.value);
    for (let index = 0; index < roomIds.length; index += 1) {
      const roomId = roomIds[index];
      next[roomId] = { ...summaries.value[roomId], unreadCount: 0, hasUnread: false };
    }
    summaries.value = next;
    void persist('summaries');
    return true;
  }

  /** Drops every local trace of chat — sign-out wipes the account's cache. */
  function reset(): void {
    rooms.value = [];
    roomStatus.value = 'idle';
    summaries.value = {};
    messages.value = {};
    messageStatus.value = {};
    messageOffsets.value = {};
    olderStatus.value = {};
    olderEnd.value = {};
    clearDrafts();
    stickerPacks.value = [];
    stickerStatus.value = 'idle';
    sendError.value = '';
    activeRoomId.value = '';
    invites.value = [];
    filter.value = 'all';
    stale.value = true;
    // The realtime channel is the account's too: close it so a signed-out
    // session cannot keep receiving pushes on a dead token.
    closeChatWs();
    // No coalesced write may outlive the account that scheduled it: the cache
    // is being cleared, and a late write could repopulate it with rows of a
    // session already gone.
    const pending = Array.from(pendingMessagePersists.values());
    for (let index = 0; index < pending.length; index += 1) window.clearTimeout(pending[index]);
    pendingMessagePersists.clear();
    if (db) {
      const handle = db;
      db = null;
      dbPromise = null;
      void handle.clear();
    }
  }

  // Chat is account-scoped: the moment the session ends, drop every cached
  // room, message and draft so the next sign-in cannot see the previous
  // account's conversations. Watched here rather than in the account store to
  // keep the reset with the data it clears.
  watch(phase, (next, previous) => {
    if (previous === 'signed-in' && next !== 'signed-in') reset();
  });

  /* --- Realtime --------------------------------------------------------- */

  let realtimeWired = false;

  function wireRealtime(): void {
    if (realtimeWired) return;
    realtimeWired = true;
    onChatWsPacket((packet) => {
      const payload = packet.data;
      if (!payload) return;

      if (packet.type === 'messages.new') {
        const message = normalizeChatMessage(payload);
        // The same rule the thread merges by: an event row is not a message, so
        // it never lands in a thread and never becomes a room's preview or its
        // unread count.
        if (!message || !hasChatMessageContent(message)) return;
        applyLiveMessage(message);
      } else if (
        packet.type === 'messages.update' ||
        packet.type === 'messages.sync.file' ||
        packet.type === 'messages.sync.finalize' ||
        packet.type === 'messages.sync.links'
      ) {
        const message = normalizeChatMessage(payload);
        if (!message) return;
        applyLiveMessage(message);
      } else if (packet.type === 'messages.delete') {
        // The deletion event carries the target's id in `meta.message_id`.
        const targetId =
          payload.meta && typeof payload.meta === 'object' && typeof (payload.meta as Record<string, unknown>).message_id === 'string'
            ? ((payload.meta as Record<string, unknown>).message_id as string)
            : '';
        if (targetId) dropMessage(targetId);
      }
    });
  }

  /** Merges a live message: into the open thread, or as unread + preview. */
  function applyLiveMessage(message: ChatMessage): void {
    if (message.roomId === activeRoomId.value) {
      // A merge that changed nothing (the gateway re-pushing a row the send
      // already merged) must not slide the window or touch the cache.
      if (!mergeMessages(activeRoomId.value, [{ ...message, status: 'sent' }])) return;
      // The thread slides towards the present, so the oldest rows fall out.
      capOldest(activeRoomId.value);
      scheduleMessagePersist(activeRoomId.value);
      return;
    }
    const summary = summaries.value[message.roomId];
    summaries.value = {
      ...summaries.value,
      [message.roomId]: {
        unreadCount: (summary?.unreadCount || 0) + 1,
        hasUnread: true,
        lastMessage: message,
      },
    };
    void persist('summaries');
  }

  /** Removes a deleted message from the thread it lives in, if loaded. */
  function dropMessage(messageId: string): void {
    let changed = false;
    const next: Record<string, ChatMessage[]> = {};
    const removed: string[] = [];
    const roomIds = Object.keys(messages.value);
    for (let index = 0; index < roomIds.length; index += 1) {
      const roomId = roomIds[index];
      const thread = messages.value[roomId];
      const kept = thread.filter((message) => message.id !== messageId);
      if (kept.length !== thread.length) {
        changed = true;
        removed.push(roomId);
      }
      next[roomId] = kept;
    }
    if (!changed) return;
    messages.value = next;
    // The room's rows renumber inwards, so the next older page starts one row
    // earlier — otherwise paging would step over the row after the deleted one.
    for (let index = 0; index < removed.length; index += 1) {
      const roomId = removed[index];
      setOffset(roomId, Math.max(0, (messageOffsets.value[roomId] || 0) - 1));
    }
    void persist('messages', activeRoomId.value);
  }

  /**
   * Marks a room as the one on screen: its live messages merge into the
   * thread, and every other room's live messages bump unread. Pass `''` to
   * leave the room — the connection stays open, because the gateway pushes
   * `messages.new` for any of the user's rooms, which is what keeps the room
   * list's unread badges live.
   */
  function setActiveRoom(roomId: string): void {
    wireRealtime();
    if (activeRoomId.value === roomId) return;
    if (activeRoomId.value) unsubscribeChatRoom(activeRoomId.value);
    activeRoomId.value = roomId;
    // A stale failure notice belongs to the room it happened in.
    sendError.value = '';
    if (roomId) {
      subscribeChatRoom(roomId);
    } else if (signedIn.value) {
      void connectChatWs();
    }
  }

  return {
    rooms,
    roomStatus,
    summaries,
    messages,
    messageStatus,
    messageOffsets,
    olderStatus,
    olderEnd,
    drafts,
    draftAttachments,
    attachmentsFor,
    addAttachment,
    removeAttachment,
    clearDraft,
    sendError,
    storageError,
    stale,
    loadedPhase,
    activeRoomId,
    setActiveRoom,
    invites,
    inviteCount,
    filter,
    visibleRooms,
    setFilter,
    loadInvites,
    acceptInvite,
    declineInvite,
    startDirect,
    findAccounts,
    stickerPacks,
    stickerStatus,
    loadStickerPacks,
    stickerImageFor,
    resolveStickerImage,
    sendSticker,
    react,
    edit,
    deleteMessage,
    readAll,
    signedIn,
    selfAccountId,
    loadRooms,
    loadRoom,
    loadNewest,
    loadOlder,
    send,
    markRead,
    draftFor,
    setDraft,
    reset,
  };
});
