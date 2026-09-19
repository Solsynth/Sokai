<template>
  <div class="kai-view">
    <KaiHeader :title="title" />

    <main class="kai-content">
      <!-- The field is the whole screen, so it takes the initial highlight and
           the platform keyboard opens with it: this screen exists to be typed
           into, unlike the thread it was reached from. -->
      <KaiTextArea
        v-model="draft"
        :label="t('chat_label')"
        :placeholder="t('chat_hint')"
      />

      <!-- A reply says what it answers, above the field; an edit says what is
           being rewritten. Both come from the view params, so they ride with
           the one push that opened the composer. -->
      <p v-if="replyName" class="kai-text kai-text--secondary">
        {{ t('chat_reply_to', { name: replyName }) }}
      </p>
      <p v-else-if="editingId" class="kai-text kai-text--secondary">
        {{ t('chat_editing') }}
      </p>

      <!-- The same media toolbar the post composer carries — one icon button
           per source, walked by the D-pad — plus the sticker picker, which is
           the one attachment a message can carry as its whole content. An edit
           rewrites the words only: the message keeps the media it already has,
           so the toolbar is not offered there. -->
      <div v-if="!editingId" class="kai-compose-media">
        <KaiIconButton
          :icon="Camera"
          :label="t('compose_take_photo')"
          :show-label="false"
          @select="addMedia(takePhoto)"
        />
        <KaiIconButton
          :icon="Video"
          :label="t('compose_record_video')"
          :show-label="false"
          @select="addMedia(recordVideo)"
        />
        <!-- The microphone records in the page: the recorder app would be a
             whole app switch, and the sender would not see the take. A device
             without the media APIs falls back to the platform recorder. The
             recorder and the dictation tool share one microphone, so only the
             one that is not in use is drawn. -->
        <KaiIconButton
          v-if="!dictating"
          :icon="recording ? Square : Mic"
          :label="recording ? t('chat_stop_recording') : t('compose_record_audio')"
          :show-label="false"
          @select="toggleRecord"
        />
        <!-- Dictation is the platform's speech service, not a take: each
             settled phrase is appended to the message as text. -->
        <KaiIconButton
          v-if="dictationSupported && !recording"
          :icon="dictating ? Square : Speech"
          :label="dictating ? t('compose_dictate_stop') : t('compose_dictate')"
          :show-label="false"
          @select="toggleDictation"
        />
        <KaiIconButton
          :icon="Images"
          :label="t('compose_add_photo')"
          :show-label="false"
          @select="addMedia(pickImage)"
        />
        <KaiIconButton
          :icon="Sticker"
          :label="t('chat_stickers')"
          :show-label="false"
          @select="push('chat-stickers', { room: roomId })"
        />
      </div>

      <!-- While recording, the take says how long it is running: the only
           feedback a handset without a level meter gives. Dictation's feedback
           is the phrase in flight, which is not in the field yet. -->
      <p v-if="recording" class="kai-text kai-text--recording">
        {{ t('chat_recording', { time: clock }) }}
      </p>
      <p v-if="dictating" class="kai-text kai-text--recording">
        {{ dictationPhrase ? t('compose_dictating', { text: dictationPhrase }) : t('dictation_listening') }}
      </p>

      <KaiList class="kai-list--flat">
        <KaiComposeAttachment
          v-for="attachment in attachments"
          :key="attachment.id"
          :attachment="attachment"
          @remove="chat.removeAttachment(roomId, attachment.id)"
        />
      </KaiList>

      <!-- In flight, the waiting line is the send's feedback: the request can
           take a beat (an upload first, then the POST), and the right key is
           already inert so this is the one thing that moves. -->
      <p v-if="sending" class="kai-waiting">
        <span class="kai-spinner__ring"></span>
        {{ t('chat_sending_label') }}
      </p>

      <p v-if="chat.sendError" class="kai-text kai-text--error">{{ t(chat.sendError) }}</p>
      <p v-if="dictationError" class="kai-text kai-text--error">{{ t(dictationError) }}</p>
      <p v-if="chat.storageError" class="kai-text kai-text--error">{{ t('chat_storage_error') }}</p>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { Camera, Images, Mic, Speech, Square, Sticker, Video } from '@lucide/vue';
