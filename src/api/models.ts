/**
 * Wire → app models for Solar Network posts.
 *
 * A hand-written allowlist rather than a generic snake_case → camelCase
 * recursion: it is smaller, faster, and it documents exactly which API fields
 * this app depends on. Field names and enum values were read off live
 * responses from `https://api.solian.app` — the HTTP enums are 0-based
 * integers, and `null` is common (`title` is null on more than half of them,
 * `edited_at` on most, `tags[].name` sometimes).
 */

const MINUTE_MS = 60000;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

/**
 * The wire is untyped JSON; every field below is narrowed by a runtime guard
 * before it is trusted. `RawRecord` keeps those guards the single source of
 * truth instead of spreading `as` casts through the normalisers.
 */
type RawRecord = Record<string, any>;

export interface Author {
  name: string;
  nick: string | null;
  display: string;
  /** Drive file id of the avatar, or null when the publisher has none. */
  picture: string | null;
}

/** A post publisher, as the composer's identity list needs it. */
export interface Publisher {
  name: string;
  nick: string | null;
  display: string;
  picture: string | null;
}

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  width: number;
  height: number;
  /** The server sends a BlurHash on some image attachments; '' is the common case. */
  blurhash: string;
  /**
   * An explicit media URL, when the row carries one or the app builds the row
   * itself (a voice note, whose bytes live behind `meta.voice_url` and have no
   * drive file id). '' means the media is addressed by `id` — which is the
   * usual case, and the only one the display surfaces assume.
   */
  src: string;
}

/**
 * An embedded `replied_post` / `forwarded_post`, flattened to what a quote block
 * can show. Never recursed past one level: those structures nest.
 */
export interface PostReference {
  id: string;
  author: Author;
  title: string | null;
  content: string;
  /** 0 = markdown, 1 = html. */
  contentType: number;
  publishedAt: string | null;
  isTruncated: boolean;
  attachments: Attachment[];
}

export interface PostCounts {
  replies: number;
  boosts: number;
  reactions: number;
  upvotes: number;
  downvotes: number;
  views: number;
}

export interface Post {
  id: string;
  slug: string | null;
  title: string | null;
  description: string | null;
  content: string;
  /** 0 = markdown, 1 = html. */
  contentType: number;
  /** 0 = moment, 1 = article, 2 = blog. */
  kind: number;
  /** 0 = public, 1 = friends, 2 = unlisted, 3 = private, … */
  visibility: number;
  publishedAt: string | null;
  editedAt: string | null;
  isTruncated: boolean;
  counts: PostCounts;
  reactions: Record<string, number>;
  /** Which reactions the signed-in user has made: `{ symbol: boolean }`. */
  reactionsMade: Record<string, boolean>;
  tags: string[];
  attachments: Attachment[];
  author: Author;
  repliedTo: PostReference | null;
  forwardedFrom: PostReference | null;
  /**
   * The post this one continues, when it is a chain member (`chained_post`).
   * A chain member is a continuation of a post, not a reply to it: it is read
   * under its head, never as a row of its own.
   */
  chainedTo: PostReference | null;
  /** The head's id as the wire states it (`chained_post_id`); '' for a head. */
  chainedToId: string;
  /**
   * A head's continuation, oldest first (`chained_posts`). The wire hydrates
   * these on a read by id — a list row carries the id of the head it belongs
   * to, not the thread.
   */
  chainedPosts: Post[];
  /** How many posts the chain holds; may exceed the hydrated list. */
  chainedCount: number;
}

/** A countdown label: a string-table key and the numbers it is handed. */
export interface Label {
  key: string;
  args?: Record<string, number>;
}

export interface Countdown {
  id: string;
  title: string;
  startTime: string;
  endTime: string | null;
  /** A whole day — a holiday, an anniversary — rather than a span with a clock. */
  isAllDay: boolean;
  isOngoing: boolean;
}

/**
 * The avatar's drive file id: publishers carry it as `picture.id`, accounts as
 * `profile.picture.id` — the fallback covers account-shaped objects.
 */
function pictureIdOf(raw: RawRecord): string | null {
  const picture = raw.picture;
  if (picture && typeof picture === 'object' && typeof (picture as RawRecord).id === 'string') {
    return (picture as RawRecord).id as string;
  }
  const profile = raw.profile;
  if (profile && typeof profile === 'object') {
    const profilePicture = (profile as RawRecord).picture;
    if (
      profilePicture &&
      typeof profilePicture === 'object' &&
      typeof (profilePicture as RawRecord).id === 'string'
    ) {
      return (profilePicture as RawRecord).id as string;
    }
  }
  return null;
}

function normalizeAuthor(raw: unknown): Author {
  const publisher = raw && typeof raw === 'object' ? (raw as RawRecord) : {};
  const name = typeof publisher.name === 'string' ? publisher.name : '';
  const nick = typeof publisher.nick === 'string' ? publisher.nick : '';

  return { name, nick: nick || null, display: nick || name, picture: pictureIdOf(publisher) };
}

/** Drops anything without a name. */
export function normalizePublisherList(raw: unknown): Publisher[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeAuthor(item))
    .filter((publisher): publisher is Publisher => publisher.name !== '')
    .map((publisher) => ({
      name: publisher.name,
      nick: publisher.nick,
      display: publisher.display,
      picture: publisher.picture,
    }));
}

