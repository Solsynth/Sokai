<template>
  <li
    ref="root"
    tabindex="-1"
    nav-selectable="true"
    :nav-selected="isSelected ? 'true' : 'false'"
    class="kai-post"
    @click="emit('select')"
  >
    <span class="kai-post__author">{{ post.author.display }}</span>

    <span class="kai-post__meta">
      <span v-if="time" class="kai-post__time">{{ time }}</span>
      <span v-if="post.repliedTo" class="kai-post__ref">
        {{ t('post_replied_to', { name: post.repliedTo.author.display }) }}
      </span>
      <span v-if="post.forwardedFrom" class="kai-post__ref">
        {{ t('post_forwarded_from', { name: post.forwardedFrom.author.display }) }}
      </span>
      <span v-for="tag in post.tags" :key="tag" class="kai-tag">{{ tag }}</span>
    </span>

    <span class="kai-post__excerpt">{{ body }}</span>
  </li>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { excerpt } from '../content/markdown.js';
import { formatRelativeTime } from '../api/models.js';
import { t } from '../kaios/l10n.js';
import { nav, registerSelectable, unregisterSelectable } from '../kaios/nav.js';

const props = defineProps({
  post: { type: Object, required: true },
});

const emit = defineEmits(['select']);

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

onMounted(() => {
  uid.value = registerSelectable({
    el: root,
    onEnter: () => emit('select'),
  });
});

onBeforeUnmount(() => {
  unregisterSelectable(uid.value);
});
</script>
