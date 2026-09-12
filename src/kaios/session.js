import { reactive } from 'vue';

import { API_BASE_URL } from '../api/solian.js';
import { request } from './xhr.js';

/**
 * Session state and the OAuth 2.0 device authorization flow (RFC 8628),
 * mirroring the SolianWatch app's standalone sign-in:
 *
 *   POST {base}/stargate/auth/open/device/code   (form: client_id, scope)
 *     -> { device_code, user_code, verification_uri, expires_in, interval }
 *   POST {base}/stargate/auth/open/token         (poll, form)
 *     grant_type=urn:ietf:params:oauth:grant-type:device_code
 *     -> 200 { access_token, refresh_token, expires_in } on approval
 *     -> 400 { error: authorization_pending | slow_down | expired_token |
 *                     access_denied | invalid_grant } while pending / terminal
 *   POST {base}/stargate/auth/open/token         (refresh)
 *     grant_type=refresh_token -> { access_token, refresh_token, ... }
 *   GET  {base}/stargate/accounts/me             (Bearer) -> profile
 *   DELETE {base}/stargate/sessions/current      (Bearer) -> revoke on sign-out
 *
 * The client id is shared with the watch: `solian-on-watch` is a public OIDC
 * client registered server-side (no secret — the device code is the
 * credential), so a KaiOS app can authenticate as the same client.
 *
 * The token pair lives in localStorage — the only durable store a KaiOS 2.5
 * app has (the watch keeps it in the iOS Keychain for the same reason). Reads
 * and writes are guarded: on hosts with no localStorage (a `file://` origin,
 * private mode) the app simply runs anonymous.
 *
 * `bearerToken()` is the refresh seam: every API call awaits it, so a token
 * near expiry is refreshed lazily, and an `invalid_grant` from the refresh
 * (revoked/expired server-side) drops the session back to anonymous rather
 * than leaving a half-authenticated app.
 *
 * `session.js` imports `API_BASE_URL` from `solian.js`, which imports
 * `bearerToken` from here. That cycle is safe: both sides use the other's
 * export only inside functions, never at module-evaluation time.
 */

export const session = reactive({
  /** 'anonymous' | 'signing-in' | 'signed-in' */
  phase: 'anonymous',
  /** The code to type on the approving device, while `phase === 'signing-in'`. */
  userCode: '',
  /** The page to open on that device; the code is entered there. */
  verificationUri: '',
  /** True while a poll is in flight waiting for approval. */
  waiting: false,
  /** l10n key for the last sign-in failure; '' when the flow is healthy. */
  errorKey: '',
  /** Cached identity: { id, name, nick, display }; null when not signed in. */
  account: null,
});

const CLIENT_ID = 'solian-on-watch';
/** The watch's client allows `["*"]` and the server matches scopes exactly. */
const SCOPE = '*';
const STORAGE_KEY = 'sokai.session';
/** Refresh a token with less than this much life left. */
const REFRESH_BEFORE_MS = 60000;
const DEFAULT_EXPIRES_S = 600;

let accessToken = null;
let refreshToken = null;
/** Epoch milliseconds at which `accessToken` expires. */
let expiresAt = 0;
/**
 * Bumped on cancel/sign-out to invalidate any in-flight poll: a started flow
 * captures the generation and stops acting once it no longer matches.
 */
let pollGeneration = 0;

// ---- Storage ---------------------------------------------------------------

function storage() {
  try {
    return window.localStorage;
  } catch (error) {
    return null;
  }
}

function loadStoredSession() {
  const store = storage();
  if (!store) return;
  let raw = null;
  try {
    raw = JSON.parse(store.getItem(STORAGE_KEY) || 'null');
  } catch (error) {
    raw = null;
  }
  if (!raw || typeof raw.accessToken !== 'string') return;

  accessToken = raw.accessToken;
  refreshToken = typeof raw.refreshToken === 'string' ? raw.refreshToken : null;
  expiresAt = typeof raw.expiresAt === 'number' ? raw.expiresAt : 0;
  // Optimistic: the cached identity renders immediately; a dead token is
  // discovered lazily by the first `bearerToken()` refresh.
  session.phase = 'signed-in';
  session.account = raw.account && typeof raw.account === 'object' ? raw.account : null;
}

