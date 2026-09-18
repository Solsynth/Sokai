/**
 * The Solar Network Sphere API, as far as this app reads it.
 *
 * Reads are anonymous: the public `/sphere/...` routes need no
 * `Authorization` header, and the server limits anonymous responses to public,
 * published, non-draft posts anyway. The account-scoped calls — the countdown
 * for the signed-in identity, the composer's publisher list, and post creation
 * — send the live session's bearer token and answer with the session's own
 * data. No proxy — on device the privileged `systemXHR` path bypasses CORS
 * entirely (see `~/src/kaios/xhr.ts`).
 */

import { request, type ApiResponse, type HttpError, type RequestOptions } from '~/src/kaios/xhr.js';
import { bearerToken } from '~/src/kaios/session.js';
import {
  fileIdOf,
  normalizeAccountStatus,
  normalizeAppNotificationList,
  normalizeCalendarMonth,
  normalizeChatAccountList,
  normalizeChatInviteList,
  normalizeChatMessage,
  normalizeChatMessageList,
  normalizeChatRoom,
  normalizeChatRoomList,
  normalizeChatSummaryMap,
  normalizeCheckInResult,
  normalizeCountdownList,
  normalizeFortuneSaying,
  normalizeStickerPackList,
  normalizePost,
  normalizePostList,
  normalizePublisherList,
  type AccountStatus,
  type CheckInResult,
  type FortuneSaying,
  type AppNotification,
  type CalendarDay,
  type ChatAccount,
  type ChatInvite,
  type ChatMessage,
  type ChatRoom,
  type ChatSummary,
  type Countdown,
  type Post,
  type Publisher,
  type StickerPack,
} from '~/src/api/models.js';

export const API_BASE_URL = 'https://api.solian.app';

const DEFAULT_TAKE = 20;

/** The room list is walked in pages of this size; 100 is the clients' batch. */
const CHAT_ROOM_PAGE = 100;
/** Ceiling on that walk: 1000 rooms is far past a handset chat list. */
const CHAT_ROOM_PAGES = 10;

/**
 * Headers for an API call. Anonymous callers send only `Accept`; a live
 * session adds `Authorization: Bearer <token>` (refreshed lazily by the
 * session module when near expiry), which lifts the server's anonymous
 * limits — friends-only, unlisted and draft posts become visible, and
 * per-account routes answer.
 *
 * `forceRefresh` mints a new bearer even when the stored one still looks live;
 * see `authedRequest`.
 */
async function apiHeaders(forceRefresh = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = await bearerToken(forceRefresh);
  if (token) headers.Authorization = 'Bearer ' + token;
  return headers;
}

/**
 * One authenticated call.
 *
 * The bearer is resolved at send time, so the ordinary expiry case never leaves
 * a request carrying a dead one. What that cannot see is a session the server
 * has stopped accepting while the stored expiry is still in the future — a
 * sign-out from another device, a revoked session — and that only ever shows up
 * as a refused request. So a 401 is answered once: force a refresh, retry. If
 * the refresh cannot revive the session, `bearerToken` has already dropped it,
 * which leaves no bearer to retry with and the original refusal for the caller
 * — the sign-in gate the screens already key off. Anonymous callers never had a
 * bearer, so they are never retried.
 *
 * Retrying is safe because a 401 is refused at authentication: the first
 * attempt had no effect to duplicate.
 */
export async function authedRequest(url: string, options: RequestOptions = {}): Promise<ApiResponse> {
  const headers = await apiHeaders();
  try {
    return await request(url, { ...options, headers: { ...options.headers, ...headers } });
  } catch (error) {
    if ((error as HttpError).status !== 401) throw error;
    const refreshed = await apiHeaders(true);
    if (!refreshed.Authorization) throw error;
    return request(url, { ...options, headers: { ...options.headers, ...refreshed } });
  }
}

