import { API_BASE_URL } from '~/src/api/solian.js';
import { request } from '~/src/kaios/xhr.js';
import { useAccountStore, type Account, type AccountProfile } from '~/src/stores/account.js';

/**
 * The OAuth 2.0 device authorization flow (RFC 8628), mirroring the
 * SolianWatch app's standalone sign-in:
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
 * Everything the views read lives in the Pinia account store
 * (`~/src/stores/account.ts`); this module keeps the tokens and the flow
 * private and writes the store. `session.js` imports `API_BASE_URL` from
 * `solian.ts`, which imports `bearerToken` from here — that cycle is safe:
 * both sides use the other's export only inside functions, never at
 * module-evaluation time.
 */

const CLIENT_ID = 'solian-on-watch';
/** The watch's client allows `["*"]` and the server matches scopes exactly. */
const SCOPE = '*';
const STORAGE_KEY = 'sokai.session';
/** Refresh a token with less than this much life left. */
const REFRESH_BEFORE_MS = 60000;
const DEFAULT_EXPIRES_S = 600;

let accessToken: string | null = null;
let refreshToken: string | null = null;
/** Epoch milliseconds at which `accessToken` expires. */
let expiresAt = 0;
/**
 * Bumped on cancel/sign-out to invalidate any in-flight poll: a started flow
 * captures the generation and stops acting once it no longer matches.
 */
let pollGeneration = 0;

interface StoredSession {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  account?: unknown;
}

interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}

/** The flow's own failure shape: an l10n key, or a Stargate `error` code. */
interface FlowError extends Error {
  pollKey?: string;
  error?: string;
}

// ---- Storage ---------------------------------------------------------------

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch (error) {
    return null;
  }
}

/**
 * Restores a stored session into the account store. Called by `main.ts` after
 * Pinia is installed — the store needs an active Pinia, which module
 * evaluation time does not have.
 */
export function initSession(): void {
  const account = useAccountStore();
  const store = storage();
  if (!store) return;
  let raw: StoredSession | null = null;
  try {
    raw = JSON.parse(store.getItem(STORAGE_KEY) || 'null') as StoredSession | null;
  } catch (error) {
    raw = null;
  }
  if (!raw || typeof raw.accessToken !== 'string') return;

  accessToken = raw.accessToken;
  refreshToken = typeof raw.refreshToken === 'string' ? raw.refreshToken : null;
  expiresAt = typeof raw.expiresAt === 'number' ? raw.expiresAt : 0;
  // Optimistic: the cached identity renders immediately; a dead token is
  // discovered lazily by the first `bearerToken()` refresh. The cached
  // identity is also refreshed best-effort in the background — `refreshProfile`
  // refreshes an expired token and re-fetches `/me`, so a display name or
  // banner changed on another device shows up on the next launch.
  account.phase = 'signed-in';
  account.account = raw.account && typeof raw.account === 'object' ? (raw.account as Account) : null;
  refreshProfile(pollGeneration);
}

function saveSession(): void {
  const store = storage();
  if (!store) return;
  const record: StoredSession = {
    accessToken: accessToken as string | undefined,
    refreshToken: refreshToken as string | undefined,
    expiresAt: expiresAt,
    account: useAccountStore().account,
  };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch (error) {
    // Quota or a blocking host: the session still lives in memory.
  }
}