function normalizeReference(raw: unknown): PostReference | null {
  if (!raw || typeof raw !== 'object' || !(raw as RawRecord).id) return null;
  const source = raw as RawRecord;

  return {
    id: String(source.id),
    author: normalizeAuthor(source.publisher),
    title: source.title || null,
    content: typeof source.content === 'string' ? source.content : '',
    /** 0 = markdown, 1 = html. */
    contentType: source.content_type || 0,
    publishedAt: source.published_at || source.created_at || null,
    isTruncated: Boolean(source.is_truncated),
    attachments: normalizeAttachments(source.attachments),
  };
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];

  const tags: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const tag = raw[index];
    const name = tag && typeof tag === 'object' ? (tag as RawRecord).name : null;
    if (typeof name === 'string' && name) tags.push(name);
  }

  return tags;
}

/* --- Attachments ------------------------------------------------------- */

/* MIME prefixes are the first answer; the extension covers the files the API
   leaves `mime_type` empty on, the same fallback FloatLand uses. */
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'];
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogv', 'mov', 'mkv', 'avi', 'flv', 'm4v', '3gp'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'opus'];

const KIND_KEYS: Record<AttachmentKind, string> = {
  image: 'post_attach_image',
  video: 'post_attach_video',
  audio: 'post_attach_audio',
  file: 'post_attach_file',
};

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * @param mimeType may be '' — the API leaves it empty on some files
 * @param name the extension covers what `mime_type` does not
 */
export function attachmentKind(mimeType: string, name: string): AttachmentKind {
  const mime = typeof mimeType === 'string' ? mimeType : '';
  if (mime) {
    if (mime.slice(0, 6) === 'image/') return 'image';
    if (mime.slice(0, 6) === 'video/') return 'video';
    if (mime.slice(0, 6) === 'audio/') return 'audio';
    return 'file';
  }

  const extension = extensionOf(typeof name === 'string' ? name : '');
  if (IMAGE_EXTENSIONS.indexOf(extension) !== -1) return 'image';
  if (VIDEO_EXTENSIONS.indexOf(extension) !== -1) return 'video';
  if (AUDIO_EXTENSIONS.indexOf(extension) !== -1) return 'audio';
  return 'file';
}

/** String-table key for the row's `[image]` marker. */
export function attachmentKindKey(kind: AttachmentKind): string {
  return KIND_KEYS[kind] || 'post_attach_file';
}

const KILOBYTE = 1024;
const MEGABYTE = 1048576;

/** Locale-neutral on purpose: `Intl` is not worth its bytes on Gecko 48. */
export function formatBytes(size: number): string {
  if (typeof size !== 'number' || size <= 0) return '';
  if (size < KILOBYTE) return size + ' B';
  if (size < MEGABYTE) {
    const kilobytes = size / KILOBYTE;
    // 1.5 KB keeps a digit a file browser would show; above ten it is noise.
    return (kilobytes < 10 ? Math.round(kilobytes * 10) / 10 : Math.round(kilobytes)) + ' KB';
  }
  return (size / MEGABYTE).toFixed(1) + ' MB';
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/**
 * A media length as `m:ss` — a voice note's duration, a recording in progress.
 * Minutes are not padded (`1:05`, not `01:05`), matching the clients' own
 * timers; anything past an hour reads in minutes, which is fine for a message.
 */
export function formatClock(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / MS_PER_SECOND));
  const minutes = Math.floor(total / SECONDS_PER_MINUTE);
  const seconds = total % SECONDS_PER_MINUTE;
  return minutes + ':' + (seconds < 10 ? '0' + seconds : String(seconds));
}

const NAME_BUDGET = 22;

/**
 * One line of attachment metadata for a 240px row: pixel dimensions for media
 * (the file name is a `image_picker_<uuid>.jpg` on the wire), the name for
 * anything else, and the size.
 */
export function describeAttachment(attachment: Attachment): string {
  const parts: string[] = [];
  const isMedia = attachment.kind === 'image' || attachment.kind === 'video';

  if (isMedia && attachment.width && attachment.height) {
    parts.push(attachment.width + '×' + attachment.height);
  } else if (attachment.name) {
    parts.push(
      attachment.name.length > NAME_BUDGET
        ? attachment.name.slice(0, NAME_BUDGET) + '…'
        : attachment.name,
    );
  }

  const size = formatBytes(attachment.size);
  if (size) parts.push(size);

  return parts.join(' · ');
}

/**
 * What the wire's attachment object is cut down to.
 *
 * Nothing here is downloaded. `url` was null on all 90 attachments in a sampled
 * list response, `has_thumbnail` was set on one (a video poster), and the file
 * behind `/drive/files/{id}` is the original — several megabytes each. A row
 * renders this metadata instead, which is also why the detail screen does not
 * embed images.
 */
function normalizeAttachment(raw: unknown): Attachment | null {
  if (!raw || typeof raw !== 'object' || !(raw as RawRecord).id) return null;
  const source = raw as RawRecord;

  const name = typeof source.name === 'string' ? source.name : '';
  const mimeType = typeof source.mime_type === 'string' ? source.mime_type : '';

  return {
    id: String(source.id),
    name,
    mimeType,
    kind: attachmentKind(mimeType, name),
    size: typeof source.size === 'number' && source.size > 0 ? source.size : 0,
    width: source.width || 0,
    height: source.height || 0,
    blurhash: typeof source.blurhash === 'string' && source.blurhash ? source.blurhash : '',
    // The wire's own URL when it sends one. It was null across a sampled
    // response, so nothing may depend on it — every caller falls back to the
    // drive route built from `id`.
    src: typeof source.url === 'string' ? source.url : '',
  };
}

/** Drops anything without an id. */
function normalizeAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeAttachment).filter((item): item is Attachment => item !== null);
}