/**
 * A published file as an `<img>` can load it, served by the server's `thumb`
 * preset: small enough for a feed row, and converted to JPEG — KaiOS 2.5's
 * Gecko 48 renders the compressed WebP the full-size route answers poorly.
 * The endpoint answers `307` to a signed object-storage URL, so no CORS or
 * `systemXHR` involvement is needed: plain image loading is cross-origin by
 * design, and the KaiOS privileged CSP starts at `default-src * data: blob:`.
 */
export function fileUrl(id: string): string {
  return API_BASE_URL + '/drive/files/' + encodeURIComponent(id) + '?preset=thumb';
}

/**
 * The untouched original — WebP for uploaded images, full resolution — for the
 * lightbox that shows it full-size and lets the user zoom. Display surfaces
 * (rows, detail, avatars, inline photos) use `fileUrl`'s thumb preset instead.
 */
export function originalUrl(id: string): string {
  return API_BASE_URL + '/drive/files/' + encodeURIComponent(id) + '?original=1';
}

/**
 * A media URL the API handed back in a message's meta (a voice note's
 * `voice_url`) as something the platform can load: absolute on some
 * deployments, server-relative on others, and only this module knows the base.
 */
export function resolveMediaUrl(url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  return API_BASE_URL + (url.charAt(0) === '/' ? url : '/' + url);
}

/**
 * The server-generated thumbnail, as an `<img>` can load it. For a video this
 * is a small poster frame — never the multi-megabyte original `originalUrl`
 * points at — so a feed row can afford to show it. A 404 (no thumbnail on the
 * server) just falls back to the attachment's text line.
 */
export function thumbnailUrl(id: string): string {
  return API_BASE_URL + '/drive/files/' + encodeURIComponent(id) + '?thumbnail=1';
}

/** Pagination is `offset` + `take`. The body is a bare array; the row count lives in `x-total`. */
function readTotal(headers: Record<string, string>): number {
  const total = parseInt(headers ? headers['x-total'] : '', 10);
  return Number.isNaN(total) ? 0 : total;
}

/**
 * The post feed, or its search when `query` is given (the server's semantic
 * engine answers it — which is why a search can take a few seconds). A chain
 * member is dropped: it is a continuation read under its head, and as a row of
 * its own it is a sentence with its beginning cut off. The head stays, and its
 * count says how many follow it — the rule the Solian client's post list
 * applies (`posts_pod.dart`).
 */
export async function listPosts({
  take = DEFAULT_TAKE,
  offset = 0,
  query = '',
}: {
  take?: number;
  offset?: number;
  query?: string;
} = {}): Promise<{ posts: Post[]; total: number }> {
  let url =
    API_BASE_URL + '/sphere/posts?take=' + take + '&offset=' + offset + '&replies=false&orderDesc=true';
  if (query) url += '&query=' + encodeURIComponent(query);

  const response = await authedRequest(url);
  const posts = normalizePostList(response.data).filter((post) => !post.chainedToId);
  return { posts, total: readTotal(response.headers) };
}

/** `null` when the payload is not a post. */
export async function getPost(id: string): Promise<Post | null> {
  const url = API_BASE_URL + '/sphere/posts/' + encodeURIComponent(id);

  const response = await authedRequest(url);
  return normalizePost(response.data);
}

/**
 * Whose calendar this app reads. Signed in, the account's own calendar answers
 * (`me`), which is where its own events live; anonymous, the name-scoped route
 * answers — the public events of the developer account, mixed with the
 * network's own notable days.
 */
const PUBLIC_CALENDAR_ACCOUNT = 'solsynth';

/**
 * One passport calendar read. `route` is the path after the account segment
 * (`/calendar`, `/calendar/countdown`). The account's own route is
 * per-account and answers 401 to a session that has gone, so a failure falls
 * back to the public calendar rather than leaving the screen empty.
 */
async function readCalendar(route: string, query: string): Promise<unknown> {
  const token = await bearerToken();
  if (token) {
    try {
      const url = calendarUrl('me', route, query);
      const response = await authedRequest(url);
      return response.data;
    } catch (error) {
      // Fall through to the public calendar.
    }
  }

  const response = await authedRequest(calendarUrl(PUBLIC_CALENDAR_ACCOUNT, route, query));
  return response.data;
}

