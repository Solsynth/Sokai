<template>
  <div class="kai-post__quote">
    <p class="kai-post__quote-label">{{ t(labelKey, { name: quote.author.display }) }}</p>

    <p v-if="quote.title" class="kai-post__quote-title">{{ quote.title }}</p>

    <!-- Rows keep the quoted body as text; the detail screen renders it as
         markdown, like the post it belongs to. -->
    <div v-if="rich" class="kai-md kai-md--quote" v-html="html"></div>
    <p v-else-if="text" class="kai-post__quote-text">{{ text }}</p>

    <p v-if="quote.attachments.length" class="kai-post__quote-attach">
      {{ t('post_count_attachments', { n: quote.attachments.length }) }}
    </p>

    <p v-if="quote.isTruncated" class="kai-post__quote-text">{{ t('post_truncated') }}</p>
  </div>
</template>

<script setup>
import { computed } from 'vue';

import { bodyHtml, excerpt } from '../content/markdown.js';
import { t } from '../kaios/l10n.js';

const props = defineProps({
  /** A normalised `repliedTo` / `forwardedFrom` reference. */
  quote: { type: Object, required: true },
  /** `post_replied_to` or `post_forwarded_from`. */
  labelKey: { type: String, required: true },
  /** Detail screens render markdown; feed rows stay text-only. */
  rich: { type: Boolean, default: false },
});

/** A quote is context, not the post: two lines is as much as a row can give it. */
const QUOTE_UNITS = 48;

const text = computed(() => excerpt(props.quote, QUOTE_UNITS));
const html = computed(() => bodyHtml(props.quote));
</script>