/**
 * Post kind (`type` on the wire) → string-table key. A moment is the default and
 * needs no label; an unknown enum renders as nothing rather than as a number.
 */
export function postKindKey(kind: number): string | null {
  switch (kind) {
    case 1:
      return 'post_kind_article';
    case 2:
      return 'post_kind_blog';
    default:
      return null;
  }
}

/* --- Event countdown --------------------------------------------------- */

/**
 * An event from `/passport/accounts/{name}/calendar/countdown`, cut down to a
 * one-line countdown. `is_ongoing` is the server's own answer and is trusted over
 * re-deriving it from the clock.
 */
export function normalizeCountdown(raw: unknown): Countdown | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as RawRecord;

  const title = typeof source.title === 'string' ? source.title : '';
  const startTime = source.start_time || null;
  if (!title || !startTime) return null;

  return {
    id: source.event_id ? String(source.event_id) : title + '@' + startTime,
    title,
    startTime,
    endTime: source.end_time || null,
    isAllDay: Boolean(source.is_all_day),
    isOngoing: Boolean(source.is_ongoing),
  };
}

export function normalizeCountdownList(raw: unknown): Countdown[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeCountdown).filter((item): item is Countdown => item !== null);
}

/**
 * How far away an event is, as a string-table key and its arguments. The
 * view formats it, so the wording stays in the string table.
 */
export function countdownLabel(event: Countdown, now: number = Date.now()): Label | null {
  if (event.isOngoing) return { key: 'countdown_ongoing' };

  const at = Date.parse(event.startTime);
  if (Number.isNaN(at)) return null;

  const remaining = at - now;
  if (remaining <= 0) return { key: 'countdown_ongoing' };

  if (remaining >= DAY_MS) {
    return {
      key: 'countdown_days',
      args: { d: Math.floor(remaining / DAY_MS), h: Math.floor((remaining % DAY_MS) / HOUR_MS) },
    };
  }

  if (remaining >= HOUR_MS) {
    return {
      key: 'countdown_hours',
      args: { h: Math.floor(remaining / HOUR_MS), m: Math.floor((remaining % HOUR_MS) / MINUTE_MS) },
    };
  }

  return { key: 'countdown_minutes', args: { m: Math.max(1, Math.floor(remaining / MINUTE_MS)) } };
}

/* --- Event calendar ---------------------------------------------------- */

/**
 * A day on the event calendar (`GET /passport/accounts/{name}/calendar`), the
 * month view's own row: the day, and what falls on it. `user_events` and
 * `notable_days` are the two lists a reading surface uses; the server also
 * hangs presence and check-in rows on the day, which this app does not show.
 *
 * The server buckets days by UTC date, and so does everything here: a day is
 * its `YYYY-MM-DD` key, never a `Date` that a time zone could move.
 */
export interface CalendarDay {
  date: string;
  events: CalendarEvent[];
  notableDays: NotableDay[];
}

/** One entry on a day: an account's own event, private, shared or public. */
export interface CalendarEvent {
  id: string;
  title: string;
  description: string;
  location: string;
  startTime: string;
  endTime: string | null;
  isAllDay: boolean;
}

/** A holiday or other date the network knows about, named where you are. */
export interface NotableDay {
  name: string;
  description: string;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function pad2(value: number): string {
  return value < 10 ? '0' + value : '' + value;
}

/** The UTC day a wire instant falls on, as `YYYY-MM-DD`; `null` when it is not one. */
export function dayKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 10) return null;
  const key = value.slice(0, 10);
  return DAY_KEY.test(key) ? key : null;
}

/** The key for a UTC calendar date. `month` is 1-12, as the API writes it. */
export function dayKeyOf(year: number, month: number, day: number): string {
  return '' + year + '-' + pad2(month) + '-' + pad2(day);
}

/** `key` shifted by whole days. */
export function dayKeyOffset(key: string, days: number): string {
  const at = Date.UTC(
    Number(key.slice(0, 4)),
    Number(key.slice(5, 7)) - 1,
    Number(key.slice(8, 10)) + days,
  );
  const date = new Date(at);
  return dayKeyOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** The first day of the month `delta` months from the one `key` falls in. */
export function monthStart(key: string, delta: number): string {
  const at = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1 + delta, 1));
  return dayKeyOf(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
}

/** 0 for Monday … 6 for Sunday: the calendar's weeks start on Monday. */
export function weekdayIndex(key: string): number {
  const at = Date.UTC(
    Number(key.slice(0, 4)),
    Number(key.slice(5, 7)) - 1,
    Number(key.slice(8, 10)),
  );
  // `getUTCDay` counts from Sunday; the grid counts from Monday.
  return (new Date(at).getUTCDay() + 6) % 7;
}

/**
 * The 42 day keys a month grid shows: six Monday-started weeks, the first
 * beginning on or before the 1st, so every month is the same shape and the
 * cursor can move a week at a time without the grid changing height.
 */
export function monthKeys(key: string): string[] {
  const first = monthStart(key, 0);
  const start = dayKeyOffset(first, -weekdayIndex(first));
  const keys: string[] = [];
  for (let index = 0; index < 42; index += 1) keys.push(dayKeyOffset(start, index));
  return keys;
}