function calendarUrl(account: string, route: string, query: string): string {
  return API_BASE_URL + '/passport/accounts/' + encodeURIComponent(account) + route + '?' + query;
}

/** Soonest first, as the server orders them. */
export async function listCountdowns({ take = 3 } = {}): Promise<Countdown[]> {
  return normalizeCountdownList(await readCalendar('/calendar/countdown', 'take=' + take));
}

/**
 * A month of the event calendar, the full-calendar screen's own read: one row
 * per day that has something on it, each holding the day's events and notable
 * days. The dashboard's one-line countdown is a separate, smaller call.
 */
export async function listCalendarMonth(year: number, month: number): Promise<CalendarDay[]> {
  const query = 'year=' + year + '&month=' + month + '&includeNotableDays=true';
  return normalizeCalendarMonth(await readCalendar('/calendar', query));
}

/** A post's replies, offset-paginated like the feed. */
export async function listReplies(
  id: string,
  { take = DEFAULT_TAKE, offset = 0 } = {},
): Promise<{ posts: Post[]; total: number }> {
  const url =
    API_BASE_URL + '/sphere/posts/' + encodeURIComponent(id) + '/replies?take=' + take + '&offset=' + offset;

  const response = await authedRequest(url);
  return { posts: normalizePostList(response.data), total: readTotal(response.headers) };
}

/**
 * The signed-in account's own publishers (`?mine=true`), in the order the
 * server lists them. A post is published under a publisher, and the compose
 * screen defaults to the first — the same default FloatLand's composer picks
 * when its publisher list loads.
 */
export async function listMyPublishers(): Promise<Publisher[]> {
  const url = API_BASE_URL + '/sphere/publishers?mine=true&take=100';
  const response = await authedRequest(url);
  return normalizePublisherList(response.data);
}

/**
 * Uploads a file to the account's drive and returns its id, or `null` when the
 * server did not answer with one. The endpoint is the same direct upload the
 * FloatLand composer's proxy forwards to; the bearer token authorises it.
 * `xhr.ts` passes the FormData through untouched so the browser sets the
 * multipart boundary.
 */
export async function uploadFile(file: Blob, name: string): Promise<string | null> {
  const form = new FormData();
  form.append('file', file, name);

  const response = await authedRequest(API_BASE_URL + '/drive/files/upload/direct', { method: 'POST', body: form });

  // The response nests the created file under several shapes across API
  // versions; FloatLand accepts the same chain.
  const data = response.data as Record<string, any> | null;
  let created: unknown = null;
  if (data && typeof data === 'object') {
    if (data.file) created = data.file;
    else if (data.file_info) created = data.file_info;
    else if (data.data && data.data.file) created = data.data.file;
    else if (data.data && data.data.id) created = data.data;
    else if (data.id) created = data;
  }
  const id = created && typeof created === 'object' ? (created as Record<string, any>).id : null;
  return typeof id === 'string' ? id : null;
}

/**
 * Publishes a post (`type 0`) under the named publisher, with optional
 * uploaded attachment ids and an optional threading relationship — the reply's
 * `replied_post_id` or the quote's `forwarded_post_id`, at most one (mirrors
 * Solian's compose payload). The payload defaults to public, no title, tags or
 * categories; the server fills in the rest (timestamps, counts, id).
 */
export async function createPost(
  publisher: string,
  content: string,
  attachments: string[] = [],
  relationship: { repliedPostId?: string; forwardedPostId?: string } = {},
): Promise<Post | null> {
  const url = API_BASE_URL + '/sphere/posts?pub=' + encodeURIComponent(publisher);
  const body: Record<string, unknown> = {
    content,
    visibility: 0,
    language: null,
    tags: [],
    categories: [],
    attachments,
    type: 0,
  };
  if (relationship.repliedPostId) body.replied_post_id = relationship.repliedPostId;
  if (relationship.forwardedPostId) body.forwarded_post_id = relationship.forwardedPostId;

  const response = await authedRequest(url, { method: 'POST', body });
  return normalizePost(response.data);
}