function clearStoredSession(): void {
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
 */
export async function bearerToken(): Promise<string | null> {
  if (!accessToken) return null;
  if (expiresAt - Date.now() > REFRESH_BEFORE_MS) return accessToken;
  if (!refreshToken) return accessToken;

  try {
    const pair = await refresh(refreshToken);
    storePair(pair);
    return accessToken;
  } catch (error) {
    if (error && (error as FlowError).error === 'invalid_grant') {
      dropSession();
      return null;
    }
    return accessToken;
  }
}

function storePair(pair: TokenPair): void {
  accessToken = pair.accessToken;
  // Stargate may rotate the refresh token or omit it; keep the previous one
  // when a response does not carry a replacement.
  if (pair.refreshToken) refreshToken = pair.refreshToken;
  expiresAt = Date.now() + pair.expiresIn * 1000;
  saveSession();
}

function dropSession(): void {
  pollGeneration += 1;
  accessToken = null;
  refreshToken = null;
  expiresAt = 0;
  useAccountStore().reset();
  clearStoredSession();
}

// ---- Device flow -----------------------------------------------------------

/**
 * Starts (or restarts) sign-in: asks Stargate for a device code and polls the
 * token endpoint until the user approves on another device. Terminal failures
 * land in the store's `errorKey` as an l10n key; the view offers a retry.
 */
export async function startSignIn(): Promise<void> {
  const account = useAccountStore();
  if (account.phase === 'signing-in') cancelSignIn();
  const generation = ++pollGeneration;

  account.phase = 'signing-in';
  account.waiting = false;
  account.errorKey = '';
  account.userCode = '';
  account.verificationUri = '';
  account.verificationUriComplete = '';

  try {
    const code = await requestDeviceCode();
    if (generation !== pollGeneration) return;
    account.userCode = code.userCode;
    account.verificationUri = code.verificationUri;
    account.verificationUriComplete = code.verificationUriComplete || '';
    account.waiting = true;
    await poll(code, generation);
  } catch (error) {
    if (generation !== pollGeneration) return;
    account.waiting = false;
    account.errorKey =
      error && typeof (error as FlowError).pollKey === 'string'
        ? (error as FlowError).pollKey as string
        : 'error_load_failed';
  }
}

/** Cancels an in-flight sign-in (the Cancel softkey, or leaving the screen). */
export function cancelSignIn(): void {
  const account = useAccountStore();
  if (account.phase !== 'signing-in') return;
  pollGeneration += 1;
  account.reset();
}

/**
 * Signs out: revokes the server session (best effort, never blocking — a
 * failure only means the session outlives this device) and drops every local
 * trace so the next sign-in starts clean.
 */
export function signOut(): void {
  const token = accessToken;
  dropSession();
  if (token) {
    request(API_BASE_URL + '/stargate/sessions/current', {
      method: 'DELETE',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
    }).catch(() => {
      // Best effort: local sign-out already happened.
    });
  }
}

// ---- Flow internals --------------------------------------------------------

function form(pairs: Array<[string, string]>): string {
  return pairs
    .map((pair) => encodeURIComponent(pair[0]) + '=' + encodeURIComponent(pair[1]))
    .join('&');
}

function formOptions(body: string): { method: string; headers: Record<string, string>; body: string } {
  return {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body,
  };
}

async function requestDeviceCode(): Promise<DeviceCode> {
  const response = await request(
    API_BASE_URL + '/stargate/auth/open/device/code',
    formOptions(form([['client_id', CLIENT_ID], ['scope', SCOPE]])),
  );
  const data = response.data as Record<string, unknown> | null;
  if (!data || typeof data.device_code !== 'string' || typeof data.user_code !== 'string') {
    const error = new Error('Invalid device response') as FlowError;
    error.pollKey = 'error_load_failed';
    throw error;
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: typeof data.verification_uri === 'string' ? data.verification_uri : '',
    verificationUriComplete:
      typeof data.verification_uri_complete === 'string' ? data.verification_uri_complete : '',
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : DEFAULT_EXPIRES_S,
    interval: typeof data.interval === 'number' ? data.interval : 5,
  };
}

/**
 * Polls until approval. RFC 8628: `authorization_pending` keeps waiting,
 * `slow_down` lengthens the interval by five seconds, and the terminal errors
 * (`access_denied`, `expired_token`, `invalid_grant`) end the flow.
 */
async function poll(code: DeviceCode, generation: number): Promise<void> {
  const deadline = Date.now() + code.expiresIn * 1000;
  let delayMs = Math.max(code.interval, 1) * 1000;

  while (Date.now() < deadline) {
    await sleep(delayMs);
    if (generation !== pollGeneration) return;

    let pair: TokenPair;
    try {
      pair = await exchange(code.deviceCode);
    } catch (error) {
      if (generation !== pollGeneration) return;
      switch ((error as FlowError).error) {
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
    const account = useAccountStore();
    account.waiting = false;
    // The identity is a nice-to-have; a failed profile fetch keeps the session.
    await refreshProfile(generation);
    if (generation !== pollGeneration) return;
    account.phase = 'signed-in';
    return;
  }

  throw pollFailure('account_expired');
}

function pollFailure(key: string): FlowError {
  const error = new Error(key) as FlowError;
  error.pollKey = key;
  return error;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function exchange(deviceCode: string): Promise<TokenPair> {
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

async function refresh(token: string): Promise<TokenPair> {
  const response = await request(
    API_BASE_URL + '/stargate/auth/open/token',
    formOptions(form([['grant_type', 'refresh_token'], ['client_id', CLIENT_ID], ['refresh_token', token]])),
  );
  return parseTokenResponse(response.data);
}

function parseTokenResponse(data: unknown): TokenPair {
  const source = data as Record<string, unknown> | null;
  if (!source || typeof source.access_token !== 'string') {
    const error = new Error('Invalid token response') as FlowError;
    error.error = 'invalid_response';
    throw error;
  }
  return {
    accessToken: source.access_token,
    refreshToken: typeof source.refresh_token === 'string' ? source.refresh_token : null,
    expiresIn: typeof source.expires_in === 'number' ? source.expires_in : 300,
  };
}

/**
 * Fetches the signed-in identity into the store, best-effort. Called after a
 * successful device-flow exchange and, fire-and-forget, on session restore
 * (where it also refreshes an expired token first — `bearerToken` — so the
 * launch self-heals before the first read request).
 *
 * `generation` guards against the identity applying after a sign-out or a new
 * sign-in replaced the session; a failed fetch keeps the cached identity.
 */
async function refreshProfile(generation: number): Promise<void> {
  try {
    const token = await bearerToken();
    if (!token || generation !== pollGeneration) return;
    const response = await request(API_BASE_URL + '/stargate/accounts/me', {
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
    });
    const account = normalizeAccount(response.data);
    if (generation !== pollGeneration || !account) return;
    useAccountStore().account = account;
    saveSession();
  } catch (error) {
    // Best effort: the token is valid even if the profile fetch is not.
  }
}

function normalizeAccount(raw: unknown): Account | null {
  const source = raw as Record<string, unknown> | null;
  if (!source || typeof source !== 'object' || typeof source.id !== 'string') return null;
  const name = typeof source.name === 'string' ? source.name : '';
  const nick = typeof source.nick === 'string' ? source.nick : '';
  return {
    id: source.id,
    name: name,
    nick: nick,
    display: nick || name,
    // The banner is optional: keep whatever profile object the server sent
    // (`null` when there is none — the signed-in screen guards on it).
    profile:
      source.profile && typeof source.profile === 'object' ? (source.profile as AccountProfile) : null,
  };
}