/** Today, as the server buckets days. */
export function todayKey(): string {
  const now = new Date();
  return dayKeyOf(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
}

/** A local `HH:MM` reading of a wire instant, and '' when it is not one. */
function clockOf(value: string): string {
  const at = Date.parse(value);
  if (Number.isNaN(at)) return '';
  const time = new Date(at);
  return pad2(time.getHours()) + ':' + pad2(time.getMinutes());
}

/**
 * An event's span as `HH:MM–HH:MM` in the device's own time — the same time
 * the dashboard clock shows — or just the start when there is no end. '' when
 * the instant cannot be read.
 */
export function formatClockRange(startTime: string, endTime: string | null): string {
  const start = clockOf(startTime);
  if (!start) return '';
  const end = endTime ? clockOf(endTime) : '';
  return end && end !== start ? start + '–' + end : start;
}

function normalizeCalendarEvent(raw: unknown): CalendarEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as RawRecord;

  const title = typeof source.title === 'string' ? source.title : '';
  const startTime = source.start_time || null;
  if (!title || !startTime) return null;

  return {
    id: source.id ? String(source.id) : title + '@' + startTime,
    title,
    description: typeof source.description === 'string' ? source.description : '',
    location: typeof source.location === 'string' ? source.location : '',
    startTime,
    endTime: source.end_time || null,
    isAllDay: Boolean(source.is_all_day),
  };
}

function normalizeCalendarEventList(raw: unknown): CalendarEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeCalendarEvent).filter((item): item is CalendarEvent => item !== null);
}

function normalizeNotableDay(raw: unknown): NotableDay | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as RawRecord;

  // `local_name` is the day as the account's own country calls it; the global
  // one is the fallback, and the name is required either way.
  const local = typeof source.local_name === 'string' ? source.local_name : '';
  const global = typeof source.global_name === 'string' ? source.global_name : '';
  const name = local || global;
  if (!name) return null;

  return {
    name,
    description: typeof source.description === 'string' ? source.description : '',
  };
}

function normalizeNotableDayList(raw: unknown): NotableDay[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeNotableDay).filter((item): item is NotableDay => item !== null);
}

/**
 * A month of the calendar, cut down to the days that have something on them:
 * the grid draws its own empty days, so a day row with nothing on it is
 * dropped rather than carried around. Days without a readable date are
 * dropped too — neither list can be placed without one.
 */
export function normalizeCalendarMonth(raw: unknown): CalendarDay[] {
  if (!Array.isArray(raw)) return [];

  const days: CalendarDay[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const row = raw[index];
    if (!row || typeof row !== 'object') continue;

    const date = dayKey((row as RawRecord).date);
    if (!date) continue;

    const events = normalizeCalendarEventList((row as RawRecord).user_events);
    const notableDays = normalizeNotableDayList((row as RawRecord).notable_days);
    if (!events.length && !notableDays.length) continue;

    days.push({ date, events, notableDays });
  }
  return days;
}

/** `null` when `raw` is not a post, so callers can filter. */
export function normalizePost(raw: unknown): Post | null {
  if (!raw || typeof raw !== 'object' || !(raw as RawRecord).id) return null;
  const source = raw as RawRecord;

  const reactions: Record<string, number> = {};
  const rawReactions =
    source.reactions_count && typeof source.reactions_count === 'object'
      ? (source.reactions_count as RawRecord)
      : {};
  const symbols = Object.keys(rawReactions);
  for (let index = 0; index < symbols.length; index += 1) {
    reactions[symbols[index]] = rawReactions[symbols[index]];
  }

  // The server only sends `reactions_made` for the signed-in user's own reads;
  // anonymous responses carry neither the key nor a use for it.
  const reactionsMade: Record<string, boolean> = {};
  const rawMade =
    source.reactions_made && typeof source.reactions_made === 'object'
      ? (source.reactions_made as RawRecord)
      : {};
  const madeSymbols = Object.keys(rawMade);
  for (let index = 0; index < madeSymbols.length; index += 1) {
    reactionsMade[madeSymbols[index]] = Boolean(rawMade[madeSymbols[index]]);
  }

  return {
    id: String(source.id),
    slug: source.slug || null,
    title: source.title || null,
    description: source.description || null,
    content: typeof source.content === 'string' ? source.content : '',
    contentType: source.content_type || 0,
    kind: source.type || 0,
    visibility: source.visibility || 0,
    // Anonymous reads never return drafts, but the fallback keeps a missing
    // `published_at` from producing an empty timestamp.
    publishedAt: source.published_at || source.created_at || null,
    editedAt: source.edited_at || null,
    isTruncated: Boolean(source.is_truncated),
    counts: {
      replies: source.replies_count || 0,
      boosts: source.boost_count || 0,
      // `reactions_count` arrives as `{ pray: 1 }`; the count of *kinds* is what
      // the string table renders.
      reactions: symbols.length,
      upvotes: source.upvotes || 0,
      downvotes: source.downvotes || 0,
      views: source.views_total || 0,
    },
    reactions,
    reactionsMade,
    tags: normalizeTags(source.tags),
    attachments: normalizeAttachments(source.attachments),
    author: normalizeAuthor(source.publisher),
    repliedTo: normalizeReference(source.replied_post),
    forwardedFrom: normalizeReference(source.forwarded_post),
    chainedTo: normalizeReference(source.chained_post),
    // A list row states the head by id alone, so the id is read on its own
    // rather than through the embedded post.
    chainedToId: chainHeadId(source),
    chainedPosts: normalizePostList(source.chained_posts),
    // The count covers the whole chain — a head with more members than the
    // read hydrated still knows how many follow it.
    chainedCount:
      source.chained_count ||
      (Array.isArray(source.chained_posts) ? source.chained_posts.length : 0),
  };
}

