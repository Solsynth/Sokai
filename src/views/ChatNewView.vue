<template>
  <div class="kai-view">
    <KaiHeader :title="t('chat_new_message')" />

    <main class="kai-content">
      <!-- The search field takes the initial highlight, so the keyboard is up
           the moment the screen mounts — the same arrangement as Search. -->
      <KaiInput
        v-model="query"
        :label="t('chat_account_search_label')"
        :placeholder="t('chat_account_search_hint')"
        @submit="onSubmit"
      />

      <KaiSpinner v-if="loading" />

      <template v-else>
        <p v-if="errorKey" class="kai-text kai-text--error">{{ t(errorKey) }}</p>

        <p v-else-if="submitted && accounts.length === 0" class="kai-text kai-text--secondary">
          {{ t('chat_account_search_empty', { q: submitted }) }}
        </p>

        <KaiList class="kai-list--flat">
          <KaiListItem
            v-for="account in accounts"
            :key="account.id"
            :thumb="account.picture || ''"
            :primary="account.display"
            :secondary="'@' + account.name"
            @select="open(account.id)"
          />
        </KaiList>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import type { ChatAccount } from '~/src/api/models.js';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiInput from '~/src/components/KaiInput.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import KaiSpinner from '~/src/components/KaiSpinner.vue';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { push } from '~/src/kaios/views.js';
import { useChatStore } from '~/src/stores/chat.js';

/**
 * New message: find an account and open the one-to-one room with it (the
 * "create direct message" action on the clients' new-chat sheet). The room is
 * created on first use server-side, so picking the same account twice lands in
 * the same conversation.
 */

withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({}) });

const chat = useChatStore();

const query = ref('');
/** The term the current results came from; `query` is what is being typed. */
const submitted = ref('');
const accounts = ref<ChatAccount[]>([]);
const loading = ref(false);
const errorKey = ref('');

/** Enter commits the field: search for the term and leave the platform's text mode. */
async function onSubmit(): Promise<void> {
  const term = query.value.trim();
  if (!term) return;
  submitted.value = term;
  loading.value = true;
  errorKey.value = '';

  const active = document.activeElement as HTMLElement | null;
  if (active) active.blur();

  accounts.value = await chat.findAccounts(term);
  loading.value = false;
}

/** Opens (or starts) the direct room and pushes its thread. */
async function open(accountId: string): Promise<void> {
  errorKey.value = '';
  const room = await chat.startDirect(accountId);
  if (!room) {
    errorKey.value = 'chat_new_message_failed';
    return;
  }
  push('chat-room', { id: room.id });
}

onMounted(() => {
  setBaseSoftkeys(() => ({
    center: { label: t('action_open') },
    right: { label: '' },
  }));
});
</script>
