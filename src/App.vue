<template>
  <div class="kai-app">
    <component :is="view" :params="currentView.params" />
    <KaiSoftkey />
  </div>
</template>

<script setup lang="ts">
import { computed, watch, type Component } from 'vue';

import KaiSoftkey from '~/src/components/KaiSoftkey.vue';
import { installHashSync } from '~/src/kaios/hash.js';
import { setBackHandler } from '~/src/kaios/keys.js';
import { canGoBack, currentView, pop, stack } from '~/src/kaios/views.js';
import AboutView from '~/src/views/AboutView.vue';
import AccountView from '~/src/views/AccountView.vue';
import CalendarView from '~/src/views/CalendarView.vue';
import ChatComposeView from '~/src/views/ChatComposeView.vue';
import ChatInvitesView from '~/src/views/ChatInvitesView.vue';
import ChatNewView from '~/src/views/ChatNewView.vue';
import ChatRoomView from '~/src/views/ChatRoomView.vue';
import ChatSearchView from '~/src/views/ChatSearchView.vue';
import ChatStickersView from '~/src/views/ChatStickersView.vue';
import ChatView from '~/src/views/ChatView.vue';
import ComposeView from '~/src/views/ComposeView.vue';
import DashboardView from '~/src/views/DashboardView.vue';
import ExploreView from '~/src/views/ExploreView.vue';
import LightboxView from '~/src/views/LightboxView.vue';
import NotificationsView from '~/src/views/NotificationsView.vue';
import PostView from '~/src/views/PostView.vue';
import PublisherView from '~/src/views/PublisherView.vue';
import ReactionsView from '~/src/views/ReactionsView.vue';
import SearchView from '~/src/views/SearchView.vue';

const VIEWS: Record<string, Component> = {
  dashboard: DashboardView,
  calendar: CalendarView,
  explore: ExploreView,
  compose: ComposeView,
  publishers: PublisherView,
  search: SearchView,
  post: PostView,
  reactions: ReactionsView,
  notifications: NotificationsView,
  lightbox: LightboxView,
  chat: ChatView,
  'chat-room': ChatRoomView,
  'chat-compose': ChatComposeView,
  'chat-new': ChatNewView,
  'chat-invites': ChatInvitesView,
  'chat-search': ChatSearchView,
  'chat-stickers': ChatStickersView,
  account: AccountView,
  about: AboutView,
};

const view = computed(() => VIEWS[currentView.value.name]);

// The dev browser gets a URL that reflects the stack (`#/explore`, reload
// restores the screen, screens are bookmarkable); a handset gets none — the
// hardware Back key is the app's own history, see `kaios/hash.ts`.
installHashSync({
  allowedNames: Object.keys(VIEWS),
  applyStack: (entries) => {
    stack.value = entries;
  },
});

// Installed only while there is somewhere to go back to. With no handler the
// Back key falls through to the platform, which leaves the app — the behaviour
// the design guide requires at the top level.
watch(
  canGoBack,
  (backable) => {
    setBackHandler(
      backable
        ? () => {
            pop();
            return true;
          }
        : null,
    );
  },
  { immediate: true },
);
</script>