/** The chain head a post continues: `chained_post_id`, else the embedded post's id. */
function chainHeadId(source: RawRecord): string {
  if (typeof source.chained_post_id === 'string' && source.chained_post_id) {
    return source.chained_post_id;
  }
  const embedded = source.chained_post;
  return embedded && typeof embedded === 'object' && embedded.id ? String(embedded.id) : '';
}

/** Drops anything that is not a post. */
export function normalizePostList(raw: unknown): Post[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizePost).filter((item): item is Post => item !== null);
}

/**
 * Visibility enum → string-table key. `0` (public) has no label, and an enum
 * this build does not know about renders as nothing rather than as a raw number.
 */
export function visibilityKey(visibility: number): string | null {
  switch (visibility) {
    case 1:
      return 'post_visibility_friends';
    case 2:
      return 'post_visibility_unlisted';
    case 3:
      return 'post_visibility_private';
    case 4:
      return 'post_visibility_close_friends';
    case 5:
      return 'post_visibility_subscribers';
    default:
      return null;
  }
}

/* --- Chat --------------------------------------------------------------- */

/**
 * Wire → app models for the messager endpoints (`/messager/chat/...`), the
 * same allowlist discipline as the post models above: every field below is
 * narrowed by a runtime guard, snake_case → camelCase, and `null` is common
 * (a direct room's `name`, a message's `content` on event rows).
 *
 * The shapes were read off `solar_network_sdk`'s chat models, which parse the
 * live `/messager/chat` responses: `SnChatRoom`, `SnChatMember` (whose
 * `account` is an `SnAccount`), `SnChatMessage`, and `SnChatSummary`.
 */

/** An account embedded in a chat member: the unique handle and display name. */
export interface ChatAccount {
  id: string;
  /** The unique handle, rendered as `@name`. */
  name: string;
  /** The pretty display name, or null when the server sent none. */
  nick: string | null;
  display: string;
  /** Drive file id of the avatar, or null when the account has none. */
  picture: string | null;
}

/** A room member: who they are, and their per-room last-read watermark. */
export interface ChatMember {
  id: string;
  chatRoomId: string;
  accountId: string;
  account: ChatAccount;
  /** Per-room alias set by the member, or null. */
  nick: string | null;
  lastReadAt: string | null;
}

export interface ChatRoom {
  id: string;
  name: string | null;
  /** 0 = group, 1 = direct, ... (the server's integer enum). */
  type: number;
  /** Drive file id of the room picture, or null. */
  picture: string | null;
  members: ChatMember[];
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
}

/** A chat message, cut down to what a thread renders. */
export interface ChatMessage {
  id: string;
  roomId: string;
  type: string;
  content: string;
  /** The sender's account id — what "was it me?" compares against. */
  senderId: string;
  sender: ChatMember;
  /** Locally-assigned id echoed by the server on create, or null. */
  clientMessageId: string | null;
  /** The message this one answers (`replied_message_id`), or null. */
  repliedMessageId: string | null;
  createdAt: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  attachments: Attachment[];
  /**
   * A voice note's length, from `meta.duration_ms`; 0 for every other message.
   * A voice note carries no content and no attachments — the media sits behind
   * `meta.voice_url` — so this is the only thing the row can show.
   */
  voiceDurationMs: number;
  /**
   * A voice note's media, absolute or server-relative (`meta.voice_url`); '' for
   * every other message. The bytes are not an attachment, so this is the only
   * way to reach them — and it is what the lightbox plays.
   */
  voiceUrl: string;
  /** Reaction counts, `{ symbol: count }`, from `reactions_count`. */
  reactions: Record<string, number>;
  /** Which reactions the signed-in user has made, from `reactions_made`. */
  reactionsMade: Record<string, boolean>;
  /** Local-only delivery state; '' for server-fetched rows. A failed send
   *  leaves no row — the draft comes back and the error line explains. */
  status: '' | 'pending' | 'sent';
}

/** A room's unread state and last message, per `GET /messager/chat/summary`. */
export interface ChatSummary {
  unreadCount: number;
  hasUnread: boolean;
  lastMessage: ChatMessage | null;
}

/**
 * A pending invitation to a room (`GET /messager/chat/invites`). The wire row
 * is an `SnChatMember` — you, joined to a room you have not confirmed — so the
 * useful part is the embedded room (the Flutter invites sheet renders the same
 * room tile it uses in the list) and the member id used to accept or decline.
 */
export interface ChatInvite {
  id: string;
  roomId: string;
  room: ChatRoom | null;
}

/**
 * A member's display name: the per-room nick first, then the account's nick,
 * then its handle — the precedence Solian's `SnChatMember.displayName` uses
 * (`ChatAccount.display` already falls back to the handle).
 */
export function chatMemberName(member: ChatMember): string {
  return member.nick || member.account.display;
}

/**
 * An account on the wire, cut down to identity: the shape `ChatMember`
 * embeds, and what account search answers.
 */
export function normalizeChatAccount(raw: unknown): ChatAccount | null {
  if (!raw || typeof raw !== 'object' || !(raw as RawRecord).id) return null;
  const source = raw as RawRecord;
  const name = typeof source.name === 'string' ? source.name : '';
  const nick = typeof source.nick === 'string' ? source.nick : '';

  return {
    id: String(source.id),
    name,
    nick: nick || null,
    display: nick || name,
    picture: pictureIdOf(source),
  };
}

