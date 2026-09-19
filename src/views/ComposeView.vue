<template>
  <div class="kai-view">
    <KaiHeader :title="headerTitle" />

    <main class="kai-content">
      <!-- Signed out: compose is a write screen, so sign-in comes first. The
           feed stays read-only; the account screen runs the device flow. -->
      <template v-if="phase !== 'signed-in'">
        <p class="kai-text">{{ t('compose_sign_in_intro') }}</p>

        <KaiList class="kai-list--flat">
          <KaiListItem :primary="t('account_sign_in')" @select="push('account')" />
        </KaiList>
      </template>

      <template v-else>
        <!-- An edit keeps the post under its own publisher, so only new posts,
             replies and forwards pick the poster. -->
        <KaiSpinner v-if="!isEdit && publisherStatus === 'loading'" />

        <template v-else-if="!isEdit && publisherStatus === 'error'">
          <p class="kai-text kai-text--error">{{ t(store.publisherErrorKey) }}</p>

          <KaiList class="kai-list--flat">
            <KaiListItem :primary="t('error_retry')" @select="store.loadPublishers" />
          </KaiList>
        </template>

        <template v-else>
          <!-- Who the post goes out under; the row opens the publisher list.
               Flush under the header: the lone row carries no gap or hairline. -->
          <KaiList v-if="!isEdit" class="kai-list--flat kai-list--flush">
            <KaiListItem
              :primary="t('compose_post_as', { name: publisherDisplay })"
              :secondary="'@' + (store.publisher ? store.publisher.name : '')"
              :thumb="store.publisher ? store.publisher.picture || '' : ''"
              @select="push('publishers')"
            />
          </KaiList>

          <p v-if="replyAuthor" class="kai-text kai-text--secondary">
            {{ t('compose_reply_to', { name: replyAuthor }) }}
          </p>

          <KaiPostQuote v-if="quoted" :quote="quoted" label-key="post_forwarded_from" />

          <KaiTextArea
            v-model="store.content"
            :label="t('compose_label')"
            :placeholder="t('compose_hint')"
          />

          <!-- The media toolbar: one icon button per capture source, walked by
               the D-pad like the pager's cells. Picked files join the draft as
               removable rows below. -->
          <div class="kai-compose-media">
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
            <!-- The platform recorder and dictation share one microphone, and
                 the recorder is a whole app switch: only the tool that can run
                 is drawn — dictation where the device has the speech service,
                 the recorder where it does not. -->
            <KaiIconButton
              v-if="!dictating && !dictationSupported"
              :icon="Mic"
              :label="t('compose_record_audio')"
              :show-label="false"
              @select="addMedia(recordAudio)"
            />
            <!-- Dictation is the platform's speech service, not a take: each
                 settled phrase is appended to the body as text. The tool is
                 only drawn where the device has the API (KaiOS adds it on top
                 of Gecko 48, so it is not everywhere). -->
            <KaiIconButton
              v-if="dictationSupported"
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
          </div>

          <!-- While the platform listens, the phrase in flight is the feedback
               — the text itself lands only once the phrase is settled. The
               failure line sits here too: it is about the tool above it. -->
          <p v-if="dictating" class="kai-text kai-text--recording">
            {{ dictationPhrase ? t('compose_dictating', { text: dictationPhrase }) : t('dictation_listening') }}
          </p>
          <p v-if="dictationError" class="kai-text kai-text--error">{{ t(dictationError) }}</p>

          <KaiList class="kai-list--flat">
            <KaiComposeAttachment
              v-for="attachment in store.attachments"
              :key="attachment.id"
              :attachment="attachment"
              @remove="store.removeAttachment(attachment.id)"
            />
          </KaiList>

          <!-- In flight, the waiting line is the submit's feedback: attachments
               upload first, then the post goes out, and the right key is
               already inert so this is the one thing that moves. -->
          <p v-if="submitting" class="kai-waiting">
            <span class="kai-spinner__ring"></span>
            {{ t('compose_posting') }}
          </p>

          <p v-if="errorKey" class="kai-text kai-text--error">{{ t(errorKey) }}</p>
        </template>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { Camera, Images, Mic, Speech, Square, Video } from '@lucide/vue';
