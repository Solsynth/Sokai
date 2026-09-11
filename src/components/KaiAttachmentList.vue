<template>
  <div class="kai-attachments">
    <template v-for="attachment in shown" :key="attachment.id">
      <!-- A picture is the point of a picture post; the caption under it carries
           what the row would otherwise have said in text. -->
      <img
        v-if="attachment.src && !failed[attachment.id]"
        class="kai-attachment__image"
        :src="attachment.src"
        :width="attachment.width"
        :height="attachment.height"
        :alt="attachment.detail"
        @error="fail(attachment.id)"
      />

      <!-- A picture's caption is optional: the detail screen shows the picture
           whole and needs no line under it, while a row summarises with one.
           Non-picture attachments always keep their line — a document has only
           text to be. A failed picture falls back to its line either way. -->
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

<script setup>
import { computed, reactive } from 'vue';

import { attachmentKindKey, describeAttachment } from '../api/models.js';
import { fileUrl } from '../api/solian.js';
import { t } from '../kaios/l10n.js';

const props = defineProps({
  attachments: { type: Array, required: true },
  /** Rows render one line and count the rest; `0` renders every attachment. */
  limit: { type: Number, default: 0 },
  /** Rows caption their pictures; the detail shows them whole, captionless. */
  showCaptions: { type: Boolean, default: true },
});

/** id of every attachment whose file failed to load, so its line stands alone. */
const failed = reactive({});

function fail(id) {
  failed[id] = true;
}

const shown = computed(() => {
  const list = props.limit > 0 ? props.attachments.slice(0, props.limit) : props.attachments;
  return list.map((attachment) => ({
    id: attachment.id,
    kindKey: attachmentKindKey(attachment.kind),
    detail: describeAttachment(attachment),
    // Only pictures have something to show; a video poster would need the
    // platform's own thumbnail, which exists for one file in ninety.
    src: attachment.kind === 'image' ? fileUrl(attachment.id) : '',
    width: attachment.width,
    height: attachment.height,
  }));
});

const hidden = computed(() =>
  props.limit > 0 ? Math.max(0, props.attachments.length - props.limit) : 0,
);
</script>