function normalizeChatMember(raw: unknown): ChatMember | null {
  if (!raw || typeof raw !== 'object' || !(raw as RawRecord).id) return null;
  const source = raw as RawRecord;

  const account = normalizeChatAccount(source.account);
  const accountId =
    typeof source.account_id === 'string'
      ? source.account_id
      : account
        ? account.id
        : '';

  return {
    id: String(source.id),
    chatRoomId: typeof source.chat_room_id === 'string' ? source.chat_room_id : '',
    accountId,
    account:
      account ||
      ({
        id: accountId,
        name: accountId,
        nick: null,
        display: accountId,
        picture: null,
      } as ChatAccount),
    nick: typeof source.nick === 'string' ? source.nick : null,
    lastReadAt: source.last_read_at || null,
  };
}

function normalizeChatMemberList(raw: unknown): ChatMember[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeChatMember).filter((item): item is ChatMember => item !== null);
}

export function normalizeChatRoom(raw: unknown): ChatRoom | null {
  if (!raw || typeof raw !== 'object' || !(raw as RawRecord).id) return null;
  const source = raw as RawRecord;

  return {
    id: String(source.id),
    name: typeof source.name === 'string' ? source.name : null,
    type: typeof source.type === 'number' ? source.type : 0,
    picture: pictureIdOf(source),
    members: normalizeChatMemberList(source.members),
    createdAt: source.created_at || null,
    updatedAt: source.updated_at || null,
    deletedAt: source.deleted_at || null,
  };
}

export function normalizeChatRoomList(raw: unknown): ChatRoom[] {
  // `GET /messager/chat` answers `{ rooms: [...] }` (the iOS `ChatRoomsResponse`
  // shape); a bare array is accepted too for mixed-version deployments.
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as RawRecord).rooms)
      ? ((raw as RawRecord).rooms as unknown[])
      : [];
  if (!list.length) return [];
  return list.map(normalizeChatRoom).filter((item): item is ChatRoom => item !== null);
}

export function normalizeChatMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object' || !(raw as RawRecord).id) return null;
  const source = raw as RawRecord;

  return {
    id: String(source.id),
    roomId: typeof source.chat_room_id === 'string' ? source.chat_room_id : '',
    type: typeof source.type === 'string' ? source.type : 'text',
    content: typeof source.content === 'string' ? source.content : '',
    senderId: typeof source.sender_id === 'string' ? source.sender_id : '',
    sender:
      normalizeChatMember(source.sender) ||
      ({
        id: '',
        chatRoomId: '',
        accountId: '',
        account: { id: '', name: '', nick: null, display: '', picture: null },
        nick: null,
        lastReadAt: null,
      } as ChatMember),
    clientMessageId: source.client_message_id || null,
    repliedMessageId:
      typeof source.replied_message_id === 'string' ? source.replied_message_id : null,
    createdAt: source.created_at || null,
    editedAt: source.edited_at || null,
    deletedAt: source.deleted_at || null,
    attachments: normalizeAttachments(source.attachments),
    voiceDurationMs: voiceDurationOf(source),
    voiceUrl: voiceUrlOf(source),
    reactions: reactionCountsOf(source),
    reactionsMade: reactionMadeOf(source),
    status: '',
  };
}

/** `meta.voice_url`, as a voice note writes it; '' when there is none. */
function voiceUrlOf(source: RawRecord): string {
  const meta = source.meta;
  if (!meta || typeof meta !== 'object') return '';
  const raw = (meta as RawRecord).voice_url;
  return typeof raw === 'string' ? raw : '';
}

/**
 * `meta.duration_ms`, as a voice note writes it. The wire is inconsistent
 * about the number's type (a JSON number in both clients' sends, but the meta
 * bag is free-form), hence the string case.
 */
function voiceDurationOf(source: RawRecord): number {
  const meta = source.meta;
  if (!meta || typeof meta !== 'object') return 0;
  const raw = (meta as RawRecord).duration_ms;
  if (typeof raw === 'number' && raw > 0) return Math.round(raw);
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (!Number.isNaN(parsed) && parsed > 0) return Math.round(parsed);
  }
  return 0;
}

/**
 * The message's reaction counts (`reactions_count`), `{ symbol: count }`. Only
 * numbers are trusted — a hand-written packet must not be able to wedge the
 * pills — so a non-numeric count is dropped, not coerced.
 */
function reactionCountsOf(source: RawRecord): Record<string, number> {
  const raw = source.reactions_count;
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as RawRecord;
  const counts: Record<string, number> = {};
  const symbols = Object.keys(record);
  for (let index = 0; index < symbols.length; index += 1) {
    const value = record[symbols[index]];
    if (typeof value === 'number' && value > 0) counts[symbols[index]] = Math.round(value);
  }
  return counts;
}

/** Which reactions the signed-in user has made (`reactions_made`). */
function reactionMadeOf(source: RawRecord): Record<string, boolean> {
  const raw = source.reactions_made;
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as RawRecord;
  const made: Record<string, boolean> = {};
  const symbols = Object.keys(record);
  for (let index = 0; index < symbols.length; index += 1) {
    if (record[symbols[index]] === true) made[symbols[index]] = true;
  }
  return made;
}

export function normalizeChatMessageList(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeChatMessage).filter((item): item is ChatMessage => item !== null);
}

/**
 * The messager's own bookkeeping, written into a room's timeline as rows that
 * are not anything anyone said: the gateway's sync steps, and the markers a
 * delete, an edit, a reaction or a pin leaves behind. This table names the
 * `messages.*` ones, which share no prefix; the membership and call events are
 * `system.<domain>.<what>` and are matched by prefix below.
 *
 * Solian keeps these behind its event-message setting and hides every one of
 * them at `none` (`_isSystemEventType` / `_shouldIncludeInActiveList`), which
 * is the level a KaiOS thread takes: a bubble for one is protocol in the
 * middle of a conversation, and this app has no call screen for a `call.*` row
 * to open.
 */