/**
 * Updates an existing post's editable fields (content, attachments), scoped to
 * its publisher the same way creation is. Requires a signed-in session that
 * owns the publisher.
 */
export async function updatePost(
  publisher: string,
  id: string,
  content: string,
  attachments: string[] = [],
): Promise<Post | null> {
  const url = API_BASE_URL + '/sphere/posts/' + encodeURIComponent(id) + '?pub=' + encodeURIComponent(publisher);
  const response = await authedRequest(url, {
    method: 'PATCH',
    body: {
      content,
      visibility: 0,
      attachments,
      type: 0,
    },
  });
  return normalizePost(response.data);
}

/** Deletes a post the signed-in session owns. */
export async function deletePost(id: string): Promise<void> {
  const url = API_BASE_URL + '/sphere/posts/' + encodeURIComponent(id);
  await authedRequest(url, { method: 'DELETE' });
}

/**
 * Reacts to a post. The endpoint toggles: a reaction already present is taken
 * back, so `true` means the reaction now sits on the post (added), `false`
 * that it was removed. Requires a signed-in session — anonymous callers get a
 * 401, which the reaction picker surfaces as the sign-in prompt.
 */
export async function reactToPost(
  id: string,
  symbol: string,
  attitude: number,
): Promise<boolean> {
  const url = API_BASE_URL + '/sphere/posts/' + encodeURIComponent(id) + '/reactions';
  const response = await authedRequest(url, { method: 'POST', body: { symbol, attitude } });
  return response.status !== 204;
}

/* --- Chat --------------------------------------------------------------- */

/**
 * The signed-in account's chat rooms. The live route is `GET /messager/chat`
 * — **not** the `/messager/chat/rooms` the SDK's `ChatApi` still points at,
 * which 404s; the same correction appears in the iOS client
 * (`SharedConstants.API.chatRooms`). The payload is an object with a `rooms`
 * array (`{ rooms: [...] }`, as the iOS `ChatRoomsResponse` decodes), so the
 * normalizer accepts that and a bare array for mixed-version deployments.
 *
 * Chat is account-scoped: anonymous callers get a 401, which the chat screen
 * surfaces as the sign-in prompt.
 */
export async function listChatRooms({
  take = DEFAULT_TAKE,
  offset = 0,
  query = '',
}: {
  take?: number;
  offset?: number;
  query?: string;
} = {}): Promise<{ rooms: ChatRoom[]; total: number }> {
  let url = API_BASE_URL + '/messager/chat?take=' + take + '&offset=' + offset;
  // The same route answers the server-side room search (`?query=`, what the
  // watch's `searchChatRooms` calls) — no separate endpoint.
  if (query) url += '&query=' + encodeURIComponent(query);

  const response = await authedRequest(url);
  const rooms = normalizeChatRoomList(response.data);
  // The route may not paginate; without `x-total` the loaded page is the whole
  // list, which is what `listAllChatRooms` then stops on.
  const total = readTotal(response.headers) || rooms.length;
  return { rooms, total };
}

/**
 * The whole room list, walked page by page. The chat list is presented whole
 * (the watch and Flutter tiles both render it as one list), so the server's
 * page boundary belongs here rather than in the UI. Stops on the first short
 * page, and at the page guard so a runaway count cannot stall a handset.
 */
export async function listAllChatRooms(): Promise<ChatRoom[]> {
  const loaded: ChatRoom[] = [];
  for (let index = 0; index < CHAT_ROOM_PAGES; index += 1) {
    const page = await listChatRooms({ take: CHAT_ROOM_PAGE, offset: index * CHAT_ROOM_PAGE });
    for (let row = 0; row < page.rooms.length; row += 1) loaded.push(page.rooms[row]);
    if (page.rooms.length < CHAT_ROOM_PAGE) break;
  }
  return loaded;
}

