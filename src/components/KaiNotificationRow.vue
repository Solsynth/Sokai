<template>
  <li
    ref="root"
    tabindex="-1"
    nav-selectable="true"
    :nav-selected="isSelected ? 'true' : 'false'"
    class="kai-notification"
    @click="emit('select')"
  >
    <!-- Who it is about: their face when the server sent one, else the glyph
         its topic names — the reference tile's own split. -->
    <span class="kai-notification__lead">
      <KaiAvatar v-if="notification.picture" :file="notification.picture" size="xs" />
      <span v-else class="kai-notification__glyph" aria-hidden="true">
        <component :is="icon" />
      </span>
    </span>

    <span class="kai-notification__text">
      <span class="kai-notification__title">{{ notification.title }}</span>
      <span v-if="time" class="kai-notification__time">{{ time }}</span>
      <span v-if="detail" class="kai-notification__detail">{{ detail }}</span>
    </span>

    <!-- Unread is a dot rather than a fill: the highlight already owns the
         row's background, so the state needs a mark of its own. -->
    <span
      v-if="!notification.viewedAt"
      class="kai-notification__unread"
      role="img"
      :aria-label="t('notifications_unread')"
    ></span>
  </li>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue';
import {
  AtSign,
  Bell,
  CircleCheck,
  FilePlus,
  Gift,
  Globe,
  Heart,
  LogIn,
  MessageSquare,
  Reply,
  ShoppingBag,
  Sparkles,
  UserPlus,
  WalletMinimal,
} from '@lucide/vue';

import { formatRelativeTime, type AppNotification } from '~/src/api/models.js';
import { excerpt } from '~/src/content/markdown.js';
import { t } from '~/src/kaios/l10n.js';
import { nav, registerSelectable, unregisterSelectable } from '~/src/kaios/nav.js';
import KaiAvatar from './KaiAvatar.vue';

/**
 * One notification as a row: who it is about (their picture, or the glyph its
 * topic names), the server's title, when it happened, and the body clipped to a
 * row's worth of text.
 *
 * The reference client's tile does the same at its small size: the `compact`
 * reading drops the attached images and keeps the title, the time and the body,
 * which is the 240px case this screen is.
 */

const props = withDefaults(
  defineProps<{
    notification: AppNotification;
    /** Eligible for the highlight when the screen mounts. The first row takes
     *  it, the same contract the feed's rows have. */
    initial?: boolean;
  }>(),
  { initial: false },
);

const emit = defineEmits<{
  select: [];
  /** The highlight landed on this row — echoed with its notification id. */
  selected: [id: string];
}>();

/**
 * Topic → glyph, the Flutter tile's own map (`_getNotificationIcon`) widened
 * with the topics the SDK's preference list names. The server writes both the
 * singular and the plural spelling (`invites.realm` / `invites.realms`,
 * `wallet.transactions` / `wallets.transactions`), so both are matched; an
 * unknown topic — a third-party app's, say — falls back to the bell.
 */
const TOPIC_ICONS: Record<string, Component> = {
  'posts.mentions.new': AtSign,
  'post.replies': Reply,
  'posts.reactions.new': Heart,
  'posts.awards.new': Sparkles,
  'posts.new': FilePlus,
  'wallets.transactions': WalletMinimal,
  'wallet.transactions': WalletMinimal,
  'wallet.orders.paid': ShoppingBag,
  'subscriptions.orders': ShoppingBag,
  'subscriptions.begun': CircleCheck,
  'subscriptions.discontinued_in_app': CircleCheck,
  'gifts.claimed': Gift,
  'auth.login': LogIn,
  'auth.verification': LogIn,
  'relationships.friends.request': UserPlus,
  'invites.chat': MessageSquare,
  'invites.realm': Globe,
  'invites.realms': Globe,
};

const icon = computed(() => TOPIC_ICONS[props.notification.topic] || Bell);

const time = computed(() => {
  const label = formatRelativeTime(props.notification.createdAt);
  if (!label) return '';
  return 'key' in label ? t(label.key, label.args) : label.text;
});

/**
 * The body line: the server's text with its markdown stripped and its width
 * clipped the way a feed row's excerpt is (a CJK glyph costs two units, and
 * `-webkit-line-clamp` is not available on Gecko 48). A notification the
 * server left without a body falls back to its subtitle, which is the only
 * other text the wire carries.
 */
const detail = computed(() =>
  excerpt({
    content: props.notification.body || props.notification.subtitle,
    contentType: 0,
  }),
);

const root = ref<HTMLElement | null>(null);
const uid = ref(0);

const isSelected = computed(() => uid.value !== 0 && nav.current === uid.value);

watch(isSelected, (selected) => {
  if (selected) emit('selected', props.notification.id);
});

onMounted(() => {
  uid.value = registerSelectable({
    el: root,
    onEnter: () => emit('select'),
    initial: props.initial,
  });
});

onBeforeUnmount(() => {
  unregisterSelectable(uid.value);
});
</script>
