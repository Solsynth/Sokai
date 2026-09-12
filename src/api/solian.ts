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

import { request } from '~/src/kaios/xhr.js';
import { bearerToken } from '~/src/kaios/session.js';
import {
  normalizeCountdownList,
  normalizePost,
  normalizePostList,
  normalizePublisherList,
  type Countdown,
  type Post,
  type Publisher,
} from '~/src/api/models.js';

export const API_BASE_URL = 'https://api.solian.app';

const DEFAULT_TAKE = 20;

/**
 * Headers for an API call. Anonymous callers send only `Accept`; a live
 * session adds `Authorization: Bearer <token>` (refreshed lazily by the
 * session module when near expiry), which lifts the server's anonymous
 * limits — friends-only, unlisted and draft posts become visible, and
 * per-account routes answer.
 */
async function apiHeaders(): Promise<{ headers: Record<string, string> }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = await bearerToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  return { headers };
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
 * engine answers it — which is why a search can take a few seconds).
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

  const response = await request(url, await apiHeaders());
  return { posts: normalizePostList(response.data), total: readTotal(response.headers) };
}

/** `null` when the payload is not a post. */
export async function getPost(id: string): Promise<Post | null> {
  const url = API_BASE_URL + '/sphere/posts/' + encodeURIComponent(id);

  const response = await request(url, await apiHeaders());
  return normalizePost(response.data);
}

/**
 * Whose calendar the dashboard counts down to. Signed in, the countdown comes
 * from the user's own account (`me`); anonymous, the name-scoped route is
 * used — the public events of the developer account mixed with the network's
 * own notable days.
 */
const COUNTDOWN_ACCOUNT = 'solsynth';

/** Soonest first, as the server orders them. */
export async function listCountdowns({ take = 3 } = {}): Promise<Countdown[]> {
  const token = await bearerToken();
  if (token) {
    try {
      const url = API_BASE_URL + '/passport/accounts/me/calendar/countdown?take=' + take;
      const response = await request(url, await apiHeaders());
      return normalizeCountdownList(response.data);
    } catch (error) {
      // The signed-in route is per-account; fall back to the public mix.
    }
  }
  const url =
    API_BASE_URL +
    '/passport/accounts/' +
    encodeURIComponent(COUNTDOWN_ACCOUNT) +
    '/calendar/countdown?take=' +
    take;

  const response = await request(url, await apiHeaders());
  return normalizeCountdownList(response.data);
}

/** A post's replies, offset-paginated like the feed. */
export async function listReplies(
  id: string,
  { take = DEFAULT_TAKE, offset = 0 } = {},
): Promise<{ posts: Post[]; total: number }> {
  const url =
    API_BASE_URL + '/sphere/posts/' + encodeURIComponent(id) + '/replies?take=' + take + '&offset=' + offset;

  const response = await request(url, await apiHeaders());
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
  const response = await request(url, await apiHeaders());
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

  const response = await request(API_BASE_URL + '/drive/files/upload/direct', {
    method: 'POST',
    ...(await apiHeaders()),
    body: form,
  });

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

  const response = await request(url, {
    method: 'POST',
    ...(await apiHeaders()),
    body,
  });
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
  const response = await request(url, {
    method: 'PATCH',
    ...(await apiHeaders()),
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
  await request(url, {
    method: 'DELETE',
    ...(await apiHeaders()),
  });
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
  const response = await request(url, {
    method: 'POST',
    ...(await apiHeaders()),
    body: { symbol, attitude },
  });
  return response.status !== 204;
}