import KaiComposeAttachment from '~/src/components/KaiComposeAttachment.vue';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiIconButton from '~/src/components/KaiIconButton.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiTextArea from '~/src/components/KaiTextArea.vue';
import { formatClock } from '~/src/api/models.js';
import { pickImage, recordAudio, recordVideo, takePhoto, type PickedMedia } from '~/src/kaios/activity.js';
import { useDictation } from '~/src/kaios/dictation.js';
import { t } from '~/src/kaios/l10n.js';
import { canRecordInApp, startRecording, type ActiveRecording } from '~/src/kaios/recorder.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { pop, push } from '~/src/kaios/views.js';
import { chatRoomTitle, useChatStore } from '~/src/stores/chat.js';

/**
 * Writing one room's message, full screen. The field used to sit under the
 * thread, where it shared a 240x320 display with the messages and fought the
 * list for the D-pad; here it is the screen, with Send on the right key, and
 * the thread is untouched underneath — Back returns to it.
 *
 * Media follows the post composer: a picked file joins the draft as a row and
 * uploads when the message is sent, so an abandoned draft costs nothing. A
 * sticker is not a file at all — it is the `:prefix+slug:` placeholder as the
 * content, and it sends on its own from the picker.
 *
 * The text and the files live in the store, not here: pushing the sticker
 * picker unmounts this screen, and returning must find the draft intact.
 */

const props = withDefaults(defineProps<{ params?: Record<string, string> }>(), {
  params: () => ({}),
});

const roomId = computed(() => props.params.id || '');
const chat = useChatStore();

/** The room's title, so the screen says who is being written to. */
const title = computed(() => {
  const room = chat.rooms.find((item) => item.id === roomId.value);
  return room ? chatRoomTitle(room, chat.selfAccountId) : t('nav_chat');
});

/* --- Reply and edit modes -------------------------------------------------
 * The composer is reused across pushes (the same view-instance contract the
 * post screens keep), so the modes are read from the params: `replyTo` /
 * `replyName` make the next send answer that message, `edit` makes it a
 * PATCH of that one, seeded with its text. A reply writes the room's normal
 * draft; an edit has its own field state, so the room's draft is never
 * clobbered by a message being rewritten.
 */

/** The message being answered (`replied_message_id`), '' for a plain send. */
const replyTo = computed(() => props.params.replyTo || '');
/** The sender's display name for the reply hint line. */
const replyName = computed(() => props.params.replyName || '');
/** The message being edited, '' for a plain send. */
const editingId = computed(() => props.params.edit || '');
/** The edit field's own text, seeded from the message's content. */
const editingText = ref(props.params.content || '');
/** The edited message's already-uploaded attachment ids, sent back on save. */
const originalAttachmentIds = computed<string[]>(() => {
  const raw = props.params.attachmentIds;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch (error) {
    return [];
  }
});

// A later push onto the same composer instance swaps the target: reseed the
// edit field with the new message's content.
watch(() => props.params, () => {
  editingText.value = props.params.content || '';
}, { immediate: true });

const draft = computed({
  get: () => (editingId.value ? editingText.value : chat.draftFor(roomId.value)),
  set: (value: string) => {
    if (editingId.value) editingText.value = value;
    else chat.setDraft(roomId.value, value);
  },
});

const attachments = computed(() =>
  editingId.value ? [] : chat.attachmentsFor(roomId.value),
);

/** A message needs words or files; both empty, the right key is inert. An
 *  edit needs words — the media stays on the message either way. */
const hasBody = computed(() => {
  if (editingId.value) return editingText.value.trim().length > 0;
  return draft.value.trim().length > 0 || attachments.value.length > 0;
});

/**
 * Dictation writes into the composer's text — the room's draft, or the edit
 * field's own state — through the same accessors the field uses: a settled
 * phrase is appended to whatever the message holds at that moment, so it can
 * never swallow typing that happened while the microphone was open.
 */
const {
  supported: dictationSupported,
  listening: dictating,
  interim: dictationPhrase,
  errorKey: dictationError,
  toggle: toggleDictation,
  stop: stopDictation,
} = useDictation({
  read: () => (editingId.value ? editingText.value : chat.draftFor(roomId.value)),
  write: (value) => {
    if (editingId.value) editingText.value = value;
    else chat.setDraft(roomId.value, value);
  },
});

