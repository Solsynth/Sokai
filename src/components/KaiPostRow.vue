<template>
  <li
    ref="root"
    tabindex="-1"
    nav-selectable="true"
    :nav-selected="isSelected ? 'true' : 'false'"
    class="kai-post"
    @click="emit('select')"
  >
    <span class="kai-post__author">
      {{ post.author.display }}
      <span v-if="post.author.name" class="kai-post__handle">@{{ post.author.name }}</span>
    </span>

    <span class="kai-post__meta">
      <span v-if="time" class="kai-post__time">{{ time }}</span>
      <span v-if="kind">{{ t(kind) }}</span>
      <span v-if="post.editedAt">{{ t('post_edited') }}</span>
      <span v-if="visibility">{{ t(visibility) }}</span>
      <span v-if="post.isTruncated">{{ t('post_truncated') }}</span>
    </span>

    <span v-if="post.title" class="kai-post__title">{{ post.title }}</span>

    <span class="kai-post__excerpt">{{ body }}</span>

    <KaiPostQuote v-if="quote" :quote="quote" :label-key="quoteLabelKey" />

    <KaiAttachmentList :attachments="post.attachments" :limit="ATTACHMENT_LINES" />

    <span v-if="counts.length" class="kai-post__counts">
      <span v-for="count in counts" :key="count.key">{{ t(count.key, { n: count.n }) }}</span>
    </span>

    <span v-if="post.tags.length" class="kai-post__tags">
      <span v-for="tag in post.tags" :key="tag" class="kai-tag">{{ tag }}</span>
    </span>
  </li>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import KaiAttachmentList from './KaiAttachmentList.vue';
import KaiPostQuote from './KaiPostQuote.vue';
import { excerpt } from '../content/markdown.js';
import { formatRelativeTime, postKindKey, visibilityKey } from '../api/models.js';
import { t } from '../kaios/l10n.js';
import { nav, registerSelectable, unregisterSelectable } from '../kaios/nav.js';

const props = defineProps({
  post: { type: Object, required: true },
});

const emit = defineEmits(['select']);

/** One sample line and a count for the rest: a row is not the place for a gallery. */
const ATTACHMENT_LINES = 1;

const root = ref(null);
const uid = ref(0);

const isSelected = computed(() => uid.value !== 0 && nav.current === uid.value);

// Feed rows are text, never markup: the full body is what the detail screen
// renders as markdown.
const body = computed(() => excerpt(props.post));

const time = computed(() => {
  const relative = formatRelativeTime(props.post.publishedAt);
  if (!relative) return '';
  return relative.key ? t(relative.key, relative.args) : relative.text;
});

const kind = computed(() => postKindKey(props.post.kind));
const visibility = computed(() => visibilityKey(props.post.visibility));

// A reply quotes its parent the same way a forward quotes its source; only the
// label differs.
const quote = computed(() => props.post.forwardedFrom || props.post.repliedTo);
const quoteLabelKey = computed(() =>
  props.post.forwardedFrom ? 'post_forwarded_from' : 'post_replied_to',
);

const counts = computed(() => {
  const list = [];
  const { replies, boosts, reactions } = props.post.counts;
  if (replies) list.push({ key: 'post_count_replies', n: replies });
  if (boosts) list.push({ key: 'post_count_boosts', n: boosts });
  if (reactions) list.push({ key: 'post_count_reactions', n: reactions });
  return list;
});

onMounted(() => {
  uid.value = registerSelectable({
    el: root,
    onEnter: () => emit('select'),
    // Posts are the screen's primary content: the highlight starts here even
    // when the page-flip controls sit above the list.
    initial: true,
  });
});

onBeforeUnmount(() => {
  unregisterSelectable(uid.value);
});
</script>