function saveSession() {
  const store = storage();
  if (!store) return;
  const record = {
    accessToken: accessToken,
    refreshToken: refreshToken,
    expiresAt: expiresAt,
    account: session.account,
  };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch (error) {
    // Quota or a blocking host: the session still lives in memory.
  }
}

function clearStoredSession() {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch (error) {
    // Nothing left to do; the in-memory state is dropped regardless.
  }
}

// ---- Token plumbing --------------------------------------------------------

/**
 * A usable bearer token for the API's `Authorization` header, refreshing
 * lazily when the cached one is near expiry. `null` when anonymous — the API
 * calls are then simply unauthenticated.
 *
 * A refresh rejected as `invalid_grant` means the session is dead server-side:
 * it is dropped and `null` returned. Any other refresh failure is transient, so
 * the cached token is sent anyway and the request surfaces the outcome itself.
 *
 * @returns {Promise<string|null>}
 */
export async function bearerToken() {
  if (!accessToken) return null;
  if (expiresAt - Date.now() > REFRESH_BEFORE_MS) return accessToken;
  if (!refreshToken) return accessToken;

  try {
    const pair = await refresh(refreshToken);
    storePair(pair);
    return accessToken;
  } catch (error) {
    if (error && error.error === 'invalid_grant') {
      dropSession();
      return null;
    }
    return accessToken;
  }
}

function storePair(pair) {
  accessToken = pair.accessToken;
  // Stargate may rotate the refresh token or omit it; keep the previous one
  // when a response does not carry a replacement.
  if (pair.refreshToken) refreshToken = pair.refreshToken;
  expiresAt = Date.now() + pair.expiresIn * 1000;
  saveSession();
}

function dropSession() {
  pollGeneration += 1;
  accessToken = null;
  refreshToken = null;
  expiresAt = 0;
  session.phase = 'anonymous';
  session.waiting = false;
  session.errorKey = '';
  session.userCode = '';
  session.verificationUri = '';
  session.account = null;
  clearStoredSession();
}

// ---- Device flow -----------------------------------------------------------

/**
 * Starts (or restarts) sign-in: asks Stargate for a device code and polls the
 * token endpoint until the user approves on another device. Terminal failures
 * land in `session.errorKey` as an l10n key; the view offers a retry.
 */
export async function startSignIn() {
  if (session.phase === 'signing-in') cancelSignIn();
  const generation = ++pollGeneration;

  session.phase = 'signing-in';
  session.waiting = false;
  session.errorKey = '';
  session.userCode = '';
  session.verificationUri = '';

  try {
    const code = await requestDeviceCode();
    if (generation !== pollGeneration) return;
    session.userCode = code.userCode;
    session.verificationUri = code.verificationUri;
    session.waiting = true;
    await poll(code, generation);
  } catch (error) {
    if (generation !== pollGeneration) return;
    session.waiting = false;
    session.errorKey = error && typeof error.pollKey === 'string' ? error.pollKey : 'error_load_failed';
  }
}

/** Cancels an in-flight sign-in (the Cancel softkey, or leaving the screen). */
export function cancelSignIn() {
  if (session.phase !== 'signing-in') return;
  pollGeneration += 1;
  session.phase = 'anonymous';
  session.waiting = false;
  session.errorKey = '';
  session.userCode = '';
  session.verificationUri = '';
}

/**
 * Signs out: revokes the server session (best effort, never blocking — a
 * failure only means the session outlives this device) and drops every local
 * trace so the next sign-in starts clean.
 */
export function signOut() {
  const token = accessToken;
  dropSession();
  if (token) {
    request(API_BASE_URL + '/stargate/sessions/current', {
      method: 'DELETE',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
    }).catch(function () {
      // Best effort: local sign-out already happened.
    });
  }
}