/** Runs a capture source; a cancelled pick is a no-op. */
async function addMedia(source: () => Promise<PickedMedia | null>): Promise<void> {
  const picked = await source();
  if (picked) chat.addAttachment(roomId.value, picked.blob, picked.name);
}

/* --- Voice recording --------------------------------------------------- */

/** The take in progress, or null. Its presence *is* the recording state. */
const recording = ref<ActiveRecording | null>(null);
const elapsedMs = ref(0);
let ticker = 0;

/** The take's length as `m:ss`, ticking a couple of times a second. */
const clock = computed(() => formatClock(elapsedMs.value));

function stopTicker(): void {
  if (ticker) {
    window.clearInterval(ticker);
    ticker = 0;
  }
}

/** The microphone starts and the timer runs until the take is stopped. */
async function beginRecording(): Promise<void> {
  const take = await startRecording();
  if (!take) {
    // No in-page mic (or the user refused it): the platform recorder is the
    // fallback path, the same activity every other media source uses.
    await addMedia(recordAudio);
    return;
  }
  recording.value = take;
  elapsedMs.value = take.elapsed();
  stopTicker();
  ticker = window.setInterval(() => {
    if (recording.value) elapsedMs.value = recording.value.elapsed();
  }, 500);
}

/** Finishes the take and puts it in the draft, with its length. */
async function finishRecording(): Promise<void> {
  const take = recording.value;
  if (!take) return;
  recording.value = null;
  stopTicker();
  const done = await take.stop();
  if (done) chat.addAttachment(roomId.value, done.blob, done.name, done.durationMs);
}

/** The mic button and the right key both end the take, so either finishes it. */
function toggleRecord(): void {
  if (recording.value) void finishRecording();
  else void beginRecording();
}

/**
 * Sends what is in the draft and returns to the thread; an edit saves the
 * rewritten message instead. The store clears the draft (and its files) on
 * success and puts the text back on failure, so an empty draft means it went —
 * and a failure keeps this screen up for the retry, which is the right key.
 *
 * The request can take a beat (a file upload first, then the POST), so a send
 * is guarded and announced: the right key goes inert and the waiting line
 * shows while it is in flight — the same double-submit guard the post
 * composer's `submitting` keeps.
 */
const sending = ref(false);

async function send(): Promise<void> {
  if (sending.value) return;
  sending.value = true;
  try {
    // A take still running is finished first, not thrown away: Send while
    // recording means "record this and send it".
    if (recording.value) await finishRecording();

    if (editingId.value) {
      const text = editingText.value.trim();
      if (!text) return;
      const ok = await chat.edit(roomId.value, editingId.value, text, originalAttachmentIds.value);
      if (ok) pop();
      return;
    }

    if (!hasBody.value) return;
    await chat.send(roomId.value, draft.value, attachments.value, replyTo.value);
    if (!chat.sendError) pop();
  } finally {
    sending.value = false;
  }
}

onMounted(() => {
  setBaseSoftkeys(() => ({
    center: { label: t('action_open') },
    // While a take is running the right key finishes it, and while the platform
    // is listening it ends the session — the same action as each tool above, so
    // the microphone is never one key away from being released.
    right: recording.value
      ? { label: t('chat_stop'), onPress: () => void finishRecording() }
      : dictating.value
        ? { label: t('dictation_stop'), onPress: stopDictation }
        : sending.value
          ? { label: '', onPress: null }
          : hasBody.value
            ? { label: t('chat_send'), onPress: send }
            : { label: '' },
  }));

  // Keep the room subscribed while writing in it: a message that arrives now
  // belongs to the thread this draft is for. The room screen clears the active
  // room as it unmounts and this screen mounts after it, so the last word on
  // the room is this one (the smoke asserts that frame order).
  chat.setActiveRoom(roomId.value);
});

onBeforeUnmount(() => {
  // Leaving mid-take releases the microphone: an open track is what keeps the
  // device's mic indicator on, and the take was never asked for.
  stopTicker();
  if (recording.value) recording.value.cancel();
});
</script>
