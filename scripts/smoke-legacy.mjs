#!/usr/bin/env node
/**
 * Runtime gate: loads the built page the way a browser loads it — external
 * scripts fetched and executed in document order — then drives it with KaiOS
 * hardware key events.
 *
 * Why this exists on top of `verify-legacy.mjs`: static analysis can prove the
 * bundle *parses*, but not that the app *runs*. The polyfills that make Gecko 48
 * work are injected at build time by usage detection, so the only honest check is
 * to take those APIs away and see whether the app still starts, navigates and
 * reads posts over a privileged request.
 *
 * What this gate cannot do: jsdom fetches external scripts asynchronously, so a
 * script that a browser would run *during* parsing effectively runs after it
 * here. Execution *timing* is therefore enforced statically, by the `<head>`
 * `defer` rule in `verify-legacy.mjs` — this harness only asserts what happens
 * once the app is running.
 *
 * The realm still provides jsdom's DOM, which is newer than Gecko 48's: this
 * covers JavaScript built-ins and app behaviour, not DOM API age.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { JSDOM } from 'jsdom';

import { STATUS_BAR_PX, statusBarInset } from '../src/kaios/screen.ts';

const failures = [];
let steps = 0;

function check(label, condition, observed) {
  steps += 1;
  const status = condition ? 'ok  ' : 'FAIL';
  const detail = condition || observed === undefined ? '' : ` — observed: ${JSON.stringify(observed)}`;
  console.log(`  ${status} ${label}${detail}`);
  if (!condition) failures.push(label);
}

const navState = (nodes) => nodes.map((node) => node.getAttribute('nav-selected'));

/** Rendered text, with Vue's template whitespace collapsed. */
const tight = (value) => value.replace(/\s+/g, ' ').trim();

/* --- Canned API responses ------------------------------------------------ */

const HOUR_MS = 3600000;
const MINUTE_MS = 60000;

const FEED_POST_ID = '01a09055-3a56-7bc1-b59b-c84e56100be9';
const SECOND_POST_ID = '01a09028-3836-7c15-8a22-93b7b7db11e0';
const REPLY_ID = '01a08ff3-1852-7114-883c-3f05ac1bcb96';
const FORWARD_ID = '01a089c1-e23b-7c68-9e8f-498a77d2ae08';
/** A post the reply list answers, which is not on the screen — its quote stays. */
const STRANGER_ID = '01a08f00-0000-7000-8000-000000000001';
/** The post chained to the fixture head, rendered on the head's own screen. */
const CHAIN_ID = '01a08f00-0000-7000-8000-000000000002';
/** The signed-in account's own post, for the edit/delete scenarios. */
const OWNED_POST_ID = '01a0eeee-1234-5678-9abc-def012345678';

/** The wire shape observed from `https://api.solian.app`: snake_case, integer enums. */
function wirePost(overrides) {
  const hourAgo = new Date(Date.now() - HOUR_MS).toISOString();

  return Object.assign(
    {
      id: FEED_POST_ID,
      title: null,
      description: null,
      slug: null,
      edited_at: null,
      drafted_at: null,
      published_at: hourAgo,
      visibility: 0,
      content: '',
      content_type: 0,
      type: 0,
      is_truncated: false,
      replies_count: 0,
      thread_replies_count: 0,
      boost_count: 0,
      reactions_count: {},
      upvotes: 0,
      downvotes: 0,
      views_total: 0,
      replied_post_id: null,
      replied_post: null,
      forwarded_post_id: null,
      forwarded_post: null,
      chained_post_id: null,
      chained_post: null,
      chained_posts: [],
      chained_count: 0,
      attachments: [],
      tags: [],
      publisher: { id: '5e446e1d-29fa-4aea-9c6d-c20306b83433', type: 0, name: 'iCat', nick: 'iCat', picture: { id: 'avatar-1' } },
      resource_identifier: 'post:' + FEED_POST_ID,
      meta: { embeds: [] },
      created_at: hourAgo,
    },
    overrides,
  );
}

const FEED = [
  wirePost({
    title: 'SN notes',
    type: 1,
    is_truncated: true,
    replies_count: 3,
    boost_count: 2,
    reactions_count: { pray: 1, laugh: 1 },
    reactions_made: { pray: true },
    content: '# SN notes\n\n- supports X\n- and Y\n\nSee [the docs](https://example.com/docs) for more.',
    attachments: [
      {
        id: '01M28ESTWBSXQSTMVVBYYFDXSK',
        name: 'image_picker_C094B4E1.jpg',
        mime_type: 'image/jpeg',
        size: 358482,
        width: 810,
        height: 1440,
        has_thumbnail: false,
        // The server sends a BlurHash on some pictures; the row has to paint
        // it as one wash over the reserved box (see the smoke check below).
        blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
      },
      {
        id: '01M27VGQRP4WP819BZ0TXDN7HF',
        name: 'clip.mp4',
        mime_type: 'video/mp4',
        size: 2470997,
        width: 1800,
        height: 1168,
      },
    ],
    forwarded_post_id: FORWARD_ID,
    forwarded_post: {
      id: FORWARD_ID,
      content: 'source body text',
      publisher: { id: 'c', type: 0, name: 'QRBG3376', nick: 'QRBG3376' },
      attachments: [{ id: 'f1', name: 'a.png', mime_type: 'image/png', size: 1024, width: 100, height: 200 }],
    },
  }),
  wirePost({
    /* A chain member in the timeline: a continuation of another post, which a
       list has to drop — read without its head it is a sentence with the
       beginning cut off. It sits between the two rows, so the rendered list is
       still the head and Solsynth's post. */
    id: CHAIN_ID,
    content: 'chained body',
    chained_post_id: FEED_POST_ID,
    chained_post: { id: FEED_POST_ID, publisher: { id: 'c', type: 0, name: 'iCat', nick: 'iCat' } },
    publisher: { id: 'c', type: 0, name: 'QRBG3376', nick: 'QRBG3376' },
  }),
  wirePost({
    id: SECOND_POST_ID,
    content: '第二篇内容',
    // Drafts can have a null `published_at`; the row has to fall back to
    // `created_at` instead of rendering nothing (or throwing).
    published_at: null,
    publisher: { id: 'b', type: 0, name: 'solsynth', nick: 'Solsynth' },
    replied_post_id: REPLY_ID,
    replied_post: { id: REPLY_ID, publisher: { id: 'c', type: 0, name: 'QRBG3376', nick: 'QRBG3376' } },
    // The head of a chain the list did not hydrate: its members are never rows
    // of their own, so the count is how a row says the post carries on.
    chained_count: 2,
  }),
];

const DETAIL = wirePost({
  content:
    '# Heading\n\n- a\n- b\n\n![shot](solian://files/01M28ESTWBSXQSTMVVBYYFDXSK)\n\n![pixel](https://example.com/track.png)',
  visibility: 2,
  replies_count: 1,
  edited_at: new Date(Date.now() - HOUR_MS / 2).toISOString(),
  tags: [{ name: 'sokai' }, { name: null }],
  attachments: [
    { id: 'v1', name: 'clip.mp4', mime_type: 'video/mp4', size: 2470997, width: 1800, height: 1168 },
    { id: 'p1', name: 'photo.jpg', mime_type: 'image/jpeg', size: 630784, width: 3024, height: 1898 },
    { id: 'd1', name: 'notes.pdf', mime_type: 'application/pdf', size: 1536 },
  ],
  forwarded_post_id: FORWARD_ID,
  forwarded_post: {
    id: FORWARD_ID,
    content: 'Quoted source body.',
    publisher: { id: 'c', type: 0, name: 'QRBG3376', nick: 'QRBG3376' },
  },
  /* The post's continuation: hydrated on a read by id, and rendered under the
     body. The member states its own head by id and carries none of its own. */
  chained_posts: [
    wirePost({
      id: CHAIN_ID,
      content: 'chained body',
      chained_post_id: FEED_POST_ID,
      chained_post: { id: FEED_POST_ID, content: 'x', publisher: { id: 'c', type: 0, name: 'iCat', nick: 'iCat' } },
      publisher: { id: 'c', type: 0, name: 'QRBG3376', nick: 'QRBG3376' },
    }),
  ],
  chained_count: 4,
});

/** A chain member read on its own: the head is named above the body. */
const CHAIN_MEMBER = wirePost({
  id: CHAIN_ID,
  content: 'chained body',
  chained_post_id: FEED_POST_ID,
  chained_post: {
    id: FEED_POST_ID,
    content: 'head body',
    publisher: { id: 'c', type: 0, name: 'iCat', nick: 'iCat' },
  },
  publisher: { id: 'c', type: 0, name: 'QRBG3376', nick: 'QRBG3376' },
});

/* One reply quotes the post on screen (the head), so its quote is suppressed;
   the other quotes a post that is not, so it keeps its own. */
const REPLIES = [
  wirePost({
    id: REPLY_ID,
    content: 'reply body',
    publisher: { id: 'c', type: 0, name: 'QRBG3376', nick: 'QRBG3376' },
    replied_post_id: FEED_POST_ID,
    replied_post: { id: FEED_POST_ID, publisher: { id: 'c', type: 0, name: 'iCat', nick: 'iCat' } },
  }),
  wirePost({
    id: '01a08f11-1852-7114-883c-3f05ac1bcb97',
    content: 'second reply body',
    publisher: { id: 'c', type: 0, name: 'iCat', nick: 'iCat' },
    replied_post_id: STRANGER_ID,
    replied_post: { id: STRANGER_ID, publisher: { id: 'c', type: 0, name: 'solsynth', nick: 'Solsynth' } },
  }),
];

/**
 * The one event the dashboard counts down to, and the day the calendar is
 * opened on (the dashboard pushes the day it names). Hoisted out of the
 * fixture so both reads describe the same instant.
 */
const SOLSTICE_START = new Date(Date.now() + 3 * 24 * HOUR_MS + 4 * HOUR_MS);
const SOLSTICE_END = new Date(Date.now() + 3 * 24 * HOUR_MS + 5 * HOUR_MS);

/** The UTC day the server would bucket an instant into — what the app derives too. */
const utcKey = (date) => date.toISOString().slice(0, 10);

const CAL_DAY = utcKey(SOLSTICE_START);
const CAL_MONTH = CAL_DAY.slice(0, 7);
/** A notable day in the same month, never on the event's own day. */
const CAL_NOTABLE_DAY = CAL_MONTH + '-' + (Number(CAL_DAY.slice(8, 10)) === 15 ? '16' : '15');

const CANNED = {
  countdown: {
    status: 200,
    headers: '',
    body: [
      {
        event_id: '01f00000-0000-0000-0000-000000000001',
        event_type: 1,
        title: 'Solstice',
        description: 'The network turns a year older.',
        location: 'the sun',
        start_time: SOLSTICE_START.toISOString(),
        end_time: SOLSTICE_END.toISOString(),
        is_all_day: false,
        days_remaining: 3,
        hours_remaining: 4,
        is_ongoing: false,
        meta: null,
        account_id: '00000000-0000-0000-0000-000000000001',
      },
    ],
  },
  /* The month the calendar opens on: the day the dashboard pointed at, with the
     event on it, and one notable day. Every other day has no row at all, which
     is the shape the server sends. */
  calendar: {
    status: 200,
    headers: '',
    body: [
      {
        date: CAL_NOTABLE_DAY + 'T00:00:00Z',
        check_in_result: null,
        statuses: [],
        user_events: [],
        notable_days: [
          {
            date: CAL_NOTABLE_DAY + 'T00:00:00Z',
            local_name: 'Founders Day',
            global_name: 'Founders Day',
            localizable_key: 'Founders Day',
            country_code: null,
            description: null,
            meta: null,
            occurrence_key: 'us|' + CAL_NOTABLE_DAY + '|founders-day',
            holidays: [0],
            tags: [0],
          },
        ],
      },
      {
        date: CAL_DAY + 'T00:00:00Z',
        check_in_result: null,
        statuses: [],
        user_events: [
          {
            id: 'evt-solstice',
            title: 'Solstice',
            description: 'The network turns a year older.',
            location: 'the sun',
            start_time: SOLSTICE_START.toISOString(),
            end_time: SOLSTICE_END.toISOString(),
            is_all_day: false,
            visibility: 200,
            tags: [],
            account_id: 'acc-1',
          },
        ],
        notable_days: [],
      },
    ],
  },
  list: { status: 200, headers: 'x-total: 42\r\n', body: FEED },
  detail: { status: 200, headers: '', body: DETAIL },
  /* A chain member read on its own: it names the head it continues, and it has
     no continuation of its own. */
  chainMember: { status: 200, headers: '', body: CHAIN_MEMBER },
  /* The signed-in account's own post, for the edit/delete scenarios: a simple
     text post with one picture, under the personal publisher. */
  ownedDetail: {
    status: 200,
    headers: '',
    body: wirePost({
      id: OWNED_POST_ID,
      content: 'owned post body',
      publisher: { id: 'pub-1', type: 0, name: 'testuser', nick: 'Test User', picture: { id: 'avatar-1' } },
      attachments: [{ id: 'seed-1', name: 'seed.png', mime_type: 'image/png', size: 4096, width: 100, height: 100 }],
    }),
  },
  replies: { status: 200, headers: 'x-total: 21\r\n', body: REPLIES },
  /* The reply list's second page: a different row, so the flip check proves the
     offset was applied rather than re-rendering what was already there. */
  repliesPage2: {
    status: 200,
    headers: 'x-total: 21\r\n',
    body: [
      wirePost({
        id: '01a08f22-1852-7114-883c-3f05ac1bcb98',
        content: 'page two reply',
        publisher: { id: 'c', type: 0, name: 'QRBG3376', nick: 'QRBG3376' },
      }),
    ],
  },
  /* Stargate device flow: one code request, one pending poll, then approval.
     `interval: 1` keeps the poll fast enough for the gate's real timers. */
  deviceCode: {
    status: 200,
    headers: '',
    body: {
      device_code: 'dev-1',
      user_code: 'CODE-1234',
      verification_uri: 'https://solar.app/device',
      verification_uri_complete: 'https://solar.app/device?user_code=CODE-1234',
      expires_in: 600,
      interval: 1,
    },
  },
  tokenPending: { status: 400, headers: '', body: { error: 'authorization_pending' } },
  tokenOk: {
    status: 200,
    headers: '',
    body: { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 },
  },
  /* The `refresh_token` grant on the same endpoint the device flow polls. A
     distinct response so a restore-time refresh is not answered by the
     device-flow steps above. */
  refresh: {
    status: 200,
    headers: '',
    body: { access_token: 'refreshed-access', refresh_token: 'test-refresh-2', expires_in: 3600 },
  },
  me: {
    status: 200,
    headers: '',
    /* Held briefly so the session-restore scenario can observe the cached
       identity before the refreshed profile replaces it. */
    delay: 300,
    body: {
      id: 'acc-1',
      // Wire convention: `name` is the unique handle (@name), `nick` the
      // pretty display name — the same split the feed rows use.
      name: 'testuser',
      nick: 'Test User',
      profile: { background: { id: 'banner-1' }, picture: { id: 'avatar-1' } },
    },
  },
  revoke: { status: 200, headers: '', body: {} },
  /* The inbox (`GET /metoer/notifications`): three rows covering what the
     screen has to tell apart — an actor with a face and a post to open (still
     unread), a topic with no face at all (the glyph path, also unread), and one
     the account has already been through. The first names a post through
     `action_uri`, the others point at things this app has no screen for. */
  notifications: {
    status: 200,
    headers: 'x-total: 3\r\n',
    body: [
      {
        id: 'notif-1',
        app_id: 'dev.solsynth.solian',
        topic: 'post.replies',
        title: 'iCat replied to you',
        subtitle: '',
        content: 'Good point, **thanks** for the write-up.',
        meta: { pfp: 'cat-avatar', action_uri: 'solian://posts/' + FEED_POST_ID },
        viewed_at: null,
        account_id: 'acc-1',
        created_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      },
      {
        id: 'notif-2',
        app_id: 'dev.solsynth.solian',
        topic: 'wallet.transactions',
        title: 'You received 5 stardust',
        subtitle: 'From Solsynth',
        content: '',
        meta: { action_uri: '/wallet' },
        viewed_at: null,
        account_id: 'acc-1',
        created_at: new Date(Date.now() - 26 * HOUR_MS).toISOString(),
      },
      {
        id: 'notif-3',
        app_id: 'dev.solsynth.solian',
        topic: 'auth.login',
        title: 'New sign-in from KaiOS',
        subtitle: 'Sokai',
        content: 'A new device signed in to your account.',
        meta: {},
        viewed_at: new Date(Date.now() - HOUR_MS).toISOString(),
        account_id: 'acc-1',
        created_at: new Date(Date.now() - 3 * 24 * HOUR_MS).toISOString(),
      },
    ],
  },
  /* Compose: the account's own publishers, the photo upload, and a created post. */
  publishers: {
    status: 200,
    headers: '',
    body: [
      { id: 'pub-1', type: 0, name: 'testuser', nick: 'Test User', picture: { id: 'pub-avatar-1' } },
      { id: 'pub-2', type: 0, name: 'secondpub', nick: 'Second Pub', picture: { id: 'pub-avatar-2' } },
    ],
  },
  upload: {
    status: 200,
    headers: '',
    body: { file: { id: 'file-upload-1', name: 'picked-photo.jpg', mime_type: 'image/jpeg', size: 16 } },
  },
  created: {
    status: 200,
    headers: '',
    body: wirePost({
      content: 'Hello from the smoke test',
      publisher: { id: 'pub-2', type: 0, name: 'secondpub', nick: 'Second Pub' },
    }),
  },
  /* Chat: two rooms (a group and a direct), the unread summary, and the
     group's thread. The direct room carries no name — the row is titled by
     its other member, like the Flutter client's room tile. */
  chatRooms: {
    status: 200,
    headers: 'x-total: 2\r\n',
    body: [
      {
        id: 'room-group',
        name: 'SN Notes',
        description: null,
        slug: null,
        type: 0,
        encryption_mode: 0,
        is_public: true,
        is_community: false,
        is_read_receipts_public: true,
        picture: { id: 'room-pic-1' },
        background: null,
        realm_id: null,
        account_id: null,
        realm: null,
        created_at: new Date(Date.now() - 30 * 24 * HOUR_MS).toISOString(),
        updated_at: new Date(Date.now() - HOUR_MS).toISOString(),
        deleted_at: null,
        members: [
          {
            id: 'm-me',
            chat_room_id: 'room-group',
            account_id: 'acc-1',
            account: { id: 'acc-1', name: 'testuser', nick: 'Test User', profile: { picture: { id: 'avatar-1' } } },
            nick: null,
            notify: 0,
            joined_at: null,
            last_read_at: new Date(Date.now() - HOUR_MS).toISOString(),
          },
          {
            id: 'm-peer',
            chat_room_id: 'room-group',
            account_id: 'acc-2',
            account: { id: 'acc-2', name: 'icat', nick: 'iCat', profile: { picture: { id: 'cat-avatar' } } },
            nick: null,
            notify: 0,
            joined_at: null,
            last_read_at: null,
          },
        ],
      },
      {
        id: 'room-direct',
        name: null,
        description: null,
        slug: null,
        type: 1,
        encryption_mode: 0,
        is_public: false,
        is_community: false,
        is_read_receipts_public: true,
        picture: null,
        background: null,
        realm_id: null,
        account_id: null,
        realm: null,
        created_at: new Date(Date.now() - 7 * 24 * HOUR_MS).toISOString(),
        updated_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
        deleted_at: null,
        members: [
          {
            id: 'm-me',
            chat_room_id: 'room-direct',
            account_id: 'acc-1',
            account: { id: 'acc-1', name: 'testuser', nick: 'Test User', profile: { picture: { id: 'avatar-1' } } },
            nick: null,
            notify: 0,
            joined_at: null,
            last_read_at: null,
          },
          {
            id: 'm-peer2',
            chat_room_id: 'room-direct',
            account_id: 'acc-3',
            /* No profile picture, and the room has no picture either: this
               row is the lettered-avatar case, the shape a room has before
               anyone sets an image. */
            account: { id: 'acc-3', name: 'qrb', nick: 'QRB' },
            nick: null,
            notify: 0,
            joined_at: null,
            last_read_at: null,
          },
        ],
      },
    ],
  },
  /* `last_message` can be an event row; the group's is a plain text message. */
  chatSummary: {
    status: 200,
    headers: '',
    body: {
      'room-group': {
        unread_count: 2,
        has_unread: true,
        last_message: {
          id: 'msg-3',
          chat_room_id: 'room-group',
          type: 'text',
          content: 'New build is up!',
          sender_id: 'acc-2',
          sender: {
            id: 'm-peer',
            chat_room_id: 'room-group',
            account_id: 'acc-2',
            account: { id: 'acc-2', name: 'icat', nick: 'iCat', profile: { picture: { id: 'cat-avatar' } } },
            nick: null,
            notify: 0,
            joined_at: null,
            last_read_at: null,
          },
          created_at: new Date(Date.now() - 60000).toISOString(),
          updated_at: new Date(Date.now() - 60000).toISOString(),
          deleted_at: null,
          attachments: [],
        },
      },
      /* The direct room's last message is picture-only: the row's preview has
         no text to show and falls back to the attachment label. */
      'room-direct': {
        unread_count: 0,
        has_unread: false,
        last_message: {
          id: 'msg-d1',
          chat_room_id: 'room-direct',
          type: 'text',
          content: '',
          sender_id: 'acc-3',
          sender: {
            id: 'm-peer2',
            chat_room_id: 'room-direct',
            account_id: 'acc-3',
            account: { id: 'acc-3', name: 'qrb', nick: 'QRB' },
            nick: null,
          },
          created_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
          attachments: [
            {
              id: 'att-qr',
              name: 'image_picker_9f2.jpg',
              mime_type: 'image/jpeg',
              size: 180000,
              width: 720,
              height: 960,
            },
          ],
        },
      },
    },
  },
  /* The thread, newest-first at offset 0 (the messager's pagination
     direction). The group's messages: two from the peer, one own. */
  chatMessages: {
    status: 200,
    headers: 'x-total: 4\r\n',
    body: [
      {
        /* The newest message is a voice note: no content and no attachment
           rows — the bytes are behind meta.voice_url — so it is what proves
           the thread, the viewer and the room list all handle one. */
        id: 'msg-voice',
        chat_room_id: 'room-group',
        type: 'voice',
        content: null,
        sender_id: 'acc-2',
        sender: {
          id: 'm-peer',
          chat_room_id: 'room-group',
          account_id: 'acc-2',
          account: { id: 'acc-2', name: 'icat', nick: 'iCat', profile: { picture: { id: 'cat-avatar' } } },
          nick: null,
          notify: 0,
          joined_at: null,
          last_read_at: null,
        },
        meta: { duration_ms: 7300, voice_url: '/messager/chat/voice/clip-1.ogg' },
        created_at: new Date(Date.now() - 30000).toISOString(),
        updated_at: new Date(Date.now() - 30000).toISOString(),
        deleted_at: null,
        attachments: [],
      },
      {
        id: 'msg-3',
        chat_room_id: 'room-group',
        type: 'text',
        content: 'New build is up!',
        sender_id: 'acc-2',
        sender: {
          id: 'm-peer',
          chat_room_id: 'room-group',
          account_id: 'acc-2',
          account: { id: 'acc-2', name: 'icat', nick: 'iCat', profile: { picture: { id: 'cat-avatar' } } },
          nick: null,
          notify: 0,
          joined_at: null,
          last_read_at: null,
        },
        created_at: new Date(Date.now() - 60000).toISOString(),
        updated_at: new Date(Date.now() - 60000).toISOString(),
        deleted_at: null,
        attachments: [
          {
            id: 'att-inline',
            name: 'render.png',
            mime_type: 'image/png',
            size: 240000,
            width: 800,
            height: 600,
            blurhash: null,
          },
        ],
      },
      {
        id: 'msg-2',
        chat_room_id: 'room-group',
        type: 'text',
        content: 'Nice, thanks!',
        sender_id: 'acc-1',
        sender: {
          id: 'm-me',
          chat_room_id: 'room-group',
          account_id: 'acc-1',
          account: { id: 'acc-1', name: 'testuser', nick: 'Test User', profile: { picture: { id: 'avatar-1' } } },
          nick: null,
          notify: 0,
          joined_at: null,
          last_read_at: null,
        },
        created_at: new Date(Date.now() - 5 * 60000).toISOString(),
        updated_at: new Date(Date.now() - 5 * 60000).toISOString(),
        deleted_at: null,
        attachments: [
          {
            id: 'att-doc',
            name: 'notes.pdf',
            mime_type: 'application/pdf',
            size: 51200,
            width: 0,
            height: 0,
          },
        ],
      },
      {
        id: 'msg-1',
        chat_room_id: 'room-group',
        type: 'text',
        content: 'Morning all',
        sender_id: 'acc-2',
        sender: {
          id: 'm-peer',
          chat_room_id: 'room-group',
          account_id: 'acc-2',
          account: { id: 'acc-2', name: 'icat', nick: 'iCat', profile: { picture: { id: 'cat-avatar' } } },
          nick: null,
          notify: 0,
          joined_at: null,
          last_read_at: null,
        },
        created_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
        updated_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
        deleted_at: null,
        attachments: [],
      },
      {
        /* The row the gateway writes while a message syncs. It has no content,
           no attachments and nothing to open, so it never reaches the DOM —
           the thread must render four bubbles from this five-row page. */
        id: 'msg-placeholder',
        chat_room_id: 'room-group',
        type: 'placeholder',
        content: null,
        sender_id: 'acc-2',
        sender: {
          id: 'm-peer',
          chat_room_id: 'room-group',
          account_id: 'acc-2',
          account: { id: 'acc-2', name: 'icat', nick: 'iCat', profile: { picture: { id: 'cat-avatar' } } },
          nick: null,
          notify: 0,
          joined_at: null,
          last_read_at: null,
        },
        created_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
        updated_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
        deleted_at: null,
        attachments: [],
      },
      {
        /* A member joining a call — the room's own event, not a message. It
           carries content, so only the type rule can keep it out of the
           thread: Solian hides `system.*` at its `none` event level, which is
           the level this app takes. */
        id: 'msg-call-joined',
        chat_room_id: 'room-group',
        type: 'system.call.member.joined',
        content: 'iCat joined the call',
        sender_id: 'acc-2',
        sender: {
          id: 'm-peer',
          chat_room_id: 'room-group',
          account_id: 'acc-2',
          account: { id: 'acc-2', name: 'icat', nick: 'iCat', profile: { picture: { id: 'cat-avatar' } } },
          nick: null,
          notify: 0,
          joined_at: null,
          last_read_at: null,
        },
        created_at: new Date(Date.now() - 4 * HOUR_MS).toISOString(),
        updated_at: new Date(Date.now() - 4 * HOUR_MS).toISOString(),
        deleted_at: null,
        attachments: [],
      },
      {
        /* The call itself, and the marker an edit leaves behind: two more
           rows the thread draws nothing for. */
        id: 'msg-call-start',
        chat_room_id: 'room-group',
        type: 'call.start',
        content: 'Call started',
        sender_id: 'acc-2',
        sender: {
          id: 'm-peer',
          chat_room_id: 'room-group',
          account_id: 'acc-2',
          account: { id: 'acc-2', name: 'icat', nick: 'iCat', profile: { picture: { id: 'cat-avatar' } } },
          nick: null,
          notify: 0,
          joined_at: null,
          last_read_at: null,
        },
        meta: { duration: 42 },
        created_at: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
        updated_at: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
        deleted_at: null,
        attachments: [],
      },
      {
        /* The marker an edit leaves behind: a `messages.*` event, which shares
           no prefix with the `system.` ones. */
        id: 'msg-updated',
        chat_room_id: 'room-group',
        type: 'messages.update',
        content: 'New build is up! (edited)',
        sender_id: 'acc-2',
        sender: {
          id: 'm-peer',
          chat_room_id: 'room-group',
          account_id: 'acc-2',
          account: { id: 'acc-2', name: 'icat', nick: 'iCat', profile: { picture: { id: 'cat-avatar' } } },
          nick: null,
          notify: 0,
          joined_at: null,
          last_read_at: null,
        },
        meta: { previous_content: 'New build is up!' },
        created_at: new Date(Date.now() - 6 * HOUR_MS).toISOString(),
        updated_at: new Date(Date.now() - 6 * HOUR_MS).toISOString(),
        deleted_at: null,
        attachments: [],
      },
    ],
  },
  /** Milliseconds to hold the feed's next-page response, so the loading UI is observable. */
  delayFlip: 60,
  /**
   * The long room, reached through chat search rather than from the list. Its
   * 620 messages are generated page-side (`longRoomMessages`); only the count
   * and the base time are canned, because a literal array of that size would
   * dwarf this file. The count is what makes the thread's window observable:
   * page 1 is 50 rows, the tenth load reaches the 500-row cap, and the eleventh
   * slides the newest fifty out of the view while the cache keeps them.
   */
  chatLongTotal: 620,
  chatLongBase: new Date(Date.now() - 620 * MINUTE_MS).toISOString(),
  chatLongRoom: {
    status: 200,
    headers: '',
    body: {
      id: 'room-long',
      name: 'Long Room',
      description: null,
      slug: null,
      type: 0,
      encryption_mode: 0,
      is_public: false,
      is_community: false,
      is_read_receipts_public: true,
      picture: null,
      background: null,
      realm_id: null,
      account_id: null,
      realm: null,
      created_at: new Date(Date.now() - 30 * 24 * HOUR_MS).toISOString(),
      updated_at: new Date(Date.now() - HOUR_MS).toISOString(),
      deleted_at: null,
      members: [
        {
          id: 'm-long-me',
          chat_room_id: 'room-long',
          account_id: 'acc-1',
          account: { id: 'acc-1', name: 'testuser', nick: 'Test User', profile: { picture: { id: 'avatar-1' } } },
          nick: null,
        },
        {
          id: 'm-long-peer',
          chat_room_id: 'room-long',
          account_id: 'acc-2',
          account: { id: 'acc-2', name: 'icat', nick: 'iCat', profile: { picture: { id: 'cat-avatar' } } },
          nick: null,
        },
      ],
    },
  },
  /* The room-feature surfaces behind the chat list's left key. */
  chatInvites: {
    status: 200,
    headers: '',
    body: [
      {
        id: 'invite-1',
        chat_room_id: 'room-invite',
        chat_room: {
          id: 'room-invite',
          name: 'Design Crew',
          description: null,
          slug: null,
          type: 0,
          encryption_mode: 0,
          is_public: false,
          is_community: false,
          is_read_receipts_public: true,
          /* A group with no picture, whose members do have avatars: the row
             must letter the room's own name, not borrow a member's face. */
          picture: null,
          background: null,
          realm_id: null,
          account_id: null,
          realm: null,
          created_at: new Date(Date.now() - 3 * 24 * HOUR_MS).toISOString(),
          updated_at: new Date(Date.now() - 3 * 24 * HOUR_MS).toISOString(),
          deleted_at: null,
          members: [
            {
              id: 'm-invite-peer',
              chat_room_id: 'room-invite',
              account_id: 'acc-2',
              account: { id: 'acc-2', name: 'icat', nick: 'iCat', profile: { picture: { id: 'cat-avatar' } } },
              nick: null,
            },
          ],
        },
        account_id: 'acc-1',
        account: { id: 'acc-1', name: 'testuser', nick: 'Test User', profile: { picture: { id: 'avatar-1' } } },
        nick: null,
        notify: 0,
        joined_at: null,
        last_read_at: null,
      },
    ],
  },
  accountSearch: {
    status: 200,
    headers: '',
    body: [
      {
        id: 'acc-9',
        name: 'solsynth',
        nick: 'Solsynth',
        language: 'en-US',
        profile: { picture: { id: 'sol-avatar' } },
      },
    ],
  },
  /* Stickers: the account's owned packs (`/sphere/stickers/me` answers
     ownership rows with the pack nested) and one sticker's lookup, which is
     how a bubble turns a `:prefix+slug:` placeholder into an image. */
  stickerPacks: {
    status: 200,
    headers: '',
    body: [
      {
        id: 'own-1',
        pack_id: 'pack-1',
        account_id: 'acc-1',
        pack: {
          id: 'pack-1',
          name: 'Sky',
          prefix: 'sky',
          icon: { id: 'pack-icon-1' },
          stickers: [
            { id: 'st-1', slug: 'wave', name: '', image: { id: 'sticker-img-1', mime_type: 'image/png' } },
            { id: 'st-2', slug: 'cool', name: '', image: { id: 'sticker-img-2', mime_type: 'image/png' } },
          ],
        },
      },
    ],
  },
  stickerLookup: {
    status: 200,
    headers: '',
    body: { id: 'st-1', slug: 'wave', name: '', image: { id: 'sticker-img-1', mime_type: 'image/png' } },
  },
  /** The one-to-one room the new-message flow creates. */
  directRoom: {
    status: 200,
    headers: '',
    body: {
      id: 'room-dm-new',
      name: null,
      description: null,
      slug: null,
      type: 1,
      encryption_mode: 0,
      is_public: false,
      is_community: false,
      is_read_receipts_public: true,
      picture: null,
      background: null,
      realm_id: null,
      account_id: null,
      realm: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
      members: [
        {
          id: 'm-me',
          chat_room_id: 'room-dm-new',
          account_id: 'acc-1',
          account: { id: 'acc-1', name: 'testuser', nick: 'Test User', profile: { picture: { id: 'avatar-1' } } },
          nick: null,
        },
        {
          id: 'm-sol',
          chat_room_id: 'room-dm-new',
          account_id: 'acc-9',
          account: { id: 'acc-9', name: 'solsynth', nick: 'Solsynth', profile: { picture: { id: 'sol-avatar' } } },
          nick: null,
        },
      ],
    },
  },
};

