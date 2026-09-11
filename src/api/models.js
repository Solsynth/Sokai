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
 * An embedded `replied_post` / `forwarded_post`, flattened to what a row can
 * show. Never recursed further: those structures nest.
 */
function normalizeReference(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  return { id: String(raw.id), author: { display: normalizeAuthor(raw.publisher).display } };
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
    attachmentCount: Array.isArray(raw.attachments) ? raw.attachments.length : 0,
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
