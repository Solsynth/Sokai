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
      <KaiAvatar :file="post.author.picture" size="xs" />
      <span>{{ post.author.display }}</span>
      <span v-if="post.author.name" class="kai-post__handle">&nbsp;@{{ post.author.name }}</span>
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

    <KaiReactionChips :reactions="post.reactions" />

    <span v-if="post.tags.length" class="kai-post__tags">
      <span v-for="tag in post.tags" :key="tag" class="kai-tag">{{ tag }}</span>
    </span>
  </li>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import KaiAttachmentList from './KaiAttachmentList.vue';
import KaiAvatar from './KaiAvatar.vue';
import KaiPostQuote from './KaiPostQuote.vue';
import KaiReactionChips from './KaiReactionChips.vue';
import { excerpt } from '~/src/content/markdown.js';
import { reactionChips } from '~/src/content/reactions.js';
import { formatRelativeTime, postKindKey, visibilityKey, type Post } from '~/src/api/models.js';
import { t } from '~/src/kaios/l10n.js';
import { nav, registerSelectable, unregisterSelectable } from '~/src/kaios/nav.js';

const props = withDefaults(
  defineProps<{
    post: Post;
    /** Eligible for the highlight when the screen mounts: the feed marks the
     *  row it restores so a Back returns to the same place in the timeline. */
    initial?: boolean;
    /**
     * Whether the row may repeat the post it replies to. A reply list turns it
     * off for a reply whose parent is already on the screen: the quote then
     * says a second time what the reader can see above. A forward's quote is
     * never the parent in that conversation — the quote *is* the forward — so
     * it is not affected.
     */
    showReplyReference?: boolean;
  }>(),
  { initial: true, showReplyReference: true },
);

const emit = defineEmits<{
  select: [];
  /** The row became the highlighted entry; the feed uses it to arm the
   *  softkey actions that act on the highlighted post (reacting). */
  selected: [id: string];
}>();

/** One sample line and a count for the rest: a row is not the place for a gallery. */
const ATTACHMENT_LINES = 1;

const root = ref<HTMLElement | null>(null);
const uid = ref(0);

const isSelected = computed(() => uid.value !== 0 && nav.current === uid.value);

// Feed rows are text, never markup: the full body is what the detail screen
// renders as markdown.
const body = computed(() => excerpt(props.post));

const time = computed(() => {
  const relative = formatRelativeTime(props.post.publishedAt);
  if (!relative) return '';
  return 'key' in relative ? t(relative.key, relative.args) : relative.text;
});

const kind = computed(() => postKindKey(props.post.kind));
const visibility = computed(() => visibilityKey(props.post.visibility));

// A reply quotes its parent the same way a forward quotes its source; only the
// label differs. The replied-to quote is the one a list can suppress: the row
// only says it when the parent is not already on the screen.
const quote = computed(() =>
  props.post.forwardedFrom || (props.showReplyReference ? props.post.repliedTo : null),
);
const quoteLabelKey = computed(() =>
  props.post.forwardedFrom ? 'post_forwarded_from' : 'post_replied_to',
);

const chips = computed(() => reactionChips(props.post.reactions));

const counts = computed(() => {
  const list: Array<{ key: string; n: number }> = [];
  const { replies, boosts, reactions } = props.post.counts;
  if (replies) list.push({ key: 'post_count_replies', n: replies });
  if (boosts) list.push({ key: 'post_count_boosts', n: boosts });
  // The head's chain: the members are not rows of their own, so this is where
  // a row says the post carries on.
  if (props.post.chainedCount) list.push({ key: 'post_count_chain', n: props.post.chainedCount });
  // The sticker pills render the known reactions individually; the kinds count
  // is only for reactions without a bundled sticker (custom ones).
  if (reactions && !chips.value.length) list.push({ key: 'post_count_reactions', n: reactions });
  return list;
});

// The feed arms its softkey actions on the highlighted post, so a row reports
// when the highlight lands on it.
watch(isSelected, (selected) => {
  if (selected) emit('selected', props.post.id);
});

onMounted(() => {
  uid.value = registerSelectable({
    el: root,
    onEnter: () => emit('select'),
    // Posts are the screen's primary content: the highlight starts here even
    // when the page-flip controls sit above the list.
    initial: props.initial,
  });
});

onBeforeUnmount(() => {
  unregisterSelectable(uid.value);
});
</script>
