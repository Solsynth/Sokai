<template>
  <div ref="root" class="kai-post__quote">
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

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { bodyHtml, excerpt } from '~/src/content/markdown.js';
import { type PostReference } from '~/src/api/models.js';
import { t } from '~/src/kaios/l10n.js';
import { cachePhotoSrcs } from '~/src/kaios/media-cache.js';

const props = withDefaults(
  defineProps<{
    /** A normalised `repliedTo` / `forwardedFrom` reference. */
    quote: PostReference;
    /** `post_replied_to` or `post_forwarded_from`. */
    labelKey: string;
    /** Detail screens render markdown; feed rows stay text-only. */
    rich?: boolean;
  }>(),
  { rich: false },
);

/** A quote is context, not the post: two lines is as much as a row can give it. */
const QUOTE_UNITS = 48;

const text = computed(() => excerpt(props.quote, QUOTE_UNITS));
const html = computed(() => bodyHtml(props.quote));

const root = ref<HTMLElement | null>(null);
// The quote's markdown images upgrade to their disk-cached URLs once ready,
// the same pass the post body runs (`flush: 'post'` so the nodes exist).
watch(html, () => cachePhotoSrcs(root.value), { flush: 'post' });
</script>
