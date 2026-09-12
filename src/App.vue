<template>
  <div class="kai-app">
    <component :is="view" :params="currentView.params" />
    <KaiSoftkey />
  </div>
</template>

<script setup>
import { computed, watch } from 'vue';

import KaiSoftkey from './components/KaiSoftkey.vue';
import { setBackHandler } from './kaios/keys.js';
import { canGoBack, currentView, pop } from './kaios/views.js';
import AboutView from './views/AboutView.vue';
import AccountView from './views/AccountView.vue';
import DashboardView from './views/DashboardView.vue';
import ExploreView from './views/ExploreView.vue';
import PostView from './views/PostView.vue';
import SearchView from './views/SearchView.vue';

const VIEWS = {
  dashboard: DashboardView,
  explore: ExploreView,
  search: SearchView,
  post: PostView,
  account: AccountView,
  about: AboutView,
};

const view = computed(() => VIEWS[currentView.value.name]);

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