const EVENT_MESSAGE_TYPES: Record<string, true> = {
  'messages.update': true,
  'messages.sync.file': true,
  'messages.sync.finalize': true,
  'messages.sync.links': true,
  'messages.delete': true,
  'messages.reaction.added': true,
  'messages.reaction.removed': true,
  'messages.pinned': true,
  'messages.unpinned': true,
};

/**
 * Whether a room's message row is something to draw. The room's own events are
 * not, whatever the server put on them — a call row carries content, and it is
 * not a message. The `placeholder` the gateway writes while a message syncs
 * goes the same way; the realtime handler has always skipped that one.
 */
export function hasChatMessageContent(message: ChatMessage): boolean {
  const type = message.type;
  if (type === 'placeholder') return false;
  if (type.indexOf('system.') === 0 || type.indexOf('call.') === 0) return false;
  if (EVENT_MESSAGE_TYPES[type] === true) return false;
  return (
    Boolean(message.content) ||
    message.attachments.length > 0 ||
    Boolean(message.voiceUrl) ||
    message.voiceDurationMs > 0
  );
}

export function normalizeChatSummary(raw: unknown): ChatSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as RawRecord;

  const unreadCount =
    typeof source.unread_count === 'number' && source.unread_count > 0 ? source.unread_count : 0;
  return {
    unreadCount,
    hasUnread: Boolean(source.has_unread) || unreadCount > 0,
    lastMessage: normalizeChatMessage(source.last_message),
  };
}

/**
 * `GET /messager/chat/summary` answers a map keyed by room id — the same shape
 * Solian's `ChatSummary` notifier reads. Rows that fail to parse are dropped;
 * a room without a row simply has no unread state.
 */
export function normalizeChatSummaryMap(raw: unknown): Record<string, ChatSummary> {
  const map: Record<string, ChatSummary> = {};
  if (!raw || typeof raw !== 'object') return map;

  const source = raw as RawRecord;
  const keys = Object.keys(source);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const summary = normalizeChatSummary(source[key]);
    if (summary) map[key] = summary;
  }
  return map;
}

/** Drops anything that is not an invitation (a row without an id or room). */
export function normalizeChatInviteList(raw: unknown): ChatInvite[] {
  if (!Array.isArray(raw)) return [];
  const invites: ChatInvite[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item || typeof item !== 'object' || !(item as RawRecord).id) continue;
    const source = item as RawRecord;
    invites.push({
      id: String(source.id),
      roomId: typeof source.chat_room_id === 'string' ? source.chat_room_id : '',
      room: normalizeChatRoom(source.chat_room),
    });
  }
  return invites;
}

/** Account search rows (`GET /stargate/accounts/search`), as identity only. */
export function normalizeChatAccountList(raw: unknown): ChatAccount[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeChatAccount)
    .filter((item): item is ChatAccount => item !== null);
}

/* --- Notifications ------------------------------------------------------ */

/**
 * Wire → app models for the account's notification inbox
 * (`GET /metoer/notifications`), read off `SnNotification` in
 * `solar_network_sdk`: a `topic` the row picks its icon by, the server's own
 * `title`/`subtitle`/`content`, a free-form `meta` bag carrying the actor's
 * picture (`pfp`) and the route to open (`action_uri`), and `viewed_at` —
 * null until the account has seen the notification, which is what the row's
 * unread dot reads.
 *
 * Named `AppNotification` rather than `Notification` on purpose: the DOM has a
 * `Notification` of its own, and a module that later wants the platform's
 * would silently get this one instead.
 */
export interface AppNotification {
  id: string;
  /** The tenant app that sent it; '' for a system notification. */
  appId: string;
  /** The server's topic, e.g. `post.replies` — what the row's icon is chosen by. */
  topic: string;
  title: string;
  subtitle: string;
  /** The body the server wrote (`content` on the wire). */
  body: string;
  /** Drive file id of the actor's picture, or '' when there is none. */
  picture: string;
  /** The route the notification points at, or '' when it names none. */
  actionUri: string;
  /** When the account saw it; '' while unread. */
  viewedAt: string;
  createdAt: string;
}

/** `null` when `raw` is not a notification, so callers can filter. */
export function normalizeAppNotification(raw: unknown): AppNotification | null {
  if (!raw || typeof raw !== 'object' || !(raw as RawRecord).id) return null;
  const source = raw as RawRecord;
  const meta = source.meta && typeof source.meta === 'object' ? (source.meta as RawRecord) : {};

  return {
    id: String(source.id),
    appId: typeof source.app_id === 'string' ? source.app_id : '',
    topic: typeof source.topic === 'string' ? source.topic : '',
    title: typeof source.title === 'string' ? source.title : '',
    subtitle: typeof source.subtitle === 'string' ? source.subtitle : '',
    body: typeof source.content === 'string' ? source.content : '',
    // The actor's face when the server sent one. A notification about the
    // account's own action carries no `pfp`, and the row falls back to the
    // glyph its topic names.
    picture: typeof meta.pfp === 'string' ? meta.pfp : '',
    actionUri: typeof meta.action_uri === 'string' ? meta.action_uri : '',
    viewedAt: typeof source.viewed_at === 'string' ? source.viewed_at : '',
    createdAt: typeof source.created_at === 'string' ? source.created_at : '',
  };
}

/** Drops anything that is not a notification. */
export function normalizeAppNotificationList(raw: unknown): AppNotification[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeAppNotification)
    .filter((item): item is AppNotification => item !== null);
}

