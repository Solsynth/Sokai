import { API_BASE_URL } from '~/src/api/solian.js';
import { bearerToken } from '~/src/kaios/session.js';

/**
 * The chat realtime channel — a lean WebSocket client over the messager
 * gateway, mirroring Solian's `WebSocketService`:
 *
 *  - connects to `wss://<host>/ws?namespace=dev.solsynth.solian&tk=<token>`
 *    (the same namespace + token auth the Flutter client uses on web),
 *  - sends a `ping` heartbeat every minute (the gateway answers `pong`),
 *  - reconnects with capped exponential backoff,
 *  - tracks subscribed rooms so a reconnect re-subscribes them.
 *
 * It is deliberately smaller than Solian's service: no connectivity events, no
 * internet-mode derivation, no duplicate-device handling — a KaiOS phone's
 * messenger needs "new messages arrive" and "they came back", nothing more.
 * A host without `WebSocket` (jsdom, a locked-down origin) simply never
 * connects: the chat page then updates on the next visit, which is exactly the
 * refresh-on-visit behaviour the rest of the app already has.
 */

/** Product multi-tenant id — must match the server's wsgateway namespace. */
const NAMESPACE = 'dev.solsynth.solian';

const HEARTBEAT_MS = 60000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_JITTER_MS = 200;

export interface ChatWsPacket {
  type: string;
  data: Record<string, unknown> | null;
}

type Listener = (packet: ChatWsPacket) => void;

/** A platform timer handle — `setTimeout`/`setInterval` on Gecko 48, `NodeJS`-free. */
type TimerHandle = ReturnType<typeof setTimeout>;

/** The single shared connection; chat screens register listeners on it. */
let socket: WebSocket | null = null;
let listeners: Listener[] = [];
let subscribedRooms = new Set<string>();
let heartbeatTimer: TimerHandle | null = null;
let reconnectTimer: TimerHandle | null = null;
let reconnectAttempts = 0;
/** Bumped on close so stale handlers from a dead socket stop acting. */
let generation = 0;

function wsAvailable(): boolean {
  return typeof WebSocket === 'function';
}

function sendRaw(payload: string): void {
  if (socket && socket.readyState === 1 /* OPEN */) socket.send(payload);
}

/**
 * Packets are queued while the socket is still connecting (or reconnecting)
 * and flushed on open, in order: a read receipt sent the instant a room opens
 * must not be lost to the handshake. Bounded, so a dead socket cannot grow the
 * queue without limit.
 */
const OUTBOX_LIMIT = 32;
let outbox: string[] = [];

function sendPacket(packet: Record<string, unknown>): void {
  const payload = JSON.stringify(packet);
  if (socket && socket.readyState === 1) {
    socket.send(payload);
  } else if (outbox.length < OUTBOX_LIMIT) {
    outbox.push(payload);
  }
}

function flushOutbox(): void {
  const pending = outbox;
  outbox = [];
  for (let index = 0; index < pending.length; index += 1) {
    sendRaw(pending[index]);
  }
}

function clearTimers(): void {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  heartbeatTimer = null;
  reconnectTimer = null;
}

function scheduleHeartbeat(): void {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    sendPacket({ type: 'ping', data: null });
    scheduleHeartbeat();
  }, HEARTBEAT_MS);
}

function reemit(packet: ChatWsPacket): void {
  for (let index = 0; index < listeners.length; index += 1) {
    listeners[index](packet);
  }
}

/** Reconnects the subscribed rooms once the socket is open again. */
function resubscribe(): void {
  subscribedRooms.forEach((roomId) => {
    sendPacket({ type: 'messages.subscribe', endpoint: 'messager', data: { chat_room_id: roomId } });
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  // Cap the backoff at 30s; jitter keeps a fleet of phones from hammering the
  // gateway in lockstep on an outage.
  const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
  const jitter = Math.floor(Math.random() * RECONNECT_JITTER_MS);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectChatWs();
  }, base + jitter);
}