// ---- Flow internals --------------------------------------------------------

function form(pairs) {
  return pairs
    .map(function (pair) {
      return encodeURIComponent(pair[0]) + '=' + encodeURIComponent(pair[1]);
    })
    .join('&');
}

function formOptions(body) {
  return {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body,
  };
}

async function requestDeviceCode() {
  const response = await request(
    API_BASE_URL + '/stargate/auth/open/device/code',
    formOptions(form([['client_id', CLIENT_ID], ['scope', SCOPE]])),
  );
  const data = response.data;
  if (!data || typeof data.device_code !== 'string' || typeof data.user_code !== 'string') {
    const error = new Error('Invalid device response');
    error.pollKey = 'error_load_failed';
    throw error;
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: typeof data.verification_uri === 'string' ? data.verification_uri : '',
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : DEFAULT_EXPIRES_S,
    interval: typeof data.interval === 'number' ? data.interval : 5,
  };
}

/**
 * Polls until approval. RFC 8628: `authorization_pending` keeps waiting,
 * `slow_down` lengthens the interval by five seconds, and the terminal errors
 * (`access_denied`, `expired_token`, `invalid_grant`) end the flow.
 */
async function poll(code, generation) {
  const deadline = Date.now() + code.expiresIn * 1000;
  let delayMs = Math.max(code.interval, 1) * 1000;

  while (Date.now() < deadline) {
    await sleep(delayMs);
    if (generation !== pollGeneration) return;

    let pair;
    try {
      pair = await exchange(code.deviceCode);
    } catch (error) {
      if (generation !== pollGeneration) return;
      switch (error && error.error) {
        case 'authorization_pending':
          continue;
        case 'slow_down':
          delayMs += 5000;
          continue;
        case 'access_denied':
          throw pollFailure('account_denied');
        case 'expired_token':
        case 'invalid_grant':
          throw pollFailure('account_expired');
        default:
          throw pollFailure('error_load_failed');
      }
    }

    if (generation !== pollGeneration) return;
    storePair(pair);
    session.waiting = false;
    // The identity is a nice-to-have; a failed profile fetch keeps the session.
    await loadProfile(generation);
    if (generation !== pollGeneration) return;
    session.phase = 'signed-in';
    return;
  }

  throw pollFailure('account_expired');
}

function pollFailure(key) {
  const error = new Error(key);
  error.pollKey = key;
  return error;
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function exchange(deviceCode) {
  const response = await request(
    API_BASE_URL + '/stargate/auth/open/token',
    formOptions(
      form([
        ['grant_type', 'urn:ietf:params:oauth:grant-type:device_code'],
        ['client_id', CLIENT_ID],
        ['device_code', deviceCode],
      ]),
    ),
  );
  return parseTokenResponse(response.data);
}

async function refresh(token) {
  const response = await request(
    API_BASE_URL + '/stargate/auth/open/token',
    formOptions(form([['grant_type', 'refresh_token'], ['client_id', CLIENT_ID], ['refresh_token', token]])),
  );
  return parseTokenResponse(response.data);
}

function parseTokenResponse(data) {
  if (!data || typeof data.access_token !== 'string') {
    const error = new Error('Invalid token response');
    error.error = 'invalid_response';
    throw error;
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 300,
  };
}

async function loadProfile(generation) {
  try {
    const response = await request(API_BASE_URL + '/stargate/accounts/me', {
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + accessToken },
    });
    const account = normalizeAccount(response.data);
    if (generation !== pollGeneration || !account) return;
    session.account = account;
    saveSession();
  } catch (error) {
    // Best effort: the token is valid even if the profile fetch is not.
  }
}

function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const name = typeof raw.name === 'string' ? raw.name : '';
  const nick = typeof raw.nick === 'string' ? raw.nick : '';
  return {
    id: raw.id,
    name: name,
    nick: nick,
    display: nick || name,
  };
}

loadStoredSession();
