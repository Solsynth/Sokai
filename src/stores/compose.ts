import { ref } from 'vue';
import { defineStore } from 'pinia';

import { attachmentKind, type AttachmentKind, type Publisher } from '~/src/api/models.js';
import { listMyPublishers } from '~/src/api/solian.js';

/**
 * The compose store: the in-progress post, shared across the compose screens.
 *
 * Only the top of the view stack is mounted, so pushing the publisher picker
 * (or any screen) unmounts ComposeView and would destroy a view-local draft.
 * This store is the single home for the draft — content, attachments, the
 * publisher list and the choice — mirroring FloatLand's `useCompose`, which
 * exists for the same reason. A draft therefore survives navigating away and
 * back, and is cleared only by a successful post.
 */

export interface ComposeAttachment {
  /** Local id for the row key. */
  id: string;
  /** The picked bytes; uploaded lazily at submit time (FloatLand does the same).
   *  Absent for an already-uploaded attachment seeded from an edited post. */
  blob?: Blob;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  /** Object-URL preview for pictures, so the draft shows what was picked; '' otherwise. */
  preview: string;
  /** The drive file id once uploaded (or seeded); null until then. */
  fileId: string | null;
}

/**
 * What the compose flow is anchored to: a fresh post, a reply, a forward
 * (quote), or an edit — the same split Solian's composer uses. Only the mode
 * itself travels with the draft; the target ids come from the view params.
 */
export type ComposeMode =
  | { kind: 'new' }
  | { kind: 'reply'; postId: string }
  | { kind: 'forward'; postId: string }
  | { kind: 'edit'; postId: string; publisherName: string };

export type PublisherStatus = 'idle' | 'loading' | 'error' | 'ready';

let attachmentSeq = 0;

export const useComposeStore = defineStore('compose', () => {
  /** The draft body, markdown, as typed. */
  const content = ref('');
  const publishers = ref<Publisher[]>([]);
  const publisher = ref<Publisher | null>(null);
  const publisherStatus = ref<PublisherStatus>('idle');
  /** l10n key for why the publisher list could not be used; '' while healthy. */
  const publisherErrorKey = ref('');
  const attachments = ref<ComposeAttachment[]>([]);
  /** The compose target; `new` is the default and the only surviving state. */
  const mode = ref<ComposeMode>({ kind: 'new' });

  /** Loads the account's publishers; the first becomes the default poster. */
  async function loadPublishers(): Promise<void> {
    publisherStatus.value = 'loading';
    publisherErrorKey.value = '';
    try {
      const list = await listMyPublishers();
      publishers.value = list;
      if (!publisher.value && list.length > 0) publisher.value = list[0] ?? null;
      if (list.length > 0) {
        publisherStatus.value = 'ready';
      } else {
        publisherErrorKey.value = 'compose_no_publisher';
        publisherStatus.value = 'error';
      }
    } catch (error) {
      publisherErrorKey.value = 'error_load_failed';
      publisherStatus.value = 'error';
    }
  }

  function selectPublisher(name: string): void {
    const next = publishers.value.find((item) => item.name === name) ?? null;
    if (next) publisher.value = next;
  }

  function addAttachment(file: Blob, name: string): void {
    attachmentSeq += 1;
    attachments.value.push({
      id: 'compose-attachment-' + attachmentSeq,
      blob: file,
      name,
      mimeType: file.type || '',
      size: file.size || 0,
      kind: attachmentKind(file.type || '', name),
      preview: /^image\//.test(file.type || '') ? URL.createObjectURL(file) : '',
      fileId: null,
    });
  }

  function removeAttachment(id: string): void {
    const index = attachments.value.findIndex((attachment) => attachment.id === id);
    if (index === -1) return;
    const attachment = attachments.value[index];
    if (attachment && attachment.preview) URL.revokeObjectURL(attachment.preview);
    attachments.value.splice(index, 1);
  }

  /** Clears the draft after a successful post; the chosen publisher stays. */
  function reset(): void {
    for (const attachment of attachments.value) {
      if (attachment.preview) URL.revokeObjectURL(attachment.preview);
    }
    content.value = '';
    attachments.value = [];
    publisherErrorKey.value = '';
  }

  /** A fresh post: the default target, reached after a post or a stale session. */
  function beginNew(): void {
    reset();
    mode.value = { kind: 'new' };
  }

  /** A reply to `postId`; the draft starts empty like a new post. */
  function beginReply(postId: string): void {
    reset();
    mode.value = { kind: 'reply', postId };
  }

  /** A quote of `postId`; the draft starts empty like a new post. */
  function beginForward(postId: string): void {
    reset();
    mode.value = { kind: 'forward', postId };
  }

  /**
   * An edit of `postId`, seeded with the post's own content, its already
   * uploaded attachments and its publisher. The publisher row is not shown in
   * edit mode: the post stays under the publisher it was written as.
   */
  function beginEdit(
    postId: string,
    content_: string,
    seeds: Array<{ id: string; name: string; size: number; kind: AttachmentKind }>,
    publisherName: string,
  ): void {
    reset();
    mode.value = { kind: 'edit', postId, publisherName };
    content.value = content_;
    attachmentSeq += 1;
    for (let index = 0; index < seeds.length; index += 1) {
      const seed = seeds[index];
      attachmentSeq += 1;
      attachments.value.push({
        id: 'compose-attachment-' + attachmentSeq,
        name: seed.name,
        mimeType: '',
        size: seed.size,
        kind: seed.kind,
        preview: '',
        fileId: seed.id,
      });
    }
  }

  return {
    content,
    publishers,
    publisher,
    publisherStatus,
    publisherErrorKey,
    attachments,
    mode,
    loadPublishers,
    selectPublisher,
    addAttachment,
    removeAttachment,
    reset,
    beginNew,
    beginReply,
    beginForward,
    beginEdit,
  };
});