/**
 * The room-list's unread state, keyed by room id. `last_message` can be a
 * `messages.delete`-style event row with no content — the row normalizer keeps
 * it for the timestamp, the view renders an empty preview.
 */
export async function getChatSummary(): Promise<Record<string, ChatSummary>> {
  const url = API_BASE_URL + '/messager/chat/summary';
  const response = await authedRequest(url);
  return normalizeChatSummaryMap(response.data);
}

/**
 * A single room, for the thread header when the room list has not loaded it
 * (a direct entry, or a room beyond the loaded list page). `GET
 * /messager/chat/{id}` answers a room for anonymous callers too (it backs the
 * public room preview), so a signed-out open is not a hard failure.
 */
export async function getChatRoom(roomId: string): Promise<ChatRoom | null> {
  const url = API_BASE_URL + '/messager/chat/' + encodeURIComponent(roomId);

  const response = await authedRequest(url);
  return normalizeChatRoom(response.data);
}

/**
 * A room's messages, offset-paginated. `GET /messager/chat/{roomId}/messages`
 * (again without the SDK's `/rooms` segment), newest-first at offset 0, so
 * page 1 is the newest page — the same direction as the feed. The row count
 * comes back in `x-total`.
 */
export async function listChatMessages(
  roomId: string,
  { take = DEFAULT_TAKE, offset = 0 } = {},
): Promise<{ messages: ChatMessage[]; total: number }> {
  const url =
    API_BASE_URL +
    '/messager/chat/' +
    encodeURIComponent(roomId) +
    '/messages?take=' +
    take +
    '&offset=' +
    offset;

  const response = await authedRequest(url);
  return {
    messages: normalizeChatMessageList(response.data),
    total: readTotal(response.headers),
  };
}

/**
 * Sends a text message to a room (`POST /messager/chat/{roomId}/messages`).
 * The server fills in timestamps, id and sender; a `client_message_id` lets
 * the sender reconcile the optimistic row with the server's echo. Requires a
 * signed-in session.
 *
 * `attachmentIds` are already-uploaded drive files (`uploadFile`), sent as the
 * wire's `attachments_id` — the field both other clients use (Flutter's
 * `_buildPayload`, the watch's `sendChatMessage`), plus the `meta` object the
 * server expects alongside it.
 *
 * `repliedMessageId` is the message this one answers (`replied_message_id`,
 * the field Flutter's sender writes for a reply); omitted for a plain message.
 */
export async function sendChatMessage(
  roomId: string,
  content: string,
  clientMessageId: string,
  attachmentIds: string[] = [],
  repliedMessageId = '',
): Promise<ChatMessage | null> {
  const url =
    API_BASE_URL + '/messager/chat/' + encodeURIComponent(roomId) + '/messages';
  const body: Record<string, unknown> = {
    content,
    attachments_id: attachmentIds,
    meta: {},
    client_message_id: clientMessageId,
  };
  if (repliedMessageId) body.replied_message_id = repliedMessageId;
  const response = await authedRequest(url, { method: 'POST', body });
  return normalizeChatMessage(response.data);
}

/**
 * Sends a voice message (`POST /messager/chat/{roomId}/messages/voice`), the
 * dedicated endpoint the watch's `sendVoiceMessage` and Flutter's
 * `MessageSender.sendVoiceMessage` both use. The take uploads in the same
 * request as the send: a multipart body carrying the bytes as `file`, the
 * measured length as `durationMs`, and the reconciliation id as
 * `client_message_id` — the wire shape the iOS client writes. The answer is
 * the created `voice` message, whose `meta.voice_url` and `meta.duration_ms`
 * the normalizer reads into `voiceUrl`/`voiceDurationMs`.
 */