import { type AttachmentKind, type PostReference } from '~/src/api/models.js';
import { createPost, updatePost, uploadFile } from '~/src/api/solian.js';
import KaiComposeAttachment from '~/src/components/KaiComposeAttachment.vue';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiIconButton from '~/src/components/KaiIconButton.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import KaiPostQuote from '~/src/components/KaiPostQuote.vue';
import KaiSpinner from '~/src/components/KaiSpinner.vue';
import KaiTextArea from '~/src/components/KaiTextArea.vue';
import { pickImage, recordAudio, recordVideo, takePhoto, type PickedMedia } from '~/src/kaios/activity.js';
import { useDictation } from '~/src/kaios/dictation.js';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { pop, push } from '~/src/kaios/views.js';
import { useAccountStore } from '~/src/stores/account.js';
import { useComposeStore } from '~/src/stores/compose.js';
import { useFeedStore } from '~/src/stores/feed.js';

const props = withDefaults(defineProps<{ params?: Record<string, string> }>(), {
  params: () => ({}),
});

const accountStore = useAccountStore();
const store = useComposeStore();

/** l10n key for the last submit failure; '' while healthy. */
const errorKey = ref('');
const submitting = ref(false);

const phase = computed(() => accountStore.phase);
const signedIn = computed(() => phase.value === 'signed-in');
const publisherStatus = computed(() => store.publisherStatus);
const publisherDisplay = computed(() => store.publisher?.display ?? '');

const mode = computed(() => store.mode.kind);
const isEdit = computed(() => mode.value === 'edit');
const isReply = computed(() => mode.value === 'reply');
const isForward = computed(() => mode.value === 'forward');

const hasBody = computed(() => store.content.trim().length > 0 || store.attachments.length > 0);
const formReady = computed(() => signedIn.value && (isEdit.value || publisherStatus.value === 'ready'));

/**
 * Dictation writes into the shared draft: a settled phrase is appended to
 * whatever the body holds at that moment, so it can never swallow typing that
 * happened while the microphone was open.
 */
const {
  supported: dictationSupported,
  listening: dictating,
  interim: dictationPhrase,
  errorKey: dictationError,
  toggle: toggleDictation,
  stop: stopDictation,
} = useDictation({
  read: () => store.content,
  write: (value) => {
    store.content = value;
  },
});

const headerTitle = computed(() => {
  if (isEdit.value) return t('compose_edit');
  if (isReply.value) return t('compose_reply');
  if (isForward.value) return t('compose_forward');
  return t('nav_compose');
});

/** The name to print under a reply composer; '' for other modes. */
const replyAuthor = computed(() => (isReply.value ? props.params.author || '' : ''));

/**
 * The quoted post for a forward, JSON in the view params — the post is already
 * in memory when the composer opens, so there is no second fetch. A full Post
 * is structurally a PostReference, so the quote block can render it directly.
 */
const quoted = computed<PostReference | null>(() => {
  if (!isForward.value) return null;
  const raw = props.params.forwarded;
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as PostReference) : null;
  } catch (error) {
    return null;
  }
});

/** The edited post's already-uploaded attachments, as seed rows for the draft. */
function parseEditAttachments(raw: string | undefined): Array<{ id: string; name: string; size: number; kind: AttachmentKind }> {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seeds: Array<{ id: string; name: string; size: number; kind: AttachmentKind }> = [];
    for (let index = 0; index < parsed.length; index += 1) {
      const item = parsed[index];
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string') continue;
      const kind =
        record.kind === 'image' || record.kind === 'video' || record.kind === 'audio' || record.kind === 'file'
          ? record.kind
          : 'file';
      seeds.push({
        id: record.id,
        name: typeof record.name === 'string' ? record.name : '',
        size: typeof record.size === 'number' && record.size > 0 ? record.size : 0,
        kind,
      });
    }
    return seeds;
  } catch (error) {
    return [];
  }
}

/**
 * Applies the compose target from the view params. Runs on every mount; the
 * idempotence guard keeps the draft when the same compose is remounted (the
 * publisher picker round-trip), and resets it when the target changes or a
 * stale mode is left over from an abandoned session.
 */
