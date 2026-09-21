import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

/**
 * A disk-backed cache for the app's media — the drive thumbnails, originals,
 * video posters and voice notes that every feed, thread and viewer renders.
 *
 * Without it a picture is fetched again every time a row is re-seen: Gecko 48's
 * HTTP cache is per-URL and the device clears it freely, so a handset
 * re-downloads the same bytes on every visit. This module keeps the fetched
 * Blobs in IndexedDB — the same removable, `temporary`-storage database shape
 * `src/kaios/idb.ts` uses for the chat cache — and hands screens `blob:` URLs
 * backed by disk.
 *
 * Design rules, mirroring the chat cache's:
 *
 *  - The database is opened removable, and every failure — no IndexedDB, a
 *    blocked open, a refused write — degrades to loading the URL directly,
 *    exactly what the app did before. The cache is a speedup, never a
 *    dependency: hosts without IndexedDB (jsdom, a locked-down origin) keep
 *    their exact old behaviour, which is what the smoke gate locks in.
 *  - Media is capped: at most `MAX_CACHE_BYTES` on disk, evicted oldest-first,
 *    and an entry bigger than `MAX_ENTRY_BYTES` is never stored or even
 *    buffered — a multi-megabyte original has no business pinned on a feature
 *    phone, and the browser's own cache still covers it in flight.
 *  - Bytes are fetched through a `mozSystem` XHR (the same privilege `xhr.ts`
 *    relies on): the drive endpoint answers no CORS headers, so `fetch()` has
 *    no way to read it. A host without the privilege falls back to a plain
 *    XHR, which fails where CORS is absent — the URL is then loaded directly,
 *    as before.
 *  - Every `blob:` URL the module creates is owned by it and revoked on
 *    eviction or clear, so a cleared cache cannot leave dead URLs behind.
 *
 * `useCachedUrl` is the wiring a screen uses: it renders the raw URL
 * immediately (nothing is ever blank) and swaps in the cached `blob:` URL once
 * it is ready. A media element can pass `hold` so the swap never restarts a
 * playback mid-way.
 */

const DB_NAME = 'sokai-media';
const DB_VERSION = 1;

const STORE_FILES = 'files';
const STORE_META = 'meta';

/** Total on-disk budget: a modest slice of a handset's storage, oldest-first. */
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
/** An entry larger than this is never stored (nor buffered into memory). */
const MAX_ENTRY_BYTES = 6 * 1024 * 1024;

/** How long the open may take before the cache is treated as unavailable. */
const OPEN_TIMEOUT_MS = 3000;
/** How long one media fetch may take before the cache gives up on it. */
const FETCH_TIMEOUT_MS = 30000;

/** A row in the `meta` store: the facts eviction and stats need, sans bytes. */
interface MediaMeta {
  url: string;
  size: number;
  savedAt: number;
}

let db: IDBDatabase | null = null;
let openPromise: Promise<IDBDatabase | null> | null = null;

/** Every `blob:` URL created for a cached URL, so clear/eviction can revoke. */
const objectUrls = new Map<string, string>();
/** The one fetch in flight per URL, so a feed page asks for a URL once. */
const inflight = new Map<string, Promise<string>>();
/** Serialises writes, so the eviction totals below never race. */
let writeChain: Promise<void> = Promise.resolve();
/** Disk bytes the cache accounts for; `-1` until first read from the database. */
let totalBytes = -1;

/**
 * Opens the database, in the same removable shape as `src/kaios/idb.ts`: the
 * KaiOS options-object form marks it temporary (the system may delete it
 * freely), plain `open(name, version)` is the fallback, and the whole open is
 * abandoned after `OPEN_TIMEOUT_MS` rather than letting a blocked connection
 * hang a screen. A host with no IndexedDB resolves `null`.
 */