export async function sendVoiceMessage(
  roomId: string,
  file: Blob,
  name: string,
  durationMs: number,
  clientMessageId: string,
): Promise<ChatMessage | null> {
  const form = new FormData();
  form.append('file', file, name);
  form.append('client_message_id', clientMessageId);
  form.append('durationMs', String(durationMs));

  const response = await authedRequest(
    API_BASE_URL + '/messager/chat/' + encodeURIComponent(roomId) + '/messages/voice',
    { method: 'POST', body: form },
  );
  return normalizeChatMessage(response.data);
}

/**
 * Edits a message's text (`PATCH /messager/chat/{roomId}/messages/{messageId}`,
 * the route Flutter's `MessageRepository.editMessage` uses). The message's
 * attachments are sent back under `attachments_id` — the server replaces the
 * list with what the payload names, so the already-uploaded originals are
 * what keep the media on the message.
 */
export async function editChatMessage(
  roomId: string,
  messageId: string,
  content: string,
  attachmentIds: string[] = [],
): Promise<ChatMessage | null> {
  const url =
    API_BASE_URL +
    '/messager/chat/' +
    encodeURIComponent(roomId) +
    '/messages/' +
    encodeURIComponent(messageId);
  const response = await authedRequest(url, {
    method: 'PATCH',
    body: { content, attachments_id: attachmentIds, meta: {} },
  });
  return normalizeChatMessage(response.data);
}

/** Deletes a message (`DELETE /messager/chat/{roomId}/messages/{messageId}`). */
export async function deleteChatMessage(roomId: string, messageId: string): Promise<void> {
  const url =
    API_BASE_URL +
    '/messager/chat/' +
    encodeURIComponent(roomId) +
    '/messages/' +
    encodeURIComponent(messageId);
  await authedRequest(url, { method: 'DELETE' });
}

/**
 * Reacts to a message (`POST /messager/chat/{roomId}/messages/{messageId}/reactions`,
 * the route Flutter's `reactToMessage` uses). The endpoint toggles exactly like
 * the post one: a reaction already present is taken back, so `true` means the
 * reaction now sits on the message (added), `false` that it was removed.
 */
export async function reactToChatMessage(
  roomId: string,
  messageId: string,
  symbol: string,
  attitude: number,
): Promise<boolean> {
  const url =
    API_BASE_URL +
    '/messager/chat/' +
    encodeURIComponent(roomId) +
    '/messages/' +
    encodeURIComponent(messageId) +
    '/reactions';
  const response = await authedRequest(url, {
    method: 'POST',
    body: { symbol, attitude },
  });
  return response.status !== 204;
}

/* --- Stickers ----------------------------------------------------------- */

/**
 * The sticker packs to offer in the picker. The account's own packs come first
 * (`GET /sphere/stickers/me`, the route both other clients read); when the
 * account has none — a fresh one, or an anonymous host — the public
 * marketplace (`GET /sphere/stickers`, which answers anonymously) stands in,
 * so the picker is never a dead end.
 */
export async function listStickerPacks(): Promise<StickerPack[]> {
  try {
    const mine = await authedRequest(API_BASE_URL + '/sphere/stickers/me');
    const owned = normalizeStickerPackList(mine.data);
    if (owned.length) return owned;
  } catch (error) {
    // Fall through to the marketplace.
  }

  const response = await request(API_BASE_URL + '/sphere/stickers?take=20');
  return normalizeStickerPackList(response.data);
}

/**
 * The drive file id behind a sticker placeholder (`:prefix+slug:`), resolved
 * from `GET /sphere/stickers/lookup/{placeholder}` — the route Flutter's
 * markdown uses. The `/open` sibling would be one request, but it redirects to
 * the *original* file (a 1080px PNG, ~500KB), which a 240px screen has no use
 * for: the id lets the bubble load the server's `thumb` preset like every
 * other picture in the app. `null` when the sticker is unknown or private.
 */
export async function lookupStickerImage(placeholder: string): Promise<string | null> {
  const url =
    API_BASE_URL + '/sphere/stickers/lookup/' + encodeURIComponent(placeholder);
  const response = await authedRequest(url);
  return fileIdOf(response.data, 'image');
}