/** Runs before any other script in the page (see the stub note above). */
const PREAMBLE = `<script>
(function () {
  /* Firefox 48 does not have these. */
  var proto = Array.prototype;
  delete proto.flat; delete proto.flatMap; delete proto.at;
  delete proto.findLast; delete proto.findLastIndex;

  delete Object.fromEntries;
  delete Object.getOwnPropertyDescriptors;
  delete Object.hasOwn;

  proto = String.prototype;
  delete proto.matchAll; delete proto.replaceAll;
  delete proto.trimStart; delete proto.trimEnd; delete proto.at;

  delete Promise.prototype.finally;
  delete Promise.allSettled;
  delete Promise.any;
  delete Promise.withResolvers;

  delete window.NodeList.prototype.forEach;
  delete window.NodeList.prototype[Symbol.iterator];

  delete window.queueMicrotask;
  delete window.structuredClone;
  delete window.AbortController;
  delete window.ResizeObserver;
  delete window.IntersectionObserver;
  delete window.globalThis;

  /* Gecko 48 only knows the boolean form of scrollIntoView: the options-object
     form (Firefox 50+) throws, and the app must never call it. A throw here
     fails the gate exactly where the handset would. */
  Element.prototype.scrollIntoView = function (arg) {
    if (arg !== undefined && typeof arg !== 'boolean') {
      throw new TypeError(
        "'block' member of ScrollIntoViewOptions 'nearest' is not a valid value for enumeration ScrollLogicalPosition."
      );
    }
  };

  /* Deterministic stand-in for public/js/libs/l10n.js: get() echoes the id —
     and the placeholder names it was handed — so assertions also prove strings
     flow through the l10n layer with the right argument names. once() is
     synchronous, which turns the real page's mount race into a hard failure. */
  window.navigator.mozL10n = {
    get: function (id, args) {
      if (!args) return id;
      return id + '(' + Object.keys(args).sort().join(',') + ')';
    },
    once: function (callback) { callback(); }
  };

  /* The platform media activities: the compose screen's toolbar launches them
     (camera capture, recorder record, gallery pick) and reads the chosen file
     back as a Blob. The answer mirrors the requested type, so the attachment
     rows land with the right kind. The result lands in a later turn of the
     event loop, like the real activity. */
  window.MozActivity = function (spec) {
    this.spec = spec;
    var self = this;
    setTimeout(function () {
      var types = (spec.data && spec.data.type) || [];
      var isVideo = types.indexOf('video/*') !== -1;
      var isAudio = types.indexOf('audio/*') !== -1;
      self.result = isVideo
        ? { blob: new Blob(['fake-video-bytes'], { type: 'video/mp4' }), name: 'clip.mp4' }
        : isAudio
          ? { blob: new Blob(['fake-audio-bytes'], { type: 'audio/mp4' }), name: 'recording.m4a' }
          : { blob: new Blob(['fake-photo-bytes'], { type: 'image/jpeg' }), name: 'picked-photo.jpg' };
      if (typeof self.onsuccess === 'function') self.onsuccess();
    }, 0);
  };

  /* Gecko 48 has getUserMedia and MediaRecorder; jsdom has neither. The
     stand-ins below let the in-app voice recorder be driven for real: the
     stream's tracks record that they were stopped (an open track is what keeps
     the microphone light on), and the recorder hands back one chunk of audio
     when it stops, like the real one's final dataavailable. */
  window.__media = { getUserMedia: 0, constraints: null, started: 0, stopped: 0, trackStops: 0 };
  var fakeStream = {
    getTracks: function () {
      return [{
        stop: function () { window.__media.trackStops += 1; }
      }];
    }
  };
  try {
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: function (constraints) {
          window.__media.getUserMedia += 1;
          window.__media.constraints = constraints;
          return Promise.resolve(fakeStream);
        }
      }
    });
  } catch (error) {
    window.navigator.mediaDevices = {
      getUserMedia: function () { return Promise.resolve(fakeStream); }
    };
  }
  window.MediaRecorder = function (stream, options) {
    this.stream = stream;
    this.mimeType = (options && options.mimeType) || 'audio/ogg;codecs=opus';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstart = null;
    this.onstop = null;
    this.onerror = null;
    var self = this;
    this.start = function () {
      self.state = 'recording';
      window.__media.started += 1;
      setTimeout(function () { if (self.onstart) self.onstart({}); }, 0);
    };
    this.stop = function () {
      self.state = 'inactive';
      window.__media.stopped += 1;
      setTimeout(function () {
        if (self.ondataavailable) {
          self.ondataavailable({ data: new Blob(['fake-audio-bytes'], { type: 'audio/ogg' }) });
        }
        if (self.onstop) self.onstop({});
      }, 0);
    };
  };
  window.MediaRecorder.isTypeSupported = function (type) {
    return String(type).indexOf('opus') !== -1;
  };

  /* KaiOS adds the Web Speech API on top of Gecko 48 and gates it behind the
     manifest's speech-recognition privilege; the realm has no recognition at
     all, so this stands in for the platform's. It records how the app opened
     the session (the app must ask for continuous interim results), and the
     test drives it the way the service does: emit() delivers a phrase, fail()
     reports a refusal, and stop() ends the session the way the platform does —
     a turn later, after the last result. */
  window.__speech = { started: 0, stopped: 0, aborted: 0, lang: '', continuous: null, interimResults: null, instance: null };
  window.SpeechRecognition = function () {
    this.lang = '';
    this.continuous = false;
    this.interimResults = false;
    this.maxAlternatives = 1;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    var self = this;
    this.start = function () {
      window.__speech.started += 1;
      window.__speech.lang = self.lang;
      window.__speech.continuous = self.continuous;
      window.__speech.interimResults = self.interimResults;
      window.__speech.instance = self;
    };
    this.stop = function () {
      window.__speech.stopped += 1;
      setTimeout(function () { if (self.onend) self.onend(); }, 0);
    };
    this.abort = function () {
      window.__speech.aborted += 1;
    };
  };
  /* One result, settled or not — the shape SpeechRecognitionEvent carries. */
  window.__speech.emit = function (transcript, isFinal) {
    var session = window.__speech.instance;
    if (!session || typeof session.onresult !== 'function') return;
    session.onresult({
      resultIndex: 0,
      results: { length: 1, 0: { length: 1, isFinal: isFinal, 0: { transcript: transcript } } }
    });
  };
  /* A refusal: the service reports it and then ends the session, which is what
     the app has to survive without latching the microphone on. */
  window.__speech.fail = function (code) {
    var session = window.__speech.instance;
    if (!session) return;
    if (typeof session.onerror === 'function') session.onerror({ error: code });
    if (typeof session.onend === 'function') session.onend();
  };

  /* Gecko 48 has object URLs for the attachment preview; jsdom does not. */
  if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = function () { return 'blob:smoke-photo'; };
    URL.revokeObjectURL = function () {};
  }

  /* Gecko 48 has a real canvas 2D context; jsdom has none, and the BlurHash
     wash (src/kaios/blur.ts) silently falls back to the plain box without it.
     This stand-in keeps the wash — and the CSS that has to stretch its single
     32×32 decode over the reserved box — observable to the gate. */
  window.HTMLCanvasElement.prototype.getContext = function () {
    return {
      createImageData: function (width, height) {
        return { data: new Uint8ClampedArray(width * height * 4) };
      },
      putImageData: function () {}
    };
  };
  window.HTMLCanvasElement.prototype.toDataURL = function () {
    return 'data:image/png;base64,c21va2U=';
  };

  /* Stands in for WebSocket so the chat realtime path is exercised: the socket
     opens on a later turn (like the real handshake), records every frame the
     app sends, and lets the harness push a server packet back. Gecko 48 has a
     real WebSocket; jsdom has none, so this closes the fidelity gap rather
     than papering over it. */
  window.__wsFrames = [];
  window.__wsSockets = [];
  window.WebSocket = function (url) {
    this.url = url;
    this.readyState = 0;
    var self = this;
    this.send = function (payload) {
      window.__wsFrames.push(JSON.parse(payload));
    };
    this.close = function () {
      self.readyState = 3;
      if (typeof self.onclose === 'function') self.onclose({});
    };
    window.__wsSockets.push(this);
    setTimeout(function () {
      if (self.readyState !== 0) return;
      self.readyState = 1;
      if (typeof self.onopen === 'function') self.onopen({});
    }, 0);
  };
  window.WebSocket.prototype.addEventListener = function () {};
  /* Delivers a server frame to the newest open socket. */
  window.__wsPush = function (packet) {
    var open = window.__wsSockets.filter(function (s) { return s.readyState === 1; });
    var target = open[open.length - 1];
    if (target && typeof target.onmessage === 'function') {
      target.onmessage({ data: JSON.stringify(packet) });
    }
  };

  /* Stands in for XMLHttpRequest so the privileged path can be inspected, and
     answers from a canned route table so the read path can be driven end to
     end. Responses land in a later turn of the event loop, like the real ones. */
  var CANNED = ${JSON.stringify(CANNED)};

  window.__requests = [];
  /* Refresh-grant exchanges only; device-flow polls are counted separately by
     the endpoint stub's own step counter. */
  window.__refreshes = 0;
  var __tokenPolls = 0;
  var __meRevoked = false;
  /* This session's reaction toggles: a symbol reacted again is taken back
     (the endpoint answers 204 for a removal, 200 for an addition). */
  var __reactions = {};

  /* One page of the long room's history, newest first, with take/offset honoured
     the way the messager honours them. The rows are generated rather than
     canned: 620 of them is what makes the thread's 500-row window observable.
     The content is the row's own ordinal from the oldest end, so a test can
     name exactly which rows are on screen after any number of loads. */
  function longRoomMessages(offset, take) {
    var total = CANNED.chatLongTotal;
    var rows = [];
    for (var index = offset; index < Math.min(total, offset + take); index += 1) {
      var ordinal = total - index;
      var mine = ordinal % 2 === 0;
      var at = new Date(Date.parse(CANNED.chatLongBase) + ordinal * 60000).toISOString();
      rows.push({
        id: 'long-' + ordinal,
        chat_room_id: 'room-long',
        type: 'text',
        content: 'L' + ordinal,
        sender_id: mine ? 'acc-1' : 'acc-2',
        sender: {
          id: mine ? 'm-long-me' : 'm-long-peer',
          chat_room_id: 'room-long',
          account_id: mine ? 'acc-1' : 'acc-2',
          account: mine
            ? { id: 'acc-1', name: 'testuser', nick: 'Test User', profile: { picture: { id: 'avatar-1' } } }
            : { id: 'acc-2', name: 'icat', nick: 'iCat', profile: { picture: { id: 'cat-avatar' } } },
          nick: null,
        },
        created_at: at,
        updated_at: at,
        deleted_at: null,
        attachments: [],
      });
    }
    return rows;
  }

  /* The querystring of a URL, as a lookup of its key=value pairs. */
  function queryOf(url) {
    var out = {};
    var query = url.split('?')[1] || '';
    var parts = query.split('&');
    for (var i = 0; i < parts.length; i += 1) {
      var pair = parts[i].split('=');
      if (pair[0]) out[pair[0]] = decodeURIComponent(pair[1] || '');
    }
    return out;
  }
  window.XMLHttpRequest = function (options) {
    this.options = options;
    this.responseType = '';
    this.timeout = 0;
    this.status = 0;
    this.requestHeaders = {};
    this.responseHeaders = '';
    this.requestBody = '';
  };
  window.XMLHttpRequest.prototype.open = function (method, url) {
    this.method = method;
    this.url = url;
  };
  window.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    this.requestHeaders[name] = value;
  };
  window.XMLHttpRequest.prototype.getAllResponseHeaders = function () {
    return this.responseHeaders;
  };
  window.XMLHttpRequest.prototype.send = function (body) {
    this.requestBody = body;
    window.__requests.push(this);
    var xhr = this;
    setTimeout(function () { respond(xhr); }, 0);
  };
  window.XMLHttpRequest.prototype.respond = function (status, body, headers) {
    this.status = status;
    this.response = body;
    this.responseHeaders = headers || '';
    this.onload();
  };

  function respond(xhr) {
    var url = xhr.url;
    if (url.indexOf('/stargate/auth/open/device/code') !== -1) {
      xhr.respond(CANNED.deviceCode.status, CANNED.deviceCode.body, CANNED.deviceCode.headers);
      return;
    }
    if (url.indexOf('/stargate/auth/open/token') !== -1) {
      if (String(xhr.requestBody || '').indexOf('grant_type=refresh_token') !== -1) {
        window.__refreshes += 1;
        xhr.respond(CANNED.refresh.status, CANNED.refresh.body, CANNED.refresh.headers);
        return;
      }
      __tokenPolls += 1;
      var tokenStep = __tokenPolls === 1 ? CANNED.tokenPending : CANNED.tokenOk;
      xhr.respond(tokenStep.status, tokenStep.body, tokenStep.headers);
      return;
    }
    if (url.indexOf('/stargate/accounts/me') !== -1) {
      /* The ?revoked-me scenario: the first call answers 401 to a bearer that
         has not expired — a session the server no longer accepts. The retry,
         after a forced refresh, answers normally. */
      if (window.location.search.indexOf('revoked-me') !== -1 && !__meRevoked) {
        __meRevoked = true;
        xhr.respond(401, { code: 'UNAUTHORIZED', message: 'Session revoked' }, '');
        return;
      }
      var meDelay = CANNED.me.delay || 0;
      if (meDelay > 0) {
        setTimeout(function () {
          xhr.respond(CANNED.me.status, CANNED.me.body, CANNED.me.headers);
        }, meDelay);
      } else {
        xhr.respond(CANNED.me.status, CANNED.me.body, CANNED.me.headers);
      }
      return;
    }
    if (url.indexOf('/stargate/sessions/current') !== -1) {
      xhr.respond(CANNED.revoke.status, CANNED.revoke.body, CANNED.revoke.headers);
      return;
    }
    if (url.indexOf('/sphere/publishers?mine=true') !== -1) {
      xhr.respond(CANNED.publishers.status, CANNED.publishers.body, CANNED.publishers.headers);
      return;
    }
    if (url.indexOf('/drive/files/upload/direct') !== -1) {
      // One id per upload: a message carrying two files must not point twice
      // at the same one.
      window.__uploads = (window.__uploads || 0) + 1;
      xhr.respond(
        CANNED.upload.status,
        { file: { id: 'file-upload-' + window.__uploads, name: 'upload.bin', mime_type: 'application/octet-stream', size: 16 } },
        CANNED.upload.headers,
      );
      return;
    }
    if (url.indexOf('/sphere/stickers/lookup/') !== -1) {
      xhr.respond(CANNED.stickerLookup.status, CANNED.stickerLookup.body, CANNED.stickerLookup.headers);
      return;
    }
    if (url.indexOf('/sphere/stickers/me') !== -1) {
      xhr.respond(CANNED.stickerPacks.status, CANNED.stickerPacks.body, CANNED.stickerPacks.headers);
      return;
    }
    if (url.indexOf('/sphere/posts/${OWNED_POST_ID}') !== -1 && xhr.method === 'GET') {
      xhr.respond(CANNED.ownedDetail.status, CANNED.ownedDetail.body, CANNED.ownedDetail.headers);
      return;
    }
    if (url.indexOf('/messager/chat/summary') !== -1) {
      xhr.respond(CANNED.chatSummary.status, CANNED.chatSummary.body, CANNED.chatSummary.headers);
      return;
    }
    if (url.indexOf('/messager/chat/invites') !== -1 && url.indexOf('/accept') !== -1) {
      window.__acceptedInvites = (window.__acceptedInvites || 0) + 1;
      xhr.respond(200, {}, '');
      return;
    }
    if (url.indexOf('/messager/chat/invites') !== -1 && url.indexOf('/decline') !== -1) {
      xhr.respond(200, {}, '');
      return;
    }
    if (url.indexOf('/messager/chat/invites') !== -1) {
      xhr.respond(CANNED.chatInvites.status, CANNED.chatInvites.body, CANNED.chatInvites.headers);
      return;
    }
    if (url.indexOf('/messager/chat/read-all') !== -1) {
      xhr.respond(200, {}, '');
      return;
    }
    if (url.indexOf('/metoer/notifications/all/read') !== -1) {
      window.__notificationsReadAll = (window.__notificationsReadAll || 0) + 1;
      xhr.respond(200, {}, '');
      return;
    }
    if (url.indexOf('/metoer/notifications/') !== -1 && url.indexOf('/read') !== -1) {
      window.__notificationReads = (window.__notificationReads || []).concat(
        url.split('/metoer/notifications/')[1].split('/')[0],
      );
      xhr.respond(200, {}, '');
      return;
    }
    if (url.indexOf('/metoer/notifications') !== -1) {
      xhr.respond(CANNED.notifications.status, CANNED.notifications.body, CANNED.notifications.headers);
      return;
    }
    if (url.indexOf('/messager/chat/direct') !== -1 && xhr.method === 'POST') {
      xhr.respond(CANNED.directRoom.status, CANNED.directRoom.body, CANNED.directRoom.headers);
      return;
    }
    if (url.indexOf('/messager/chat/direct') !== -1) {
      // No conversation exists yet, so startDirectChat must fall through to
      // the POST that creates it.
      xhr.respond(404, {}, '');
      return;
    }
    if (url.indexOf('/stargate/accounts/search') !== -1) {
      xhr.respond(CANNED.accountSearch.status, CANNED.accountSearch.body, CANNED.accountSearch.headers);
      return;
    }
    if (url.indexOf('/messager/chat/room-long/messages') !== -1) {
      var longQuery = queryOf(url);
      var longTake = Number(longQuery.take || 50);
      var longOffset = Number(longQuery.offset || 0);
      xhr.respond(
        200,
        longRoomMessages(longOffset, longTake),
        'x-total: ' + CANNED.chatLongTotal + '\\r\\n',
      );
      return;
    }
    if (url.indexOf('/messager/chat/room-long') !== -1) {
      xhr.respond(CANNED.chatLongRoom.status, CANNED.chatLongRoom.body, CANNED.chatLongRoom.headers);
      return;
    }
    if (url.indexOf('/messager/chat/room-group/messages/voice') !== -1 && xhr.method === 'POST') {
      // The dedicated voice endpoint uploads the take and answers the created
      // voice message: no content, no attachment rows — the media sits
      // behind meta.voice_url and the length in meta.duration_ms (echoing the
      // multipart form's durationMs field, which is how the send proves the
      // take's measured length rode along).
      window.__sentSeq = (window.__sentSeq || 0) + 1;
      var voiceBody = xhr.requestBody;
      var voiceDuration = 0;
      var voiceClientId = '';
      try {
        // The take rides as a FormData part; jsdom's FormData answers get().
        if (voiceBody && typeof voiceBody.get === 'function') {
          var durValue = voiceBody.get('durationMs');
          if (durValue !== null && durValue !== undefined) voiceDuration = Number(durValue);
          var clientValue = voiceBody.get('client_message_id');
          if (clientValue !== null && clientValue !== undefined) voiceClientId = String(clientValue);
        } else {
          var voiceText = String(voiceBody || '');
          var durMatch = voiceText.match(/name="durationMs"\\r\\n\\r\\n(\\d+)/);
          if (durMatch) voiceDuration = Number(durMatch[1]);
          var clientMatch = voiceText.match(/name="client_message_id"\\r\\n\\r\\n([^\\r]+)/);
          if (clientMatch) voiceClientId = clientMatch[1];
        }
      } catch (e) {}
      // What the send carried, for the gate's assertions: the measured length
      // is the point of the dedicated endpoint.
      window.__voiceDuration = voiceDuration;
      window.__voiceClientId = voiceClientId;
      var voiceSent = JSON.parse(JSON.stringify(CANNED.chatMessages.body[0]));
      voiceSent.id = 'msg-voice-' + window.__sentSeq;
      voiceSent.type = 'voice';
      voiceSent.content = null;
      voiceSent.client_message_id = voiceClientId || null;
      voiceSent.replied_message_id = null;
      voiceSent.meta = {
        voice_url: '/messager/chat/voice/sent-' + window.__sentSeq + '.ogg',
        duration_ms: voiceDuration,
      };
      voiceSent.attachments = [];
      voiceSent.sender_id = 'acc-1';
      voiceSent.sender = {
        id: 'm-me',
        chat_room_id: 'room-group',
        account_id: 'acc-1',
        account: { id: 'acc-1', name: 'testuser', nick: 'Test User', profile: { picture: { id: 'avatar-1' } } },
        nick: null,
        notify: 0,
        joined_at: null,
        last_read_at: null,
      };
      voiceSent.created_at = new Date(Date.now() + 600000 + window.__sentSeq * 10000).toISOString();
      voiceSent.updated_at = voiceSent.created_at;
      xhr.respond(200, voiceSent, '');
      return;
    }
    // A message react toggles like a post one: odd posts add the reaction
    // (200), even posts take it back (204) — the contract the picker follows.
    if (url.indexOf('/messager/chat/room-group/messages/') !== -1 && url.indexOf('/reactions') !== -1) {
      window.__reactionPosts = (window.__reactionPosts || 0) + 1;
      xhr.respond(window.__reactionPosts % 2 === 1 ? 200 : 204, {}, '');
      return;
    }
    // An edit echoes the message with the new text and an edited_at, which is
    // what turns the bubble's "edited" marker on. The sender stays the
    // account's own, so edit and delete remain offered afterwards.
    if (url.indexOf('/messager/chat/room-group/messages/') !== -1 && xhr.method === 'PATCH') {
      var editedBody = JSON.parse(xhr.requestBody || '{}');
      var edited = JSON.parse(JSON.stringify(CANNED.chatMessages.body[0]));
      edited.id = url.split('/messages/')[1];
      edited.content = editedBody.content || '';
      edited.edited_at = new Date().toISOString();
      edited.sender_id = 'acc-1';
      edited.sender = {
        id: 'm-me',
        chat_room_id: 'room-group',
        account_id: 'acc-1',
        account: { id: 'acc-1', name: 'testuser', nick: 'Test User', profile: { picture: { id: 'avatar-1' } } },
        nick: null,
        notify: 0,
        joined_at: null,
        last_read_at: null,
      };
      xhr.respond(200, edited, '');
      return;
    }
    // A delete succeeds; the message drops from the thread.
    if (url.indexOf('/messager/chat/room-group/messages/') !== -1 && xhr.method === 'DELETE') {
      window.__deletedMessages = (window.__deletedMessages || 0) + 1;
      xhr.respond(200, {}, '');
      return;
    }
    if (url.indexOf('/messager/chat/room-group/messages') !== -1 && xhr.method === 'POST') {
      // A switch lets the gate exercise the failure contract: the send 500s, the
      // optimistic row is dropped and the draft comes back.
      if (window.__failNextChatSend) {
        window.__failNextChatSend = false;
        xhr.respond(500, { code: 'SERVER_ERROR', message: 'nope' }, '');
        return;
      }
      // The send echo answers the created message: content echoes the body, and
      // the id is unique per request so two sends never collide on one row.
      window.__sentSeq = (window.__sentSeq || 0) + 1;
      var sentContent = '';
      try { sentContent = (JSON.parse(xhr.requestBody) || {}).content || ''; } catch (e) {}
      var sent = JSON.parse(JSON.stringify(CANNED.chatMessages.body[0]));
      sent.id = 'msg-sent-' + window.__sentSeq;
      sent.content = sentContent;
      // A reply's anchor echoes back, so the sent bubble can quote it.
      try { sent.replied_message_id = (JSON.parse(xhr.requestBody) || {}).replied_message_id || null; } catch (e) {}
      // The server answers the created message with its attachments resolved
      // from attachments_id (a drive file id becomes that file's metadata),
      // which is what the sent bubble then renders.
      sent.attachments = [];
      try {
        var postedIds = (JSON.parse(xhr.requestBody) || {}).attachments_id || [];
        for (var a = 0; a < postedIds.length; a += 1) {
          sent.attachments.push({
            id: postedIds[a],
            name: 'upload.bin',
            mime_type: 'application/pdf',
            size: 51200,
            width: 0,
            height: 0,
          });
        }
      } catch (e) {}
      sent.sender_id = 'acc-1';
      sent.sender = {
        id: 'm-me',
        chat_room_id: 'room-group',
        account_id: 'acc-1',
        account: { id: 'acc-1', name: 'testuser', nick: 'Test User', profile: { picture: { id: 'avatar-1' } } },
        nick: null,
        notify: 0,
        joined_at: null,
        last_read_at: null,
      };
      // Strictly increasing per send, so the thread's ordering is deterministic
      // regardless of how fast the gate drives the composer.
      sent.created_at = new Date(Date.now() + 600000 + window.__sentSeq * 10000).toISOString();
      sent.updated_at = sent.created_at;
      xhr.respond(200, sent, '');
      return;
    }
    if (url.indexOf('/messager/chat/room-group/messages') !== -1) {
      xhr.respond(CANNED.chatMessages.status, CANNED.chatMessages.body, CANNED.chatMessages.headers);
      return;
    }
    if (url.indexOf('/messager/chat/room-group') !== -1) {
      xhr.respond(CANNED.chatRooms.status, CANNED.chatRooms.body[0], CANNED.chatRooms.headers);
      return;
    }
    if (url.indexOf('/messager/chat?') !== -1 && url.indexOf('query=long') !== -1) {
      // Chat search: the long room's own result, so the thread's paging can be
      // reached without the room appearing in the list.
      xhr.respond(200, { rooms: [CANNED.chatLongRoom.body] }, 'x-total: 1\\r\\n');
      return;
    }
    if (url.indexOf('/messager/chat') !== -1) {
      // The live room-list route is /messager/chat, answering a { rooms: [...] }
      // object (the iOS ChatRoomsResponse shape).
      xhr.respond(CANNED.chatRooms.status, { rooms: CANNED.chatRooms.body }, CANNED.chatRooms.headers);
      return;
    }
    if (url.indexOf('/sphere/posts') !== -1 && xhr.method === 'POST' && url.indexOf('/reactions') === -1) {
      xhr.respond(CANNED.created.status, CANNED.created.body, CANNED.created.headers);
      return;
    }
    if (url.indexOf('/reactions') !== -1 && xhr.method === 'POST') {
      var symbol = '';
      try { symbol = (JSON.parse(xhr.requestBody) || {}).symbol || ''; } catch (e) {}
      if (__reactions[symbol]) {
        delete __reactions[symbol];
        xhr.respond(204, '', '');
      } else {
        __reactions[symbol] = true;
        xhr.respond(200, CANNED.created.body, CANNED.created.headers);
      }
      return;
    }
    var canned = url.indexOf('/calendar/countdown') !== -1
      ? CANNED.countdown
      : url.indexOf('/calendar?') !== -1
        ? CANNED.calendar
        : url.indexOf('/replies') !== -1
          ? (url.indexOf('offset=20') !== -1 ? CANNED.repliesPage2 : CANNED.replies)
          : url.indexOf(${JSON.stringify(CHAIN_ID)}) !== -1
            ? CANNED.chainMember
            : url.indexOf('?') !== -1
              ? CANNED.list
              : CANNED.detail;

    var delay = url.indexOf('offset=20') !== -1 && url.indexOf('/replies') === -1
      ? CANNED.delayFlip
      : 0;
    if (delay > 0) {
      setTimeout(function () {
        xhr.respond(canned.status, canned.body, canned.headers);
      }, delay);
    } else {
      xhr.respond(canned.status, canned.body, canned.headers);
    }
  }
})();
</script>`;

