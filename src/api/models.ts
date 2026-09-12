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
  tags: string[];
  attachments: Attachment[];
  author: Author;
  repliedTo: PostReference | null;
  forwardedFrom: PostReference | null;
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
  isOngoing: boolean;
}

function normalizeAuthor(raw: unknown): Author {
  const publisher = raw && typeof raw === 'object' ? (raw as RawRecord) : {};
  const name = typeof publisher.name === 'string' ? publisher.name : '';
  const nick = typeof publisher.nick === 'string' ? publisher.nick : '';

  return { name, nick: nick || null, display: nick || name };
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
function formatBytes(size: number): string {
  if (typeof size !== 'number' || size <= 0) return '';
  if (size < KILOBYTE) return size + ' B';
  if (size < MEGABYTE) {
    const kilobytes = size / KILOBYTE;
    // 1.5 KB keeps a digit a file browser would show; above ten it is noise.
    return (kilobytes < 10 ? Math.round(kilobytes * 10) / 10 : Math.round(kilobytes)) + ' KB';
  }
  return (size / MEGABYTE).toFixed(1) + ' MB';
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
    tags: normalizeTags(source.tags),
    attachments: normalizeAttachments(source.attachments),
    author: normalizeAuthor(source.publisher),
    repliedTo: normalizeReference(source.replied_post),
    forwardedFrom: normalizeReference(source.forwarded_post),
  };
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
