<template>
  <div class="kai-view">
    <KaiHeader :title="t('chat_search')" />

    <main class="kai-content">
      <!-- The field takes the initial highlight, so the keyboard is up on
           mount — the same arrangement as Search. -->
      <KaiInput
        v-model="query"
        :label="t('chat_search_label')"
        :placeholder="t('chat_search_hint')"
        @submit="onSubmit"
      />

      <KaiSpinner v-if="loading" />

      <template v-else>
        <p v-if="errorKey" class="kai-text kai-text--error">{{ t(errorKey) }}</p>

        <p v-else-if="submitted && results.length === 0" class="kai-text kai-text--secondary">
          {{ t('chat_search_empty', { q: submitted }) }}
        </p>

        <KaiList v-if="results.length > 0" class="kai-list--flat">
          <KaiChatRoomRow
            v-for="room in results"
            :key="room.id"
            :room="room"
            :summary="chat.summaries[room.id] || null"
            :self-account-id="chat.selfAccountId"
            @select="push('chat-room', { id: room.id })"
          />
        </KaiList>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';

import type { ChatRoom } from '~/src/api/models.js';
import { listChatRooms } from '~/src/api/solian.js';
import KaiChatRoomRow from '~/src/components/KaiChatRoomRow.vue';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiInput from '~/src/components/KaiInput.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiSpinner from '~/src/components/KaiSpinner.vue';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { push } from '~/src/kaios/views.js';
import { CHAT_PAGE, useChatStore } from '~/src/stores/chat.js';

/**
 * Room search: the room list route with a `query` term (the server answers it,
 * the same call the watch's `searchChatRooms` makes). Results are rendered with
 * the list's own room row, so a hit looks like the room it opens.
 */

withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({}) });

const chat = useChatStore();

const query = ref('');
/** The term the current results came from; `query` is what is being typed. */
const submitted = ref('');
const results = ref<ChatRoom[]>([]);
const loading = ref(false);
const errorKey = ref('');

/** Enter commits the field: search and leave the platform's text mode. */
async function onSubmit(): Promise<void> {
  const term = query.value.trim();
  if (!term) return;
  submitted.value = term;
  loading.value = true;
  errorKey.value = '';

  const active = document.activeElement as HTMLElement | null;
  if (active) active.blur();

  try {
    const result = await listChatRooms({ take: CHAT_PAGE, offset: 0, query: term });
    results.value = result.rooms;
  } catch (error) {
    errorKey.value = 'chat_search_error';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  setBaseSoftkeys(() => ({
    center: { label: t('action_open') },
    right: { label: '' },
  }));
});
</script>