/**
 * The post id in a notification's `action_uri`, or '' when it names something
 * this app has no screen for. The server writes the route in every shape the
 * Solian clients accept — `solian://posts/<id>`, `/posts/<id>`, an
 * `https://solian.app/posts/<id>` link — and this app does have a post screen,
 * so those open the post. A profile, a realm or a chat room does not; the row
 * then only marks itself read.
 *
 * A `posts/` segment has to start the path or follow a separator, so a host or
 * a word that merely ends in `posts` is not a match.
 */
export function postIdFromActionUri(uri: string): string {
  if (typeof uri !== 'string') return '';
  const match = /(?:^|\/)posts\/([^/?#]+)/.exec(uri.trim());
  return match ? decodeURIComponent(match[1]) : '';
}

/* --- Stickers ----------------------------------------------------------- */

/**
 * A sticker in a pack (`GET /sphere/stickers`, `/sphere/stickers/me`). A
 * sticker message carries no file id — it is the placeholder `:prefix+slug:`
 * as the content, which is why the image is looked up from that placeholder
 * (see `lookupStickerImage`).
 */
export interface Sticker {
  id: string;
  slug: string;
  /** Empty on most stickers; the slug is the usable label. */
  name: string;
  /** Drive file id of the image, or null when the pack has none to show. */
  image: string | null;
}

export interface StickerPack {
  id: string;
  name: string;
  /** Half of the placeholder: `:<prefix>+<slug>:`. */
  prefix: string;
  /** The pack's cover, or null. */
  icon: string | null;
  stickers: Sticker[];
}

/**
 * The drive file id of a named object field — `image` on a sticker, `icon` on
 * a pack. Sticker rows are not account-shaped, so `pictureIdOf` (which reads
 * `picture`/`profile.picture`) does not see them, and reading the wrong field
 * silently leaves every sticker without an image.
 */
export function fileIdOf(raw: unknown, field: string): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = (raw as RawRecord)[field];
  if (value && typeof value === 'object' && typeof (value as RawRecord).id === 'string') {
    return (value as RawRecord).id as string;
  }
  return null;
}

function normalizeSticker(raw: unknown): Sticker | null {
  if (!raw || typeof raw !== 'object' || !(raw as RawRecord).id) return null;
  const source = raw as RawRecord;
  return {
    id: String(source.id),
    slug: typeof source.slug === 'string' ? source.slug : '',
    name: typeof source.name === 'string' ? source.name : '',
    image: fileIdOf(source, 'image'),
  };
}

function normalizeStickerPack(raw: unknown): StickerPack | null {
  if (!raw || typeof raw !== 'object' || !(raw as RawRecord).id) return null;
  const source = raw as RawRecord;
  const stickers: Sticker[] = [];
  if (Array.isArray(source.stickers)) {
    for (let index = 0; index < source.stickers.length; index += 1) {
      const sticker = normalizeSticker(source.stickers[index]);
      // A sticker without a slug cannot be addressed in a placeholder, and
      // one without an image has nothing to show: neither can be sent.
      if (sticker && sticker.slug && sticker.image) stickers.push(sticker);
    }
  }
  return {
    id: String(source.id),
    name: typeof source.name === 'string' ? source.name : '',
    prefix: typeof source.prefix === 'string' ? source.prefix : '',
    icon: fileIdOf(source, 'icon'),
    stickers,
  };
}

/**
 * The owned-pack list (`GET /sphere/stickers/me`) answers ownership rows
 * `{ id, pack: {...} }`, while the marketplace (`GET /sphere/stickers`)
 * answers packs directly — both are accepted, so either route can back the
 * picker. Packs with nothing sendable are dropped.
 */
export function normalizeStickerPackList(raw: unknown): StickerPack[] {
  if (!Array.isArray(raw)) return [];
  const packs: StickerPack[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const row = raw[index];
    if (!row || typeof row !== 'object') continue;
    const nested = (row as RawRecord).pack;
    const pack = normalizeStickerPack(nested || row);
    if (pack && pack.prefix && pack.stickers.length) packs.push(pack);
  }
  return packs;
}

/**
 * The sticker a message carries, or '' when it carries none: a sticker
 * message's whole content is `:prefix+slug:` (the rule both other clients
 * match, Flutter's `^:([-\w]*\+[-\w]*):$`). `-` and `_` are allowed in either
 * half because pack prefixes and slugs contain them.
 */
export function stickerPlaceholder(content: string): string {
  const match = /^:([-\w]+\+[-\w]+):$/.exec(content.trim());
  return match ? match[1] : '';
}

/**
 * FloatLand's buckets, rendered from the shipped string table rather than from
 * `Intl` or a month table: Gecko 48 has neither worth the bytes.
 *
 * `null` when there is no usable date, so callers can leave the timestamp out.
 */
export function formatRelativeTime(
  iso: string | null,
  now: number = Date.now(),
): Label | { text: string } | null {
  if (typeof iso !== 'string' || !iso) return null;

  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;

  const elapsed = now - at;

  if (elapsed < MINUTE_MS) return { key: 'post_just_now' };
  if (elapsed < HOUR_MS) return { key: 'post_minutes_ago', args: { m: Math.floor(elapsed / MINUTE_MS) } };
  if (elapsed < DAY_MS) return { key: 'post_hours_ago', args: { h: Math.floor(elapsed / HOUR_MS) } };
  if (elapsed < 7 * DAY_MS) return { key: 'post_days_ago', args: { d: Math.floor(elapsed / DAY_MS) } };

  return { text: iso.slice(0, 10) };
}
