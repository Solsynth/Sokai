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

function objectOrEmpty(value) {
  return value && typeof value === 'object' ? value : {};
}

function normalizeAuthor(raw) {
  const publisher = objectOrEmpty(raw);
  const name = typeof publisher.name === 'string' ? publisher.name : '';
  const nick = typeof publisher.nick === 'string' ? publisher.nick : '';

  return { name, nick: nick || null, display: nick || name };
}

/**
 * An embedded `replied_post` / `forwarded_post`, flattened to what a quote block
 * can show. Never recursed past one level: those structures nest.
 */
function normalizeReference(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  return {
    id: String(raw.id),
    author: normalizeAuthor(raw.publisher),
    title: raw.title || null,
    content: typeof raw.content === 'string' ? raw.content : '',
    /** 0 = markdown, 1 = html. */
    contentType: raw.content_type || 0,
    publishedAt: raw.published_at || raw.created_at || null,
    isTruncated: Boolean(raw.is_truncated),
    attachments: normalizeAttachments(raw.attachments),
  };
}

function normalizeTags(raw) {
  if (!Array.isArray(raw)) return [];

  const tags = [];
  for (let index = 0; index < raw.length; index += 1) {
    const tag = raw[index];
    const name = tag && typeof tag === 'object' ? tag.name : null;
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

const KIND_KEYS = {
  image: 'post_attach_image',
  video: 'post_attach_video',
  audio: 'post_attach_audio',
  file: 'post_attach_file',
};

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function startsWith(value, prefix) {
  return value.slice(0, prefix.length) === prefix;
}

/**
 * @param {string} mimeType
 * @param {string} name
 * @returns {'image'|'video'|'audio'|'file'}
 */
export function attachmentKind(mimeType, name) {
  const mime = typeof mimeType === 'string' ? mimeType : '';
  if (mime) {
    if (startsWith(mime, 'image/')) return 'image';
    if (startsWith(mime, 'video/')) return 'video';
    if (startsWith(mime, 'audio/')) return 'audio';
    return 'file';
  }

  const extension = extensionOf(typeof name === 'string' ? name : '');
  if (IMAGE_EXTENSIONS.indexOf(extension) !== -1) return 'image';
  if (VIDEO_EXTENSIONS.indexOf(extension) !== -1) return 'video';
  if (AUDIO_EXTENSIONS.indexOf(extension) !== -1) return 'audio';
  return 'file';
}

/**
 * @param {string} kind from `attachmentKind`
 * @returns {string} string-table key for the row's `[image]` marker
 */
export function attachmentKindKey(kind) {
  return KIND_KEYS[kind] || 'post_attach_file';
}

const KILOBYTE = 1024;
const MEGABYTE = 1048576;

/** Locale-neutral on purpose: `Intl` is not worth its bytes on Gecko 48. */
function formatBytes(size) {
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
 *
 * @param {object} attachment normalised attachment
 * @returns {string}
 */
export function describeAttachment(attachment) {
  const parts = [];
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
function normalizeAttachment(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;

  const name = typeof raw.name === 'string' ? raw.name : '';
  const mimeType = typeof raw.mime_type === 'string' ? raw.mime_type : '';

  return {
    id: String(raw.id),
    name,
    mimeType,
    kind: attachmentKind(mimeType, name),
    size: typeof raw.size === 'number' && raw.size > 0 ? raw.size : 0,
    width: raw.width || 0,
    height: raw.height || 0,
  };
}

/**
 * @param {unknown} raw
 * @returns {Array<object>} drops anything without an id
 */
function normalizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeAttachment).filter(Boolean);
}

/**
 * Post kind (`type` on the wire) → string-table key. A moment is the default and
 * needs no label; an unknown enum renders as nothing rather than as a number.
 * @param {number} kind
 * @returns {string|null}
 */
export function postKindKey(kind) {
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
 *
 * @param {object} raw
 * @returns {object|null}
 */
export function normalizeCountdown(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const title = typeof raw.title === 'string' ? raw.title : '';
  const startTime = raw.start_time || null;
  if (!title || !startTime) return null;

  return {
    id: raw.event_id ? String(raw.event_id) : title + '@' + startTime,
    title,
    startTime,
    endTime: raw.end_time || null,
    isOngoing: Boolean(raw.is_ongoing),
  };
}

/**
 * @param {unknown} raw
 * @returns {Array<object>}
 */
export function normalizeCountdownList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeCountdown).filter(Boolean);
}

/**
 * How far away an event is, as a string-table key and its arguments. The
 * view formats it, so the wording stays in the string table.
 *
 * @param {object} event normalised countdown
 * @param {number} [now]
 * @returns {{ key: string, args?: object } | null}
 */
export function countdownLabel(event, now = Date.now()) {
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

/**
 * @param {object} raw
 * @returns {object|null} `null` when `raw` is not a post, so callers can filter
 */
export function normalizePost(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;

  const reactions = {};
  const rawReactions = objectOrEmpty(raw.reactions_count);
  const symbols = Object.keys(rawReactions);
  for (let index = 0; index < symbols.length; index += 1) {
    reactions[symbols[index]] = rawReactions[symbols[index]];
  }

  return {
    id: String(raw.id),
    slug: raw.slug || null,
    title: raw.title || null,
    description: raw.description || null,
    content: typeof raw.content === 'string' ? raw.content : '',
    /** 0 = markdown, 1 = html. */
    contentType: raw.content_type || 0,
    /** 0 = moment, 1 = article, 2 = blog. */
    kind: raw.type || 0,
    /** 0 = public, 1 = friends, 2 = unlisted, 3 = private, … */
    visibility: raw.visibility || 0,
    // Anonymous reads never return drafts, but the fallback keeps a missing
    // `published_at` from producing an empty timestamp.
    publishedAt: raw.published_at || raw.created_at || null,
    editedAt: raw.edited_at || null,
    isTruncated: Boolean(raw.is_truncated),
    counts: {
      replies: raw.replies_count || 0,
      boosts: raw.boost_count || 0,
      // `reactions_count` arrives as `{ pray: 1 }`; the count of *kinds* is what
      // the string table renders.
      reactions: symbols.length,
      upvotes: raw.upvotes || 0,
      downvotes: raw.downvotes || 0,
      views: raw.views_total || 0,
    },
    reactions,
    tags: normalizeTags(raw.tags),
    attachments: normalizeAttachments(raw.attachments),
    author: normalizeAuthor(raw.publisher),
    repliedTo: normalizeReference(raw.replied_post),
    forwardedFrom: normalizeReference(raw.forwarded_post),
  };
}

/**
 * @param {unknown} raw
 * @returns {Array<object>} drops anything that is not a post
 */
export function normalizePostList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizePost).filter(Boolean);
}

/**
 * Visibility enum → string-table key. `0` (public) has no label, and an enum
 * this build does not know about renders as nothing rather than as a raw number.
 * @param {number} visibility
 * @returns {string|null}
 */
export function visibilityKey(visibility) {
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
 * @param {string|null} iso
 * @param {number} [now]
 * @returns {{ key: string, args?: object } | { text: string } | null} `null` when
 *   there is no usable date, so callers can leave the timestamp out.
 */
export function formatRelativeTime(iso, now = Date.now()) {
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
