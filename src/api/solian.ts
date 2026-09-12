/**
 * The Solar Network Sphere API, as far as this app reads it.
 *
 * Every call here is anonymous: the public `/sphere/...` routes need no
 * `Authorization` header, and the server limits anonymous responses to public,
 * published, non-draft posts anyway. No proxy — on device the privileged
 * `systemXHR` path bypasses CORS entirely (see `~/src/kaios/xhr.ts`).
 */

import { request } from '~/src/kaios/xhr.js';
import { bearerToken } from '~/src/kaios/session.js';
import {
  normalizeCountdownList,
  normalizePost,
  normalizePostList,
  type Countdown,
  type Post,
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
 * A published file, as an `<img>` can load it. The endpoint answers `307` to a
 * signed object-storage URL — for images a compressed WebP, observed between
 * 24kB and 350kB — so no CORS or `systemXHR` involvement is needed: plain image
 * loading is cross-origin by design, and the KaiOS privileged CSP starts at
 * `default-src * data: blob:`.
 */
export function fileUrl(id: string): string {
  return API_BASE_URL + '/drive/files/' + encodeURIComponent(id);
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
