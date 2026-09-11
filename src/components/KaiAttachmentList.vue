<template>
  <div class="kai-attachments">
    <p v-for="attachment in shown" :key="attachment.id" class="kai-post__attach">
      <span class="kai-post__attach-kind">[{{ t(attachment.kindKey) }}]</span>
      {{ attachment.detail }}
    </p>

    <p v-if="hidden" class="kai-post__attach">
      {{ t('post_more_attachments', { n: hidden }) }}
    </p>
  </div>
</template>

<script setup>
import { computed } from 'vue';

import { attachmentKindKey, describeAttachment } from '../api/models.js';
import { t } from '../kaios/l10n.js';

const props = defineProps({
  attachments: { type: Array, required: true },
  /** Rows render one line and count the rest; `0` renders every attachment. */
  limit: { type: Number, default: 0 },
});

const shown = computed(() => {
  const list = props.limit > 0 ? props.attachments.slice(0, props.limit) : props.attachments;
  return list.map((attachment) => ({
    id: attachment.id,
    kindKey: attachmentKindKey(attachment.kind),
    detail: describeAttachment(attachment),
  }));
});

const hidden = computed(() =>
  props.limit > 0 ? Math.max(0, props.attachments.length - props.limit) : 0,
);
</script>