const DIST = path.resolve('dist');
const distUrl = pathToFileURL(DIST + path.sep).href;

// Vite emits relative asset URLs (`base: './'`), which is what a packaged app
// wants: on a device the app is served from its own origin root, so `./js/app.js`
// resolves exactly like `/js/app.js`, and off-device it also works from a file
// path. This rebase stays as a guard for any root-absolute URL that creeps back
// in; the tag order and attributes - the things under test - are untouched.
const html = readFileSync(path.join(DIST, 'index.html'), 'utf8')
  .replace(/(src|href)="\//g, `$1="${distUrl}`)
  .replace(/<script\b[^>]*\bsrc="[^"]*l10n\.js"[^>]*><\/script>/, PREAMBLE);

if (!html.includes('XMLHttpRequest = function (options)')) {
  console.error('Harness error: could not find the l10n script tag to replace with the stub.');
  process.exit(1);
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  url: `${distUrl}index.html`,
});

const { window } = dom;
const { document } = window;

if (document.readyState !== 'complete') {
  await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
}
await new Promise((resolve) => setTimeout(resolve, 50));

const requests = window.__requests;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const all = (selector) => Array.prototype.slice.call(document.querySelectorAll(selector));
const text = (selector) => {
  const node = document.querySelector(selector);
  return node ? node.textContent.trim() : '';
};
const texts = (selector) => all(selector).map((node) => node.textContent.trim());

/**
 * Turns the event loop until `predicate` holds.
 *
 * A load is several asynchronous hops deep — the canned response arrives in a
 * later turn, then the store updates, then Vue's scheduler renders in a
 * microtask — so a fixed number of turns would encode that chain here and break
 * the moment the app grows a hop.
 */
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return true;
    await flush();
  }
  return false;
}

/**
 * Like `until`, but for work paced by real timers — the device-flow poll
 * sleeps whole seconds between exchanges, which `flush()` (a 0ms turn) cannot
 * advance. Walks the clock in small steps up to `budgetMs`.
 */
async function untilTimer(predicate, budgetMs = 8000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * Dispatches a hardware key and waits for Vue to patch the DOM. Vue batches
 * renders into a microtask, so asserting straight after `dispatchEvent` reads
 * the previous state.
 */
async function press(key) {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  await flush();
  return event;
}

/**
 * Presses `key` until `predicate` holds, at most `limit` times. For the walks
 * whose starting point depends on what the app re-registered — a replaced list
 * hands the highlight to its nearest surviving neighbour — the loop states the
 * destination ("up to the chain row") instead of encoding a history.
 */
async function pressUntil(key, predicate, limit = 8) {
  for (let attempt = 0; attempt < limit && !predicate(); attempt += 1) {
    await press(key);
  }
  return predicate();
}

/* --- Dashboard ------------------------------------------------------------ */

/** The dashboard's own list rows: the calendar tile plus the five entries. */
const DASHBOARD_ROWS = 6;
/** The entry tiles alone — everything in the flat list but the calendar one. */
const ENTRY_ROW = '.kai-list--flat .kai-list-item:not(.kai-next-event)';

check('the app opens on the dashboard', text('.kai-header__title') === 'app_title', text('.kai-header__title'));
check(
  'the dashboard lists the top-level screens',
  texts(ENTRY_ROW + ' .kai-list-item__primary').join('|') ===
    'nav_explore|nav_chat|nav_notifications|nav_account|nav_about' &&
    texts(ENTRY_ROW + ' .kai-list-item__secondary').join('|') ===
      'nav_explore_desc|nav_chat_desc|nav_notifications_desc|nav_account_desc|nav_about_desc',
  {
    primary: texts(ENTRY_ROW + ' .kai-list-item__primary'),
    secondary: texts(ENTRY_ROW + ' .kai-list-item__secondary'),
  },
);
check(
  'the dashboard clock shows the time and the date on one line, without seconds',
  (() => {
    const time = document.querySelector('.kai-hero__time');
    const date = document.querySelector('.kai-hero__date');
    // One line: the date is a sibling of the clock inside the hero's row, not a
    // second block under it.
    if (
      !time ||
      !date ||
      time.parentElement !== date.parentElement ||
      !time.parentElement.classList.contains('kai-hero__line')
    ) {
      return false;
    }
    const line = text('.kai-hero__date');
    const match = /^(calendar_dow_\w+) · (\d{4}-\d{2}-\d{2})$/.exec(line);
    if (!match) return false;
    // The weekday must be the one that date actually falls on (Monday first).
    const [year, month, day] = match[2].split('-').map(Number);
    const names = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const index = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
    return /^\d{2}:\d{2}$/.test(text('.kai-hero__time')) && match[1] === 'calendar_dow_' + names[index];
  })(),
  { time: text('.kai-hero__time'), date: text('.kai-hero__date'), line: text('.kai-hero__line') },
);
check(
  'the dashboard entries are rows, not cards',
  Boolean(document.querySelector('.kai-list--flat')) && all('.kai-list-item').length === DASHBOARD_ROWS,
  { flat: Boolean(document.querySelector('.kai-list--flat')), entries: all('.kai-list-item').length },
);
await until(() => Boolean(document.querySelector('.kai-next-event')));
check(
  'the dashboard asks the network for the countdown and nothing else',
  requests.length === 1,
  requests.map((request) => request.url),
);
check(
  'the next event is a tile of the list, with the countdown beside its name',
  text('.kai-next-event .kai-list-item__primary').indexOf('Solstice') !== -1 &&
    text('.kai-next-event__eta') === 'countdown_days(d,h)',
  {
    primary: text('.kai-next-event .kai-list-item__primary'),
    eta: text('.kai-next-event__eta'),
  },
);
check(
  'the tile names the day the next event falls on, with its span',
  /^\d{4}-\d{2}-\d{2} · \d{2}:\d{2}–\d{2}:\d{2}$/.test(text('.kai-next-event .kai-list-item__secondary')),
  text('.kai-next-event .kai-list-item__secondary'),
);
check(
  'the calendar tile leads the list, under the clock, above the entries',
  (() => {
    const row = document.querySelector('.kai-next-event');
    const hero = document.querySelector('.kai-hero');
    const list = document.querySelector('.kai-content > ul.kai-list--flat');
    // A tile like the entries: the same element, the same flat list, the same
    // selectable — it is the list's first row, and the clock is above the list.
    return (
      Boolean(row) &&
      row.classList.contains('kai-list-item') &&
      row.getAttribute('nav-selectable') === 'true' &&
      row.parentElement === list &&
      list.firstElementChild === row &&
      hero.nextElementSibling === list
    );
  })(),
  {
    row: Boolean(document.querySelector('.kai-next-event')),
    first: Boolean(document.querySelector('.kai-list--flat .kai-list-item')),
  },
);

/* --- Calendar ------------------------------------------------------------- */

/** Monday-first day names, the order the calendar's week runs in. */
const DOW_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const mondayIndex = (key) => {
  const date = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))));
  return (date.getUTCDay() + 6) % 7;
};

const dayOffset = (key, days) => {
  const date = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)) + days));
  return date.toISOString().slice(0, 10);
};

// The calendar tile is the list's first row, so UP from the first entry (where
// the highlight starts) reaches it; Enter opens the full calendar on the day the
// tile was naming.
await press('ArrowUp');
check(
  'UP from the first entry reaches the calendar tile',
  (() => {
    const row = document.querySelector('.kai-next-event');
    return Boolean(row) && row.getAttribute('nav-selected') === 'true';
  })(),
  {
    rows: navState(all('.kai-list-item')),
    row: Boolean(document.querySelector('.kai-next-event[nav-selected="true"]')),
  },
);

/** The day the calendar's cursor sits on: the date half of its heading. */
const cursorKey = () => (text('.kai-cal__date') || '').split(' · ')[1] || '';
/** The weekday half, which must be the one that date falls on (Monday first). */
const cursorWeekday = () => (text('.kai-cal__date') || '').split(' · ')[0] || '';

const beforeCalendar = requests.length;
await press('Enter');
// The grid draws from the cursor alone; the day's own content waits on the
// month's answer, so that is what the checks below hold for.
await until(() => all('.kai-cal__day').length === 42 && Boolean(document.querySelector('.kai-cal__when')));
check('the calendar opens from the dashboard row', text('.kai-header__title') === 'nav_calendar', text('.kai-header__title'));
check(
  'the calendar fetches the month it shows',
  requests
    .slice(beforeCalendar)
    .some(
      (request) =>
        request.url.indexOf('/calendar?') !== -1 &&
        request.url.indexOf('year=' + CAL_MONTH.slice(0, 4)) !== -1 &&
        request.url.indexOf('month=' + Number(CAL_MONTH.slice(5, 7))) !== -1 &&
        request.url.indexOf('includeNotableDays=true') !== -1,
    ),
  requests.slice(beforeCalendar).map((request) => request.url),
);
check('the month bar names the month', text('.kai-cal__month') === CAL_MONTH, text('.kai-cal__month'));
check(
  'the grid is six Monday-started weeks',
  all('.kai-cal__week').length === 6 &&
    all('.kai-cal__weekday').length === 7 &&
    texts('.kai-cal__weekday').join('|') ===
      'calendar_dow_mon|calendar_dow_tue|calendar_dow_wed|calendar_dow_thu|calendar_dow_fri|calendar_dow_sat|calendar_dow_sun',
  { weeks: all('.kai-cal__week').length, days: all('.kai-cal__day').length, dow: texts('.kai-cal__weekday') },
);
check(
  'the cursor opens on the day the dashboard pointed at',
  cursorKey() === CAL_DAY &&
    cursorWeekday() === 'calendar_dow_' + DOW_NAMES[mondayIndex(CAL_DAY)] &&
    text('.kai-cal__day--cursor .kai-cal__num') === String(Number(CAL_DAY.slice(8, 10))),
  { heading: text('.kai-cal__date'), cell: text('.kai-cal__day--cursor .kai-cal__num') },
);
check(
  'the grid marks the event day and the notable day, and only those',
  all('.kai-cal__mark').length === 2 &&
    all('.kai-cal__mark--notable').length === 1 &&
    Boolean(document.querySelector('.kai-cal__day--cursor .kai-cal__mark')) &&
    !document.querySelector('.kai-cal__day--cursor .kai-cal__mark--notable'),
  { marks: all('.kai-cal__mark').length, notable: all('.kai-cal__mark--notable').length },
);
check(
  "the agenda lists the day's events, with the span they run",
  texts('.kai-content .kai-list-item__primary').join('|') === 'Solstice' &&
    /^\d{2}:\d{2}–\d{2}:\d{2}$/.test(text('.kai-cal__when')),
  { rows: texts('.kai-content .kai-list-item__primary'), when: text('.kai-cal__when') },
);

// The D-pad walks the grid a week at a time. The expected key is computed here
// so a month or week boundary is covered rather than assumed away.
const firstWeekday = mondayIndex(CAL_MONTH + '-01');
const calRow = Math.floor((Number(CAL_DAY.slice(8, 10)) - 1 + firstWeekday) / 7);

await press('ArrowDown');
const expectDown = calRow < 5 ? dayOffset(CAL_DAY, 7) : CAL_DAY;
check(
  'DOWN walks the cursor a week, and stops at the last row',
  cursorKey() === expectDown,
  { heading: text('.kai-cal__date'), expected: expectDown },
);
await press('ArrowUp');
check(
  'UP walks it back',
  cursorKey() === CAL_DAY,
  { heading: text('.kai-cal__date'), expected: CAL_DAY },
);

// Climb out of the grid: one UP per row to reach the first, one more to leave
// it. The month bar is where that lands.
for (let row = 0; row < calRow; row += 1) await press('ArrowUp');
await press('ArrowUp');
check(
  'UP out of the grid reaches the month bar',
  Boolean(document.querySelector('.kai-cal__bar .kai-list-item[nav-selected="true"]')),
  { bar: navState(all('.kai-cal__bar .kai-list-item')), cursor: cursorKey() },
);

const monthBefore = text('.kai-cal__month');
const expectedMonth = dayOffset(monthBefore + '-01', 32).slice(0, 7);
await press('Enter');
await until(() => cursorKey() === expectedMonth + '-01');
check(
  'the next arrow flips the month and loads it',
  text('.kai-cal__month') === expectedMonth &&
    cursorKey() === expectedMonth + '-01' &&
    requests.some(
      (request) =>
        request.url.indexOf('/calendar?') !== -1 &&
        request.url.indexOf('month=' + Number(expectedMonth.slice(5, 7))) !== -1,
    ),
  { month: text('.kai-cal__month'), cursor: cursorKey() },
);
await until(() => text('.kai-text--secondary') === 'calendar_no_events');
check(
  "a day with nothing on it shows no marks and says so",
  !document.querySelector('.kai-cal__day--cursor .kai-cal__mark') &&
    text('.kai-text--secondary') === 'calendar_no_events',
  { marks: all('.kai-cal__mark').length, empty: text('.kai-text--secondary') },
);

await press('SoftLeft');
await until(() => cursorKey() === utcKey(new Date()));
check(
  'the Today softkey returns the cursor to today',
  cursorKey() === utcKey(new Date()) && cursorWeekday() === 'calendar_dow_' + DOW_NAMES[mondayIndex(utcKey(new Date()))],
  { heading: text('.kai-cal__date') },
);

await press('Backspace');
await until(() => text('.kai-header__title') === 'app_title');
check(
  'Back leaves the calendar for the dashboard',
  text('.kai-header__title') === 'app_title' && all('.kai-list-item').length === DASHBOARD_ROWS,
  { title: text('.kai-header__title') },
);

await press('Enter');

/* --- Explore -------------------------------------------------------------- */

await until(() => document.querySelectorAll('li.kai-post').length > 0);

const rows = all('li.kai-post');
check('app mounts', all('#app').length === 1 && rows.length === 2, `explore rows: ${rows.length}`);
check('header renders a localised title', text('.kai-header__title') === 'nav_explore', text('.kai-header__title'));
check('first row starts selected', rows[0] && rows[0].getAttribute('nav-selected') === 'true', navState(rows));

check(
  'the page controls sit above the feed',
  (() => {
    const pager = document.querySelector('.kai-pager');
    const list = document.querySelector('.kai-content > ul.kai-list--flat');
    return Boolean(pager) && pager.nextElementSibling === list;
  })(),
  (() => {
    const pager = document.querySelector('.kai-pager');
    const list = document.querySelector('.kai-content > ul.kai-list--flat');
    return {
      pager: Boolean(pager),
      nextSibling: pager ? pager.nextElementSibling && pager.nextElementSibling.className : null,
      isPostList: pager ? pager.nextElementSibling === list : null,
    };
  })(),
);
check(
  'the highlight starts on the first post, not the page controls',
  rows[0].getAttribute('nav-selected') === 'true' && !document.querySelector('.kai-pager .kai-list-item[nav-selected="true"]'),
  { rows: navState(rows), pager: Boolean(document.querySelector('.kai-pager .kai-list-item[nav-selected="true"]')) },
);
check(
  'feed rows lead with the publisher avatar',
  (() => {
    const img = document.querySelector('li.kai-post .kai-post__author .kai-avatar');
    return Boolean(img) && img.getAttribute('src') === 'https://api.solian.app/drive/files/avatar-1?preset=thumb';
  })(),
  (() => {
    const img = document.querySelector('li.kai-post .kai-post__author .kai-avatar');
    return img ? img.getAttribute('src') : null;
  })(),
);

check(
  'the post list is a flat list',
  document.querySelectorAll('.kai-content > ul.kai-list--flat > li.kai-post').length === 2,
  all('ul').map((list) => list.className),
);
const listRequest = requests.filter(
  (request) =>
    request.url ===
    'https://api.solian.app/sphere/posts?take=20&offset=0&replies=false&orderDesc=true',
)[0];
check('the post list is fetched on mount', Boolean(listRequest));
if (listRequest) {
  check('request uses the systemXHR privilege', listRequest.options && listRequest.options.mozSystem === true);
  check('request is an anonymous GET', listRequest.method === 'GET' && !('Authorization' in listRequest.requestHeaders), {
    method: listRequest.method,
    headers: Object.keys(listRequest.requestHeaders),
  });
  check('request asks for JSON', listRequest.requestHeaders.Accept === 'application/json', listRequest.requestHeaders);
  check(
    'request URL is the offset-paginated public post list',
    listRequest.url === 'https://api.solian.app/sphere/posts?take=20&offset=0&replies=false&orderDesc=true',
    listRequest.url,
  );
}
check(
  'opening Explore adds exactly the list request',
  (() => {
    const postReads = requests.filter((request) => request.url.indexOf('/sphere/posts?') !== -1);
    return postReads.length === 1 && postReads[0].url.indexOf('offset=0') !== -1;
  })(),
  requests.filter((request) => request.url.indexOf('/sphere/posts?') !== -1).map((request) => request.url),
);

check(
  'rows show the display name and the unique @handle',
  // `name` is the unique handle (`@name`); `nick` is the pretty display name,
  // which is why the fixture keeps them different for the second row.
  texts('.kai-post__author').map(tight).join('|') === 'iCat @iCat|Solsynth @solsynth',
  texts('.kai-post__author').map(tight),
);
check(
  'rows show a relative timestamp through the l10n layer',
  text('.kai-post__time') === 'post_hours_ago(h)',
  text('.kai-post__time'),
);
check(
  'a reply row names the post it answered',
  texts('.kai-post__quote-label')[1] === 'post_replied_to(name)',
  texts('.kai-post__quote-label'),
);
check(
  'a null publication date falls back to the creation time',
  texts('.kai-post__time')[1] === 'post_hours_ago(h)',
  texts('.kai-post__time'),
);
check(
  'rows carry text, not markup',
  all('.kai-md').length === 0 && text('.kai-post__excerpt') === 'SN notes - supports X - and Y See the docs for more.',
  { markdownBlocks: all('.kai-md').length, excerpt: text('.kai-post__excerpt') },
);
check(
  'a row labels the post kind, title and truncation',
  text('.kai-post__title') === 'SN notes' &&
    tight(text('.kai-post__meta')).indexOf('post_kind_article') !== -1 &&
    tight(text('.kai-post__meta')).indexOf('post_truncated') !== -1,
  { title: text('.kai-post__title'), meta: tight(text('.kai-post__meta')) },
);
check(
  'a forwarded row quotes its source and counts its attachments',
  text('.kai-post__quote-label') === 'post_forwarded_from(name)' &&
    text('.kai-post__quote-text') === 'source body text' &&
    text('.kai-post__quote-attach').trim() === 'post_count_attachments(n)',
  {
    label: text('.kai-post__quote-label'),
    quote: text('.kai-post__quote-text'),
    attachments: text('.kai-post__quote-attach').trim(),
  },
);
check(
  'rows show the picture and count the rest; a picture carries no caption line',
  (() => {
    const image = document.querySelector('li.kai-post .kai-attachment__image');
    const lines = texts('.kai-post__attach').map(tight);
    // The shown picture has no metadata line under it; only the count of the
    // attachments it leaves out remains. (The line returns for a picture that
    // fails to load — the fallback the row needs to keep.)
    return Boolean(image) && lines.length === 1 && lines[0] === 'post_more_attachments(n)';
  })(),
  texts('.kai-post__attach').map(tight),
);
check(
  'a row shows the picture and reserves its box',
  (() => {
    const image = document.querySelector('li.kai-post .kai-attachment__image');
    return (
      Boolean(image) &&
      image.getAttribute('src') === 'https://api.solian.app/drive/files/01M28ESTWBSXQSTMVVBYYFDXSK?preset=thumb' &&
      image.getAttribute('width') === '810' &&
      image.getAttribute('height') === '1440'
    );
  })(),
  (() => {
    const image = document.querySelector('li.kai-post .kai-attachment__image');
    return image
      ? { src: image.getAttribute('src'), w: image.getAttribute('width'), h: image.getAttribute('height') }
      : null;
  })(),
);
check(
  'a row picture is edge-to-edge with square corners',
  (() => {
    const image = document.querySelector('li.kai-post .kai-attachment__image');
    return Boolean(image) && window.getComputedStyle(image).borderRadius === '0px';
  })(),
  (() => {
    const image = document.querySelector('li.kai-post .kai-attachment__image');
    return image ? window.getComputedStyle(image).borderRadius : null;
  })(),
);
check(
  'the BlurHash wash stretches over the reserved box instead of tiling',
  (() => {
    const image = document.querySelector('li.kai-post .kai-attachment__image');
    if (!image) return false;
    const style = window.getComputedStyle(image);
    // The decode is a 32×32 PNG: without `cover`/`no-repeat` the browser would
    // paint it as a grid of itself, which is the bug the gate locks out.
    return (
      image.style.backgroundImage.indexOf('data:image/png') !== -1 &&
      style.backgroundSize === 'cover' &&
      style.backgroundRepeat === 'no-repeat'
    );
  })(),
  (() => {
    const image = document.querySelector('li.kai-post .kai-attachment__image');
    if (!image) return null;
    const style = window.getComputedStyle(image);
    return {
      backgroundImage: image.style.backgroundImage,
      backgroundSize: style.backgroundSize,
      backgroundRepeat: style.backgroundRepeat,
    };
  })(),
);
check(
  'rows show the reply and boost counts, and reactions as sticker pills',
  // The known reactions render as pills (sticker + count) instead of the
  // kinds-count text; only reactions without a bundled sticker keep the text.
  text('.kai-post__counts').replace(/\s+/g, '') === 'post_count_replies(n)post_count_boosts(n)' &&
    (() => {
      const pills = Array.prototype.slice.call(document.querySelectorAll('.kai-reaction'));
      const sources = pills.map((pill) => pill.querySelector('.kai-reaction__img').getAttribute('src'));
      const counts = pills.map((pill) => pill.querySelector('.kai-reaction__count').textContent);
      return (
        pills.length === 2 &&
        sources.indexOf('/img/reactions/pray.png') !== -1 &&
        sources.indexOf('/img/reactions/laugh.png') !== -1 &&
        counts.every((count) => count === '1')
      );
    })(),
  {
    counts: text('.kai-post__counts'),
    pills: Array.prototype.slice.call(document.querySelectorAll('.kai-reaction')).map((pill) => ({
      src: pill.querySelector('.kai-reaction__img').getAttribute('src'),
      count: pill.querySelector('.kai-reaction__count').textContent,
    })),
  },
);
check(
  'a row announces the chain it heads; a member is never a row of its own',
  // The fixture's timeline holds a chain member between the two rows; the
  // timeline drops it — a continuation read without its head is a sentence with
  // the beginning cut off — so the list is still the head and Solsynth's post,
  // and the head of the second row states the chain on its counts line.
  all('li.kai-post').length === 2 &&
    texts('.kai-post__author').map(tight).join('|') === 'iCat @iCat|Solsynth @solsynth' &&
    all('.kai-post__counts')[1].textContent.replace(/\s+/g, '') === 'post_count_chain(n)',
  {
    rows: all('li.kai-post').length,
    authors: texts('.kai-post__author').map(tight),
    counts: all('.kai-post__counts').map((node) => node.textContent.replace(/\s+/g, '')),
  },
);
check(
  'the status bar space is reserved only where the bar sits over the app',
  // Handset whose window covers the whole panel: the bar is over the header.
  statusBarInset({ screenWidth: 240, screenHeight: 320, innerWidth: 240, innerHeight: 320 }) ===
    STATUS_BAR_PX &&
    // Handset the platform put below the bar: reserving it again would double the gap.
    statusBarInset({ screenWidth: 240, screenHeight: 320, innerWidth: 240, innerHeight: 294 }) === 0 &&
    // Dev server and simulator: `screen` is a monitor, so nothing is over the app.
    statusBarInset({ screenWidth: 800, screenHeight: 600, innerWidth: 240, innerHeight: 320 }) === 0 &&
    statusBarInset({ screenWidth: 1024, screenHeight: 768, innerWidth: 1024, innerHeight: 768 }) === 0,
  [
    statusBarInset({ screenWidth: 240, screenHeight: 320, innerWidth: 240, innerHeight: 320 }),
    statusBarInset({ screenWidth: 240, screenHeight: 320, innerWidth: 240, innerHeight: 294 }),
    statusBarInset({ screenWidth: 800, screenHeight: 600, innerWidth: 240, innerHeight: 320 }),
    statusBarInset({ screenWidth: 1024, screenHeight: 768, innerWidth: 1024, innerHeight: 768 }),
  ],
);
check(
  'the title bar reserves no space where the platform shows its own bar',
  document.documentElement.style.getPropertyValue('--kai-safe-top') === '0px',
  document.documentElement.style.getPropertyValue('--kai-safe-top'),
);

/* --- D-pad -------------------------------------------------------------- */

await press('ArrowDown');
check(
  'DOWN moves the highlight',
  rows[0].getAttribute('nav-selected') === 'false' && rows[1].getAttribute('nav-selected') === 'true',
  navState(rows),
);

await press('ArrowDown');
check(
  'DOWN from the last post wraps to the searchbar at the top',
  text('.kai-searchbar[nav-selected="true"]') === 'search_hint',
  text('.kai-searchbar[nav-selected="true"]'),
);

await press('ArrowDown');
check(
  'DOWN reaches the pager row',
  Boolean(document.querySelector('.kai-pager .kai-list-item[nav-selected="true"]')),
  { pagerSelected: Boolean(document.querySelector('.kai-pager .kai-list-item[nav-selected="true"]')) },
);

await press('ArrowDown');
check(
  'the list loop returns to the first post',
  rows[0].getAttribute('nav-selected') === 'true',
  navState(rows),
);

await press('ArrowUp');
check(
  'UP above the first post reaches the page controls',
  Boolean(document.querySelector('.kai-pager .kai-list-item[nav-selected="true"]')),
  { pagerSelected: Boolean(document.querySelector('.kai-pager .kai-list-item[nav-selected="true"]')) },
);

/* --- Page flip ---------------------------------------------------------- */

check(
  'the first page offers a next icon and names the page',
  (() => {
    const next = document.querySelector('.kai-pager .kai-list-item');
    return (
      Boolean(next) &&
      Boolean(next.querySelector('svg')) &&
      next.getAttribute('aria-label') === 'action_next_page' &&
      tight(text('.kai-pager__status')) === 'post_page(page,pages)'
    );
  })(),
  {
    icon: Boolean(document.querySelector('.kai-pager .kai-list-item svg')),
    aria: document.querySelector('.kai-pager .kai-list-item')
      ? document.querySelector('.kai-pager .kai-list-item').getAttribute('aria-label')
      : null,
    status: tight(text('.kai-pager__status')),
  },
);
check(
  'both page cells are always present; the inert one is dim',
  (() => {
    const cells = document.querySelectorAll('.kai-pager__cell');
    const dim = document.querySelector('.kai-pager__cell--dim');
    const active = document.querySelectorAll('.kai-pager .kai-list-item');
    return (
      cells.length === 2 &&
      Boolean(dim) &&
      dim.getAttribute('aria-hidden') === 'true' &&
      dim.getAttribute('nav-selectable') === null &&
      active.length === 1 &&
      Boolean(active[0].querySelector('svg'))
    );
  })(),
  Array.prototype.map.call(document.querySelectorAll('.kai-pager__cell'), (node) => ({
    text: node.textContent.trim(),
    cls: node.className,
    selectable: node.getAttribute('nav-selectable'),
  })),
);
check(
  'the searchbar sits above the page controls',
  (() => {
    const bar = all('.kai-searchbar')[0];
    const pager = document.querySelector('.kai-pager');
    return (
      all('.kai-searchbar').length === 1 &&
      Boolean(bar) &&
      bar.textContent.trim() === 'search_hint' &&
      bar.nextElementSibling === pager
    );
  })(),
  {
    bars: all('.kai-searchbar').map((el) => el.textContent.trim()),
    nextOfSearch: all('.kai-searchbar')[0]
      ? all('.kai-searchbar')[0].nextElementSibling &&
        all('.kai-searchbar')[0].nextElementSibling.className
      : null,
  },
);
check(
  'the pager is one row: dim prev, count, next',
  (() => {
    const pager = document.querySelector('.kai-pager');
    const nav = document.querySelector('.kai-pager__nav');
    const status = document.querySelector('.kai-pager__status');
    const cells = document.querySelectorAll('.kai-pager__cell');
    if (!pager || !nav || !status || cells.length !== 2) return false;
    const statusStyle = window.getComputedStyle(status);
    const navStyle = window.getComputedStyle(nav);
    return (
      nav.parentElement === pager &&
      status.parentElement === nav &&
      status.previousElementSibling === cells[0] &&
      status.nextElementSibling === cells[1] &&
      navStyle.display === 'flex' &&
      statusStyle.borderTopWidth === '0px' &&
      statusStyle.textAlign === 'center'
    );
  })(),
  (() => {
    const nav = document.querySelector('.kai-pager__nav');
    const status = document.querySelector('.kai-pager__status');
    return {
      navDisplay: nav ? window.getComputedStyle(nav).display : null,
      statusBorder: status ? window.getComputedStyle(status).borderTopWidth : null,
    };
  })(),
);

// The highlight is on the pager row above the feed, so Enter flips the page.
// The stub holds the response for a moment so the loading UI is observable.
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-spinner')));
const ring = window.getComputedStyle(document.querySelector('.kai-spinner__ring'));
check(
  'the feed spinner is a bare circular ring while the page flips',
  Boolean(document.querySelector('.kai-spinner')) &&
    !document.querySelector('.kai-spinner__label') &&
    ring.borderRadius === '50%' &&
    ring.width === '32px' &&
    ring.height === '32px',
  {
    label: document.querySelector('.kai-spinner__label')
      ? document.querySelector('.kai-spinner__label').textContent
      : null,
    ring: { width: ring.width, height: ring.height, radius: ring.borderRadius },
  },
);
const secondPage = () =>
  requests.filter(
    (request) =>
      request.url === 'https://api.solian.app/sphere/posts?take=20&offset=20&replies=false&orderDesc=true',
  );
await until(() => secondPage().length === 1 && all('li.kai-post').length === 2);

const flippedRows = all('li.kai-post');
check(
  'flipping the page fetches the next offset and replaces the list',
  secondPage().length === 1 && flippedRows.length === 2,
  { urls: requests.map((request) => request.url), rows: flippedRows.length },
);
check(
  'the second page offers both directions',
  (() => {
    const cells = all('.kai-pager .kai-list-item');
    return (
      cells.length === 2 &&
      cells.every((cell) => Boolean(cell.querySelector('svg'))) &&
      cells[0].getAttribute('aria-label') === 'action_prev_page' &&
      cells[1].getAttribute('aria-label') === 'action_next_page'
    );
  })(),
  all('.kai-pager .kai-list-item').map((cell) => ({
    aria: cell.getAttribute('aria-label'),
    icon: Boolean(cell.querySelector('svg')),
  })),
);
check(
  'previous, count and next share one row, labelled for screen readers',
  (() => {
    const cells = document.querySelectorAll('.kai-pager__cell');
    const status = document.querySelector('.kai-pager__status');
    if (cells.length !== 2 || !status) return false;
    return (
      Boolean(cells[0].querySelector('svg')) &&
      Boolean(cells[1].querySelector('svg')) &&
      cells[0].getAttribute('aria-label') === 'action_prev_page' &&
      cells[1].getAttribute('aria-label') === 'action_next_page' &&
      status.previousElementSibling === cells[0] &&
      status.nextElementSibling === cells[1] &&
      window.getComputedStyle(cells[0]).borderTopWidth === '0px' &&
      window.getComputedStyle(cells[1]).borderTopWidth === '0px'
    );
  })(),
  Array.prototype.map.call(
    document.querySelectorAll('.kai-pager__cell'),
    (node) => ({
      icon: Boolean(node.querySelector('svg')),
      aria: node.getAttribute('aria-label'),
    }),
  ),
);
check(
  'focus starts at the top of the new page',
  flippedRows[0].getAttribute('nav-selected') === 'true',
  navState(flippedRows),
);
check(
  "the right softkey opens the row's options sheet",
  text('.kai-softkey__key--right') === 'action_options',
  text('.kai-softkey__key--right'),
);

check('softkey shows the centre action', text('.kai-softkey__key--center') === 'action_open', text('.kai-softkey__key--center'));
check(
  'the left softkey opens the composer',
  text('.kai-softkey__key--left') === 'nav_compose',
  { left: text('.kai-softkey__key--left') },
);

/* --- Post detail -------------------------------------------------------- */

await press('Enter');
await until(() => document.querySelector('.kai-md h1'));

check('ENTER opens the selected post', text('.kai-header__title') === 'post_title', text('.kai-header__title'));
check(
  'a sub-screen carries no back softkey either',
  text('.kai-softkey__key--left') === '',
  text('.kai-softkey__key--left'),
);

const postRequest = requests.filter(
  (request) => request.url === 'https://api.solian.app/sphere/posts/' + FEED_POST_ID,
)[0];
const repliesRequest = requests.filter(
  (request) =>
    request.url ===
    'https://api.solian.app/sphere/posts/' + FEED_POST_ID + '/replies?take=20&offset=0',
)[0];
check(
  'the post and its replies are requested together',
  Boolean(postRequest) &&
    Boolean(repliesRequest) &&
    postRequest.options &&
    postRequest.options.mozSystem === true,
  requests.map((request) => request.url),
);

const heading = document.querySelector('.kai-md h1');
check(
  'the body is rendered as markdown',
  Boolean(heading) && heading.textContent === 'Heading',
  document.querySelector('.kai-md') ? document.querySelector('.kai-md').textContent : null,
);
check('markdown list syntax is not leaked as text', all('.kai-md li').length === 2 && texts('.kai-md li').join('|') === 'a|b', texts('.kai-md li'));
check(
  'no raw markdown markers survive into the DOM',
  text('.kai-md').indexOf('#') === -1,
  text('.kai-md'),
);

const bodyCard = document.querySelector('.kai-content > div.kai-post');
// The post's first attachment arrives with the wire response, so its
// selectable registers a tick later; wait for the highlight to land on it.
await until(() => Boolean(document.querySelector('.kai-post-extras[nav-selected="true"]')));
check(
  'focus starts on the first attachment, not the body',
  Boolean(document.querySelector('.kai-post-extras[nav-selected="true"]')) &&
    bodyCard.getAttribute('nav-selected') === 'false',
  {
    extras: document.querySelector('.kai-post-extras') ? document.querySelector('.kai-post-extras').getAttribute('nav-selected') : null,
    body: bodyCard.getAttribute('nav-selected'),
  },
);
check(
  'the detail leads with the author, whose picture is the avatar',
  (() => {
    const card = document.querySelector('.kai-content > div.kai-post');
    const author = card.querySelector('.kai-post__author');
    const meta = card.querySelector('.kai-post__meta');
    const body = card.querySelector('.kai-md');
    const img = author.querySelector('.kai-avatar');
    // Who wrote it, then the facts of publication, then what they wrote — the
    // order a feed row already reads in, and the order the reader sees.
    const precedes = (a, b) => Boolean(a && b && (a.compareDocumentPosition(b) & 4));
    return (
      Boolean(img) &&
      img.getAttribute('src') === 'https://api.solian.app/drive/files/avatar-1?preset=thumb' &&
      precedes(author, meta) &&
      precedes(meta, body)
    );
  })(),
  (() => {
    const card = document.querySelector('.kai-content > div.kai-post');
    return {
      order: ['.kai-post__author', '.kai-post__meta', '.kai-md'].map((sel) => {
        const el = card.querySelector(sel);
        return el ? sel : null;
      }),
      avatar: (() => {
        const img = card.querySelector('.kai-post__author .kai-avatar');
        return img ? img.getAttribute('src') : null;
      })(),
    };
  })(),
);
check(
  'the detail body sits on the page, not in a card',
  (() => {
    if (!bodyCard) return false;
    const s = window.getComputedStyle(bodyCard);
    // The picture above it is edge to edge, so a surface and a shadow under it
    // would draw a seam where the two meet. The body is a plain column of the
    // page, like every other screen's content. (jsdom reports an unset
    // `box-shadow` as '', not 'none'.)
    const noShadow = s.boxShadow === '' || s.boxShadow === 'none';
    return noShadow && s.backgroundColor === 'rgba(0, 0, 0, 0)';
  })(),
  bodyCard
    ? {
        shadow: window.getComputedStyle(bodyCard).boxShadow,
        background: window.getComputedStyle(bodyCard).backgroundColor,
      }
    : null,
);
check(
  'the body carries author, timestamp, visibility, counts and tags',
  text('.kai-content > div.kai-post').indexOf('iCat') !== -1 &&
    text('.kai-post__time') === 'post_hours_ago(h)' &&
    all('.kai-tag').length === 1 &&
    all('.kai-tag')[0].textContent.trim() === 'sokai',
  { tags: texts('.kai-tag'), time: text('.kai-post__time') },
);
check(
  'a non-public post is labelled and the edited marker shows',
  ['post_visibility_unlisted', 'post_edited', 'post_count_replies(n)'].every(
    (label) => text('.kai-content > div.kai-post').indexOf(label) !== -1,
  ),
  text('.kai-content > div.kai-post').slice(0, 200),
);
check(
  'the meta line is the publication facts, not the engagement',
  // The counts and the tags are what the post drew and what it is filed under:
  // their own lines under the body, not three more words on the meta line.
  text('.kai-post__meta').indexOf('post_count') === -1 &&
    text('.kai-post__counts').trim() === 'post_count_replies(n)' &&
    text('.kai-post__tags').trim() === 'sokai',
  {
    meta: tight(text('.kai-post__meta')),
    counts: tight(text('.kai-post__counts')),
    tags: tight(text('.kai-post__tags')),
  },
);
check(
  'the detail renders the quoted post as markdown',
  all('.kai-md--quote').length === 1 && tight(text('.kai-md--quote')) === 'Quoted source body.',
  tight(text('.kai-md--quote')),
);
check(
  'attachments sit above the body, not inside it',
  all('.kai-post-extras .kai-post__attach').length === 1 &&
    all('.kai-content > div.kai-post .kai-post__attach').length === 0 &&
    (document.querySelector('.kai-content').firstElementChild || {}).className === 'kai-post-extras',
  {
    extras: texts('.kai-post-extras .kai-post__attach').map(tight),
    insideBody: all('.kai-content > div.kai-post .kai-post__attach').length,
    firstChild: (document.querySelector('.kai-content').firstElementChild || {}).className,
  },
);
check(
  'a detail shows only the first attachment; the rest are counted',
  (() => {
    const images = all('.kai-post-extras .kai-attachment__image');
    return (
      images.length === 1 &&
      images[0].getAttribute('src') === 'https://api.solian.app/drive/files/v1?thumbnail=1' &&
      // The video's poster frame carries the play badge, so it reads playable.
      Boolean(document.querySelector('.kai-post-extras .kai-attachment__play svg')) &&
      texts('.kai-post-extras .kai-post__attach').map(tight).join(' | ') === 'post_more_attachments(n)'
    );
  })(),
  {
    images: all('.kai-post-extras img').map((image) => image.getAttribute('src')),
    badge: Boolean(document.querySelector('.kai-post-extras .kai-attachment__play svg')),
    lines: texts('.kai-post-extras .kai-post__attach').map(tight),
  },
);
check(
  'an inline file image is rendered, and a foreign one is not fetched',
  (() => {
    const photos = all('.kai-md__photo');
    const foreign = all('img').filter((image) => (image.getAttribute('src') || '').indexOf('example.com') !== -1);
    return (
      photos.length === 1 &&
      photos[0].getAttribute('src') === 'https://api.solian.app/drive/files/01M28ESTWBSXQSTMVVBYYFDXSK?preset=thumb' &&
      photos[0].getAttribute('alt') === 'shot' &&
      // A foreign image renders as nothing: the body stays pure content.
      !document.querySelector('.kai-md__image') &&
      foreign.length === 0
    );
  })(),
  {
    photos: all('.kai-md__photo').map((image) => image.getAttribute('src')),
    marker: text('.kai-md__image'),
    foreignImages: all('img').map((image) => image.getAttribute('src')),
  },
);

/* The post's own continuation: under the body, above the conversation, with a
   separator of its own — a chain member is the post carried on, not an answer
   to it, so it never reads as a reply. These stay queries rather than captured
   nodes: the detail reloads on the id it is showing, so every list under it is
   replaced and a captured row would go stale. */
const chainRows = () => all('.kai-list--chain li.kai-post');
const replyList = () => document.querySelector('.kai-list--replies');
const replyRows = () => {
  const list = replyList();
  return list ? Array.prototype.slice.call(list.querySelectorAll('li.kai-post')) : [];
};
const chainSelected = () =>
  Boolean(document.querySelector('.kai-list--chain li.kai-post[nav-selected="true"]'));
const pagerSelected = () =>
  Boolean(document.querySelector('.kai-pager .kai-list-item[nav-selected="true"]'));
const firstReplySelected = () =>
  Boolean(document.querySelector('.kai-list--replies li.kai-post[nav-selected="true"]'));
const extrasSelected = () =>
  Boolean(document.querySelector('.kai-post-extras[nav-selected="true"]'));
const replyPageTwo = () =>
  requests.filter(
    (request) =>
      request.url ===
      'https://api.solian.app/sphere/posts/' + FEED_POST_ID + '/replies?take=20&offset=20',
  );

check(
  'the post chain renders under the body, in its own section',
  texts('.kai-separator').join('|') === 'post_chained|post_replies' &&
    chainRows().length === 1 &&
    chainRows()[0].textContent.indexOf('chained body') !== -1,
  {
    separators: texts('.kai-separator'),
    chain: chainRows().length,
    chainSections: all('.kai-list--chain').length,
  },
);
check(
  'the chain reads before the replies',
  (() => {
    const chainList = document.querySelector('.kai-list--chain');
    const replySeparator = all('.kai-separator')[1];
    const precedes = (a, b) => Boolean(a && b && (a.compareDocumentPosition(b) & 4));
    return (
      Boolean(chainList) &&
      precedes(chainList, replySeparator) &&
      precedes(replySeparator, replyList())
    );
  })(),
  {
    order: ['.kai-list--chain', '.kai-list--replies'].map((selector) => {
      const node = document.querySelector(selector);
      return node ? selector : null;
    }),
  },
);

check(
  'replies render under their own separator, as flat rows',
  replyRows().length === 2 &&
    replyRows()[0].textContent.indexOf('reply body') !== -1 &&
    replyRows()[1].textContent.indexOf('second reply body') !== -1 &&
    Boolean(replyList()) &&
    replyList().className.indexOf('kai-list--flat') !== -1,
  {
    separator: texts('.kai-separator').join('|'),
    replies: replyRows().length,
    lists: all('ul').map((list) => list.className),
  },
);
check(
  'a reply whose parent is already on the screen drops its "replied to" quote',
  // The first reply answers the head this screen is about; that post is right
  // above it, so the quote would say the same thing twice. The second answers a
  // post that is not on the screen, so its quote stays.
  replyRows()[0].querySelector('.kai-post__quote') === null &&
    Boolean(replyRows()[1].querySelector('.kai-post__quote-label')) &&
    tight(replyRows()[1].querySelector('.kai-post__quote-label').textContent) === 'post_replied_to(name)',
  {
    first: replyRows()[0] ? tight(replyRows()[0].textContent) : null,
    secondLabel: replyRows()[1] && replyRows()[1].querySelector('.kai-post__quote-label')
      ? tight(replyRows()[1].querySelector('.kai-post__quote-label').textContent)
      : null,
  },
);
check(
  'the reply pager leads the rows, as it does over the feed',
  (() => {
    const pager = document.querySelector('.kai-pager');
    return Boolean(pager) && pager.nextElementSibling === replyList();
  })(),
  {
    pager: Boolean(document.querySelector('.kai-pager')),
    nextSibling: (() => {
      const pager = document.querySelector('.kai-pager');
      return pager && pager.nextElementSibling ? pager.nextElementSibling.className : null;
    })(),
    isReplyList: (() => {
      const pager = document.querySelector('.kai-pager');
      return Boolean(pager) && pager.nextElementSibling === replyList();
    })(),
  },
);

// The highlight rests on the attachment strip. The body has nothing to scroll
// in jsdom (scrollHeight is 0), so the press moves on — the `scrollFirst`
// behaviour needs a real layout box. The detail's own order is: strip, body,
// chain, pager, replies.
await press('ArrowDown');
await press('ArrowDown');
check(
  'DOWN walks the body and the post chain before the conversation',
  chainSelected(),
  { chain: navState(all('.kai-list--chain li.kai-post')), body: bodyCard.getAttribute('nav-selected') },
);

await press('ArrowDown');
check('the pager is reached above the replies', pagerSelected(), {
  pagerSelected: pagerSelected(),
});

await press('ArrowDown');
check(
  'DOWN from the pager lands on the first reply',
  firstReplySelected(),
  navState(replyRows()),
);

// The pager is an ordinary row: Enter on it flips the page under the list.
await pressUntil('ArrowUp', pagerSelected);
await press('Enter');
// The flip replaces the reply list, so wait for the rendered result, not just
// the request: the loading state and the canned response race the check.
await until(
  () =>
    replyPageTwo().length === 1 && tight(text('.kai-list--replies')).indexOf('page two reply') !== -1,
);

check(
  'flipping the reply page fetches the next offset and replaces the list',
  requests[requests.length - 1].url ===
    'https://api.solian.app/sphere/posts/' + FEED_POST_ID + '/replies?take=20&offset=20' &&
    replyPageTwo().length === 1 &&
    replyRows().length === 1 &&
    tight(text('.kai-list--replies')).indexOf('page two reply') !== -1,
  {
    url: requests[requests.length - 1].url,
    rows: replyRows().length,
    text: tight(text('.kai-list--replies')),
  },
);

// The chain member is a row like any other: open it and its own screen names the
// head it continues. The walk starts from wherever the flip left the highlight,
// which depends on how the replaced list re-registered — the wrap makes UP land
// on the chain row either way.
await pressUntil('ArrowUp', chainSelected);
await press('Enter');
await until(() => text('.kai-content').indexOf('chained body') !== -1 && all('.kai-post__quote-label').length > 0);
check(
  'a chain member read on its own names the head it continues',
  (() => {
    const read = requests.filter((request) => request.url.indexOf(CHAIN_ID) !== -1)[0];
    return (
      Boolean(read) &&
      read.url === 'https://api.solian.app/sphere/posts/' + CHAIN_ID &&
      texts('.kai-content > div.kai-post .kai-post__quote-label').join('|') === 'post_chained_to(name)'
    );
  })(),
  {
    urls: requests.map((request) => request.url).filter((url) => url.indexOf(CHAIN_ID) !== -1),
    labels: texts('.kai-post__quote-label'),
  },
);
check(
  'the member carries no chain section, and lists its own replies',
  all('.kai-list--chain').length === 0 && Boolean(document.querySelector('.kai-list--replies')),
  all('ul').map((list) => list.className),
);

// Back to the head — the same screen instance reloads on the returning id — and
// up to the strip, which is where the lightbox opens from.
await press('Backspace');
await until(() => document.querySelector('.kai-list--chain') !== null);
await pressUntil('ArrowUp', extrasSelected);
check(
  'UP walks the detail back to the attachment strip',
  extrasSelected(),
  { extras: document.querySelector('.kai-post-extras').getAttribute('nav-selected') },
);

/* --- Lightbox ------------------------------------------------------------- */

// The picture is the post: with the highlight resting on the strip, Enter
// opens the lightbox for the whole attachment set.
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-lightbox')));
check(
  'ENTER on the first attachment opens the full-bleed lightbox',
  Boolean(document.querySelector('.kai-lightbox')) &&
    !document.querySelector('.kai-header') &&
    all('.kai-lightbox__stage').length === 1,
  {
    lightbox: Boolean(document.querySelector('.kai-lightbox')),
    header: Boolean(document.querySelector('.kai-header')),
    stages: all('.kai-lightbox__stage').length,
  },
);
check(
  'the lightbox opens on the video, paused, with its controls',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return (
      Boolean(media) &&
      media.tagName === 'VIDEO' &&
      media.getAttribute('src') === 'https://api.solian.app/drive/files/v1?original=1' &&
      media.getAttribute('poster') === 'https://api.solian.app/drive/files/v1?thumbnail=1' &&
      // Paused: the play badge shows, the progress bar waits at zero.
      Boolean(document.querySelector('.kai-lightbox__play')) &&
      Boolean(document.querySelector('.kai-lightbox__progress')) &&
      text('.kai-lightbox__counter') === 'lightbox_counter(current,total)' &&
      // Nothing else is drawn: the media is the screen.
      !document.querySelector('.kai-lightbox__hint')
    );
  })(),
  {
    media: document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').tagName : null,
    src: document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').getAttribute('src') : null,
    poster: document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').getAttribute('poster') : null,
    badge: Boolean(document.querySelector('.kai-lightbox__play')),
    counter: text('.kai-lightbox__counter'),
  },
);
check(
  "the set's counter rides over the media, in its bottom corner",
  (() => {
    const counter = document.querySelector('.kai-lightbox__counter');
    if (!counter) return false;
    const box = window.getComputedStyle(counter);
    return (
      // Inside the stage, so it is positioned against the media and takes no
      // row of the screen from it.
      counter.parentNode === document.querySelector('.kai-lightbox__stage') &&
      box.position === 'absolute' &&
      box.bottom !== 'auto'
    );
  })(),
  (() => {
    const counter = document.querySelector('.kai-lightbox__counter');
    if (!counter) return null;
    const box = window.getComputedStyle(counter);
    return {
      parent: counter.parentNode ? counter.parentNode.className : null,
      position: box.position,
      bottom: box.bottom,
      right: box.right,
    };
  })(),
);

// The centre key plays and pauses; the badge and the softkey label follow.
await press('Enter');
check(
  'the centre key plays the video; the badge clears',
  text('.kai-softkey__key--center') === 'lightbox_pause' && !document.querySelector('.kai-lightbox__play'),
  { center: text('.kai-softkey__key--center'), badge: Boolean(document.querySelector('.kai-lightbox__play')) },
);
await press('Enter');
check(
  'the centre key pauses the video; the badge returns',
  text('.kai-softkey__key--center') === 'lightbox_play' && Boolean(document.querySelector('.kai-lightbox__play')),
  { center: text('.kai-softkey__key--center'), badge: Boolean(document.querySelector('.kai-lightbox__play')) },
);

// RIGHT moves on to the picture.
await press('ArrowRight');
check(
  'RIGHT moves to the picture',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return (
      Boolean(media) &&
      media.tagName === 'IMG' &&
      media.getAttribute('src') === 'https://api.solian.app/drive/files/p1?original=1'
    );
  })(),
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return {
      media: media ? media.tagName + ' ' + media.getAttribute('src') : null,
      counter: text('.kai-lightbox__counter'),
    };
  })(),
);

// UP and DOWN zoom a picture in steps (the centre key is the video's play
// key); a zoomed picture keeps the D-pad for panning instead of switching.
// (jsdom never loads the bytes, so panning itself is untestable here — the
// zoom state and the key ownership are not.)
await press('ArrowUp');
check(
  'UP zooms the picture in; the centre key stays with the video',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return (
      Boolean(media) &&
      media.className.indexOf('kai-lightbox__media--zoomed') !== -1 &&
      text('.kai-softkey__key--center') === ''
    );
  })(),
  {
    className: document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').className : null,
    center: text('.kai-softkey__key--center'),
  },
);
await press('ArrowLeft');
check(
  'a zoomed picture does not switch on LEFT',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return Boolean(media) && media.getAttribute('src') === 'https://api.solian.app/drive/files/p1?original=1';
  })(),
  document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').getAttribute('src') : null,
);
// The phone pad pans inside the zoomed picture (2/4/6/8); it never switches,
// and it is inert once the picture is back at fit.
await press('4');
await press('8');
check(
  'the 2/4/6/8 pad pans the zoomed picture without switching',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return Boolean(media) && media.getAttribute('src') === 'https://api.solian.app/drive/files/p1?original=1';
  })(),
  document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').getAttribute('src') : null,
);
await press('ArrowDown');
check(
  'DOWN zooms the picture back out to fit',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return Boolean(media) && media.className.indexOf('kai-lightbox__media--zoomed') === -1;
  })(),
  document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').className : null,
);
await press('6');
check(
  'the pad is inert at fit; only LEFT/RIGHT switch',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return Boolean(media) && media.getAttribute('src') === 'https://api.solian.app/drive/files/p1?original=1';
  })(),
  document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').getAttribute('src') : null,
);
// 1 and 3 turn the picture a quarter-turn at a time — counterclockwise and
// clockwise — and the turn is observable even though the bytes never load.
await press('1');
check(
  '1 turns the picture counterclockwise',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return Boolean(media) && media.style.transform.indexOf('rotate(-90deg)') !== -1;
  })(),
  document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').style.transform : null,
);
await press('3');
check(
  '3 turns it back upright',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return Boolean(media) && media.style.transform === '';
  })(),
  document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').style.transform : null,
);
await press('3');
check(
  '3 turns it on clockwise',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return Boolean(media) && media.style.transform.indexOf('rotate(90deg)') !== -1;
  })(),
  document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').style.transform : null,
);

// RIGHT again reaches the document, which has only its line to be.
await press('ArrowRight');
check(
  'RIGHT reaches a document, which keeps its line',
  (() => {
    const line = document.querySelector('.kai-lightbox__line');
    return Boolean(line) && tight(line.textContent) === '[post_attach_file] notes.pdf · 1.5 KB';
  })(),
  text('.kai-lightbox__line'),
);

// LEFT wraps back through the set to the video.
await press('ArrowLeft');
await press('ArrowLeft');
check(
  'LEFT wraps back to the first attachment',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return (
      Boolean(media) &&
      media.tagName === 'VIDEO' &&
      media.getAttribute('src') === 'https://api.solian.app/drive/files/v1?original=1'
    );
  })(),
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return media ? media.tagName + ' ' + media.getAttribute('src') : null;
  })(),
);

// Back returns to the post, whose strip holds the highlight again.
await press('Backspace');
await until(() => Boolean(document.querySelector('.kai-post-extras[nav-selected="true"]')));
check(
  'Back leaves the lightbox for the post',
  text('.kai-header__title') === 'post_title' && Boolean(document.querySelector('.kai-post-extras[nav-selected="true"]')),
  {
    title: text('.kai-header__title'),
    extras: document.querySelector('.kai-post-extras') ? document.querySelector('.kai-post-extras').getAttribute('nav-selected') : null,
  },
);

/* --- Reactions: the option menu and the sign-in gate -------------------- */

// The post's actions live in an option menu behind the right softkey, so the
// read path — body to replies — stays uninterrupted. The bar answers a tap
// like the key it stands for: this opens the menu with a pointer click, not a
// key press.
document.querySelector('.kai-softkey__key--right').click();
await until(() => Boolean(document.querySelector('.kai-option-menu')));
check(
  "the option menu lists the post's actions",
  texts('.kai-option-menu__item').join('|') === 'action_reply|action_forward|action_react|action_reload',
  texts('.kai-option-menu__item').join('|'),
);
check(
  'the option menu carries its own title and Select/Cancel bar',
  text('.kai-option-menu__header') === 'post_options' &&
    text('.kai-option-menu__key--left') === 'action_cancel' &&
    text('.kai-option-menu__key--center') === 'action_select' &&
    // The screen's own bar reads empty while the sheet is up.
    text('.kai-softkey__key--left') === '' &&
    text('.kai-softkey__key--center') === '',
  {
    header: text('.kai-option-menu__header'),
    left: text('.kai-option-menu__key--left'),
    center: text('.kai-option-menu__key--center'),
    screenLeft: text('.kai-softkey__key--left'),
    screenCenter: text('.kai-softkey__key--center'),
  },
);
// The sheet's own CANCEL answers a tap too.
document.querySelector('.kai-option-menu__key--left').click();
await until(() => !document.querySelector('.kai-option-menu'));
check(
  'the sheet CANCEL closes the option menu',
  text('.kai-header__title') === 'post_title' && !document.querySelector('.kai-option-menu'),
  { title: text('.kai-header__title'), menu: Boolean(document.querySelector('.kai-option-menu')) },
);
// Back closes it as well, without leaving the post.
document.querySelector('.kai-softkey__key--right').click();
await until(() => Boolean(document.querySelector('.kai-option-menu')));
await press('Backspace');
await until(() => !document.querySelector('.kai-option-menu'));
check(
  'Back closes the option menu without leaving the post',
  text('.kai-header__title') === 'post_title' && !document.querySelector('.kai-option-menu'),
  { title: text('.kai-header__title'), menu: Boolean(document.querySelector('.kai-option-menu')) },
);

// React runs from the menu; anonymous it leads to the sign-in gate, not a
// dead 401. The cursor starts on Reply: two DOWNs reach React.
document.querySelector('.kai-softkey__key--right').click();
await until(() => Boolean(document.querySelector('.kai-option-menu')));
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => text('.kai-header__title') === 'action_react');
check(
  'React from the option menu opens the reaction picker',
  text('.kai-header__title') === 'action_react',
  text('.kai-header__title'),
);
check(
  'reacting while signed out shows the sign-in gate',
  text('.kai-content > .kai-text') === 'reactions_sign_in' &&
    texts('.kai-list-item__primary').join('|') === 'account_sign_in',
  {
    intro: text('.kai-content > .kai-text'),
    rows: texts('.kai-list-item__primary').join('|'),
  },
);
await press('Backspace');
await until(() => Boolean(document.querySelector('.kai-post-extras[nav-selected="true"]')));

/* --- Back, then the other screen ---------------------------------------- */

await press('Backspace');
await until(() => all('li.kai-post').length === 2);
check(
  'the hardware Back key goes back to Explore',
  text('.kai-header__title') === 'nav_explore' && all('li.kai-post').length === 2,
  { title: text('.kai-header__title'), rows: all('li.kai-post').length },
);
// The timeline is preserved on a return: the page that was on screen (page 2,
// after the flip test) stays — the last list fetch is still its offset=20,
// not a fresh offset=0 reload.
const lastListRequest = requests
  .filter(
    (request) => request.url.indexOf('/sphere/posts?') !== -1 && request.url.indexOf('query=') === -1,
  )
  .slice(-1)[0];
check(
  'returning to the feed does not refetch the timeline',
  Boolean(lastListRequest) && lastListRequest.url.indexOf('offset=20') !== -1,
  lastListRequest ? lastListRequest.url : null,
);

// Explore is no longer the top level: its Back goes up to the dashboard, and the
// dashboard is where the platform takes Back.
await press('Backspace');
await until(() => document.querySelectorAll('.kai-list-item').length === DASHBOARD_ROWS);
check(
  'Back returns to the dashboard',
  text('.kai-header__title') === 'app_title' && all('.kai-list-item').length === DASHBOARD_ROWS,
  { title: text('.kai-header__title'), entries: all('.kai-list-item').length },
);

await press('ArrowDown');
check(
  'DOWN reaches the second dashboard entry',
  all(ENTRY_ROW)[1].getAttribute('nav-selected') === 'true',
  navState(all(ENTRY_ROW)),
);

// The second row is the new Chat screen; the fifth is About.
await press('ArrowDown');
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => text('.kai-header__title') === 'nav_about');
const about = text('.kai-content');
check('About opens from the dashboard', text('.kai-header__title') === 'nav_about', text('.kai-header__title'));
// Guards the build-time `define` values: unreplaced, these render as nothing
// and the screen is silently blank.
check('About shows the compiled version', about.includes('0.2.0'), about);
check('About shows the compiled target', about.includes('KaiOS 2.5 (Gecko 48)'), about);

await press('Backspace');
await until(() => document.querySelectorAll('.kai-list-item').length === DASHBOARD_ROWS);

/* --- Search ------------------------------------------------------------ */

// From the dashboard, the first entry is Explore: open it and walk up to the
// searchbar. The timeline is preserved on page 2 (the earlier flip test), so
// the pager carries both cells: three UPs from the first post reach the bar
// (next cell, previous cell, searchbar).
await press('Enter');
await until(() => all('li.kai-post').length === 2);
await press('ArrowUp');
await press('ArrowUp');
await press('ArrowUp');
await flush();
check(
  'UP three times from the first post reaches the searchbar',
  (() => {
    const bar = all('.kai-searchbar').find((el) => el.textContent.trim() === 'search_hint');
    return Boolean(bar && bar.getAttribute('nav-selected') === 'true');
  })(),
  all('.kai-searchbar').map((el) => el.textContent.trim()),
);

await press('Enter');
await until(() => text('.kai-header__title') === 'nav_search');
check(
  'the searchbar pushes the Search screen, whose field starts highlighted',
  text('.kai-header__title') === 'nav_search' &&
    document.querySelector('.kai-field__input[nav-selected="true"]') !== null,
  {
    header: text('.kai-header__title'),
    fieldSelected: Boolean(document.querySelector('.kai-field__input[nav-selected="true"]')),
  },
);

// Type a term and commit with Enter.
const field = document.querySelector('.kai-field__input');
field.value = 'sol';
field.dispatchEvent(new window.Event('input', { bubbles: true }));
await flush();
check(
  'the one-line searchbar field draws its underline',
  window.getComputedStyle(field).borderBottomStyle === 'solid',
  window.getComputedStyle(field).borderBottomStyle,
);
// A one-line field has no caret line to give the D-pad, so the highlight takes
// the press — the field is not a trap; and Enter is the app's action here, not
// the platform's newline (see the compose body, where it is the reverse).
const searchEnter = await press('Enter');
check(
  'Enter in a one-line field is the app action, not the platform newline',
  searchEnter.defaultPrevented === true,
  searchEnter.defaultPrevented,
);
await until(() => all('li.kai-post').length === 2);
// The commit closed the platform's editor: the field keeps the highlight but no
// longer the keys, so the D-pad moves on to the results.
const searchDown = await press('ArrowDown');
check(
  'DOWN after a committed search moves off the field to the results',
  searchDown.defaultPrevented === true &&
    document.querySelector('.kai-field__input[nav-selected="true"]') === null,
  {
    prevented: searchDown.defaultPrevented,
    stillOnField: Boolean(document.querySelector('.kai-field__input[nav-selected="true"]')),
  },
);

const searchRequest = requests.filter((request) => request.url.indexOf('query=sol') !== -1)[0];
check(
  'the search hits the posts search endpoint',
  Boolean(searchRequest) &&
    searchRequest.url ===
      'https://api.solian.app/sphere/posts?take=20&offset=0&replies=false&orderDesc=true&query=sol',
  searchRequest ? searchRequest.url : null,
);
check(
  'search results render as post rows under their own page controls',
  all('li.kai-post').length === 2 &&
    document.querySelector('.kai-pager') !== null &&
    document.querySelector('.kai-pager').nextElementSibling ===
      document.querySelector('.kai-content > ul.kai-list--flat'),
  {
    rows: all('li.kai-post').length,
    pager: Boolean(document.querySelector('.kai-pager')),
  },
);

// Back out to the dashboard, where the platform takes Back.
await press('Backspace');
await until(() => text('.kai-header__title') === 'nav_explore');
await press('Backspace');
await until(() => document.querySelectorAll('.kai-list-item').length === DASHBOARD_ROWS);

/* --- Account: the device flow ---------------------------------------------- */

// The dashboard's fourth row is Account; enter it while signed out.
await press('ArrowDown');
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => text('.kai-header__title') === 'nav_account');
check(
  'the account screen offers sign-in when signed out',
  text('.kai-content > .kai-text') === 'account_sign_in_intro' &&
    texts('.kai-list-item__primary').join('|') === 'account_sign_in',
  {
    intro: text('.kai-content > .kai-text'),
    rows: texts('.kai-list-item__primary'),
  },
);

// Start the flow: the Sign in row is the only row.
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-account__code')));
const codeRequest = requests.filter(
  (request) => request.url.indexOf('/stargate/auth/open/device/code') !== -1,
)[0];
check(
  'the device flow asks Stargate for a code as the shared client',
  Boolean(codeRequest) &&
    codeRequest.method === 'POST' &&
    codeRequest.requestBody.indexOf('client_id=solian-on-watch') !== -1 &&
    codeRequest.requestBody.indexOf('scope=*') !== -1,
  codeRequest ? { method: codeRequest.method, body: codeRequest.requestBody } : null,
);
check(
  'the user code and waiting state are shown for the other device',
  text('.kai-account__code') === 'CODE-1234' && text('.kai-account__waiting') === 'account_waiting',
  { code: text('.kai-account__code'), waiting: text('.kai-account__waiting') },
);
check(
  'the signing-in screen shows a QR code encoding the prefilled page',
  (() => {
    const image = document.querySelector('.kai-account__qr img');
    if (!image) return false;
    const src = image.getAttribute('src');
    const prefix = 'data:image/svg+xml;charset=utf-8,';
    if (!src || src.indexOf(prefix) !== 0) return false;
    // A real QR is drawn: the SVG carries the white backing and module paths.
    const svg = decodeURIComponent(src.slice(prefix.length));
    return svg.indexOf('<svg') === 0 && svg.indexOf('<rect') !== -1 && svg.indexOf('<path') !== -1;
  })(),
  (() => {
    const image = document.querySelector('.kai-account__qr img');
    return image ? image.getAttribute('src') : null;
  })(),
);

// The first poll is still pending; the second exchange approves.
await untilTimer(() => Boolean(document.querySelector('.kai-account__name')));
const tokenRequests = requests.filter(
  (request) => request.url.indexOf('/stargate/auth/open/token') !== -1,
);
check(
  'the poll exchanges the device code twice, pending then approved',
  tokenRequests.length === 2 &&
    decodeURIComponent(tokenRequests[0].requestBody).indexOf(
      'grant_type=urn:ietf:params:oauth:grant-type:device_code',
    ) !== -1 &&
    tokenRequests[0].requestBody.indexOf('device_code=dev-1') !== -1,
  tokenRequests.map((request) => decodeURIComponent(request.requestBody)),
);
const meRequest = requests.filter(
  (request) => request.url.indexOf('/stargate/accounts/me') !== -1,
)[0];
check(
  'the profile is fetched with the new token',
  Boolean(meRequest) && meRequest.requestHeaders.Authorization === 'Bearer test-access',
  meRequest ? meRequest.requestHeaders : null,
);
check(
  'the account screen shows the signed-in identity and its banner',
  (() => {
    const name = text('.kai-account__name');
    const handle = text('.kai-account__handle');
    const banner = document.querySelector('.kai-account__banner');
    const pfp = document.querySelector('.kai-account__pfp');
    return (
      name === 'Test User' &&
      handle === '@testuser' &&
      Boolean(banner) &&
      banner.getAttribute('src') === 'https://api.solian.app/drive/files/banner-1?preset=thumb' &&
      Boolean(pfp) &&
      pfp.getAttribute('src') === 'https://api.solian.app/drive/files/avatar-1?preset=thumb'
    );
  })(),
  {
    name: text('.kai-account__name'),
    handle: text('.kai-account__handle'),
    banner: (document.querySelector('.kai-account__banner') || {}).getAttribute
      ? document.querySelector('.kai-account__banner').getAttribute('src')
      : null,
    pfp: (document.querySelector('.kai-account__pfp') || {}).getAttribute
      ? document.querySelector('.kai-account__pfp').getAttribute('src')
      : null,
  },
);

// Back to the dashboard: the feed now goes out authenticated.
await press('Backspace');
await until(() => text('.kai-header__title') === 'app_title');
await press('Enter');
await until(() => all('li.kai-post').length > 0);
const authedFeed = requests
  .filter(
    (request) =>
      request.url.indexOf('/sphere/posts?') !== -1 && request.url.indexOf('query=') === -1,
  )
  .slice(-1)[0];
check(
  'the feed is authenticated after sign-in',
  Boolean(authedFeed) && authedFeed.requestHeaders.Authorization === 'Bearer test-access',
  authedFeed ? authedFeed.requestHeaders : null,
);

/* --- Reactions: the signed-in picker ------------------------------------ */

// The highlight rests on the first post, so the right softkey opens its
// options sheet; React is the third choice (after Reply and Forward).
await until(() => text('.kai-softkey__key--right') === 'action_options');
await press('SoftRight');
await until(() => Boolean(document.querySelector('.kai-option-menu')));
check(
  "a feed row's options sheet lists the read-write actions",
  texts('.kai-option-menu__item').join('|') === 'action_reply|action_forward|action_react',
  texts('.kai-option-menu__item').join('|'),
);
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => document.querySelectorAll('.kai-reaction-tile').length === 15);
check(
  'the signed-in picker shows the fifteen reaction stickers',
  text('.kai-header__title') === 'action_react' &&
    document.querySelectorAll('.kai-reaction-tile').length === 15,
  {
    title: text('.kai-header__title'),
    tiles: document.querySelectorAll('.kai-reaction-tile').length,
  },
);
const reactionBadges = () =>
  Array.prototype.slice.call(document.querySelectorAll('.kai-reaction-tile__count')).map((node) => node.textContent);
check(
  'the picker carries the post reactions as count badges',
  reactionBadges().length === 2 && reactionBadges().every((count) => count === '1'),
  reactionBadges(),
);

// The cursor starts on the first sticker; the D-pad walks the 5×3 grid.
check(
  'the picker starts on the first sticker',
  document.querySelectorAll('.kai-reaction-tile')[0].className.indexOf('kai-reaction-tile--selected') !== -1,
  document.querySelectorAll('.kai-reaction-tile')[0].className,
);
await press('ArrowRight');
check(
  'RIGHT moves the cursor to the next sticker',
  document.querySelectorAll('.kai-reaction-tile')[1].className.indexOf('kai-reaction-tile--selected') !== -1,
  document.querySelectorAll('.kai-reaction-tile')[1].className,
);

// Enter reacts with the highlighted sticker; the toggle answer bumps the badge.
await press('Enter');
await until(() => reactionBadges().length === 3);
const reactionPosts = requests.filter(
  (request) =>
    request.method === 'POST' &&
    request.url.indexOf('/sphere/posts/') !== -1 &&
    request.url.indexOf('/reactions') !== -1,
);
check(
  'reacting POSTs the highlighted sticker and attitude',
  reactionPosts.length === 1 &&
    JSON.parse(reactionPosts[0].requestBody).symbol === 'salute' &&
    JSON.parse(reactionPosts[0].requestBody).attitude === 0,
  reactionPosts.map((request) => request.requestBody),
);
check(
  'a fresh reaction appears as a count badge',
  reactionBadges().length === 3 && reactionBadges().indexOf('1') !== -1,
  reactionBadges(),
);

// Reactions the user made — the post's `reactions_made` (pray) and the one
// just added (salute) — are tinted and carry a check, like the main app's.
check(
  'reactions the user made are highlighted with a check',
  (() => {
    const tiles = Array.prototype.slice.call(document.querySelectorAll('.kai-reaction-tile'));
    const bySrc = {};
    for (const tile of tiles) {
      const img = tile.querySelector('img');
      if (img) bySrc[img.getAttribute('src')] = tile;
    }
    const made = (tile) =>
      Boolean(tile) && tile.className.indexOf('kai-reaction-tile--made') !== -1;
    const pray = bySrc['/img/reactions/pray.png'];
    const salute = bySrc['/img/reactions/salute.png'];
    return (
      made(pray) && Boolean(pray.querySelector('.kai-reaction-tile__check')) &&
      made(salute) && Boolean(salute.querySelector('.kai-reaction-tile__check'))
    );
  })(),
  (() => {
    const tiles = Array.prototype.slice.call(document.querySelectorAll('.kai-reaction-tile'));
    const made = tiles
      .filter((tile) => tile.className.indexOf('kai-reaction-tile--made') !== -1)
      .map((tile) => tile.querySelector('img').getAttribute('src'));
    return { made, checks: document.querySelectorAll('.kai-reaction-tile__check').length };
  })(),
);

// Reacting again with the same sticker takes it back: the endpoint answers
// 204, the badge and the highlight both clear.
await press('Enter');
await until(() => reactionBadges().length === 2);
check(
  're-acting with the same sticker removes its badge and highlight',
  (() => {
    const tiles = Array.prototype.slice.call(document.querySelectorAll('.kai-reaction-tile'));
    const salute = tiles.find((tile) => {
      const img = tile.querySelector('img');
      return img && img.getAttribute('src') === '/img/reactions/salute.png';
    });
    return (
      reactionBadges().length === 2 &&
      Boolean(salute) &&
      salute.className.indexOf('kai-reaction-tile--made') === -1
    );
  })(),
  { badges: reactionBadges(), made: document.querySelectorAll('.kai-reaction-tile--made').length },
);

await press('Backspace');
await until(() => text('.kai-header__title') === 'nav_explore');
await press('Backspace');
await until(() => text('.kai-header__title') === 'app_title');

/* --- Owned post: edit and delete ---------------------------------------- */

// The signed-in account's own post, reached by bookmarking its URL: the hash
// sync rebuilds the stack and the canned route answers the owned detail.
window.location.hash = '#/explore/post?id=' + OWNED_POST_ID;
await until(() => Boolean(document.querySelector('.kai-post-extras[nav-selected="true"]')));
check(
  "the owned post's picture leads the view",
  text('.kai-header__title') === 'post_title' &&
    document.querySelector('.kai-post-extras').getAttribute('nav-selected') === 'true',
  { title: text('.kai-header__title'), extras: document.querySelector('.kai-post-extras').getAttribute('nav-selected') },
);
document.querySelector('.kai-softkey__key--right').click();
await until(() => Boolean(document.querySelector('.kai-option-menu')));
check(
  "an owned post's menu adds edit and delete",
  texts('.kai-option-menu__item').join('|') ===
    'action_reply|action_forward|action_react|post_edit|post_delete|action_reload',
  texts('.kai-option-menu__item').join('|'),
);

// The cursor starts on Reply; three DOWNs reach Edit.
await press('ArrowDown');
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
check(
  "edit opens the composer seeded with the post's content",
  text('.kai-header__title') === 'compose_edit' &&
    document.querySelector('.kai-field__textarea').value === 'owned post body',
  {
    title: text('.kai-header__title'),
    draft: document.querySelector('.kai-field__textarea') ? document.querySelector('.kai-field__textarea').value : null,
  },
);
check(
  'the edited post keeps its own publisher: no publisher row',
  texts('.kai-list-item__primary').join('|').indexOf('compose_post_as') === -1,
  texts('.kai-list-item__primary').join('|'),
);
check(
  "the edited post's attachments seed the draft",
  texts('.kai-list-item__primary').join('|').indexOf('seed.png') !== -1,
  texts('.kai-list-item__primary').join('|'),
);
check(
  'the Save key is live on the seeded draft',
  text('.kai-softkey__key--right') === 'compose_save',
  text('.kai-softkey__key--right'),
);

// Edit the body and save: the PATCH is scoped to the post's publisher.
const editField = document.querySelector('.kai-field__textarea');
editField.value = 'owned post body\nedited';
editField.dispatchEvent(new window.Event('input', { bubbles: true }));
await press('SoftRight');
await until(() => text('.kai-header__title') === 'post_title');
const editRequests = requests.filter(
  (request) => request.method === 'PATCH' && request.url.indexOf('/sphere/posts/' + OWNED_POST_ID) !== -1,
);
check(
  'saving PATCHes the post under its publisher with the new content',
  editRequests.length === 1 &&
    editRequests[0].url.indexOf('pub=testuser') !== -1 &&
    JSON.parse(editRequests[0].requestBody).content === 'owned post body\nedited',
  editRequests.map((request) => ({ url: request.url, body: request.requestBody })),
);

// Back on the post view; the menu's Delete row asks before it acts.
await until(() => Boolean(document.querySelector('.kai-post-extras[nav-selected="true"]')));
document.querySelector('.kai-softkey__key--right').click();
await until(() => Boolean(document.querySelector('.kai-option-menu')));
await press('ArrowDown');
await press('ArrowDown');
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
check(
  'the first press on Delete asks for confirmation',
  texts('.kai-option-menu__item').join('|').indexOf('post_delete_confirm') !== -1,
  texts('.kai-option-menu__item').join('|'),
);
await press('Enter');
await until(() => text('.kai-header__title') === 'nav_explore');
const deleteRequests = requests.filter(
  (request) => request.method === 'DELETE' && request.url.indexOf('/sphere/posts/' + OWNED_POST_ID) !== -1,
);
check(
  'the second press DELETEs the post and returns to the feed',
  deleteRequests.length === 1 && text('.kai-header__title') === 'nav_explore',
  { deletes: deleteRequests.length, title: text('.kai-header__title') },
);

await press('Backspace');
await until(() => text('.kai-header__title') === 'app_title');

/* --- Compose: publisher, photo, post -------------------------------------- */

// Signed in, the write path is the left softkey — no compose tile on the feed.
await press('Enter');
await until(() => all('li.kai-post').length === 2);
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
check(
  'compose opens on the first owned publisher with the media toolbar',
  texts('.kai-list-item__primary').join('|') === 'compose_post_as(name)' &&
    // The row is icon-only: each tool draws a lucide glyph and keeps its name
    // as the accessible label. The platform recorder is absent because
    // dictation owns the microphone where the device has the speech service.
    all('.kai-icon-button').length === 4 &&
    all('.kai-icon-button svg').length === 4 &&
    all('.kai-icon-button')
      .map((button) => button.getAttribute('aria-label'))
      .join('|') ===
      'compose_take_photo|compose_record_video|compose_dictate|compose_add_photo' &&
    all('.kai-icon-button__label').length === 0,
  {
    rows: texts('.kai-list-item__primary'),
    tools: all('.kai-icon-button').map((button) => button.getAttribute('aria-label')),
  },
);
check(
  'the Post as row leads with the publisher avatar',
  (() => {
    const img = document.querySelector('.kai-list-item--thumb .kai-avatar');
    return Boolean(img) && img.getAttribute('src') === 'https://api.solian.app/drive/files/pub-avatar-1?preset=thumb';
  })(),
  (() => {
    const img = document.querySelector('.kai-list-item--thumb .kai-avatar');
    return img ? img.getAttribute('src') : null;
  })(),
);
check(
  'the Post key waits for content',
  text('.kai-softkey__key--right') === '',
  text('.kai-softkey__key--right'),
);

// Type the body. The field is the screen's primary control, so it opens in the
// platform's text mode — but the D-pad is not trapped there: the caret keeps a
// press only while the draft has a line to move to, and a one-line value has
// none. (That trap was the bug: the focused field swallowed every arrow.)
const composeField = document.querySelector('.kai-field__textarea');
check(
  'compose opens in text mode on the body field',
  document.activeElement === composeField && composeField.getAttribute('nav-selected') === 'true',
  {
    focused: document.activeElement === composeField,
    selected: composeField.getAttribute('nav-selected'),
  },
);
check(
  'the compose body carries no underline',
  window.getComputedStyle(composeField).borderBottomStyle === 'none',
  window.getComputedStyle(composeField).borderBottomStyle,
);

composeField.value = 'hello\nworld';
composeField.setSelectionRange(0, 0);
composeField.dispatchEvent(new window.Event('input', { bubbles: true }));
await flush();
const caretDown = await press('ArrowDown');
check(
  'DOWN with a line below the caret stays with the caret',
  caretDown.defaultPrevented === false && composeField.getAttribute('nav-selected') === 'true',
  { prevented: caretDown.defaultPrevented, selected: composeField.getAttribute('nav-selected') },
);
composeField.setSelectionRange(composeField.value.length, composeField.value.length);
const lastLineDown = await press('ArrowDown');
check(
  'DOWN at the last line hands the press to the media toolbar',
  lastLineDown.defaultPrevented === true &&
    document.querySelector('.kai-icon-button[nav-selected="true"]').getAttribute('aria-label') === 'compose_take_photo',
  { prevented: lastLineDown.defaultPrevented, tools: all('.kai-icon-button[nav-selected="true"]').map((b) => b.getAttribute('aria-label')) },
);
await press('ArrowUp');
check(
  'UP comes back to the body field',
  composeField.getAttribute('nav-selected') === 'true' && document.activeElement === composeField,
  {
    selected: composeField.getAttribute('nav-selected'),
    focused: document.activeElement === composeField,
  },
);
// Enter in the body is the platform's newline — the draft is markdown, so
// consuming it would make a line break impossible.
const bodyEnter = await press('Enter');
check(
  'Enter in the multi-line body is left to the platform, not the app action',
  bodyEnter.defaultPrevented === false,
  bodyEnter.defaultPrevented,
);

composeField.value = 'Hello from the smoke test';
composeField.dispatchEvent(new window.Event('input', { bubbles: true }));
await flush();
check(
  'the Post key appears once there is content',
  text('.kai-softkey__key--right') === 'compose_post',
  text('.kai-softkey__key--right'),
);

// Switch publisher: the row above the field opens the picker.
await press('ArrowUp');
await press('Enter');
await until(() => text('.kai-header__title') === 'compose_publisher_title');
check(
  'the picker lists the account publishers, marking the current one',
  texts('.kai-list-item__primary').join('|') === 'Test User|Second Pub' &&
    texts('.kai-list-item__secondary').join('|') === 'compose_current · @testuser|@secondpub',
  { primary: texts('.kai-list-item__primary'), secondary: texts('.kai-list-item__secondary') },
);
check(
  'the picker rows lead with each publisher avatar',
  (() => {
    const imgs = all('.kai-list-item--thumb .kai-avatar');
    return (
      imgs.length === 2 &&
      imgs[0].getAttribute('src') === 'https://api.solian.app/drive/files/pub-avatar-1?preset=thumb' &&
      imgs[1].getAttribute('src') === 'https://api.solian.app/drive/files/pub-avatar-2?preset=thumb'
    );
  })(),
  all('.kai-list-item--thumb .kai-avatar').map((img) => img.getAttribute('src')),
);
await press('ArrowDown');
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
// The remounted draft highlights its body field again, in text mode — the D-pad
// still leaves it, which is what the navigation below relies on.
check(
  'the remounted draft returns to text mode on the body field',
  document.activeElement === document.querySelector('.kai-field__textarea'),
  document.activeElement ? document.activeElement.className : null,
);
await flush();
check(
  'the chosen publisher comes back to the draft, avatar included',
  texts('.kai-list-item__secondary')[0] === '@secondpub' &&
    (() => {
      const img = document.querySelector('.kai-list-item--thumb .kai-avatar');
      return Boolean(img) && img.getAttribute('src') === 'https://api.solian.app/drive/files/pub-avatar-2?preset=thumb';
    })(),
  {
    secondary: texts('.kai-list-item__secondary'),
    thumb: (() => {
      const img = document.querySelector('.kai-list-item--thumb .kai-avatar');
      return img ? img.getAttribute('src') : null;
    })(),
  },
);

// Attach media: DOWN from the body reaches the first toolbar tool (Take
// photo); the camera activity hands the file back as a Blob.
await press('ArrowDown');
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-compose-attachment')));
check(
  'the picked photo joins the draft as a removable row',
  (texts('.kai-compose-attachment .kai-list-item__primary')[0] || '').indexOf('picked-photo.jpg') !== -1 &&
    (texts('.kai-compose-attachment .kai-list-item__secondary')[0] || '').indexOf('compose_tap_to_remove') !== -1,
  texts('.kai-compose-attachment .kai-list-item__primary'),
);
check(
  'the tile name clamps to one line, ellipsized',
  (() => {
    const primary = document.querySelector('.kai-compose-attachment .kai-list-item__primary');
    if (!primary) return false;
    const style = window.getComputedStyle(primary);
    // The ellipsis pair — `-webkit-line-clamp` would be the modern way, but
    // Gecko 48 has neither it nor `display: -webkit-box`.
    return style.whiteSpace === 'nowrap' && style.overflow === 'hidden' && style.textOverflow === 'ellipsis';
  })(),
  (() => {
    const primary = document.querySelector('.kai-compose-attachment .kai-list-item__primary');
    return primary ? window.getComputedStyle(primary) : null;
  })(),
);

// The toolbar walks left to right and wraps, like the pager's cells.
await press('ArrowDown');
check(
  'DOWN walks to the record-video tool',
  document.querySelector('.kai-icon-button[nav-selected="true"]').getAttribute('aria-label') === 'compose_record_video',
  all('.kai-icon-button[nav-selected="true"]').map((b) => b.getAttribute('aria-label')),
);
await press('ArrowDown');
check(
  'DOWN walks to the dictate tool',
  document.querySelector('.kai-icon-button[nav-selected="true"]').getAttribute('aria-label') === 'compose_dictate',
  all('.kai-icon-button[nav-selected="true"]').map((b) => b.getAttribute('aria-label')),
);
await press('ArrowDown');
check(
  'DOWN walks to the gallery tool',
  document.querySelector('.kai-icon-button[nav-selected="true"]').getAttribute('aria-label') === 'compose_add_photo',
  all('.kai-icon-button[nav-selected="true"]').map((b) => b.getAttribute('aria-label')),
);
// UP walks back out of the toolbar into the body field. The body element is
// re-created by the publisher-picker remount, so it is queried fresh here, and
// the walk is bounded by the field itself rather than by a count of the tools.
for (let step = 0; step < 8; step += 1) {
  if (document.querySelector('.kai-field__textarea').getAttribute('nav-selected') === 'true') break;
  await press('ArrowUp');
}
check(
  'UP leaves the toolbar for the body field',
  document.querySelector('.kai-field__textarea').getAttribute('nav-selected') === 'true',
  document.querySelector('.kai-field__textarea').getAttribute('nav-selected'),
);

// Post: the photo uploads first, then the post is created, then back to the feed.
await press('SoftRight');
await until(() => text('.kai-header__title') === 'nav_explore');
await until(() => all('li.kai-post').length === 2);
const uploadRequest = requests
  .filter((request) => request.url.indexOf('/drive/files/upload/direct') !== -1)
  .slice(-1)[0];
const createRequest = requests
  .filter((request) => request.url.indexOf('/sphere/posts?pub=') !== -1)
  .slice(-1)[0];
const createBody = createRequest ? JSON.parse(createRequest.requestBody) : null;
check(
  'posting uploads the photo, then creates the post under the chosen publisher',
  Boolean(uploadRequest) &&
    uploadRequest.method === 'POST' &&
    uploadRequest.requestHeaders.Authorization === 'Bearer test-access' &&
    Boolean(createRequest) &&
    createRequest.method === 'POST' &&
    createRequest.requestHeaders.Authorization === 'Bearer test-access' &&
    Boolean(createBody) &&
    createBody.content === 'Hello from the smoke test' &&
    JSON.stringify(createBody.attachments) === '["file-upload-1"]',
  {
    uploadUrl: uploadRequest ? uploadRequest.url : null,
    uploadAuth: uploadRequest ? uploadRequest.requestHeaders.Authorization : null,
    createUrl: createRequest ? createRequest.url : null,
    createBody,
  },
);

// The store cleared the draft: a fresh compose visit starts empty.
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
check(
  'a fresh compose visit starts with an empty draft and no photo',
  document.querySelector('.kai-field__textarea').value === '' &&
    !document.querySelector('.kai-compose-attachment'),
  {
    value: document.querySelector('.kai-field__textarea').value,
    attachments: all('.kai-compose-attachment').length,
  },
);

/* --- Dictation: the platform's speech service, not a recording ------------ */

// jsdom lays nothing out, so a textarea's `scrollHeight` is 0 for every value
// and the growth the field owes a value it was not typed into would be
// invisible. Give this field a height that tracks its text, the way a laid-out
// one does, so the check below measures the growth rather than an empty string.
const dictatedFieldTarget = document.querySelector('.kai-field__textarea');
Object.defineProperty(dictatedFieldTarget, 'scrollHeight', {
  configurable: true,
  get() {
    return this.value.length * 12;
  },
});

// The tool sits in the media toolbar after the microphone; walk to it the way
// the D-pad does rather than counting presses from the field.
for (let step = 0; step < 8; step += 1) {
  const selected = document.querySelector('.kai-icon-button[nav-selected="true"]');
  if (selected && selected.getAttribute('aria-label') === 'compose_dictate') break;
  await press('ArrowDown');
}
check(
  'the media toolbar offers dictation where the platform has speech',
  (document.querySelector('.kai-icon-button[nav-selected="true"]') || {}).getAttribute('aria-label') ===
    'compose_dictate' && window.__speech.started === 0,
  {
    selected: (document.querySelector('.kai-icon-button[nav-selected="true"]') || {}).getAttribute('aria-label'),
    speech: window.__speech,
  },
);
await press('Enter');
await flush();
check(
  'starting a dictation opens a continuous session with interim results, in the UI language',
  window.__speech.started === 1 &&
    window.__speech.continuous === true &&
    window.__speech.interimResults === true &&
    /^[a-z]{2}(-|$)/i.test(window.__speech.lang || '') &&
    text('.kai-softkey__key--right') === 'dictation_stop',
  { speech: window.__speech, right: text('.kai-softkey__key--right') },
);
check(
  'the listening line says so before a phrase lands',
  text('.kai-text--recording') === 'dictation_listening',
  text('.kai-text--recording'),
);
window.__speech.emit('and dicta', false);
await flush();
check(
  'the phrase in flight is shown rather than typed',
  text('.kai-text--recording') === 'compose_dictating(text)' &&
    document.querySelector('.kai-field__textarea').value === '',
  {
    line: text('.kai-text--recording'),
    value: document.querySelector('.kai-field__textarea').value,
  },
);
window.__speech.emit('Hello there.', true);
await flush();
check(
  'a settled phrase lands in the draft and clears the live line',
  document.querySelector('.kai-field__textarea').value === 'Hello there.' &&
    text('.kai-text--recording') === 'dictation_listening',
  {
    value: document.querySelector('.kai-field__textarea').value,
    line: text('.kai-text--recording'),
  },
);
window.__speech.emit('Again.', true);
await flush();
check(
  'the next phrase is appended to what is already written',
  document.querySelector('.kai-field__textarea').value === 'Hello there. Again.',
  document.querySelector('.kai-field__textarea').value,
);
// The field has to grow for a value it was not typed into: the platform fires
// `input` only for keystrokes, and the view scrolls instead of the box, so a
// clipped draft would be unreachable.
check(
  'a dictated draft grows the field, not an inner scrollbar',
  document.querySelector('.kai-field__textarea').style.height ===
    document.querySelector('.kai-field__textarea').value.length * 12 + 'px',
  document.querySelector('.kai-field__textarea').style.height,
);
await press('SoftRight');
await until(() => text('.kai-softkey__key--right') === 'compose_post');
check(
  'the right key ends the dictation and the Post key comes back',
  window.__speech.stopped === 1 &&
    text('.kai-softkey__key--right') === 'compose_post' &&
    !document.querySelector('.kai-text--recording'),
  { speech: window.__speech, right: text('.kai-softkey__key--right') },
);
// Leaving with a session still open releases it: the backend holds the
// microphone until something ends it, and an unmounted screen cannot.
await press('Enter');
await flush();
const dictatedField = document.querySelector('.kai-field__textarea');
dictatedField.value = '';
dictatedField.dispatchEvent(new window.Event('input', { bubbles: true }));
await flush();
await press('Backspace');
await until(() => text('.kai-header__title') === 'nav_explore');
check(
  'leaving the composer mid-dictation ends the session',
  window.__speech.started === 2 && window.__speech.aborted === 1,
  window.__speech,
);
await press('Backspace');
await until(() => text('.kai-header__title') === 'app_title');

/* --- Chat: room list, thread, send -------------------------------------- */

// The dashboard's second row is Chat; enter it while signed in.
await press('ArrowDown');
await press('Enter');
await until(() => text('.kai-header__title') === 'nav_chat');
await until(() => all('.kai-list-item').length === 2);
check(
  'the chat screen lists the rooms with unread and last-message previews',
  texts('.kai-list-item__primary').join('|') === 'SN Notes|QRB' &&
    texts('.kai-chat-row__unread').join('|') === 'chat_unread(n)' &&
    texts('.kai-chat-row__preview').join('|') ===
      'iCat: New build is up!|QRB: chat_attachment' &&
    text('.kai-header__title') === 'nav_chat',
  {
    primary: texts('.kai-list-item__primary'),
    unread: texts('.kai-chat-row__unread'),
    preview: texts('.kai-chat-row__preview'),
    title: text('.kai-header__title'),
  },
);
// The unread count is a badge, not body text: its own element beside the
// preview, shaped as a capsule. (The fill itself is a palette token, which
// jsdom does not resolve — the browser check reads the rendered colour.)
check(
  'the unread count is a capsule of its own, beside the preview not in it',
  (() => {
    const pill = document.querySelector('.kai-chat-row__unread');
    if (!pill) return false;
    const style = window.getComputedStyle(pill);
    return (
      pill.parentElement.className.indexOf('kai-list-item__secondary') !== -1 &&
      pill.nextElementSibling.className.indexOf('kai-chat-row__preview') !== -1 &&
      pill.textContent.trim() === 'chat_unread(n)' &&
      style.borderRadius !== '0px' &&
      style.borderRadius !== '0rem' &&
      style.whiteSpace === 'nowrap' &&
      document.querySelectorAll('.kai-chat-row__unread').length === 1
    );
  })(),
  (() => {
    const pill = document.querySelector('.kai-chat-row__unread');
    if (!pill) return null;
    const style = window.getComputedStyle(pill);
    return {
      text: pill.textContent.trim(),
      next: pill.nextElementSibling ? pill.nextElementSibling.className : null,
      radius: style.borderRadius,
      nowrap: style.whiteSpace,
    };
  })(),
);
// A room with no picture is lettered from its title, so the row keeps the
// same left edge as one that has a picture.
check(
  'a room with no picture is lettered into an avatar circle',
  (() => {
    const rows = all('.kai-list-item');
    const picture = rows[0].querySelector('.kai-avatar');
    const circle = rows[1].querySelector('.kai-avatar--letter');
    return (
      picture.tagName === 'IMG' &&
      Boolean(circle) &&
      circle.tagName === 'SPAN' &&
      circle.textContent.trim() === 'QR' &&
      rows[1].className.indexOf('kai-list-item--thumb') !== -1
    );
  })(),
  (() => {
    const circle = all('.kai-list-item')[1].querySelector('.kai-avatar');
    return circle
      ? { tag: circle.tagName, text: circle.textContent.trim(), className: circle.className }
      : null;
  })(),
);
check(
  'the room list renders whole — the server pages are walked behind it',
  !document.querySelector('.kai-pager') &&
    requests.filter((request) => request.url.indexOf('/messager/chat?') !== -1).length === 1 &&
    requests.filter((request) => request.url.indexOf('/messager/chat?') !== -1)[0].url.indexOf('take=100') !== -1,
  {
    pager: Boolean(document.querySelector('.kai-pager')),
    roomRequests: requests
      .filter((request) => request.url.indexOf('/messager/chat?') !== -1)
      .map((request) => request.url),
  },
);
check(
  'the group row leads with the room avatar',
  (() => {
    const img = document.querySelector('.kai-list-item--thumb .kai-avatar');
    return Boolean(img) && img.getAttribute('src') === 'https://api.solian.app/drive/files/room-pic-1?preset=thumb';
  })(),
  (() => {
    const img = document.querySelector('.kai-list-item--thumb .kai-avatar');
    return img ? img.getAttribute('src') : null;
  })(),
);
// The preview is one line, clipped: a long last message must not grow the row.
// The pill rides outside the clip, so the count is never the part cut off.
check(
  'a room row previews the last message on one clipped line',
  (() => {
    const preview = document.querySelector('.kai-chat-row__preview');
    if (!preview) return false;
    const style = window.getComputedStyle(preview);
    const secondary = preview.parentElement;
    return (
      style.whiteSpace === 'nowrap' &&
      style.overflow === 'hidden' &&
      style.textOverflow === 'ellipsis' &&
      secondary.className.indexOf('kai-list-item__secondary') !== -1 &&
      window.getComputedStyle(secondary).display === 'flex'
    );
  })(),
  (() => {
    const preview = document.querySelector('.kai-chat-row__preview');
    if (!preview) return null;
    const style = window.getComputedStyle(preview);
    return {
      whiteSpace: style.whiteSpace,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      secondaryDisplay: window.getComputedStyle(preview.parentElement).display,
    };
  })(),
);

// The left key is the write path, as on Explore: it opens the chat menu.
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-option-menu')));
check(
  'the chat list left key opens the room-feature menu',
  texts('.kai-option-menu__item').join('|') ===
    'chat_new_message|chat_invites_count(n)|chat_filter|chat_search|chat_read_all',
  texts('.kai-option-menu__item'),
);
await press('Backspace');
await flush();

// Filter: the watch's own scope tabs.
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-option-menu')));
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => texts('.kai-option-menu__item').join('|') === 'chat_tab_all|chat_tab_direct|chat_tab_groups');
check(
  'the filter entry opens the all/direct/groups scope',
  text('.kai-option-menu__header') === 'chat_filter',
  { header: text('.kai-option-menu__header'), items: texts('.kai-option-menu__item') },
);
await press('ArrowDown');
await press('Enter');
await until(() => document.querySelectorAll('.kai-list-item').length === 1);
check(
  'choosing Direct narrows the list to direct rooms',
  texts('.kai-list-item__primary').join('|') === 'QRB' &&
    text('.kai-header__title') === 'chat_tab_direct',
  { rows: texts('.kai-list-item__primary'), title: text('.kai-header__title') },
);
check(
  'a filter with no matches says so instead of looking empty',
  text('.kai-content') !== '' && !document.querySelector('.kai-text--secondary'),
  text('.kai-content'),
);
// Back to every room.
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-option-menu')));
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => texts('.kai-option-menu__item').join('|') === 'chat_tab_all|chat_tab_direct|chat_tab_groups');
await press('Enter');
await until(() => document.querySelectorAll('.kai-list-item').length === 2);
check(
  'All restores every room',
  texts('.kai-list-item__primary').join('|') === 'SN Notes|QRB',
  texts('.kai-list-item__primary'),
);

// Mark all read: the one bulk HTTP read path.
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-option-menu')));
await press('ArrowDown');
await press('ArrowDown');
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() =>
  requests.some((request) => request.url.indexOf('/messager/chat/read-all') !== -1),
);
const readAllRequest = requests.filter(
  (request) => request.url.indexOf('/messager/chat/read-all') !== -1,
)[0];
await until(() => !document.querySelector('.kai-chat-row__unread'));
check(
  'Mark all as read POSTs once and clears every unread badge',
  Boolean(readAllRequest) &&
    readAllRequest.method === 'POST' &&
    readAllRequest.requestHeaders.Authorization === 'Bearer test-access' &&
    !document.querySelector('.kai-chat-row__unread') &&
    texts('.kai-chat-row__preview').join('|') === 'iCat: New build is up!|QRB: chat_attachment',
  {
    method: readAllRequest ? readAllRequest.method : null,
    pills: document.querySelectorAll('.kai-chat-row__unread').length,
    preview: texts('.kai-chat-row__preview'),
  },
);

// New message: account search, then the one-to-one room opens.
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-option-menu')));
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-field__input--line')));
check(
  'New message opens an account search whose field starts highlighted',
  text('.kai-header__title') === 'chat_new_message' &&
    document.activeElement === document.querySelector('.kai-field__input--line'),
  { title: text('.kai-header__title'), focused: document.activeElement?.className ?? null },
);
const accountField = document.querySelector('.kai-field__input--line');
accountField.value = 'solsynth';
accountField.dispatchEvent(new window.Event('input', { bubbles: true }));
await flush();
await press('Enter');
await until(() => text('.kai-list-item__primary') === 'Solsynth');
check(
  'searching accounts lists the match with its handle',
  texts('.kai-list-item__primary').join('|') === 'Solsynth' &&
    texts('.kai-list-item__secondary').join('|') === '@solsynth' &&
    window.__requests.some(
      (request) =>
        request.url.indexOf('/stargate/accounts/search') !== -1 &&
        request.url.indexOf('query=solsynth') !== -1,
    ),
  {
    rows: texts('.kai-list-item__primary'),
    handles: texts('.kai-list-item__secondary'),
  },
);
await press('ArrowDown');
await press('Enter');
await until(() => text('.kai-header__title') === 'QRB' || text('.kai-header__title') === 'Solsynth');
const directPost = requests.filter(
  (request) => request.method === 'POST' && request.url.indexOf('/messager/chat/direct') !== -1,
)[0];
check(
  'picking an account creates the direct room and opens its thread',
  Boolean(directPost) &&
    directPost.requestBody.indexOf('related_user_id') !== -1 &&
    text('.kai-header__title') === 'Solsynth',
  {
    body: directPost ? directPost.requestBody : null,
    title: text('.kai-header__title'),
  },
);
await press('Backspace');
await until(() => text('.kai-header__title') === 'chat_new_message');
await press('Backspace');
await until(() => text('.kai-header__title') === 'nav_chat');

// Invites: accept with the right key, acting on the highlighted row.
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-option-menu')));
await press('ArrowDown');
await press('Enter');
await until(() => text('.kai-header__title') === 'chat_invites');
await until(() => document.querySelectorAll('.kai-list-item').length === 1);
check(
  'Invites lists the pending room with accept/decline on the softkeys',
  texts('.kai-list-item__primary').join('|') === 'Design Crew' &&
    text('.kai-softkey__key--left') === 'chat_decline' &&
    text('.kai-softkey__key--right') === 'chat_accept',
  {
    rows: texts('.kai-list-item__primary'),
    left: text('.kai-softkey__key--left'),
    right: text('.kai-softkey__key--right'),
  },
);
check(
  'a group without a picture is lettered rather than given a member face',
  (() => {
    const row = document.querySelector('.kai-list-item');
    const avatar = row.querySelector('.kai-avatar');
    return (
      Boolean(avatar) &&
      avatar.tagName === 'SPAN' &&
      avatar.textContent.trim() === 'DC'
    );
  })(),
  (() => {
    const avatar = document.querySelector('.kai-list-item .kai-avatar');
    return avatar
      ? { tag: avatar.tagName, text: avatar.textContent.trim(), className: avatar.className }
      : null;
  })(),
);
await press('SoftRight');
await until(() => window.__acceptedInvites === 1);
await until(() => text('.kai-header__title') === 'nav_chat');
check(
  'accepting an invite POSTs the accept and returns to the room list',
  window.__acceptedInvites === 1 && text('.kai-header__title') === 'nav_chat',
  { accepted: window.__acceptedInvites, title: text('.kai-header__title') },
);

// Open the group room: its thread loads cache-first and marks the room read.
await until(() => document.querySelectorAll('.kai-list-item').length === 2);
await press('Enter');
await until(() => all('li.kai-chat-bubble').length === 4);
// The voice note carries no content, so it is deliberately absent here: this
// list is the text bubbles, in display order.
const bubbleTexts = () => texts('.kai-chat-bubble__content');
check(
  'the thread renders newest at the bottom, oldest first',
  bubbleTexts().join('|') === 'Morning all|Nice, thanks!|New build is up!' &&
    all('.kai-chat-bubble')[1].className.indexOf('kai-chat-bubble--own') !== -1,
  { bubbles: bubbleTexts(), own: all('.kai-chat-bubble')[1].className },
);
// Every bubble says who sent it — avatar and name, on the bubble's own side.
check(
  'every message carries its sender: the avatar and the name',
  texts('.kai-chat-bubble__sender').join('|') === 'iCat|Test User|iCat|iCat' &&
    (() => {
      const avatars = all('.kai-chat-bubble__avatar');
      return (
        avatars.length === 4 &&
        avatars[0].getAttribute('src') === 'https://api.solian.app/drive/files/cat-avatar?preset=thumb' &&
        avatars[1].getAttribute('src') === 'https://api.solian.app/drive/files/avatar-1?preset=thumb'
      );
    })(),
  {
    senders: texts('.kai-chat-bubble__sender'),
    avatars: all('.kai-chat-bubble__avatar').map((node) => node.getAttribute('src')),
  },
);
// A message's attachments render in its bubble: a picture as its thumb, a
// document as its line — the same rows a post renders.
check(
  'a message renders its attachments',
  (() => {
    const image = document.querySelector('.kai-chat-bubble .kai-attachment__image');
    const lines = texts('.kai-chat-bubble .kai-post__attach');
    return (
      Boolean(image) &&
      image.getAttribute('src') === 'https://api.solian.app/drive/files/att-inline?preset=thumb' &&
      lines.join('|') === '[post_attach_file] notes.pdf · 50 KB|[post_attach_audio] 0:07'
    );
  })(),
  {
    image: (() => {
      const node = document.querySelector('.kai-chat-bubble .kai-attachment__image');
      return node ? node.getAttribute('src') : null;
    })(),
    lines: texts('.kai-chat-bubble .kai-post__attach'),
  },
);
// Every message is a D-pad stop, so a press moves the highlight to the message
// beside it — there is no row the arrows skip over. A message the server wrote
// as a sync placeholder is not a message at all and never reaches the thread.
check(
  'every message is a D-pad stop, and a sync placeholder is not a message',
  (() => {
    const bubbles = all('.kai-chat-bubble');
    const stops = all('.kai-chat-bubble[nav-selectable="true"]');
    const selected = all('.kai-chat-bubble[nav-selected="true"]');
    return (
      // Four bubbles from a five-row page: the placeholder is dropped.
      bubbles.length === 4 &&
      stops.length === 4 &&
      selected.length === 1 &&
      // The newest message is the voice note, and it takes the highlight.
      selected[0].textContent.indexOf('[post_attach_audio]') !== -1
    );
  })(),
  all('.kai-chat-bubble').map((bubble) => ({
    selectable: bubble.getAttribute('nav-selectable'),
    selected: bubble.getAttribute('nav-selected'),
    text: bubble.textContent.replace(/\s+/g, ' ').trim().slice(0, 40),
  })),
);
// The highlight is the bubble's own border rather than an outline, which is
// what makes it follow the bubble's rounded corners — Gecko 48 draws an
// outline as a rectangle, over them. Every bubble reserves the border,
// transparent until it is the highlighted one, so the ring can never resize the
// message it lands on. jsdom resolves no custom property, so the ring's colour
// is the one thing this cannot read back; it proves the mechanism, and the
// colour is the token the stylesheet names.
check(
  'the highlight is the bubble\u2019s own border, so the ring follows its corners',
  (() => {
    const selected = document.querySelector('.kai-chat-bubble[nav-selected="true"]');
    if (!selected) return false;
    const ring = window.getComputedStyle(selected);
    return (
      ring.outlineStyle === 'none' &&
      ring.borderTopStyle === 'solid' &&
      ring.borderTopWidth === ring.borderLeftWidth &&
      ring.borderTopWidth === ring.borderRightWidth &&
      ring.borderTopWidth === ring.borderBottomWidth &&
      all('.kai-chat-bubble').every((bubble) => {
        const style = window.getComputedStyle(bubble);
        return style.borderTopStyle === 'solid' && style.borderTopWidth === ring.borderTopWidth;
      }) &&
      all('.kai-chat-bubble:not([nav-selected="true"])').every(
        (bubble) => window.getComputedStyle(bubble).borderTopColor === 'rgba(0, 0, 0, 0)',
      )
    );
  })(),
  (() => {
    const selected = document.querySelector('.kai-chat-bubble[nav-selected="true"]');
    if (!selected) return null;
    const ring = window.getComputedStyle(selected);
    return {
      outline: ring.outlineStyle,
      ring: [
        ring.borderTopWidth,
        ring.borderTopStyle,
        ring.borderTopColor,
      ],
      unselected: all('.kai-chat-bubble:not([nav-selected="true"])').map(
        (bubble) => window.getComputedStyle(bubble).borderTopColor,
      ),
    };
  })(),
);
// The page the server answered carried five rows; four bubbles are on screen.
const groupPageRows = () => {
  const page = requests
    .filter((request) => request.url.indexOf('/messager/chat/room-group/messages') !== -1)
    .slice(-1)[0];
  if (!page) return null;
  return typeof page.response === 'string' ? JSON.parse(page.response) : page.response;
};
check(
  'a sync placeholder never reaches the thread',
  (() => {
    const rows = groupPageRows();
    return (
      Boolean(rows) &&
      rows.length === 8 &&
      rows.some((row) => row.type === 'placeholder') &&
      all('li.kai-chat-bubble').length === 4
    );
  })(),
  {
    rows: (groupPageRows() || []).map((row) => row.type),
    bubbles: all('li.kai-chat-bubble').length,
  },
);
// A call is not a message either: `call.start`, `system.call.member.joined`
// and the marker an edit leaves behind (`messages.update`) are the room's own
// events, which Solian hides at its `none` event level — the level this thread
// takes. Each of these rows carries content, so the type rule is the only
// thing keeping them out; and none of them is text the conversation wrote.
check(
  'the server\u2019s call and event rows are not messages, whatever they carry',
  (() => {
    const rows = groupPageRows() || [];
    const eventTypes = ['system.call.member.joined', 'call.start', 'messages.update'];
    const present = eventTypes.every((type) => rows.some((row) => row.type === type));
    const spoken = all('.kai-chat-bubble').map((bubble) => bubble.textContent).join('\n');
    const leaked = eventTypes.filter((type) => {
      const row = rows.filter((item) => item.type === type)[0];
      return Boolean(row && row.content && spoken.indexOf(row.content) !== -1);
    });
    return present && leaked.length === 0 && all('li.kai-chat-bubble').length === 4;
  })(),
  {
    rows: (groupPageRows() || []).map((row) => row.type),
    bubbles: all('li.kai-chat-bubble').map((bubble) =>
      bubble.textContent.replace(/\s+/g, ' ').trim().slice(0, 40),
    ),
  },
);
// The room's whole history is on screen, so there is nothing older to offer:
// no Load more row sits above the thread.
check(
  'a thread whose history is exhausted carries no Load more row',
  !document.querySelector('.kai-content > ul.kai-list--flat'),
  { loadMore: Boolean(document.querySelector('.kai-content > ul.kai-list--flat')) },
);

// Enter opens the voice note in the viewer, which plays it: the media is not an
// attachment row, so the app turns `meta.voice_url` into one — resolved against
// the API base, since the wire may send it server-relative.
await press('Enter');
await until(() => text('.kai-header__title') === 'post_title' || Boolean(document.querySelector('.kai-lightbox')));
await until(() => Boolean(document.querySelector('.kai-lightbox__audio')));
check(
  'a voice note opens in the viewer as playable audio',
  (() => {
    const audio = document.querySelector('.kai-lightbox__audio');
    return (
      Boolean(audio) &&
      audio.tagName === 'AUDIO' &&
      audio.getAttribute('src') === 'https://api.solian.app/messager/chat/voice/clip-1.ogg' &&
      text('.kai-softkey__key--center') === 'lightbox_play' &&
      // Nothing else is drawn, and a set of one carries no count.
      !document.querySelector('.kai-lightbox__hint') &&
      !document.querySelector('.kai-lightbox__counter') &&
      // The row says what it is: kind and length.
      text('.kai-lightbox__line').indexOf('[post_attach_audio] 0:07') !== -1
    );
  })(),
  {
    src: (() => {
      const audio = document.querySelector('.kai-lightbox__audio');
      return audio ? audio.getAttribute('src') : null;
    })(),
    center: text('.kai-softkey__key--center'),
    counter: text('.kai-lightbox__counter'),
    line: text('.kai-lightbox__line'),
  },
);
// The centre key drives it: our own state flips, and the element is asked to
// play (jsdom has no media pipeline, so the app tracks the state itself).
await press('Enter');
await flush();
check(
  'the centre key plays the voice note',
  text('.kai-softkey__key--center') === 'lightbox_pause',
  { center: text('.kai-softkey__key--center') },
);
await press('Enter');
await flush();
check(
  'the centre key pauses it again',
  text('.kai-softkey__key--center') === 'lightbox_play',
  text('.kai-softkey__key--center'),
);
// LEFT/RIGHT only walk a media set, and a voice note is a set of one — so it
// stays put rather than sliding into the next message's media.
await press('ArrowRight');
await flush();
check(
  'a one-item viewer stays on its item',
  Boolean(document.querySelector('.kai-lightbox__audio')) &&
    !document.querySelector('.kai-lightbox__media') &&
    // A lone attachment is not a set, so it carries no count.
    !document.querySelector('.kai-lightbox__counter'),
  { counter: text('.kai-lightbox__counter') },
);
await press('Backspace');
await until(() => Boolean(document.querySelector('.kai-chat')));

// The highlight comes back to the same stop — the newest message, the voice
// note — and every press moves one message: up to the message above it, and
// back down. The thread's display runs oldest to newest downwards, so UP walks
// towards the older messages and DOWN towards the newer.
await until(() => {
  const selected = document.querySelector('.kai-chat-bubble[nav-selected="true"]');
  return Boolean(selected) && selected.textContent.indexOf('post_attach_audio') !== -1;
});
const selectedText = () => {
  const selected = document.querySelector('.kai-chat-bubble[nav-selected="true"]');
  return selected ? selected.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) : null;
};
await press('ArrowUp');
await flush();
check(
  'UP moves one message, to the one above the highlight',
  (() => {
    const selected = document.querySelector('.kai-chat-bubble[nav-selected="true"]');
    return Boolean(selected) && selected.textContent.indexOf('New build is up!') !== -1;
  })(),
  selectedText(),
);
await press('ArrowUp');
await flush();
check(
  'UP again moves one more message, not two',
  (() => {
    const selected = document.querySelector('.kai-chat-bubble[nav-selected="true"]');
    return Boolean(selected) && selected.textContent.indexOf('notes.pdf') !== -1;
  })(),
  selectedText(),
);
await press('ArrowDown');
await flush();
check(
  'DOWN moves one message back',
  (() => {
    const selected = document.querySelector('.kai-chat-bubble[nav-selected="true"]');
    return Boolean(selected) && selected.textContent.indexOf('New build is up!') !== -1;
  })(),
  selectedText(),
);
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-lightbox__media')));
check(
  "a message's picture opens in the same viewer",
  document.querySelector('.kai-lightbox__media').getAttribute('src') ===
    'https://api.solian.app/drive/files/att-inline?original=1' &&
    !document.querySelector('.kai-lightbox__hint') &&
    text('.kai-softkey__key--center') === '',
  {
    media: document.querySelector('.kai-lightbox__media').getAttribute('src'),
    counter: text('.kai-lightbox__counter'),
  },
);
await press('Backspace');
await until(() => Boolean(document.querySelector('.kai-chat')));

// Opening a room subscribes it and claims it read; there is no HTTP route for
// either — both are gateway packets (the SDK's `/rooms/{id}/read` 404s).
await until(() => window.__wsFrames.some((frame) => frame.type === 'messages.read'));
const wsFrames = window.__wsFrames;
check(
  'opening a room subscribes it and sends the read receipt over the socket',
  window.__wsSockets.length === 1 &&
    window.__wsSockets[0].url.indexOf('/ws?namespace=dev.solsynth.solian') !== -1 &&
    window.__wsSockets[0].url.indexOf('tk=test-access') !== -1 &&
    wsFrames.some(
      (frame) =>
        frame.type === 'messages.subscribe' &&
        frame.data &&
        frame.data.chat_room_id === 'room-group',
    ) &&
    wsFrames.some(
      (frame) => frame.type === 'messages.read' && frame.data && frame.data.chat_room_id === 'room-group',
    ),
  { url: window.__wsSockets[0] ? window.__wsSockets[0].url : null, frames: wsFrames },
);
// A live message for the open room merges into the thread.
window.__wsPush({
  type: 'messages.new',
  data: {
    id: 'msg-live',
    chat_room_id: 'room-group',
    type: 'text',
    content: 'live message',
    sender_id: 'acc-2',
    sender: {
      id: 'm-peer',
      chat_room_id: 'room-group',
      account_id: 'acc-2',
      account: { id: 'acc-2', name: 'icat', nick: 'iCat' },
      nick: null,
    },
    created_at: new Date(Date.now() + 120000).toISOString(),
    attachments: [],
  },
});
await until(() => bubbleTexts().indexOf('live message') !== -1);
check(
  'a live message arrives in the open thread without a refetch',
  bubbleTexts().indexOf('live message') !== -1,
  { bubbles: bubbleTexts() },
);

// The left key is the write path: it opens the composer as a screen of its
// own, so the field is not sharing the display with the thread.
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
check(
  'the room left key opens the composer full screen',
  text('.kai-header__title') === 'SN Notes' &&
    !document.querySelector('.kai-chat') &&
    document.activeElement === document.querySelector('.kai-field__textarea') &&
    text('.kai-softkey__key--left') === '',
  {
    title: text('.kai-header__title'),
    thread: Boolean(document.querySelector('.kai-chat')),
    focused: document.activeElement ? document.activeElement.className : null,
    left: text('.kai-softkey__key--left'),
  },
);
// The room stays subscribed while writing to it: the room screen clears the
// active room as it unmounts and the composer mounts after it, so the last
// word on this room must be a subscribe (whatever Vue's patch order is).
check(
  'the open room stays subscribed while the composer is up',
  (() => {
    const roomFrames = window.__wsFrames.filter(
      (frame) => frame.data && frame.data.chat_room_id === 'room-group',
    );
    const last = roomFrames[roomFrames.length - 1];
    return Boolean(last) && last.type === 'messages.subscribe';
  })(),
  window.__wsFrames,
);

// The composer carries the post composer's media toolbar, plus the sticker
// picker — the one attachment that is the message itself.
check(
  'the composer offers capture, gallery, dictation and sticker sources',
  all('.kai-icon-button').map((button) => button.getAttribute('aria-label')).join('|') ===
    'compose_take_photo|compose_record_video|compose_record_audio|compose_dictate|compose_add_photo|chat_stickers',
  all('.kai-icon-button').map((button) => button.getAttribute('aria-label')),
);
await press('ArrowDown');
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-compose-attachment')));
check(
  'the picked photo joins the chat draft as a removable row',
  (texts('.kai-compose-attachment .kai-list-item__primary')[0] || '').indexOf('picked-photo.jpg') !== -1 &&
    (texts('.kai-compose-attachment .kai-list-item__secondary')[0] || '').indexOf('compose_tap_to_remove') !== -1,
  texts('.kai-compose-attachment .kai-list-item__primary'),
);

// Voice: the microphone is captured in the page, not by the recorder app, and
// the take runs until it is stopped — the mic button and the right key both
// end it. The recorder stub was already installed; this asserts the app used
// it rather than the platform activity.
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-text--recording')));
check(
  'the microphone records in the app, not through the recorder activity',
  window.__media.getUserMedia === 1 &&
    window.__media.started === 1 &&
    window.__media.constraints.audio === true &&
    JSON.stringify(window.__media.constraints) === '{"audio":true}' &&
    !texts('.kai-compose-attachment .kai-list-item__primary').some(
      (name) => name.indexOf('recording.m4a') !== -1,
    ),
  {
    media: window.__media,
    attachments: texts('.kai-compose-attachment .kai-list-item__primary'),
  },
);
check(
  'the take says how long it has been running, and the right key ends it',
  (text('.kai-text--recording') || '').indexOf('chat_recording') !== -1 &&
    text('.kai-softkey__key--right') === 'chat_stop',
  { line: text('.kai-text--recording'), right: text('.kai-softkey__key--right') },
);
// The take's length is measured, not assumed, so this one has to actually run
// for a moment — a stopped-immediately take reads as nothing recorded.
await new Promise((resolve) => setTimeout(resolve, 1100));
await press('SoftRight');
await until(() => !document.querySelector('.kai-text--recording'));
await until(() => all('.kai-compose-attachment .kai-list-item__primary').length === 2);
check(
  'stopping puts the take in the draft with its length, and releases the mic',
  (texts('.kai-compose-attachment .kai-list-item__primary')[1] || '').indexOf('voice-1.ogg') !== -1 &&
    /^\d+:\d\d · /.test(texts('.kai-compose-attachment .kai-list-item__secondary')[1] || '') &&
    window.__media.trackStops === 1 &&
    !document.querySelector('.kai-text--recording'),
  {
    rows: texts('.kai-compose-attachment .kai-list-item__primary'),
    secondary: texts('.kai-compose-attachment .kai-list-item__secondary'),
    trackStops: window.__media.trackStops,
  },
);

const chatField = document.querySelector('.kai-field__textarea');
chatField.value = 'hello from the smoke test';
chatField.dispatchEvent(new window.Event('input', { bubbles: true }));
await flush();
check(
  'the Send key appears once there is text',
  text('.kai-softkey__key--right') === 'chat_send',
  text('.kai-softkey__key--right'),
);
await press('SoftRight');
// A sent message returns to the thread, where the optimistic row lands at once
// and the echo retires it (no `sending` marker left).
await until(() => text('.kai-header__title') === 'SN Notes' && all('li.kai-chat-bubble').length === 7);
await until(() => !document.querySelector('.kai-chat-bubble__state'));
const sentRequests = requests.filter(
  (request) =>
    request.method === 'POST' &&
    request.url.indexOf('/messager/chat/room-group/messages') !== -1,
);
const sentBody = sentRequests[0] ? JSON.parse(sentRequests[0].requestBody) : null;
// The upload stub hands out one id per upload; the message must carry the id
// of the file this send uploaded, not some other.
const expectedAttachmentId = 'file-upload-' + window.__uploads;
check(
  'sending uploads the files, POSTs them as attachments and returns to the thread',
  sentRequests.length === 1 &&
    sentRequests[0].requestHeaders.Authorization === 'Bearer test-access' &&
    Boolean(sentBody) &&
    sentBody.content === 'hello from the smoke test' &&
    typeof sentBody.client_message_id === 'string' &&
    sentBody.attachments_id.length === 2 &&
    sentBody.attachments_id[1] === expectedAttachmentId &&
    Boolean(document.querySelector('.kai-chat')) &&
    !document.querySelector('.kai-field__textarea') &&
    bubbleTexts().join('|') === 'Morning all|Nice, thanks!|New build is up!|live message|hello from the smoke test' &&
    all('.kai-chat-bubble')[5].className.indexOf('kai-chat-bubble--own') !== -1,
  {
    auth: sentRequests[0] ? sentRequests[0].requestHeaders.Authorization : null,
    body: sentBody,
    uploads: window.__uploads,
    bubbles: bubbleTexts(),
    own: all('.kai-chat-bubble')[5].className,
    field: Boolean(document.querySelector('.kai-field__textarea')),
  },
);
// The uploaded file comes back on the echo, so the sent bubble shows it.
check(
  'the sent message renders the attachment the echo carried',
  (() => {
    const row = all('.kai-chat-bubble')[5];
    const line = row.querySelector('.kai-post__attach');
    return Boolean(line) && line.textContent.indexOf('upload.bin') !== -1;
  })(),
  (() => {
    const line = all('.kai-chat-bubble')[5].querySelector('.kai-post__attach');
    return line ? line.textContent : null;
  })(),
);

// A lone voice take is a voice message, not an audio attachment: the send
// goes to the server's dedicated voice endpoint with the take's measured
// length, no drive upload, and the echo renders as a voice bubble.
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
await press('ArrowDown');
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-text--recording')));
await new Promise((resolve) => setTimeout(resolve, 1100));
await press('SoftRight');
await until(() => !document.querySelector('.kai-text--recording'));
await until(() => all('.kai-compose-attachment .kai-list-item__primary').length === 1);
const uploadsBeforeVoice = window.__uploads;
await press('SoftRight');
// The composer leaves when the echo lands; its header is the room's own
// title, so the return is told by the field going away, not the title.
await until(() => !document.querySelector('.kai-field__textarea'));
const voiceRequests = requests.filter(
  (request) =>
    request.method === 'POST' &&
    request.url.indexOf('/messager/chat/room-group/messages/voice') !== -1,
);
check(
  'a lone voice take sends through the voice endpoint with its measured length',
  voiceRequests.length === 1 &&
    voiceRequests[0].requestHeaders.Authorization === 'Bearer test-access' &&
    window.__voiceDuration > 0 &&
    typeof window.__voiceClientId === 'string' &&
    window.__uploads === uploadsBeforeVoice &&
    !document.querySelector('.kai-field__textarea'),
  {
    voiceDuration: window.__voiceDuration,
    voiceClientId: window.__voiceClientId,
    uploads: window.__uploads,
    field: Boolean(document.querySelector('.kai-field__textarea')),
  },
);
check(
  'the voice echo renders as a voice bubble with its duration',
  (() => {
    const bubbles = all('.kai-chat-bubble');
    const row = bubbles[bubbles.length - 1];
    const line = row ? row.querySelector('.kai-post__attach') : null;
    return Boolean(line) && line.textContent.indexOf('[post_attach_audio]') !== -1 && /\d+:\d\d/.test(line.textContent);
  })(),
  (() => {
    const bubbles = all('.kai-chat-bubble');
    const row = bubbles[bubbles.length - 1];
    const line = row ? row.querySelector('.kai-post__attach') : null;
    return line ? line.textContent : null;
  })(),
);

// A failed send leaves no half-sent row and does not leave the composer: the
// error line explains, the draft comes back, and the right key is the retry.
window.__failNextChatSend = true;
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
// Pick a second file for the failing send: a failure must put the whole draft
// back, files included — not just the text.
await press('ArrowDown');
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-compose-attachment')));
const retryField = document.querySelector('.kai-field__textarea');
retryField.value = 'retry me';
retryField.dispatchEvent(new window.Event('input', { bubbles: true }));
await flush();
await press('SoftRight');
await until(() => text('.kai-content .kai-text--error') === 'chat_send_failed');
check(
  'a failed send keeps the composer up with the draft and its file',
  text('.kai-header__title') === 'SN Notes' &&
    document.querySelector('.kai-field__textarea').value === 'retry me' &&
    all('.kai-compose-attachment').length === 1 &&
    text('.kai-content .kai-text--error') === 'chat_send_failed' &&
    text('.kai-softkey__key--right') === 'chat_send',
  {
    draft: document.querySelector('.kai-field__textarea').value,
    error: text('.kai-content .kai-text--error'),
    right: text('.kai-softkey__key--right'),
  },
);
await press('SoftRight');
await until(() => text('.kai-header__title') === 'SN Notes' && all('li.kai-chat-bubble').length === 7);
await until(() => !document.querySelector('.kai-chat-bubble__state'));
check(
  'pressing Send again retries the restored draft',
  bubbleTexts().join('|') === 'Morning all|Nice, thanks!|New build is up!|live message|hello from the smoke test|retry me',
  { bubbles: bubbleTexts() },
);

// Stickers: the picker lists the owned packs, then the pack's stickers; picking
// one sends the placeholder as the whole message and returns to the composer.
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
// Dictation in the composer writes the room's draft through the store, the same
// one the field is bound to — so a phrase lands where the sender will read it.
for (let step = 0; step < 8; step += 1) {
  const selected = document.querySelector('.kai-icon-button[nav-selected="true"]');
  if (selected && selected.getAttribute('aria-label') === 'compose_dictate') break;
  await press('ArrowDown');
}
await press('Enter');
await flush();
window.__speech.emit('chat dictation', true);
await flush();
check(
  'a dictated phrase lands in the room draft',
  document.querySelector('.kai-field__textarea').value === 'chat dictation',
  document.querySelector('.kai-field__textarea').value,
);
// A refused microphone is worth saying out loud — and it must leave nothing
// listening behind, so the tool and the right key both go back to idle.
window.__speech.fail('not-allowed');
await flush();
check(
  'a refused microphone is reported and the tool goes back to idle',
  text('.kai-content .kai-text--error') === 'dictation_denied' &&
    (document.querySelector('.kai-icon-button[nav-selected="true"]') || {}).getAttribute('aria-label') ===
      'compose_dictate' &&
    text('.kai-softkey__key--right') === 'chat_send' &&
    !document.querySelector('.kai-text--recording'),
  {
    error: text('.kai-content .kai-text--error'),
    right: text('.kai-softkey__key--right'),
  },
);
// Clear the dictated text again: the composer is left empty for the visits
// below, and Back only leaves the screen from an empty field.
const dictatedChatField = document.querySelector('.kai-field__textarea');
dictatedChatField.value = '';
dictatedChatField.dispatchEvent(new window.Event('input', { bubbles: true }));
await flush();
// Walk the toolbar to the sticker source rather than counting presses from the
// field: the row is whatever tools this device can offer.
for (let step = 0; step < 8; step += 1) {
  const selected = document.querySelector('.kai-icon-button[nav-selected="true"]');
  if (selected && selected.getAttribute('aria-label') === 'chat_stickers') break;
  await press('ArrowDown');
}
check(
  'the toolbar walks to the sticker source',
  (document.querySelector('.kai-icon-button[nav-selected="true"]') || {}).getAttribute('aria-label') ===
    'chat_stickers',
  all('.kai-icon-button').map((button) => button.getAttribute('aria-label')),
);
await press('Enter');
await until(() => text('.kai-header__title') === 'chat_stickers');
await until(() => document.querySelectorAll('.kai-list-item').length === 1);
check(
  'the sticker picker lists the owned packs with their count',
  texts('.kai-list-item__primary').join('|') === 'Sky' &&
    texts('.kai-list-item__secondary').join('|') === 'chat_sticker_count(n)' &&
    window.__requests.some((request) => request.url.indexOf('/sphere/stickers/me') !== -1),
  {
    packs: texts('.kai-list-item__primary'),
    counts: texts('.kai-list-item__secondary'),
  },
);
await press('Enter');
await until(() => text('.kai-header__title') === 'Sky');
await until(() => document.querySelectorAll('.kai-list-item').length === 2);
check(
  'opening a pack lists its stickers, named by the placeholder they send',
  texts('.kai-list-item__primary').join('|') === 'wave|cool' &&
    texts('.kai-list-item__secondary').join('|') === ':sky+wave:|:sky+cool:' &&
    (() => {
      const img = document.querySelector('.kai-list-item--thumb .kai-avatar');
      return Boolean(img) &&
        img.getAttribute('src') === 'https://api.solian.app/drive/files/sticker-img-1?preset=thumb';
    })(),
  {
    stickers: texts('.kai-list-item__primary'),
    placeholders: texts('.kai-list-item__secondary'),
  },
);
await press('Enter');
// The send closes the picker and the composer with it: the reader is on the
// thread the sticker went to, which is where the sticker renders below.
await until(() => Boolean(document.querySelector('.kai-chat')));
await until(() => Boolean(document.querySelector('.kai-chat-bubble__sticker')));
const stickerRequest = requests.filter(
  (request) =>
    request.method === 'POST' &&
    request.url.indexOf('/messager/chat/room-group/messages') !== -1 &&
    request.url.indexOf('/messages/voice') === -1 &&
    JSON.parse(request.requestBody || '{}').content === ':sky+wave:',
)[0];
check(
  'picking a sticker sends it and lands on the thread, not back in the composer',
  Boolean(stickerRequest) &&
    stickerRequest.requestHeaders.Authorization === 'Bearer test-access' &&
    JSON.stringify(JSON.parse(stickerRequest.requestBody).attachments_id) === '[]' &&
    text('.kai-header__title') === 'SN Notes' &&
    Boolean(document.querySelector('.kai-chat')) &&
    !document.querySelector('.kai-field__textarea'),
  {
    body: stickerRequest ? stickerRequest.requestBody : null,
    title: text('.kai-header__title'),
    composer: Boolean(document.querySelector('.kai-field__textarea')),
  },
);
// The thread renders it as the sticker: the placeholder resolves to the
// sticker's image, loaded through the usual thumb preset.
check(
  'the sticker message renders as the sticker image, not as its placeholder',
  (() => {
    const img = document.querySelector('.kai-chat-bubble__sticker');
    return Boolean(img) &&
      img.getAttribute('src') === 'https://api.solian.app/drive/files/sticker-img-1?preset=thumb' &&
      img.getAttribute('alt') === ':sky+wave:';
  })(),
  (() => {
    const img = document.querySelector('.kai-chat-bubble__sticker');
    return img ? { src: img.getAttribute('src'), alt: img.getAttribute('alt') } : null;
  })(),
);

// Two edges of the recorder: leaving mid-take must release the microphone
// (an open track is what keeps the device's mic light on), and a device with
// no in-page media APIs keeps the platform recorder as its audio path.
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
// Three tools along from the field: photo, video, then the microphone.
await press('ArrowDown');
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-text--recording')));
const stopsBeforeLeaving = window.__media.trackStops;
await press('Backspace');
await until(() => Boolean(document.querySelector('.kai-chat')));
// The recorder hands its last chunk over a turn after `stop()`; the release
// lands with it.
await until(() => window.__media.trackStops === stopsBeforeLeaving + 1);
check(
  'leaving the composer mid-take releases the microphone and keeps nothing',
  window.__media.trackStops === stopsBeforeLeaving + 1 &&
    !document.querySelector('.kai-text--recording') &&
    !texts('.kai-compose-attachment .kai-list-item__primary').some(
      (name) => name.indexOf('voice-2') !== -1,
    ),
  {
    trackStops: window.__media.trackStops,
    attachments: texts('.kai-compose-attachment .kai-list-item__primary'),
  },
);
// The fallback: with no in-page media APIs the recorder activity answers, the
// same path every other media source uses.
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
const savedMediaDevices = window.navigator.mediaDevices;
const savedMediaRecorder = window.MediaRecorder;
delete window.navigator.mediaDevices;
delete window.MediaRecorder;
await press('ArrowDown');
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() =>
  texts('.kai-compose-attachment .kai-list-item__primary').some(
    (name) => name.indexOf('recording.m4a') !== -1,
  ),
);
check(
  'without the media APIs the platform recorder is still the audio path',
  texts('.kai-compose-attachment .kai-list-item__primary').some(
    (name) => name.indexOf('recording.m4a') !== -1,
  ) && !document.querySelector('.kai-text--recording'),
  { attachments: texts('.kai-compose-attachment .kai-list-item__primary') },
);
window.navigator.mediaDevices = savedMediaDevices;
window.MediaRecorder = savedMediaRecorder;
await press('Backspace');
await until(() => Boolean(document.querySelector('.kai-chat')));

// Back to the list: the newest message is a sticker, and a placeholder is not
// something to read, so the row names it instead.
await press('Backspace');
await until(() => text('.kai-header__title') === 'nav_chat');
await until(() => texts('.kai-chat-row__preview')[0] === 'Test User: chat_sticker');
check(
  'the room list names a sticker instead of printing its placeholder',
  texts('.kai-chat-row__preview')[0] === 'Test User: chat_sticker',
  { previews: texts('.kai-chat-row__preview') },
);


/* --- Chat: the highlighted message's options sheet ------------------------ */

// The right softkey carries the highlighted message's options — the same sheet
// the post screens hang off their highlighted row. The room remounts on every
// return from a pushed screen, so the highlight restarts each visit; every
// step walks it to the target row first. The matcher reads the selected
// bubble's own body — a reply quotes its target's words, so matching the whole
// bubble text would stop on the reply instead of the message being sought.
const selectedHasContent = (fragment) => {
  const selected = document.querySelector('.kai-chat-bubble[nav-selected="true"]');
  const content = selected ? selected.querySelector('.kai-chat-bubble__content') : null;
  return Boolean(content) && content.textContent.indexOf(fragment) !== -1;
};
const walkToMessage = async (fragment) => {
  let guard = 0;
  while (!selectedHasContent(fragment) && guard < 14) {
    await press('ArrowUp');
    guard += 1;
  }
  return selectedHasContent(fragment);
};
const openSheet = () => {
  document.querySelector('.kai-softkey__key--right').click();
};

// Reopen the group room (the list's first row) for the message actions.
await press('Enter');
await until(() => all('li.kai-chat-bubble').length > 0);

// The account's own server row ("Nice, thanks!", sent by the test user) offers
// the full action set.
await walkToMessage('Nice, thanks!');
check(
  'the highlight walks to the account\'s own message',
  selectedHasContent('Nice, thanks!') &&
    text('.kai-softkey__key--right') === 'action_options',
  { right: text('.kai-softkey__key--right') },
);
openSheet();
await until(() => Boolean(document.querySelector('.kai-option-menu')));
check(
  "the highlighted message's sheet offers reply, react, edit, delete and refresh",
  text('.kai-option-menu__header') === 'chat_options' &&
    texts('.kai-option-menu__item').join('|') ===
      'action_reply|action_react|chat_edit|chat_delete|action_reload',
  {
    header: text('.kai-option-menu__header'),
    items: texts('.kai-option-menu__item').join('|'),
  },
);
// Back closes the sheet without leaving the thread.
await press('Backspace');
await until(() => !document.querySelector('.kai-option-menu'));
check(
  'Back closes the message options without leaving the thread',
  Boolean(document.querySelector('.kai-chat')) && !document.querySelector('.kai-option-menu'),
  { menu: Boolean(document.querySelector('.kai-option-menu')) },
);

// Reply opens the composer anchored on the message; the send carries
// replied_message_id and the sent bubble quotes what it answers.
await walkToMessage('Nice, thanks!');
openSheet();
await until(() => Boolean(document.querySelector('.kai-option-menu')));
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
check(
  'Reply opens the composer naming the message it answers',
  text('.kai-content .kai-text--secondary') === 'chat_reply_to(name)',
  text('.kai-content .kai-text--secondary'),
);
const replyField = document.querySelector('.kai-field__textarea');
replyField.value = 'A reply';
replyField.dispatchEvent(new window.Event('input', { bubbles: true }));
await flush();
await press('SoftRight');
await until(() => text('.kai-header__title') === 'SN Notes');
await until(() => Boolean(document.querySelector('.kai-chat-bubble__quote')));
const replyRequest = requests
  .filter(
    (request) =>
      request.method === 'POST' &&
      request.url.indexOf('/messager/chat/room-group/messages') !== -1,
  )
  .slice(-1)[0];
check(
  'a reply sends with replied_message_id and quotes the message',
  Boolean(replyRequest) &&
    JSON.parse(replyRequest.requestBody).replied_message_id === 'msg-2' &&
    text('.kai-chat-bubble__quote-sender') === 'Test User' &&
    text('.kai-chat-bubble__quote-text') === 'Nice, thanks!',
  {
    body: replyRequest ? JSON.parse(replyRequest.requestBody) : null,
    quote: text('.kai-chat-bubble__quote'),
  },
);

// React runs from the sheet: the picker takes the message's own reactions,
// posts to the message endpoint, and the store updates the bubble's pills.
await walkToMessage('Nice, thanks!');
openSheet();
await until(() => Boolean(document.querySelector('.kai-option-menu')));
await press('ArrowDown');
await press('Enter');
await until(() => text('.kai-header__title') === 'action_react');
check(
  "React opens the message's reaction picker",
  text('.kai-header__title') === 'action_react',
  text('.kai-header__title'),
);
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-reaction-tile--made')));
check(
  'picking a sticker adds the reaction and marks the tile made',
  window.__reactionPosts === 1 && Boolean(document.querySelector('.kai-reaction-tile--made')),
  { posts: window.__reactionPosts, made: Boolean(document.querySelector('.kai-reaction-tile--made')) },
);
await press('Backspace');
await until(() => !document.querySelector('.kai-reaction-grid'));
check(
  "the reacted message's bubble shows the reaction pill",
  (() => {
    const bubble = all('.kai-chat-bubble').find(
      (node) => node.textContent.indexOf('Nice, thanks!') !== -1,
    );
    return Boolean(bubble && bubble.querySelector('.kai-reaction'));
  })(),
  { pills: document.querySelectorAll('.kai-chat-bubble .kai-reaction').length },
);

// Edit opens the composer seeded with the message's text — no media toolbar,
// the message keeps the media it already has — and saving PATCHes the message.
await walkToMessage('Nice, thanks!');
openSheet();
await until(() => Boolean(document.querySelector('.kai-option-menu')));
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
check(
  "Edit opens the composer seeded with the message's text",
  document.querySelector('.kai-field__textarea').value === 'Nice, thanks!' &&
    text('.kai-content .kai-text--secondary') === 'chat_editing' &&
    !document.querySelector('.kai-compose-media'),
  {
    value: document.querySelector('.kai-field__textarea')
      ? document.querySelector('.kai-field__textarea').value
      : null,
    hint: text('.kai-content .kai-text--secondary'),
    media: Boolean(document.querySelector('.kai-compose-media')),
  },
);
const messageEditField = document.querySelector('.kai-field__textarea');
messageEditField.value = 'Thanks, now edited!';
messageEditField.dispatchEvent(new window.Event('input', { bubbles: true }));
await flush();
await press('SoftRight');
await until(() => text('.kai-header__title') === 'SN Notes');
await until(() =>
  all('.kai-chat-bubble').some((node) => node.textContent.indexOf('Thanks, now edited!') !== -1),
);
const editRequest = requests.filter(
  (request) =>
    request.method === 'PATCH' &&
    request.url.indexOf('/messager/chat/room-group/messages/msg-2') !== -1,
)[0];
check(
  'saving an edit PATCHes the message and marks the bubble edited',
  Boolean(editRequest) &&
    JSON.parse(editRequest.requestBody).content === 'Thanks, now edited!' &&
    (() => {
      const bubble = all('.kai-chat-bubble').find(
        (node) => node.textContent.indexOf('Thanks, now edited!') !== -1,
      );
      return Boolean(bubble && bubble.querySelector('.kai-chat-bubble__edited'));
    })(),
  {
    body: editRequest ? JSON.parse(editRequest.requestBody) : null,
    edited: (() => {
      const bubble = all('.kai-chat-bubble').find(
        (node) => node.textContent.indexOf('Thanks, now edited!') !== -1,
      );
      return Boolean(bubble && bubble.querySelector('.kai-chat-bubble__edited'));
    })(),
  },
);

// Delete asks once and acts on the second press; the row leaves the thread.
await walkToMessage('Thanks, now edited!');
openSheet();
await until(() => Boolean(document.querySelector('.kai-option-menu')));
await press('ArrowDown');
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
check(
  'the first delete press asks for confirmation',
  texts('.kai-option-menu__item').join('|').indexOf('chat_delete_confirm') !== -1,
  texts('.kai-option-menu__item').join('|'),
);
await press('Enter');
await until(() => !document.querySelector('.kai-option-menu'));
await until(() =>
  !all('.kai-chat-bubble').some((node) => node.textContent.indexOf('Thanks, now edited!') !== -1),
);
check(
  'the second delete press removes the message from the thread',
  window.__deletedMessages === 1 &&
    !all('.kai-chat-bubble').some((node) => node.textContent.indexOf('Thanks, now edited!') !== -1),
  { deleted: window.__deletedMessages },
);

// Back to the list for the search that follows.
await press('Backspace');
await until(() => text('.kai-header__title') === 'nav_chat');

/* --- Chat: the thread is a window on the room's history ------------------- */

// The long room is reached through chat search rather than from the list, so
// the list keeps its rows: 620 messages, which is more than the thread holds.
// Every message is named by its ordinal from the oldest end, so a test can say
// exactly which rows are on screen after any number of loads.
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-option-menu')));
const searchStep = texts('.kai-option-menu__item').indexOf('chat_search');
for (let step = 0; step < searchStep; step += 1) await press('ArrowDown');
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-field__input--line')));
const roomSearchField = document.querySelector('.kai-field__input--line');
roomSearchField.value = 'long';
roomSearchField.dispatchEvent(new window.Event('input', { bubbles: true }));
await flush();
await press('Enter');
await until(() => texts('.kai-list-item__primary').join('|') === 'Long Room');
check(
  'chat search answers with the room, and its row reads as one line',
  texts('.kai-list-item__primary').join('|') === 'Long Room' &&
    window.__requests.some(
      (request) =>
        request.url.indexOf('/messager/chat?') !== -1 && request.url.indexOf('query=long') !== -1,
    ),
  { rows: texts('.kai-list-item__primary') },
);
await press('ArrowDown');
await press('Enter');
await until(() => all('li.kai-chat-bubble').length === 50);
const longRequests = () =>
  requests.filter((request) => request.url.indexOf('/messager/chat/room-long/messages') !== -1);
const longBubbles = () => texts('.kai-chat-bubble__content');
const longFirst = () => longBubbles()[0];
const longLast = () => longBubbles()[longBubbles().length - 1];
// Page 1 is the newest page of fifty, and nothing older is fetched: the rest of
// the history is the Load more row above the oldest message.
check(
  'opening a long room loads one page of fifty, the newest of the history',
  longRequests().length === 1 &&
    longRequests()[0].url.indexOf('take=50') !== -1 &&
    longRequests()[0].url.indexOf('offset=0') !== -1 &&
    longBubbles().length === 50 &&
    longFirst() === 'L571' &&
    longLast() === 'L620' &&
    text('.kai-content > ul.kai-list--flat .kai-list-item__primary') === 'chat_load_more',
  {
    requests: longRequests().map((request) => request.url),
    rows: longBubbles().length,
    first: longFirst(),
    last: longLast(),
    loadMore: text('.kai-content > ul.kai-list--flat .kai-list-item__primary'),
  },
);
// The Load more row is a D-pad stop above the oldest message: DOWN from the
// newest message wraps onto it.
check(
  'the highlight starts on the newest message, and Load more is the row above',
  (() => {
    const selected = document.querySelector('.kai-chat-bubble[nav-selected="true"]');
    return Boolean(selected) && selected.textContent.indexOf('L620') !== -1;
  })(),
  (() => {
    const selected = document.querySelector('.kai-chat-bubble[nav-selected="true"]');
    return selected ? selected.textContent.replace(/\s+/g, ' ').trim().slice(0, 30) : null;
  })(),
);
await press('ArrowDown');
await flush();
await press('Enter');
await until(() => all('li.kai-chat-bubble').length === 100);
check(
  'Load more appends the next older page above the thread',
  longRequests().length === 2 &&
    longRequests()[1].url.indexOf('offset=50') !== -1 &&
    longBubbles().length === 100 &&
    longFirst() === 'L521' &&
    longLast() === 'L620' &&
    // The row stays where the press left it, so the reader does not lose their
    // place in the list.
    Boolean(document.querySelector('.kai-content > ul.kai-list--flat .kai-list-item[nav-selected="true"]')),
  {
    requests: longRequests().map((request) => request.url),
    rows: longBubbles().length,
    first: longFirst(),
    last: longLast(),
  },
);
// Eight more loads reach the cap exactly: 50 + 9 x 50 = 500 rows, the room's
// oldest-backed window, still with nothing dropped. Each press is followed by
// the render it causes, so a press never lands on a row whose page is still in
// flight (a second press while one loads is deliberately ignored).
for (let step = 0; step < 8; step += 1) {
  const before = longBubbles().length;
  await press('Enter');
  await until(() => longBubbles().length > before);
}
check(
  'the window fills to five hundred rows without dropping any',
  longBubbles().length === 500 && longFirst() === 'L121' && longLast() === 'L620',
  { rows: longBubbles().length, first: longFirst(), last: longLast() },
);
// The eleventh load would make 550 rows, so the newest fifty slide out of the
// view: the window follows the reader back through the history, and what left
// is in the cache (the store wrote every loaded row as it arrived).
await press('Enter');
await until(() => longFirst() === 'L71');
check(
  'past the cap, loading older messages drops the newest from the view',
  longBubbles().length === 500 && longFirst() === 'L71' && longLast() === 'L570',
  { rows: longBubbles().length, first: longFirst(), last: longLast() },
);
// And a live message slides the other way: the newest arrives, the oldest row
// on screen goes.
window.__wsPush({
  type: 'messages.new',
  data: {
    id: 'long-live',
    chat_room_id: 'room-long',
    type: 'text',
    content: 'LIVE',
    sender_id: 'acc-2',
    sender: {
      id: 'm-long-peer',
      chat_room_id: 'room-long',
      account_id: 'acc-2',
      account: { id: 'acc-2', name: 'icat', nick: 'iCat' },
      nick: null,
    },
    created_at: new Date(Date.now() + 120000).toISOString(),
    attachments: [],
  },
});
await until(() => longLast() === 'LIVE');
check(
  'a live message at the cap drops the oldest row instead of growing the thread',
  longBubbles().length === 500 && longFirst() === 'L72' && longLast() === 'LIVE',
  { rows: longBubbles().length, first: longFirst(), last: longLast() },
);
// The dropped row was one the next older page would have started at, so that
// page resumes one row earlier: the reader is not stepped over a message by the
// window moving under them. (The row the live message pushed out was the
// newest-first index 549, so the next page starts there.)
const loadMoreLabel = () =>
  text('.kai-content > ul.kai-list--flat .kai-list-item__primary');
await until(() => loadMoreLabel() === 'chat_load_more');
await press('Enter');
await until(() => longRequests().length === 12);
check(
  'the offset slides with the rows the window dropped',
  longRequests()[11].url.indexOf('offset=549') !== -1,
  { requests: longRequests().map((request) => request.url) },
);
// The next page runs off the end of the room's history, so it comes back short
// and the Load more row goes. The highlight must land on the message where the
// row was — the oldest one — not be thrown to the screen's own anchor at the
// newest message, which would scroll a reader to the bottom of the thread.
await until(() => loadMoreLabel() === 'chat_load_more');
await press('Enter');
await until(() => !document.querySelector('.kai-content > ul.kai-list--flat'));
check(
  'the last page ends the history and the highlight stays where the row was',
  !document.querySelector('.kai-content > ul.kai-list--flat') &&
    document.querySelector('.kai-chat-bubble[nav-selected="true"]') === all('li.kai-chat-bubble')[0],
  {
    loadMore: Boolean(document.querySelector('.kai-content > ul.kai-list--flat')),
    selected: (() => {
      const selected = document.querySelector('.kai-chat-bubble[nav-selected="true"]');
      return selected ? selected.textContent.replace(/\s+/g, ' ').trim().slice(0, 30) : null;
    })(),
    oldest: longFirst(),
    newest: longLast(),
  },
);
await press('Backspace');
await until(() => text('.kai-header__title') === 'chat_search');
await press('Backspace');
await until(() => text('.kai-header__title') === 'nav_chat');

await press('Backspace');
await until(() => text('.kai-header__title') === 'app_title');
await until(() => all('.kai-list-item').length === DASHBOARD_ROWS);

/* --- Notifications: the inbox ---------------------------------------------- */

// The dashboard's third row is the inbox. Signed in, it loads the account's
// own notifications.
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => text('.kai-header__title') === 'nav_notifications');
await until(() => all('.kai-notification').length === 3);
const notifRequest = requests.filter(
  (request) => request.url.indexOf('/metoer/notifications') !== -1,
)[0];
check(
  'the inbox reads the account notifications with the session token',
  Boolean(notifRequest) &&
    notifRequest.url === 'https://api.solian.app/metoer/notifications?take=20&offset=0' &&
    notifRequest.requestHeaders.Authorization === 'Bearer test-access',
  notifRequest ? { url: notifRequest.url, headers: notifRequest.requestHeaders } : null,
);
check(
  'the inbox lists what the server sent, title over time over body',
  texts('.kai-notification__title').join('|') ===
    'iCat replied to you|You received 5 stardust|New sign-in from KaiOS' &&
    texts('.kai-notification__time').join('|') === 'post_hours_ago(h)|post_days_ago(d)|post_days_ago(d)' &&
    // The body is read as text, not markup: the bold markers are stripped the
    // way a feed row's excerpt strips them.
    text('.kai-notification__detail') === 'Good point, thanks for the write-up.',
  {
    titles: texts('.kai-notification__title'),
    times: texts('.kai-notification__time'),
    detail: text('.kai-notification__detail'),
  },
);
check(
  'a row leads with the actor face when the server sent one, else its topic glyph',
  (() => {
    const rows = all('.kai-notification');
    // The reply carries `meta.pfp`, so it shows the actor; the wallet and
    // sign-in notifications carry none and fall back to the topic glyph.
    const face = rows[0].querySelector('img.kai-avatar');
    return (
      Boolean(face) &&
      (face.getAttribute('src') || '').indexOf('cat-avatar') !== -1 &&
      rows[0].querySelector('.kai-notification__glyph') === null &&
      rows[1].querySelector('.kai-notification__glyph svg') !== null &&
      rows[2].querySelector('.kai-notification__glyph svg') !== null
    );
  })(),
  all('.kai-notification').map((row) => row.innerHTML.slice(0, 60)),
);
check(
  'unread is a dot on the rows the server has not seen, and only those',
  (() => {
    const rows = all('.kai-notification');
    return (
      rows[0].querySelector('.kai-notification__unread') !== null &&
      rows[1].querySelector('.kai-notification__unread') !== null &&
      rows[2].querySelector('.kai-notification__unread') === null
    );
  })(),
  all('.kai-notification').map((row) => row.querySelector('.kai-notification__unread') !== null),
);
// One page of three is one page: the pager only appears when there is more.
check(
  'a single page of notifications draws no pager',
  document.querySelector('.kai-pager') === null,
  { pager: Boolean(document.querySelector('.kai-pager')) },
);
await until(() => text('.kai-softkey__key--right') === 'notifications_read_all');

// The centre key opens what the row points at — and the receipt goes with it.
await press('Enter');
await until(() => text('.kai-header__title') === 'post_title');
// The receipt and the post read both leave on later turns, so wait for each
// rather than racing the screen the push already drew.
await until(() => (window.__notificationReads || []).length === 1);
await until(() => requests.some((request) => request.url.indexOf('/sphere/posts/' + FEED_POST_ID) !== -1));
check(
  "opening a notification opens the post it names, and marks it read",
  text('.kai-header__title') === 'post_title' &&
    (window.__notificationReads || []).join('|') === 'notif-1' &&
    requests.some((request) => request.url.indexOf('/sphere/posts/' + FEED_POST_ID) !== -1),
  {
    header: text('.kai-header__title'),
    reads: window.__notificationReads,
  },
);

await press('Backspace');
await until(() => all('.kai-notification').length === 3);
check(
  "the row's dot clears once it has been opened",
  all('.kai-notification')[0].querySelector('.kai-notification__unread') === null,
  all('.kai-notification').map((row) => row.querySelector('.kai-notification__unread') !== null),
);

// The right key takes the whole page as read in one call.
await until(() => text('.kai-softkey__key--right') === 'notifications_read_all');
await press('SoftRight');
await until(() => window.__notificationsReadAll === 1);
check(
  'the bulk read takes every unread row in one call',
  window.__notificationsReadAll === 1 &&
    all('.kai-notification').every((row) => row.querySelector('.kai-notification__unread') === null),
  {
    calls: window.__notificationsReadAll,
    unread: all('.kai-notification').map((row) => row.querySelector('.kai-notification__unread') !== null),
  },
);
check(
  'the right key goes inert once nothing is unread',
  text('.kai-softkey__key--right') === '',
  text('.kai-softkey__key--right'),
);

await press('Backspace');
await until(() => text('.kai-header__title') === 'app_title');
await until(() => all('.kai-list-item').length === DASHBOARD_ROWS);

// Sign out: revoke the server session, then the local one.
await press('ArrowDown');
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => text('.kai-header__title') === 'nav_account');
await press('ArrowDown');
await press('Enter');
await until(() => texts('.kai-list-item__primary').join('|') === 'account_sign_in');
const revokeRequest = requests.filter(
  (request) => request.url.indexOf('/stargate/sessions/current') !== -1,
)[0];
check(
  'signing out revokes the server session',
  Boolean(revokeRequest) &&
    revokeRequest.method === 'DELETE' &&
    revokeRequest.requestHeaders.Authorization === 'Bearer test-access',
  revokeRequest ? { method: revokeRequest.method, headers: revokeRequest.requestHeaders } : null,
);
check(
  'signing out returns to the sign-in prompt',
  text('.kai-content > .kai-text') === 'account_sign_in_intro' &&
    texts('.kai-list-item__primary').join('|') === 'account_sign_in',
  { intro: text('.kai-content > .kai-text'), rows: texts('.kai-list-item__primary') },
);
await press('Backspace');
await until(() => text('.kai-header__title') === 'app_title');

/* --- Notifications: signed out --------------------------------------------- */

// The inbox is the session's own, so signed out it explains and offers the
// sign-in screen rather than reading anything.
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => text('.kai-header__title') === 'nav_notifications');
check(
  'the inbox offers sign-in when signed out',
  text('.kai-content > .kai-text') === 'notifications_sign_in_intro' &&
    texts('.kai-list-item__primary').join('|') === 'account_sign_in' &&
    all('.kai-notification').length === 0 &&
    text('.kai-softkey__key--right') === '',
  {
    intro: text('.kai-content > .kai-text'),
    rows: texts('.kai-list-item__primary'),
  },
);
await press('Backspace');
await until(() => text('.kai-header__title') === 'app_title');
await until(() => all('.kai-list-item').length === DASHBOARD_ROWS);

const backEvent = await press('Backspace');
check('Back at the top level is left to the platform', backEvent.defaultPrevented === false);

// ---- Relaunch with a stored session -----------------------------------------
// A fresh page with a stored session must render the cached identity at once
// (optimistic) and re-fetch the profile in the background — so a display name
// or banner changed on another device shows up on the next launch. jsdom's
// localStorage throws on file: origins, so the relaunch document gets an http
// origin; the rebased script URLs are absolute file:// paths, so they still
// load from dist/.
const SEED = {
  accessToken: 'test-access',
  refreshToken: 'test-refresh',
  expiresAt: Date.now() + 600000,
  account: {
    id: 'acc-1',
    name: 'testuser',
    nick: 'Cached Nick',
    display: 'Cached Nick',
    profile: { background: { id: 'banner-1' }, picture: { id: 'avatar-1' } },
  },
};
const relaunchHtml = html
  .replace(/(src|href)="\.\//g, `$1="${distUrl}`)
  .replace(
    '<head>',
    `<head><script>window.localStorage.setItem('sokai.session', ${JSON.stringify(JSON.stringify(SEED))});</script>`,
  );
const relaunch = new JSDOM(relaunchHtml, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  url: 'http://sokai.test/index.html',
});
const rw = relaunch.window;
if (rw.document.readyState !== 'complete') {
  await new Promise((resolve) => rw.addEventListener('load', resolve, { once: true }));
}
await new Promise((resolve) => setTimeout(resolve, 50));

