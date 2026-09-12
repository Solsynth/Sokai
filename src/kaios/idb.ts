import type { ChatMessage, ChatRoom, ChatSummary } from '~/src/api/models.js';

/**
 * IndexedDB persistence for the chat screens, written to the KaiOS storage
 * guidelines (developer.kaiostech.com/docs/sfp-3.0/core-developer-topics/storage):
 *
 *  - The database is opened with the `storageType: 'temporary'` option, which
 *    marks it *removable*: when the device is nearly out of space the system
 *    deletes old removable databases before the user hits "storage full".
 *    The app must therefore survive its own database vanishing — every read
 *    here treats a missing store as an empty cache, and `onupgradeneeded`
 *    recreates it on the next open.
 *  - The system blocks DB writes once free storage drops below a threshold
 *    (~30MB), so every write is error-handled: a failed write degrades to the
 *    in-memory copy and the chat store surfaces a notice instead of crashing.
 *  - Media is never stored here — the guideline puts media in DeviceStorage,
 *    not IndexedDB. This module persists only text rows (rooms, messages,
 *    summaries).
 *  - Content is capped: a room keeps at most `MAX_MESSAGES_PER_ROOM` rows and
 *    the oldest are pruned, so a long-lived room cannot grow without bound.
 *
 * The API is deliberately narrow — load/save whole collections, one database,
 * one version — so the only failure modes are "no persistence" (a host
 * without IndexedDB, e.g. jsdom or a locked-down origin) and "write failed"
 * (quota). Both are surfaced as `null` / `false`, never thrown.
 */

const DB_NAME = 'sokai-chat';
/**
 * The stored shape *is* the schema: this module persists the app's own
 * `ChatMessage`/`ChatRoom`/`ChatSummary` objects, so a revision that adds or
 * renames a field makes every row an older one wrote unreadable. A rise here
 * therefore drops the previous generation rather than migrating it — a cache
 * is disposable, and a row of the wrong shape is a crash in a render function,
 * not a stale value (v2: `ChatMessage` gained its reaction fields).
 */
const DB_VERSION = 2;

const STORE_ROOMS = 'rooms';
const STORE_MESSAGES = 'messages';
const STORE_SUMMARIES = 'summaries';

/** KaiOS guideline example: cap a room's history, prune the oldest past it. */
const MAX_MESSAGES_PER_ROOM = 10000;

/**
 * How long the open may take before the cache is treated as unavailable.
 *
 * An open is blocked — silently, with neither `success` nor `error` — while
 * another connection holds the database: a second app instance, or the
 * `versionchange` a previous load never finished. Waiting on that would leave
 * every chat screen on its spinner forever, so the wait is bounded and the
 * screen falls through to the network, exactly like a host without IndexedDB.
 */
const OPEN_TIMEOUT_MS = 3000;

let db: IDBDatabase | null = null;
let openPromise: Promise<IDBDatabase | null> | null = null;

/**
 * Opens the database. KaiOS accepts the options-object form (which is what
 * marks the DB removable); the plain `open(name, version)` is the standard
 * form Gecko 48 and desktop browsers understand, so a host that rejects the
 * options object (it throws synchronously) falls back to it. A host with no
 * IndexedDB at all resolves `null` — the chat screens then run on memory
 * alone, exactly like the session store does without localStorage.
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
      // The options-object form is the KaiOS extension that marks the DB
      // removable; the DOM lib types only know the standard numeric form, so
      // the factory is widened locally (the same dance `xhr.ts` does for the
      // `mozSystem` constructor option).
      const factory = indexedDB as unknown as {
        open(name: string, options: { version: number; storageType?: string }): IDBOpenDBRequest;
      };
      request = factory.open(DB_NAME, {
        version: DB_VERSION,
        storageType: 'temporary',
      });
    } catch (error) {
      // A host that does not know the options form (standard Gecko/browsers).
      request = indexedDB.open(DB_NAME, DB_VERSION);
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      // A version rise means the stored shape is not this revision's, so the
      // old generation goes and is rebuilt empty: the rows are a cache, the
      // reads below already treat a missing store as "nothing stored", and the
      // screens refetch. (Dropping beats migrating here — the shape is the
      // app's own type, which no migration can reconstruct field by field.)
      const stores = [STORE_ROOMS, STORE_MESSAGES, STORE_SUMMARIES];
      for (let index = 0; index < stores.length; index += 1) {
        if (database.objectStoreNames.contains(stores[index])) {
          database.deleteObjectStore(stores[index]);
        }
      }
      if (!database.objectStoreNames.contains(STORE_ROOMS)) {
        database.createObjectStore(STORE_ROOMS, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STORE_MESSAGES)) {
        const messages = database.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
        // Room-scoped reads and the per-room cap both need "by room, oldest
        // first" — ISO timestamps sort lexicographically.
        messages.createIndex('byRoom', ['roomId', 'createdAt']);
      }
      if (!database.objectStoreNames.contains(STORE_SUMMARIES)) {
        database.createObjectStore(STORE_SUMMARIES, { keyPath: 'roomId' });
      }
    };

    // `retryable` marks the failures that a later attempt could win — a block
    // clears once the other connection goes — so the dead promise is not kept
    // for the rest of the session.
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
      // The system may delete or upgrade this removable database at any time;
      // close our connection when it asks so the deletion is not fought.
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

/** A read or write that must tolerate a missing or failing database. */
function transaction(
  storeName: string,
  mode: IDBTransactionMode,
): Promise<IDBObjectStore | null> {
  return openDatabase().then((database) => {
    if (!database) return null;
    try {
      return database.transaction(storeName, mode).objectStore(storeName);
    } catch (error) {
      return null;
    }
  });
}