/* --- Chat rooms: invites, direct messages, membership ------------------- */

/** Pending invitations to rooms (`GET /messager/chat/invites`). */
export async function listChatInvites(): Promise<ChatInvite[]> {
  const response = await authedRequest(API_BASE_URL + '/messager/chat/invites');
  return normalizeChatInviteList(response.data);
}

/** Accepts an invitation; the server joins the account to the room. */
export async function acceptChatInvite(roomId: string): Promise<void> {
  const url =
    API_BASE_URL + '/messager/chat/invites/' + encodeURIComponent(roomId) + '/accept';
  await authedRequest(url, { method: 'POST' });
}

/** Declines an invitation. */
export async function declineChatInvite(roomId: string): Promise<void> {
  const url =
    API_BASE_URL + '/messager/chat/invites/' + encodeURIComponent(roomId) + '/decline';
  await authedRequest(url, { method: 'POST' });
}

/**
 * Opens (or starts) the one-to-one room with an account. `GET
 * /messager/chat/direct/{accountId}` is get-or-create; a `404` means no
 * conversation exists yet, so it is created with the related user id — the
 * flow the Flutter client's new-message action uses.
 */
export async function startDirectChat(accountId: string): Promise<ChatRoom | null> {
  const base = API_BASE_URL + '/messager/chat/direct/';
  try {
    const response = await authedRequest(base + encodeURIComponent(accountId));
    return normalizeChatRoom(response.data);
  } catch (error) {
    // `request()` rejects non-2xx with the HTTP status attached; a 404 here
    // means no conversation exists yet, anything else is a real failure.
    if ((error as HttpError).status !== 404) throw error;
  }

  const response = await authedRequest(API_BASE_URL + '/messager/chat/direct', {
    method: 'POST',
    body: { related_user_id: accountId },
  });
  return normalizeChatRoom(response.data);
}

/**
 * Account search for the new-message picker. The public Stargate route answers
 * anonymous callers too, so a signed-out search still returns rows.
 */
export async function searchAccounts(query: string): Promise<ChatAccount[]> {
  const url = API_BASE_URL + '/stargate/accounts/search?query=' + encodeURIComponent(query);
  const response = await authedRequest(url);
  return normalizeChatAccountList(response.data);
}

/**
 * Clears every room's unread state in one call. The one HTTP read path the
 * server exposes: per-room receipts are gateway packets, so this is the
 * bulk action, not the per-room one.
 */
export async function markAllChatRead(): Promise<void> {
  await authedRequest(API_BASE_URL + '/messager/chat/read-all', { method: 'POST' });
}

/* --- Notifications ------------------------------------------------------ */

/**
 * The account's notification inbox (`GET /metoer/notifications`), offset-
 * paginated like the feed: the rows are a bare array and the count lives in
 * `x-total`.
 *
 * The read is deliberately not scoped with `?app=`: this app has no tenant
 * scope of its own, the account's whole inbox is what the screen is for, and
 * every topic renders — the row picks its glyph by the topic — so no row that
 * arrives here is one the app cannot draw.
 */
export async function listNotifications({
  take = DEFAULT_TAKE,
  offset = 0,
}: {
  take?: number;
  offset?: number;
} = {}): Promise<{ notifications: AppNotification[]; total: number }> {
  const url = API_BASE_URL + '/metoer/notifications?take=' + take + '&offset=' + offset;

  const response = await authedRequest(url);
  return {
    notifications: normalizeAppNotificationList(response.data),
    total: readTotal(response.headers),
  };
}

/** Marks one notification read (`POST /metoer/notifications/{id}/read`). */
export async function markNotificationRead(id: string): Promise<void> {
  const url = API_BASE_URL + '/metoer/notifications/' + encodeURIComponent(id) + '/read';
  await authedRequest(url, { method: 'POST' });
}

