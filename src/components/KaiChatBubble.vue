<template>
  <li
    ref="root"
    tabindex="-1"
    nav-selectable="true"
    :nav-selected="isSelected ? 'true' : 'false'"
    class="kai-chat-bubble"
    :class="{ 'kai-chat-bubble--own': own }"
    @click="activate"
  >
    <!-- Every bubble carries its sender: the avatar and the name sit above the
         body, on the side the bubble is on. The thread groups nothing, so a
         message read on its own still says who sent it. -->
    <span class="kai-chat-bubble__head">
      <KaiAvatar
        class="kai-chat-bubble__avatar"
        :file="message.sender.account.picture"
        :label="senderName"
        size="xs"
      />
      <span class="kai-chat-bubble__sender">{{ senderName }}</span>
    </span>

    <!-- A reply quotes what it answers: the sender and a one-line excerpt sit
         above the bubble's own body. The target is looked up in the loaded
         thread, so a reply to a message that left the window (or a server
         row that has not arrived yet) simply shows nothing above its text. -->
    <span v-if="quote" class="kai-chat-bubble__quote">
      <span class="kai-chat-bubble__quote-sender">{{ quoteSender }}</span>
      <span class="kai-chat-bubble__quote-text">{{ quoteText }}</span>
    </span>

    <!-- A sticker message's whole content is the `:prefix+slug:` placeholder.
         It renders as the sticker, not as that text — the rule both other
         clients apply (`isStandaloneStickerContent`). While the image id is
         still being looked up, or when the sticker is unknown, the bubble
         keeps the text so the message is never blank. -->
    <img
      v-if="stickerSrc"
      class="kai-chat-bubble__sticker"
      :src="stickerSrc"
      :alt="message.content"
    />
    <p v-else-if="message.content" class="kai-chat-bubble__content">{{ message.content }}</p>

    <!-- A voice note carries no content and no attachments — its media sits
         behind `meta.voice_url` — so without this the bubble would be blank.
         The length is the one readable thing about it. -->
    <p v-else-if="message.voiceDurationMs" class="kai-post__attach">
      <span class="kai-post__attach-kind">[{{ t('post_attach_audio') }}]</span>
      {{ formatClock(message.voiceDurationMs) }}
    </p>

    <!-- Pictures, videos (as their poster frame) and files, the same rows a
         post renders — a chat message is a post with one recipient. Two at
         most, then the count: the bubble is 85% of a 240px screen. -->
    <KaiAttachmentList :attachments="message.attachments" :limit="2" />

    <!-- The reactions the message drew, the same sticker pills a post row
         carries. -->
    <KaiReactionChips v-if="hasReactions" :reactions="message.reactions" />

    <span class="kai-chat-bubble__meta">
      <span v-if="time" class="kai-chat-bubble__time">{{ time }}</span>
      <span v-if="message.status === 'pending'" class="kai-chat-bubble__state">
        {{ t('chat_sending') }}
      </span>
      <span v-if="message.editedAt" class="kai-chat-bubble__edited">{{ t('post_edited') }}</span>
    </span>
  </li>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import {
  chatMemberName,
  formatClock,
  formatRelativeTime,
  stickerPlaceholder,
  type ChatMessage,
} from '~/src/api/models.js';
import { fileUrl } from '~/src/api/solian.js';
import KaiAttachmentList from '~/src/components/KaiAttachmentList.vue';
import KaiAvatar from '~/src/components/KaiAvatar.vue';
import KaiReactionChips from '~/src/components/KaiReactionChips.vue';
import { t } from '~/src/kaios/l10n.js';
import { nav, registerSelectable, unregisterSelectable } from '~/src/kaios/nav.js';
import { useChatStore } from '~/src/stores/chat.js';

/**
 * One message in a chat thread: its sender (avatar and name — the bubble is on
 * that sender's side), the content, the attachments, and a meta line with the
 * relative time and delivery state. A pending row shows a sending marker.
 *
 * Every message is a D-pad stop, so a press moves the highlight to the message
 * beside it — never over one. Enter opens the message's media in the lightbox
 * when it carries any, which is the post detail's rule turned round: there the
 * action decides the stop, here the row does, because a thread the arrows
 * skipped through would not be a thread.
 */

const props = withDefaults(
  defineProps<{
    message: ChatMessage;
    /** Whether the bubble belongs to the signed-in account (right-aligned). */
    own?: boolean;
    /** Eligible for the highlight when the thread mounts — the newest media. */
    initial?: boolean;
  }>(),
  { own: false, initial: false },
);

const emit = defineEmits<{
  /** The message's media should open in the viewer. */
  open: [];
  /** The highlight landed on this bubble — echoed with the message id. */
  selected: [id: string];
}>();

const root = ref<HTMLElement | null>(null);
const uid = ref(0);

const isSelected = computed(() => uid.value !== 0 && nav.current === uid.value);

/** The highlight landed on the bubble: the thread's screens track the row. */
watch(isSelected, (selected) => {
  if (selected) emit('selected', props.message.id);
});

/** A message with something to open: its attachments, or a voice note's URL. */
const actionable = computed(
  () => props.message.attachments.length > 0 || Boolean(props.message.voiceUrl),
);

function activate(): void {
  if (actionable.value) emit('open');
}

onMounted(() => {
  uid.value = registerSelectable({
    el: root,
    onEnter: activate,
    initial: props.initial,
  });
});

onBeforeUnmount(() => {
  if (uid.value) unregisterSelectable(uid.value);
});

/** The in-room nick first, then the account's — `SnChatMember.displayName`. */
const chat = useChatStore();

const senderName = computed(() => chatMemberName(props.message.sender));

/**
 * The sticker this message is, as an image. The wire carries only the
 * placeholder, so its drive id is resolved once (the store caches it) and the
 * picture then loads through the usual thumb preset — never the original
 * 1080px PNG the lookup's `/open` sibling redirects to.
 */
const placeholder = computed(() => stickerPlaceholder(props.message.content));
const stickerSrc = computed(() => {
  if (!placeholder.value) return '';
  const image = chat.stickerImageFor(placeholder.value);
  return image ? fileUrl(image) : '';
});

watch(placeholder, (value) => {
  if (value) void chat.resolveStickerImage(value);
}, { immediate: true });

const time = computed(() => {
  const relative = formatRelativeTime(props.message.createdAt);
  if (!relative) return '';
  return 'key' in relative ? t(relative.key, relative.args) : relative.text;
});

/**
 * The message this one answers, from the loaded thread. A reply whose target
 * left the window (or has not arrived) quotes nothing — the bubble keeps its
 * own body without a hollow reference above it.
 */
const quote = computed(() => {
  const targetId = props.message.repliedMessageId;
  if (!targetId) return null;
  const thread = chat.messages[props.message.roomId] || [];
  return thread.find((item) => item.id === targetId) || null;
});

const quoteSender = computed(() => (quote.value ? chatMemberName(quote.value.sender) : ''));

/** The one line the quote shows: the target's own words, else what it holds. */
const quoteText = computed(() => {
  const target = quote.value;
  if (!target) return '';
  if (target.content) return target.content;
  if (target.voiceDurationMs) return t('chat_voice') + ' · ' + formatClock(target.voiceDurationMs);
  return target.attachments.length === 1
    ? t('chat_attachment')
    : t('chat_attachments', { n: target.attachments.length });
});

/** Whether the message drew any reactions worth a pill row. */
const hasReactions = computed(() => Object.keys(props.message.reactions).length > 0);
</script>
