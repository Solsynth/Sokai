<template>
  <div class="kai-view">
    <KaiHeader :title="t('check_in_title')" />

    <main class="kai-content">
      <!-- Loading today's state -->
      <p v-if="loading" class="kai-text kai-text--secondary">{{ t('check_in_loading') }}</p>

      <!-- Couldn't read today's state: the screen is useless without it. -->
      <template v-else-if="errorKey && !result">
        <p class="kai-text kai-text--error">{{ t(errorKey) }}</p>
        <KaiList class="kai-list--flat">
          <KaiListItem :primary="t('error_retry')" @select="load" />
        </KaiList>
      </template>

      <!-- Not checked in yet: the prompt and the single action. -->
      <template v-else-if="!result">
        <p class="kai-text">{{ t('check_in_check_in_today') }}</p>
        <p class="kai-text kai-text--secondary">{{ t('check_in_description') }}</p>
        <KaiList class="kai-list--flat">
          <KaiListItem
            :primary="t('check_in_check_in')"
            :initial="true"
            @select="doCheckIn"
          />
        </KaiList>
        <p v-if="errorKey" class="kai-text kai-text--error">{{ t(errorKey) }}</p>
      </template>

      <!-- Checked in: today's fortune card, watch-scaled to the glanceables. -->
      <template v-else>
        <p class="kai-separator">{{ levelName }}</p>
        <p class="kai-text kai-text--secondary">
          {{ t('check_in_checked_in', { date: dateLabel }) }}
        </p>

        <template v-if="result.fortuneReport">
          <!-- The poem is the signature moment. -->
          <p v-if="result.fortuneReport.poem" class="kai-text">{{ result.fortuneReport.poem }}</p>
          <p v-if="result.fortuneReport.summary" class="kai-text kai-text--secondary">
            {{ result.fortuneReport.summary }}
          </p>

          <template v-if="fortuneItems.length">
            <p class="kai-separator">{{ t('check_in_fortunes') }}</p>
            <KaiList class="kai-list--flat">
              <KaiListItem
                v-for="item in fortuneItems"
                :key="item.label"
                :primary="item.label"
                :secondary="item.value"
              />
            </KaiList>
          </template>
        </template>
        <!-- The AI hasn't finished the report yet: a quiet note rather than a
             fabricated poem, the same fallback the other clients show. -->
        <p v-else class="kai-text kai-text--secondary">{{ t('check_in_report_pending') }}</p>

        <!-- The daily fortune saying, advisory. -->
        <p v-if="fortune && fortune.content" class="kai-text kai-text--secondary">
          {{ fortune.content }}
        </p>

        <template v-if="result.tips.length">
          <p class="kai-separator">{{ t('check_in_tips') }}</p>
          <div v-for="tip in result.tips" :key="tip.title">
            <p class="kai-text">{{ tip.title }}</p>
            <p v-if="tip.content" class="kai-text kai-text--secondary">{{ tip.content }}</p>
          </div>
        </template>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { type CheckInResult, type FortuneSaying } from '~/src/api/models.js';
import { checkIn, fetchCheckInResult, fetchDailyFortune } from '~/src/api/solian.js';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { useAccountStore } from '~/src/stores/account.js';

// The check-in screen takes no parameters; the entry only exists signed in.
withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({}) });

const accountStore = useAccountStore();

/** Today's check-in; null while unloaded or not yet checked in. */
const result = ref<CheckInResult | null>(null);
/** Today's fortune saying; advisory, so its absence never fails the screen. */
const fortune = ref<FortuneSaying | null>(null);
const loading = ref(false);
const checkingIn = ref(false);
/** l10n key for the last failure; '' while healthy. */
const errorKey = ref('');

/** The day's rank, localised; an unknown level falls back to the key itself. */
const levelName = computed(() => t('check_in_level_' + (result.value?.level ?? 0)));

/** "M/D" of the check-in — locale-free, like the rest of this app's dates. */
const dateLabel = computed(() => {
  const at = result.value?.createdAt ?? 0;
  if (!at) return '';
  const d = new Date(at);
  return String(d.getMonth() + 1) + '/' + String(d.getDate());
});

/**
 * The four glanceable fortunes, empty values dropped — the same reduction the
 * watch card makes from the 16-field report.
 */
const fortuneItems = computed(() => {
  const report = result.value?.fortuneReport;
  if (!report) return [];
  const rows: Array<{ label: string; value: string }> = [
    { label: t('fortune_love'), value: report.love },
    { label: t('fortune_study'), value: report.study },
    { label: t('fortune_work'), value: report.career },
    { label: t('fortune_health'), value: report.health },
  ];
  return rows.filter((row) => row.value.length > 0);
});

/** Loads today's state, then the advisory fortune saying. */
async function load(): Promise<void> {
  if (accountStore.phase !== 'signed-in' || loading.value) return;
  loading.value = true;
  errorKey.value = '';
  try {
    result.value = await fetchCheckInResult();
  } catch (error) {
    errorKey.value = 'error_load_failed';
  } finally {
    loading.value = false;
  }
  fortune.value = await fetchDailyFortune();
}

/** Performs today's check-in and shows the fresh result. */
async function doCheckIn(): Promise<void> {
  if (checkingIn.value) return;
  checkingIn.value = true;
  errorKey.value = '';
  try {
    const fresh = await checkIn();
    if (fresh) {
      result.value = fresh;
      // A check-in may surface today's saying; refresh it best-effort.
      fortune.value = await fetchDailyFortune();
    } else {
      errorKey.value = 'check_in_error';
    }
  } catch (error) {
    errorKey.value = 'check_in_error';
  } finally {
    checkingIn.value = false;
  }
}

onMounted(() => {
  // The Back key is the way up; the list rows carry the screen's actions.
  setBaseSoftkeys(() => ({
    center: { label: t('action_open') },
    right: { label: '' },
  }));
  void load();
});
</script>