function openDatabase(): Promise<IDBDatabase | null> {
  if (openPromise) return openPromise;

  openPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      resolve(null);
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      const factory = indexedDB as unknown as {
        open(name: string, options: { version: number; storageType?: string }): IDBOpenDBRequest;
      };
      request = factory.open(DB_NAME, {
        version: DB_VERSION,
        storageType: 'temporary',
      });
    } catch (error) {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      // A version rise means the stored shape is not this revision's: drop the
      // old generation and rebuild empty — the rows are a cache, and a stale
      // blob of the wrong shape is not worth a migration.
      const stores = [STORE_FILES, STORE_META];
      for (let index = 0; index < stores.length; index += 1) {
        if (database.objectStoreNames.contains(stores[index])) {
          database.deleteObjectStore(stores[index]);
        }
      }
      if (!database.objectStoreNames.contains(STORE_FILES)) {
        database.createObjectStore(STORE_FILES, { keyPath: 'url' });
      }
      if (!database.objectStoreNames.contains(STORE_META)) {
        const meta = database.createObjectStore(STORE_META, { keyPath: 'url' });
        // Oldest-first eviction needs "saved, ascending"; `Date.now()` sorts.
        meta.createIndex('savedAt', 'savedAt');
      }
    };

    let settled = false;
    let timer = 0;
    const finish = (database: IDBDatabase | null, retryable: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (retryable) openPromise = null;
      resolve(database);
    };

    timer = window.setTimeout(() => finish(null, true), OPEN_TIMEOUT_MS);

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        db = null;
        openPromise = null;
      };
      db = database;
      finish(database, false);
    };

    request.onerror = () => finish(null, false);
    request.onblocked = () => finish(null, true);
  });

  return openPromise;
}

/** Reads a stored Blob; `null` when the URL was never cached or the DB failed. */
function readBlob(database: IDBDatabase, url: string): Promise<Blob | null> {
  const { promise, resolve } = Promise.withResolvers<Blob | null>();
  try {
    const store = database.transaction(STORE_FILES, 'readonly').objectStore(STORE_FILES);
    const request = store.get(url);
    request.onsuccess = () => {
      const row = request.result as { url: string; blob: Blob } | undefined;
      resolve(row && row.blob ? row.blob : null);
    };
    request.onerror = () => resolve(null);
  } catch (error) {
    resolve(null);
  }
  return promise;
}

/** Writes a Blob row and its meta row in one transaction. */
function putEntry(database: IDBDatabase, url: string, blob: Blob): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let transaction: IDBTransaction;
  try {
    transaction = database.transaction([STORE_FILES, STORE_META], 'readwrite');
  } catch (error) {
    resolve(false);
    return promise;
  }
  try {
    transaction.objectStore(STORE_FILES).put({ url, blob });
    transaction.objectStore(STORE_META).put({ url, size: blob.size, savedAt: Date.now() });
  } catch (error) {
    resolve(false);
    return promise;
  }
  transaction.oncomplete = () => resolve(true);
  transaction.onerror = () => resolve(false);
  transaction.onabort = () => resolve(false);
  return promise;
}

/** Drops the object URL a screen may be showing, if one was handed out. */
function revokeObjectUrl(url: string): void {
  const objectUrl = objectUrls.get(url);
  if (!objectUrl) return;
  objectUrls.delete(url);
  try {
    URL.revokeObjectURL(objectUrl);
  } catch (error) {
    // A host without `URL.createObjectURL` (jsdom without the harness stub):
    // nothing was created, so there is nothing to revoke.
  }
}

/**
 * Evicts the oldest entries until at least `bytesToFree` bytes are gone, and
 * adjusts the running total. Oldest-first on purpose: a cache is full of the
 * last feed visited, and the least recently saved is the least likely to be
 * wanted again. Runs inside the write chain, so the total never races.
 */
function evictBytes(database: IDBDatabase, bytesToFree: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let transaction: IDBTransaction;
  try {
    transaction = database.transaction([STORE_META, STORE_FILES], 'readwrite');
  } catch (error) {
    resolve(false);
    return promise;
  }
  const files = transaction.objectStore(STORE_FILES);
  const index = transaction.objectStore(STORE_META).index('savedAt');
  let freed = 0;
  let cursorFailed = false;

  const cursorRequest = index.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor || freed >= bytesToFree) return;
    const entry = cursor.value as MediaMeta;
    revokeObjectUrl(entry.url);
    files.delete(entry.url);
    cursor.delete();
    freed += entry.size;
    cursor.continue();
  };
  cursorRequest.onerror = () => {
    cursorFailed = true;
  };
  transaction.oncomplete = () => {
    if (!cursorFailed && totalBytes >= 0) totalBytes = Math.max(0, totalBytes - freed);
    resolve(!cursorFailed);
  };
  transaction.onerror = () => resolve(false);
  transaction.onabort = () => resolve(false);
  return promise;
}

