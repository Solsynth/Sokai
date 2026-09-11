/**
 * The Solar Network Sphere API, as far as this app reads it.
 *
 * Every call here is anonymous: the public `/sphere/...` routes need no
 * `Authorization` header, and the server limits anonymous responses to public,
 * published, non-draft posts anyway. No proxy — on device the privileged
 * `systemXHR` path bypasses CORS entirely (see `src/kaios/xhr.js`).
 */

import { request } from '../kaios/xhr.js';
import { normalizeCountdownList, normalizePost, normalizePostList } from './models.js';

export const API_BASE_URL = 'https://api.solian.app';

const DEFAULT_TAKE = 20;

/**
 * A published file, as an `<img>` can load it. The endpoint answers `307` to a
 * signed object-storage URL — for images a compressed WebP, observed between
 * 24kB and 350kB — so no CORS or `systemXHR` involvement is needed: plain image
 * loading is cross-origin by design, and the KaiOS privileged CSP starts at
 * `default-src * data: blob:`.
 *
 * @param {string} id attachment id from the wire
 * @returns {string}
 */
export function fileUrl(id) {
  return API_BASE_URL + '/drive/files/' + encodeURIComponent(id);
}

/**
 * Pagination is `offset` + `take`. The body is a bare array; the row count
 * lives in the `x-total` response header.
 */
function readTotal(headers) {
  const total = parseInt(headers ? headers['x-total'] : '', 10);
  return Number.isNaN(total) ? 0 : total;
}

function accept() {
  return { headers: { Accept: 'application/json' } };
}

/**
 * @param {{ take?: number, offset?: number }} [options]
 * @returns {Promise<{ posts: Array<object>, total: number }>}
 */
export async function listPosts({ take = DEFAULT_TAKE, offset = 0 } = {}) {
  const url =
    API_BASE_URL + '/sphere/posts?take=' + take + '&offset=' + offset + '&replies=false&orderDesc=true';

  const response = await request(url, accept());
  return { posts: normalizePostList(response.data), total: readTotal(response.headers) };
}

/**
 * @param {string} id
 * @returns {Promise<object|null>} `null` when the payload is not a post
 */
export async function getPost(id) {
  const url = API_BASE_URL + '/sphere/posts/' + encodeURIComponent(id);

  const response = await request(url, accept());
  return normalizePost(response.data);
}

/**
 * Whose calendar the dashboard counts down to.
 *
 * The `/calendar/countdown` route under `/accounts/me` needs a session, which
 * this increment does not have; the name-scoped route is anonymous, and the
 * response mixes the named account's public events with the network's own
 * notable days. The developer account is used so the mix is the network's, not a
 * private person's — swap this name, or move to `me`, when log-in lands.
 */
const COUNTDOWN_ACCOUNT = 'solsynth';

/**
 * @param {{ take?: number }} [options]
 * @returns {Promise<Array<object>>} soonest first, as the server orders them
 */
export async function listCountdowns({ take = 3 } = {}) {
  const url =
    API_BASE_URL +
    '/passport/accounts/' +
    encodeURIComponent(COUNTDOWN_ACCOUNT) +
    '/calendar/countdown?take=' +
    take;

  const response = await request(url, accept());
  return normalizeCountdownList(response.data);
}

/**
 * @param {string} id
 * @param {{ take?: number, offset?: number }} [options]
 * @returns {Promise<{ posts: Array<object>, total: number }>}
 */
export async function listReplies(id, { take = DEFAULT_TAKE, offset = 0 } = {}) {
  const url =
    API_BASE_URL + '/sphere/posts/' + encodeURIComponent(id) + '/replies?take=' + take + '&offset=' + offset;

  const response = await request(url, accept());
  return { posts: normalizePostList(response.data), total: readTotal(response.headers) };
}
