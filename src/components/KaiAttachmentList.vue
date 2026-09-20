<template>
  <div class="kai-attachments">
    <template v-for="attachment in shown" :key="attachment.id">
      <!-- A picture is the point of a picture post; the caption under it carries
           what the row would otherwise have said in text. While the bytes are
           on the wire, the box shows its BlurHash wash (when the server sent
           one) behind the still-empty image; the reserved box means nothing
           moves when the picture lands. A video's poster frame carries the
           play badge, so it reads as playable before the lightbox opens. -->
      <span
        v-if="attachment.src && !failed[attachment.id]"
        class="kai-attachment__frame"
      >
        <img
          class="kai-attachment__image"
          :class="{ 'kai-attachment__image--unknown': attachment.unknown }"
          :src="attachment.src"
          :width="attachment.width"
          :height="attachment.height"
          :style="attachment.blur ? { backgroundImage: 'url(' + attachment.blur + ')' } : null"
          :alt="attachment.detail"
          @error="fail(attachment.id)"
        />
        <KaiPlayIcon v-if="attachment.kind === 'video'" class="kai-attachment__play" />
      </span>

      <!-- A picture's caption is optional: the detail screen shows the picture
           whole and needs no line under it, while a row summarises with one.
           A video's poster frame counts as a picture here. Anything else —
           a document, a video the server has no frame for — has only its
           text line to be. A failed picture falls back to its line either way. -->
      <p v-if="showCaptions || !attachment.src || failed[attachment.id]" class="kai-post__attach">
        <span class="kai-post__attach-kind">[{{ t(attachment.kindKey) }}]</span>
        {{ attachment.detail }}
      </p>
    </template>

    <p v-if="hidden" class="kai-post__attach">
      {{ t('post_more_attachments', { n: hidden }) }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue';

import { attachmentKindKey, describeAttachment, type Attachment, type AttachmentKind } from '~/src/api/models.js';
import { fileUrl, thumbnailUrl } from '~/src/api/solian.js';
import KaiPlayIcon from '~/src/components/KaiPlayIcon.vue';
import { placeholderDataUrl } from '~/src/kaios/blur.js';
import { t } from '~/src/kaios/l10n.js';

const props = withDefaults(
  defineProps<{
    attachments: Attachment[];
    /** Rows render one line and count the rest; `0` renders every attachment. */
    limit?: number;
    /** Rows caption their pictures; the detail shows them whole, captionless. */
    showCaptions?: boolean;
  }>(),
  { limit: 0, showCaptions: false },
);

interface ShownAttachment {
  id: string;
  kind: AttachmentKind;
  kindKey: string;
  detail: string;
  src: string;
  width: number;
  height: number;
  blur: string;
  /** The server sized no dimensions for this media: the box needs a floor. */
  unknown: boolean;
}

/** id of every attachment whose file failed to load, so its line stands alone. */
const failed = reactive<Record<string, boolean>>({});

function fail(id: string): void {
  failed[id] = true;
}

const shown = computed<ShownAttachment[]>(() => {
  const list = props.limit > 0 ? props.attachments.slice(0, props.limit) : props.attachments;
  return list.map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    kindKey: attachmentKindKey(attachment.kind),
    detail: describeAttachment(attachment),
    // Pictures load their own bytes; a video would cost megabytes, so it gets
    // the server's poster frame instead — a small image, same as a picture.
    // An explicit URL wins: a row that carries one is not addressed by id.
    src: attachment.src
      ? attachment.src
      : attachment.kind === 'image'
        ? fileUrl(attachment.id)
        : attachment.kind === 'video'
          ? thumbnailUrl(attachment.id)
          : '',
    width: attachment.width,
    height: attachment.height,
    // Decoded once per hash and cached: a feed page full of the same picture
    // pays for the decode once. '' when the server sent no hash.
    blur: placeholderDataUrl(attachment.blurhash),
    unknown: !attachment.width || !attachment.height,
  }));
});

const hidden = computed(() =>
  props.limit > 0 ? Math.max(0, props.attachments.length - props.limit) : 0,
);
</script>