/** Reads the stored byte total once, seeding the eviction counter. */
function seedTotals(database: IDBDatabase): Promise<void> {
  if (totalBytes >= 0) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<number>();
  try {
    const store = database.transaction(STORE_META, 'readonly').objectStore(STORE_META);
    let bytes = 0;
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(bytes);
        return;
      }
      bytes += (cursor.value as MediaMeta).size;
      cursor.continue();
    };
    request.onerror = () => resolve(0);
  } catch (error) {
    resolve(0);
  }
  return promise.then((bytes) => {
    totalBytes = bytes;
  });
}

/**
 * Persists a fetched Blob, best-effort: evict oldest to make room at the cap,
 * and when the device refuses the write (storage below the system threshold)
 * evict the oldest half and try once more. A cache that still cannot write is
 * simply not written — the URL loads directly, as before.
 */
async function persist(url: string, blob: Blob): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  await seedTotals(database);

  const over = totalBytes + blob.size - MAX_CACHE_BYTES;
  if (over > 0) await evictBytes(database, over);

  let ok = await putEntry(database, url, blob);
  if (!ok) {
    await evictBytes(database, Math.max(1, Math.round(totalBytes / 2)));
    ok = await putEntry(database, url, blob);
  }
  if (ok && totalBytes >= 0) totalBytes += blob.size;
}

/**
 * Fetches a media file's bytes without needing CORS on the server, through the
 * `systemXHR` privilege (see `xhr.ts`). `null` when the fetch failed, timed
 * out, or the file is too large to cache — callers then load the URL directly.
 */
function fetchBlob(url: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    let xhr: XMLHttpRequest;
    try {
      const SystemXHR = XMLHttpRequest as unknown as {
        new (options?: Record<string, unknown>): XMLHttpRequest;
      };
      xhr = new SystemXHR({ mozSystem: true });
    } catch (error) {
      // No `systemXHR` privilege (a desktop browser): the request goes out
      // under normal CORS rules, and fails where the API answers none — the
      // caller then loads the URL directly, exactly as before.
      xhr = new XMLHttpRequest();
    }
    try {
      xhr.open('GET', url, true);
      xhr.responseType = 'blob';
      xhr.timeout = FETCH_TIMEOUT_MS;
      xhr.onload = () => {
        const response = xhr.response as Blob | null;
        if (xhr.status < 200 || xhr.status >= 300 || !response) {
          resolve(null);
          return;
        }
        // Bail out before handing over a blob too big to pin: buffering a
        // multi-megabyte original whole into memory on a handset is the one
        // cost the cache must never pay. The element streams the URL instead.
        const declared = parseInt(xhr.getResponseHeader('Content-Length') || '', 10);
        const size = Number.isNaN(declared) ? response.size : declared;
        resolve(size > MAX_ENTRY_BYTES ? null : response);
      };
      xhr.onerror = () => resolve(null);
      xhr.ontimeout = () => resolve(null);
      xhr.send();
    } catch (error) {
      resolve(null);
    }
  });
}

/** Creates (or reuses) the object URL a screen will bind, and owns it. */
function remember(url: string, blob: Blob): string {
  const existing = objectUrls.get(url);
  if (existing) return existing;
  const objectUrl = URL.createObjectURL(blob);
  objectUrls.set(url, objectUrl);
  return objectUrl;
}

/**
 * Resolves a media URL to a `blob:` URL backed by the disk cache, or to the
 * URL itself when the host has no IndexedDB, the bytes are not cached and
 * cannot be fetched, or the file is too large to cache. Cache-first: a stored
 * Blob answers instantly with no network, a miss fetches once (deduplicated
 * while in flight) and stores it.
 */