const rRequests = rw.__requests;
const rdoc = rw.document;
const rtext = (selector) => {
  const node = rdoc.querySelector(selector);
  return node ? node.textContent.trim() : '';
};
const rflush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function runtil(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return true;
    await rflush();
  }
  return false;
}
async function rpress(key) {
  const event = new rw.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  rdoc.dispatchEvent(event);
  await rflush();
  return event;
}
/** For work paced by the canned /me delay (a real timer `rflush` cannot reach). */
async function runtilTimer(predicate, budgetMs = 8000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

// The stored identity renders without waiting for the network…
await runtil(() => rtext('.kai-header__title') === 'app_title');
await rpress('ArrowDown');
await rpress('ArrowDown');
await rpress('ArrowDown');
await rpress('Enter');
await runtil(() => rtext('.kai-header__title') === 'nav_account');
check(
  'a restored session shows the cached identity immediately',
  (() => {
    const pfp = rdoc.querySelector('.kai-account__pfp');
    return (
      rtext('.kai-account__name') === 'Cached Nick' &&
      rtext('.kai-account__handle') === '@testuser' &&
      Boolean(pfp) &&
      pfp.getAttribute('src') === 'https://api.solian.app/drive/files/avatar-1?preset=thumb'
    );
  })(),
  { name: rtext('.kai-account__name'), handle: rtext('.kai-account__handle') },
);

// …and refreshes it in the background with a fresh /me — no token refresh,
// because the stored access token still has life in it.
const rMe = rRequests.filter((request) => request.url.indexOf('/stargate/accounts/me') !== -1)[0];
check(
  'restoring a session re-fetches the profile',
  Boolean(rMe) && rMe.requestHeaders.Authorization === 'Bearer test-access',
  rMe ? rMe.requestHeaders : null,
);
check(
  'a still-valid stored token is not refreshed on restore',
  rRequests.filter((request) => request.url.indexOf('/stargate/auth/open/token') !== -1).length === 0,
  rRequests.map((request) => request.url),
);
await runtilTimer(() => rtext('.kai-account__name') === 'Test User');
check(
  'the refreshed profile replaces the cached identity',
  rtext('.kai-account__name') === 'Test User' && rtext('.kai-account__handle') === '@testuser',
  { name: rtext('.kai-account__name'), handle: rtext('.kai-account__handle') },
);
relaunch.window.close();

// ---- Relaunch with an expired stored session --------------------------------
// The common case on a handset: the access token's lifetime is minutes, the app
// is reopened hours later. Restoring the session fires the background profile
// refresh, and the dashboard's countdown fetch follows in the same turn — both
// ask `bearerToken()` for a bearer while the cached one is stale, so an
// unguarded refresh exchange is issued twice with the same refresh token.
// Stargate may rotate that token on use, which makes the loser of the race an
// `invalid_grant` and drops a session that is perfectly alive.
const expiredHtml = html
  .replace(/(src|href)="\.\//g, `$1="${distUrl}`)
  .replace(
    '<head>',
    `<head><script>window.localStorage.setItem('sokai.session', ${JSON.stringify(
      JSON.stringify({ ...SEED, expiresAt: Date.now() - 1000 }),
    )});</script>`,
  );
const expired = new JSDOM(expiredHtml, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  url: 'http://sokai.test/index.html',
});
const ew = expired.window;
if (ew.document.readyState !== 'complete') {
  await new Promise((resolve) => ew.addEventListener('load', resolve, { once: true }));
}
const eRequests = ew.__requests;
await runtilTimer(() =>
  eRequests.some((request) => request.url.indexOf('/calendar/countdown') !== -1),
);

check(
  'an expired stored session refreshes exactly once on restore',
  ew.__refreshes === 1,
  {
    refreshes: ew.__refreshes,
    tokenRequests: eRequests
      .filter((request) => request.url.indexOf('/stargate/auth/open/token') !== -1)
      .map((request) => String(request.requestBody).slice(0, 40)),
  },
);
const eCountdown = eRequests.filter((request) => request.url.indexOf('/calendar/countdown') !== -1)[0];
check(
  'a read racing the refresh waits for it and carries the new bearer',
  Boolean(eCountdown) && eCountdown.requestHeaders.Authorization === 'Bearer refreshed-access',
  eCountdown ? eCountdown.requestHeaders : null,
);
expired.window.close();

// ---- Relaunch with a revoked session ----------------------------------------
// The other half of the same story: the stored bearer has not expired, but the
// server has stopped accepting it (the session was revoked elsewhere). Nothing
// in the proactive path can see that — only the refused request can — so the
// call has to be answered by a forced refresh and one retry. Without that the
// app keeps 401-ing until the stored expiry passes, which is minutes of a
// signed-in shell whose every read fails.
const revokedHtml = html
  .replace(/(src|href)="\.\//g, `$1="${distUrl}`)
  .replace(
    '<head>',
    `<head><script>window.localStorage.setItem('sokai.session', ${JSON.stringify(JSON.stringify(SEED))});</script>`,
  );
const revoked = new JSDOM(revokedHtml, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  url: 'http://sokai.test/index.html?revoked-me',
});
const vw = revoked.window;
if (vw.document.readyState !== 'complete') {
  await new Promise((resolve) => vw.addEventListener('load', resolve, { once: true }));
}
const vRequests = vw.__requests;
await runtilTimer(
  () => vRequests.filter((request) => request.url.indexOf('/stargate/accounts/me') !== -1).length >= 2,
);

const vMe = vRequests.filter((request) => request.url.indexOf('/stargate/accounts/me') !== -1);
check(
  'a refused request is retried once, with a refreshed bearer',
  vMe.length === 2 &&
    vMe[0].requestHeaders.Authorization === 'Bearer test-access' &&
    vMe[1].requestHeaders.Authorization === 'Bearer refreshed-access',
  vMe.map((request) => request.requestHeaders.Authorization),
);
check('the refused request forces exactly one refresh', vw.__refreshes === 1, vw.__refreshes);

// The retry has to reach the screen, not just the transport. The account
// screen renders the identity the session holds, so it is the same probe the
// restore scenario above uses for a profile that landed.
for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'Enter']) {
  vw.document.dispatchEvent(new vw.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await flush();
}
const vAccountName = () => {
  const node = vw.document.querySelector('.kai-account__name');
  return node ? node.textContent.trim() : '';
};
await runtilTimer(() => vAccountName() === 'Test User');
check('the retried read reaches the screen', vAccountName() === 'Test User', vAccountName());
revoked.window.close();

dom.window.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${steps} runtime checks failed on a Gecko 48-era realm.`);
  process.exit(1);
}

console.log(`\nruntime check passed: ${steps} assertions on a realm without post-ES2015 APIs.`);