function disposeSocket(): void {
  const current = socket;
  socket = null;
  generation += 1;
  clearTimers();
  if (current) {
    try {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      current.close();
    } catch (error) {
      // Already closed or a non-standard implementation; nothing to unwind.
    }
  }
}

/**
 * Connects (or reconnects) the shared socket. Idempotent when already open or
 * mid-connect; a no-op on hosts without WebSocket or without a bearer token
 * (the gateway rejects anonymous handshakes anyway).
 */
export async function connectChatWs(): Promise<void> {
  if (!wsAvailable() || socket) return;

  const token = await bearerToken();
  if (!token) return;

  const generationNow = ++generation;
  const url =
    API_BASE_URL.replace(/^http/, 'ws') +
    '/ws?namespace=' +
    encodeURIComponent(NAMESPACE) +
    '&tk=' +
    encodeURIComponent(token);

  let opened = false;
  const ws = new WebSocket(url);
  socket = ws;

  ws.onopen = () => {
    if (generationNow !== generation) return;
    opened = true;
    reconnectAttempts = 0;
    scheduleHeartbeat();
    // Anything queued during the handshake goes first, then the room
    // subscriptions this client is holding (a reconnect starts from an empty
    // server-side subscription set).
    flushOutbox();
    resubscribe();
  };

  ws.onmessage = (event) => {
    if (generationNow !== generation) return;
    let packet: ChatWsPacket | null = null;
    try {
      const parsed: unknown = JSON.parse(String(event.data));
      if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).type === 'string') {
        packet = {
          type: (parsed as Record<string, unknown>).type as string,
          data:
            (parsed as Record<string, unknown>).data &&
            typeof (parsed as Record<string, unknown>).data === 'object'
              ? ((parsed as Record<string, unknown>).data as Record<string, unknown>)
              : null,
        };
      }
    } catch (error) {
      // Not JSON (a malformed frame); ignore rather than throw from the socket.
    }
    if (packet) reemit(packet);
  };

  ws.onclose = () => {
    if (generationNow !== generation) return;
    const wasOpen = opened;
    disposeSocket();
    // An established connection that dropped reconnects on a backoff. One that
    // never opened (auth rejection, gateway down) is left alone: an endless
    // retry loop would only burn battery, and the next visit to a chat screen
    // asks again — so a transient failure is never a permanent latch.
    if (wasOpen) scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose follows; the error itself carries no usable detail.
  };
}

/** Registers a packet listener; returns an unsubscribe function. */
export function onChatWsPacket(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index !== -1) listeners.splice(index, 1);
  };
}

/** Subscribes to a room's live events, connecting on demand. */
export function subscribeChatRoom(roomId: string): void {
  subscribedRooms.add(roomId);
  if (socket && socket.readyState === 1) {
    sendPacket({ type: 'messages.subscribe', endpoint: 'messager', data: { chat_room_id: roomId } });
  } else {
    void connectChatWs();
  }
}

/** Stops receiving a room's live events. */
export function unsubscribeChatRoom(roomId: string): void {
  subscribedRooms.delete(roomId);
  sendPacket({ type: 'messages.unsubscribe', endpoint: 'messager', data: { chat_room_id: roomId } });
}

/**
 * Claims a room read. There is **no HTTP route** for this — the SDK's
 * `POST /messager/chat/rooms/{id}/read` 404s — it is a `messages.read` packet
 * on the gateway, the same receipt Flutter's `sendReadReceipt` and the watch's
 * send. Best-effort by nature: with the socket down the receipt is simply not
 * delivered and the unread badge stays until a later summary.
 */
export function sendChatReadReceipt(roomId: string): void {
  sendPacket({ type: 'messages.read', endpoint: 'messager', data: { chat_room_id: roomId } });
}

/** Tears the channel down (sign-out): subscriptions, listeners and the socket. */
export function closeChatWs(): void {
  subscribedRooms = new Set<string>();
  listeners = [];
  outbox = [];
  reconnectAttempts = 0;
  disposeSocket();
}
