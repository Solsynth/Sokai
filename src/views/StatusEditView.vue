<template>
  <div class="kai-view">
    <KaiHeader :title="headerTitle" />

    <main class="kai-content">
      <!-- The label is the status's own words; the symbol a single emoji. Both
           are optional — a status can be just a visibility and a mood. -->
      <KaiTextArea v-model="label" :label="t('status_label')" :placeholder="t('status_label_hint')" />
      <KaiTextArea v-model="symbol" :label="t('status_symbol')" :placeholder="t('status_symbol_hint')" />

      <!-- The three pickers walk with the D-pad; each opens an option sheet. -->
      <KaiList class="kai-list--flat kai-list--flush">
        <KaiListItem :primary="t('status_type')" :secondary="typeLabel" @select="menu = 'type'" />
        <KaiListItem :primary="t('status_mood')" :secondary="moodLabel" @select="menu = 'mood'" />
        <KaiListItem :primary="t('status_clear')" :secondary="clearLabel" @select="menu = 'clear'" />
      </KaiList>

      <p v-if="errorKey" class="kai-text kai-text--error">{{ t(errorKey) }}</p>
    </main>

    <KaiOptionMenu
      v-if="menu === 'type'"
      :title="t('status_type')"
      :options="typeOptions"
      @select="setType"
      @cancel="menu = ''"
    />
    <KaiOptionMenu
      v-if="menu === 'mood'"
      :title="t('status_mood')"
      :options="moodOptions"
      @select="setMood"
      @cancel="menu = ''"
    />
    <KaiOptionMenu
      v-if="menu === 'clear'"
      :title="t('status_clear')"
      :options="clearOptions"
      @select="setClear"
      @cancel="menu = ''"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { type AccountStatus } from '~/src/api/models.js';
import { saveAccountStatus, type StatusDraft } from '~/src/api/solian.js';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import KaiOptionMenu, { type Option } from '~/src/components/KaiOptionMenu.vue';
import KaiTextArea from '~/src/components/KaiTextArea.vue';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { pop } from '~/src/kaios/views.js';
import { useAccountStore } from '~/src/stores/account.js';

// The current status arrives as JSON in the view params (the account screen
// fetched it); `null` there means a fresh custom status.
const props = withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({ }) });

const accountStore = useAccountStore();

/** l10n key for the last save failure; '' while healthy. */
const errorKey = ref('');
const submitting = ref(false);
/** Which option sheet is up: '' | 'type' | 'mood' | 'clear'. */
const menu = ref('');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const label = ref('');
const symbol = ref('');
const type = ref(0);
const attitude = ref(1);
const clearedAt = ref(0);

const typeOptions: Option[] = [
  { id: '0', label: t('status_type_online') },
  { id: '1', label: t('status_type_busy') },
  { id: '2', label: t('status_type_dnd') },
  { id: '3', label: t('status_type_invisible') },
];
const moodOptions: Option[] = [
  { id: '0', label: t('status_mood_positive') },
  { id: '1', label: t('status_mood_neutral') },
  { id: '2', label: t('status_mood_negative') },
];
const clearOptions: Option[] = [
  { id: '0', label: t('status_clear_never') },
  { id: String(HOUR_MS), label: t('status_clear_1h') },
  { id: String(DAY_MS), label: t('status_clear_1d') },
];

const TYPE_LABELS: Record<number, string> = {
  0: t('status_type_online'),
  1: t('status_type_busy'),
  2: t('status_type_dnd'),
  3: t('status_type_invisible'),
};
const MOOD_LABELS: Record<number, string> = {
  0: t('status_mood_positive'),
  1: t('status_mood_neutral'),
  2: t('status_mood_negative'),
};
const CLEAR_LABELS: Record<number, string> = {
  0: t('status_clear_never'),
  [HOUR_MS]: t('status_clear_1h'),
  [DAY_MS]: t('status_clear_1d'),
};

/** Editing an existing custom status, not creating one. */
const editing = computed(() => Boolean(seed.value && seed.value.isCustomized));
const typeLabel = computed(() => TYPE_LABELS[type.value] ?? t('status_type_online'));
const moodLabel = computed(() => MOOD_LABELS[attitude.value] ?? t('status_mood_neutral'));
const clearLabel = computed(() => CLEAR_LABELS[clearedAt.value] ?? t('status_clear_never'));
const headerTitle = computed(() => t(editing.value ? 'account_edit_status' : 'account_set_status'));

/** The status the account screen passed in, if any. */
const seed = computed<AccountStatus | null>(() => {
  const raw = props.params.status;
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as AccountStatus) : null;
  } catch (error) {
    return null;
  }
});

function setType(id: string): void {
  type.value = Number(id);
  menu.value = '';
}
function setMood(id: string): void {
  attitude.value = Number(id);
  menu.value = '';
}
function setClear(id: string): void {
  clearedAt.value = id === '0' ? 0 : Date.now() + Number(id);
  menu.value = '';
}

async function submit(): Promise<void> {
  if (accountStore.phase !== 'signed-in' || submitting.value) return;
  submitting.value = true;
  errorKey.value = '';
  try {
    const draft: StatusDraft = {
      type: type.value,
      attitude: attitude.value,
      label: label.value,
      symbol: symbol.value,
      clearedAt: clearedAt.value,
    };
    await saveAccountStatus(draft, editing.value);
    // The account screen remounts on pop and refetches the status.
    pop();
  } catch (error) {
    errorKey.value = 'status_save_error';
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  // Seed the form from the status being edited, when there is one.
  if (seed.value) {
    label.value = seed.value.label;
    symbol.value = seed.value.symbol;
    type.value = seed.value.type;
    attitude.value = seed.value.attitude ?? 1;
    clearedAt.value = seed.value.clearedAt;
  }

  setBaseSoftkeys(() => ({
    center: { label: t('action_open') },
    right: submitting.value ? { label: '' } : { label: t('compose_save'), onPress: submit },
  }));
});
</script>