/**
 * Marks every notification read in one call — the inbox's only bulk read path
 * (the server exposes no per-page receipt), which is why the screen's right
 * softkey is this and not a per-row one.
 */
export async function markAllNotificationsRead(): Promise<void> {
  await authedRequest(API_BASE_URL + '/metoer/notifications/all/read', { method: 'POST' });
}

/* --- Account status ------------------------------------------------------ */

const STATUS_URL = API_BASE_URL + '/passport/accounts/me/statuses';

/**
 * The signed-in account's presence status. `null` when none is set — the
 * endpoint answers 404 then, which is the API's own "no status" signal (the
 * watch client treats the same 404 as nil).
 */
export async function fetchAccountStatus(): Promise<AccountStatus | null> {
  try {
    const response = await authedRequest(STATUS_URL);
    return normalizeAccountStatus(response.data);
  } catch (error) {
    if ((error as HttpError).status === 404) return null;
    throw error;
  }
}

/** What the status composer edits; the API layer owns the wire shape. */
export interface StatusDraft {
  /** 0 online, 1 busy, 2 do-not-disturb, 3 invisible. */
  type: number;
  /** 0 positive, 1 neutral, 2 negative. */
  attitude: number;
  /** The custom label; '' to leave it out. */
  label: string;
  /** The emoji symbol; '' to leave it out. */
  symbol: string;
  /** Epoch ms the status auto-clears at; 0 for never. */
  clearedAt: number;
}

/**
 * Creates or updates the custom status: POST when none is customized, PATCH
 * when one exists — they are different rows server-side, and a PATCH against
 * nothing would 404. `editing` is the caller's read of `is_customized` from a
 * fresh fetch, the same method-choice the watch client makes.
 */
export async function saveAccountStatus(draft: StatusDraft, editing: boolean): Promise<void> {
  const body: Record<string, unknown> = {
    attitude: draft.attitude,
    type: draft.type,
  };
  if (draft.label.trim()) body.label = draft.label.trim();
  if (draft.symbol.trim()) body.symbol = draft.symbol.trim();
  if (draft.clearedAt > 0) body.cleared_at = new Date(draft.clearedAt).toISOString();

  await authedRequest(STATUS_URL, { method: editing ? 'PATCH' : 'POST', body });
}

/** Clears the custom status; a 204 is the healthy answer. */
export async function clearAccountStatus(): Promise<void> {
  await authedRequest(STATUS_URL, { method: 'DELETE' });
}

/* --- Check-in & fortune --------------------------------------------------- */

const CHECK_IN_URL = API_BASE_URL + '/passport/accounts/me/check-in?version=2';

/**
 * Today's check-in result, or `null` when the account has not checked in
 * today — the endpoint answers 404 then, which is the API's own "no check-in"
 * signal (the watch client treats the same 404 as nil).
 */
export async function fetchCheckInResult(): Promise<CheckInResult | null> {
  try {
    const response = await authedRequest(CHECK_IN_URL);
    return normalizeCheckInResult(response.data);
  } catch (error) {
    if ((error as HttpError).status === 404) return null;
    throw error;
  }
}

/**
 * Performs today's check-in (`POST /passport/accounts/me/check-in?version=2`)
 * and returns the fresh result. `null` when the body does not parse as a
 * check-in result — the caller treats that as a failed check-in.
 */
export async function checkIn(): Promise<CheckInResult | null> {
  const response = await authedRequest(CHECK_IN_URL, { method: 'POST' });
  return normalizeCheckInResult(response.data);
}

/**
 * Today's fortune saying (`GET /passport/fortune/daily`). Advisory: a failure
 * returns `null` rather than throwing, mirroring the watch client's "daily
 * fortune is non-fatal" handling.
 */
export async function fetchDailyFortune(): Promise<FortuneSaying | null> {
  try {
    const response = await authedRequest(API_BASE_URL + '/passport/fortune/daily');
    return normalizeFortuneSaying(response.data);
  } catch (error) {
    return null;
  }
}