export function mediaUrl(url: string): Promise<string> {
  if (!url) return Promise.resolve('');
  const existing = objectUrls.get(url);
  if (existing) return Promise.resolve(existing);
  const pending = inflight.get(url);
  if (pending) return pending;

  const job = (async (): Promise<string> => {
    try {
      const database = await openDatabase();
      if (!database) return url;

      const blob = await readBlob(database, url);
      if (blob) return remember(url, blob);

      const fetched = await fetchBlob(url);
      if (!fetched) return url;
      const display = remember(url, fetched);
      // Persist in the background — the screen already has its blob URL, and
      // a refused write must not delay the picture. The chain stays alive
      // even if a write path throws.
      writeChain = writeChain
        .then(() => persist(url, fetched))
        .catch(() => undefined);
      return display;
    } finally {
      inflight.delete(url);
    }
  })();

  inflight.set(url, job);
  return job;
}

/**
 * Binds a source URL ref to the cache: the element renders the raw URL
 * immediately (never a blank frame) and is swapped to the cached `blob:` URL
 * once it is ready. `hold`, when given, suppresses the swap while true — the
 * lightbox passes `playing` so a video or voice note that started streaming
 * from the raw URL is not restarted by the swap.
 */
export function useCachedUrl(source: Ref<string>, hold: Ref<boolean> | null = null): Ref<string> {
  const display = ref(source.value);
  let generation = 0;
  watch(
    source,
    (url) => {
      const mine = ++generation;
      display.value = url;
      if (!url) return;
      void mediaUrl(url).then((resolved) => {
        if (mine !== generation) return;
        if (hold && hold.value) return;
        display.value = resolved;
      });
    },
    { immediate: true },
  );
  onBeforeUnmount(() => {
    generation += 1;
  });
  return display;
}

/**
 * Upgrades the inline file images of a rendered markdown body (`kai-md__photo`)
 * to their cached URLs. `v-html` hands Vue no hook for the nodes it inserted,
 * so screens call this on the same watch that guards their photos. Only the
 * current `src` is swapped, so a body that re-rendered under us is left alone.
 */
export function cachePhotoSrcs(root: HTMLElement | null): void {
  if (!root) return;
  const images = root.querySelectorAll('img.kai-md__photo');
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const current = image.getAttribute('src');
    if (!current) continue;
    void mediaUrl(current).then((resolved) => {
      if (resolved !== current && image.getAttribute('src') === current) {
        image.setAttribute('src', resolved);
      }
    });
  }
}

/** The cache's footprint, read fresh from the meta rows (no blobs loaded). */
export async function mediaCacheStats(): Promise<{ count: number; bytes: number }> {
  const database = await openDatabase();
  if (!database) return { count: 0, bytes: 0 };
  const { promise, resolve } = Promise.withResolvers<{ count: number; bytes: number }>();
  try {
    const store = database.transaction(STORE_META, 'readonly').objectStore(STORE_META);
    let count = 0;
    let bytes = 0;
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve({ count, bytes });
        return;
      }
      count += 1;
      bytes += (cursor.value as MediaMeta).size;
      cursor.continue();
    };
    request.onerror = () => resolve({ count: 0, bytes: 0 });
  } catch (error) {
    resolve({ count: 0, bytes: 0 });
  }
  const result = await promise;
  totalBytes = result.bytes;
  return result;
}

/**
 * Drops the whole media cache: every object URL is revoked (screens get fresh
 * ones when they next resolve a URL) and both stores are cleared. The settings
 * screen's clear action, and the one thing that ever removes cached bytes.
 */
export async function clearMediaCache(): Promise<void> {
  for (const objectUrl of objectUrls.values()) {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      // As above: nothing created, nothing to revoke.
    }
  }
  objectUrls.clear();

  const database = await openDatabase();
  totalBytes = 0;
  if (!database) return;

  const { promise, resolve } = Promise.withResolvers<void>();
  try {
    const transaction = database.transaction([STORE_FILES, STORE_META], 'readwrite');
    transaction.objectStore(STORE_FILES).clear();
    transaction.objectStore(STORE_META).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  } catch (error) {
    resolve();
  }
  await promise;
}