function getAll<T>(storeName: string): Promise<T[] | null> {
  return transaction(storeName, 'readonly').then((store) => {
    if (!store) return null;
    const { promise, resolve } = Promise.withResolvers<T[] | null>();
    const request = store.getAll();
    request.onsuccess = () => resolve((request.result as T[]) || []);
    request.onerror = () => resolve(null);
    return promise;
  });
}

/**
 * A plain, structured-cloneable copy of a value. The store hands over Vue
 * reactive objects, and reactive proxies are not cloneable — IndexedDB throws
 * `DataCloneError` on them, which would silently disable the whole cache.
 * A JSON round-trip is the smallest fix that also strips the proxies nested
 * inside a message's sender, attachments or a summary's last message.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Writes a whole collection. `false` means the write failed — storage full or
 * the DB was removed mid-flight — and the caller keeps its in-memory copy.
 */
function putAll<T>(storeName: string, values: T[]): Promise<boolean> {
  if (!values.length) return Promise.resolve(true);
  return transaction(storeName, 'readwrite').then((store) => {
    if (!store) return false;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const tx = store.transaction;
    try {
      for (let index = 0; index < values.length; index += 1) {
        store.put(plain(values[index]));
      }
    } catch (error) {
      resolve(false);
      return promise;
    }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
    return promise;
  });
}

/** A room's slice of the `byRoom` index (createdAt asc inside the room). */
function roomRange(roomId: string): IDBKeyRange {
  return IDBKeyRange.bound([roomId, ''], [roomId, '\uffff']);
}

/**
 * Prunes a room's message rows down to the cap, oldest first. Runs after a
 * save so a busy room cannot grow without bound (KaiOS guideline: limit the
 * size of stored content).
 */
function pruneRoomMessages(roomId: string): Promise<boolean> {
  return transaction(STORE_MESSAGES, 'readwrite').then((store) => {
    if (!store) return false;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const tx = store.transaction;

    const index = store.index('byRoom');
    const range = roomRange(roomId);
    const countRequest = index.count(range);
    countRequest.onsuccess = () => {
      const count = countRequest.result as number;
      if (count <= MAX_MESSAGES_PER_ROOM) {
        resolve(true);
        return;
      }
      // Delete the oldest rows first (the index orders by createdAt asc).
      const excess = count - MAX_MESSAGES_PER_ROOM;
      const cursorRequest = index.openCursor(range);
      let deleted = 0;
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || deleted >= excess) {
          resolve(true);
          return;
        }
        deleted += 1;
        cursor.delete();
        cursor.continue();
      };
      cursorRequest.onerror = () => resolve(false);
    };
    countRequest.onerror = () => resolve(false);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
    return promise;
  });
}

/**
 * Whether a stored row is one the thread can render: the fields a render
 * dereferences, not every field of `ChatMessage`. The cast out of IndexedDB is
 * the one place a `ChatMessage` reaches the screen without passing
 * `normalizeChatMessage`, so a row this revision cannot vouch for — a different
 * generation, a host that wrote something else — has to be a cache miss. The
 * thread then fetches the page, which is a great deal cheaper than a bubble
 * throwing on `Object.keys(message.reactions)` mid-render.
 */
function isStoredMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false;
  const row = value as ChatMessage;
  return (
    typeof row.id === 'string' &&
    typeof row.roomId === 'string' &&
    typeof row.content === 'string' &&
    // `chatMemberName` walks into the account for its display name.
    !!row.sender &&
    typeof row.sender === 'object' &&
    !!row.sender.account &&
    typeof row.sender.account.display === 'string' &&
    // The bubble indexes these directly when it draws its media and its pills;
    // `hasChatMessageContent` reads `attachments.length` before any of that.
    Array.isArray(row.attachments) &&
    !!row.reactions &&
    typeof row.reactions === 'object' &&
    !!row.reactionsMade &&
    typeof row.reactionsMade === 'object'
  );
}

/**
 * One page of a room's stored history, newest first — the same offset the
 * messager itself pages with, so the cache and the wire agree on where a page
 * begins. The cursor walks the `byRoom` index backwards and is only stepped
 * `count` times, so a room's whole capped history is never materialised to
 * answer for 50 rows of it. A row that fails `isStoredMessage` is skipped: the
 * page comes back short, and the caller fetches it.
 */
function loadMessagePage(
  roomId: string,
  offset: number,
  count: number,
): Promise<ChatMessage[] | null> {
  return transaction(STORE_MESSAGES, 'readonly').then((store) => {
    if (!store) return null;
    const { promise, resolve } = Promise.withResolvers<ChatMessage[] | null>();
    const rows: ChatMessage[] = [];
    let skipped = 0;
    const request = store.index('byRoom').openCursor(roomRange(roomId), 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(rows);
        return;
      }
      if (skipped < offset) {
        skipped += 1;
        cursor.continue();
        return;
      }
      if (rows.length >= count) {
        resolve(rows);
        return;
      }
      if (isStoredMessage(cursor.value)) rows.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => resolve(null);
    return promise;
  });
}

export interface ChatDb {
  loadRooms(): Promise<ChatRoom[] | null>;
  saveRooms(rooms: ChatRoom[]): Promise<boolean>;
  loadMessagePage(roomId: string, offset: number, count: number): Promise<ChatMessage[] | null>;
  saveMessages(roomId: string, messages: ChatMessage[]): Promise<boolean>;
  loadSummaries(): Promise<Record<string, ChatSummary> | null>;
  saveSummaries(summaries: Record<string, ChatSummary>): Promise<boolean>;
  clear(): Promise<boolean>;
}

/**
 * The chat persistence handle. `null` when the host has no IndexedDB — the
 * caller then keeps everything in memory.
 */
export function openChatDb(): Promise<ChatDb | null> {
  return openDatabase().then((database) => {
    if (!database) return null;
    return {
      loadRooms: () => getAll<ChatRoom>(STORE_ROOMS),
      saveRooms: (rooms) => putAll(STORE_ROOMS, rooms),
      loadMessagePage,
      saveMessages: (roomId, messages) =>
        putAll(STORE_MESSAGES, messages).then((saved) => {
          if (!saved) return false;
          return pruneRoomMessages(roomId);
        }),
      loadSummaries: () =>
        getAll<{ roomId: string; unreadCount: number; hasUnread: boolean; lastMessage: ChatMessage | null }>(
          STORE_SUMMARIES,
        ).then((rows) => {
          if (!rows) return null;
          const map: Record<string, ChatSummary> = {};
          for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index];
            map[row.roomId] = {
              unreadCount: row.unreadCount,
              hasUnread: row.hasUnread,
              lastMessage: row.lastMessage,
            };
          }
          return map;
        }),
      saveSummaries: (summaries) => {
        const rows = Object.keys(summaries).map((roomId) => ({
          roomId,
          unreadCount: summaries[roomId].unreadCount,
          hasUnread: summaries[roomId].hasUnread,
          lastMessage: summaries[roomId].lastMessage,
        }));
        return putAll(STORE_SUMMARIES, rows);
      },
      clear: () => {
        const { promise, resolve } = Promise.withResolvers<boolean>();
        openDatabase().then((database) => {
          if (!database) {
            resolve(true);
            return;
          }
          try {
            const tx = database.transaction(
              [STORE_ROOMS, STORE_MESSAGES, STORE_SUMMARIES],
              'readwrite',
            );
            tx.objectStore(STORE_ROOMS).clear();
            tx.objectStore(STORE_MESSAGES).clear();
            tx.objectStore(STORE_SUMMARIES).clear();
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
          } catch (error) {
            resolve(false);
          }
        });
        return promise;
      },
    };
  });
}