function syncMode(): void {
  const target = props.params.mode;
  const current = store.mode;
  if (!target) {
    if (current.kind !== 'new') store.beginNew();
    return;
  }
  if (current.kind === target && 'postId' in current && current.postId === props.params.id) return;

  if (target === 'reply') {
    store.beginReply(props.params.id || '');
  } else if (target === 'forward') {
    store.beginForward(props.params.id || '');
  } else if (target === 'edit') {
    store.beginEdit(
      props.params.id || '',
      props.params.content || '',
      parseEditAttachments(props.params.attachments),
      props.params.publisher || '',
    );
  }
}

/**
 * Runs a capture source (camera, recorder, gallery); cancelling is a no-op,
 * and the picked file joins the draft like any other attachment — the same
 * upload path the text post uses.
 */
async function addMedia(source: () => Promise<PickedMedia | null>): Promise<void> {
  const picked = await source();
  if (picked) store.addAttachment(picked.blob, picked.name);
}

/**
 * Publishes the draft and returns to the screen underneath, which remounts and
 * reloads on pop. Attachments upload first (each picks up its drive id),
 * mirroring FloatLand's submit order; an edit's seeded attachments are already
 * on the drive. A failure keeps the draft on screen; the right key is the
 * retry.
 */
async function submit(): Promise<void> {
  const m = store.mode;
  const pubName = m.kind === 'edit' ? m.publisherName : store.publisher?.name || '';
  const editId = m.kind === 'edit' ? m.postId : '';
  if (!signedIn.value || submitting.value || !hasBody.value) return;
  if (m.kind === 'edit' ? !editId : !pubName || publisherStatus.value !== 'ready') return;

  submitting.value = true;
  errorKey.value = '';
  try {
    const ids: string[] = [];
    for (const attachment of store.attachments) {
      if (attachment.fileId) {
        ids.push(attachment.fileId);
      } else {
        if (!attachment.blob) throw new Error('attachment-without-source');
        const id = await uploadFile(attachment.blob, attachment.name);
        if (!id) throw new Error('upload-failed');
        ids.push(id);
      }
    }

    const content = store.content.trim();
    if (m.kind === 'edit') {
      await updatePost(pubName, editId, content, ids);
    } else if (m.kind === 'reply') {
      await createPost(pubName, content, ids, { repliedPostId: m.postId });
    } else if (m.kind === 'forward') {
      await createPost(pubName, content, ids, { forwardedPostId: m.postId });
    } else {
      await createPost(pubName, content, ids);
    }
    // The timeline changed under the write: the feed refetches on return.
    useFeedStore().markStale();
    store.beginNew();
    pop();
  } catch (error) {
    errorKey.value = isEdit.value ? 'edit_error' : 'compose_error';
  } finally {
    submitting.value = false;
  }
}

// The write action lives on the right key, as it does across the app. It is
// live only when there is something to send; submit() guards the same edges,
// so a stray press is a no-op either way. Reading the store inside the factory
// keeps the label current as the draft is typed and photos are attached.
const rightKey = computed(() => {
  // A live session owns the right key: the microphone must always be one press
  // away from being released, even before a single phrase has landed.
  if (dictating.value) return { label: t('dictation_stop'), onPress: stopDictation };
  if (!formReady.value || submitting.value || !hasBody.value) {
    return { label: '', onPress: null };
  }
  const label = isEdit.value
    ? t('compose_save')
    : isReply.value
      ? t('compose_reply')
      : isForward.value
        ? t('compose_forward')
        : t('compose_post');
  return { label, onPress: submit };
});

// A view mounted while signed out resolves its publishers once sign-in lands;
// an edit already has its publisher, so it never asks for the list.
watch(signedIn, (in_) => {
  if (in_ && !isEdit.value && store.publisherStatus === 'idle') void store.loadPublishers();
});

// The compose target arrives in the view params; immediate runs it on mount,
// and a later push with different params (a reply to another post) retargets.
watch(() => props.params, syncMode, { immediate: true });

onMounted(() => {
  // The store survives navigation, so a return from the publisher picker keeps
  // the draft and the list; only a first visit loads.
  if (signedIn.value && !isEdit.value && store.publisherStatus === 'idle') void store.loadPublishers();

  setBaseSoftkeys(() => ({
    center: { label: t('action_open') },
    right: rightKey.value,
  }));
});
</script>
