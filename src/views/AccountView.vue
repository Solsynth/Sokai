<template>
  <div class="kai-view">
    <KaiHeader :title="t('nav_account')" />

    <main class="kai-content">
      <!-- Signed out: what sign-in is, and the action that starts it. -->
      <template v-if="accountStore.phase === 'anonymous'">
        <!-- A session that could not be renewed (expired token) lands here
             with an explanation instead of a silent sign-out. -->
        <p v-if="accountStore.noticeKey" class="kai-text kai-text--error">
          {{ t(accountStore.noticeKey) }}
        </p>

        <p class="kai-text">{{ t('account_sign_in_intro') }}</p>

        <KaiList class="kai-list--flat">
          <KaiListItem :primary="t('account_sign_in')" @select="startSignIn" />
        </KaiList>
      </template>

      <!-- Signing in: scan the QR, or type the code on the approving device. -->
      <template v-else-if="accountStore.phase === 'signing-in'">
        <div v-if="qrData" class="kai-account__qr">
          <img :src="qrData" alt="" />
        </div>

        <p class="kai-account__code">{{ accountStore.userCode }}</p>

        <p v-if="accountStore.waiting" class="kai-account__waiting">
          <span class="kai-spinner__ring"></span>
          {{ t('account_waiting') }}
        </p>

        <p class="kai-text kai-text--secondary">
          {{
            accountStore.verificationUriComplete
              ? t('account_scan_qr', { uri: accountStore.verificationUri })
              : t('account_enter_code', { uri: accountStore.verificationUri })
          }}
        </p>

        <p v-if="accountStore.errorKey" class="kai-text kai-text--error">{{ t(accountStore.errorKey) }}</p>

        <KaiList v-if="accountStore.errorKey" class="kai-list--flat">
          <KaiListItem :primary="t('error_retry')" @select="startSignIn" />
        </KaiList>
      </template>

      <!-- Signed in: who the session is, what it says, and what it can do.
           The banner is optional — only when the profile carries one. -->
      <template v-else>
        <div
          v-if="accountStore.account && accountStore.account.profile && accountStore.account.profile.background"
          class="kai-account__banner-wrap"
        >
          <img
            class="kai-account__banner"
            :src="fileUrl(accountStore.account.profile.background.id)"
            alt="Account background image"
          />
        </div>

        <div class="kai-account__identity">
          <img v-if="pfp" class="kai-account__pfp" :src="pfp" alt="Profile picture" />
          <div class="kai-account__who">
            <p class="kai-account__name">
              {{ accountStore.account ? accountStore.account.display : t('account_signed_in') }}
            </p>
            <p v-if="accountStore.account && accountStore.account.name" class="kai-account__handle">
              @{{ accountStore.account.name }}
            </p>
          </div>
        </div>

        <!-- Status: presence, the custom label, and the flags that modify it —
             the same section the watch account screen carries. -->
        <p class="kai-separator">{{ t('account_status') }}</p>

        <p v-if="statusFailed" class="kai-text kai-text--error">{{ t('error_load_failed') }}</p>
        <template v-else-if="statusLoading">
          <p class="kai-text kai-text--secondary">{{ t('account_status_loading') }}</p>
        </template>
        <template v-else-if="status">
          <div class="kai-account__status-line">
            <span
              class="kai-account__status-dot"
              :class="{ 'kai-account__status-dot--online': status.isOnline === true }"
            ></span>
            <span class="kai-account__status-text">
              {{ status.symbol ? status.symbol + ' ' : '' }}{{ status.label || t('account_no_status') }}
            </span>
          </div>
          <p v-if="status.type === 2" class="kai-text kai-text--secondary">{{ t('account_dnd') }}</p>
          <p v-if="status.type === 3" class="kai-text kai-text--secondary">{{ t('account_invisible') }}</p>
          <p v-if="status.clearedAt > 0" class="kai-text kai-text--secondary">
            {{ t('account_clears_at', { time: formatStamp(status.clearedAt) }) }}
          </p>
        </template>
        <template v-else>
          <p class="kai-text kai-text--secondary">{{ t('account_no_status') }}</p>
        </template>

        <KaiList class="kai-list--flat">
          <KaiListItem
            :primary="t('check_in_title')"
            :secondary="t('check_in_entry_hint')"
            @select="push('check-in')"
          />
          <KaiListItem
            :primary="t(status && status.isCustomized ? 'account_edit_status' : 'account_set_status')"
            @select="openStatusEditor"
          />
          <KaiListItem
            v-if="status && status.isCustomized"
            :primary="t('account_clear_status')"
            @select="confirmClearStatus"
          />
        </KaiList>

        <!-- Level and progress toward the next, when the profile carries them. -->
        <template v-if="accountStore.account && accountStore.account.profile">
          <p class="kai-separator">{{ t('account_levels') }}</p>
          <p class="kai-text">{{ t('account_level', { level: accountStore.account.profile.level }) }}</p>
          <div
            class="kai-progress"
            role="progressbar"
            :aria-valuenow="levelPercent"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div class="kai-progress__fill" :style="{ width: levelPercent + '%' }"></div>
          </div>
          <p class="kai-text kai-text--secondary">
            {{ t('account_experience', { xp: accountStore.account.profile.experience }) }}
          </p>
        </template>

        <!-- Bio, then the identity facts that date the account. -->
        <p class="kai-separator">{{ t('account_bio') }}</p>
        <p class="kai-text kai-text--secondary">
          {{ bio || t('account_no_bio') }}
        </p>

        <p v-if="joinedLabel" class="kai-text kai-text--secondary">
          {{ t('account_joined_at', { date: joinedLabel }) }}
        </p>
        <p v-if="accountStore.account && accountStore.account.region" class="kai-text kai-text--secondary">
          {{ t('account_region', { region: accountStore.account.region }) }}
        </p>

        <KaiList class="kai-list--flat">
          <KaiListItem :primary="t('nav_about')" :secondary="t('nav_about_desc')" @select="push('about')" />
          <KaiListItem :primary="t('account_sign_out')" @select="signOut" />
        </KaiList>
      </template>
    </main>

    <!-- Clear-status confirmation: destructive, so it asks twice. -->
    <KaiOptionMenu
      v-if="clearMenu"
      :title="t('status_clear_confirm')"
      :options="clearOptions"
      @select="onClearChoice"
      @cancel="clearMenu = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { type AccountStatus } from '~/src/api/models.js';
import { fetchAccountStatus, clearAccountStatus, fileUrl } from '~/src/api/solian.js';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import KaiOptionMenu, { type Option } from '~/src/components/KaiOptionMenu.vue';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { qrDataUrl } from '~/src/kaios/qrcode.js';
import { cancelSignIn, signOut, startSignIn } from '~/src/kaios/session.js';
import { useAccountStore } from '~/src/stores/account.js';
import { push } from '~/src/kaios/views.js';

// Every screen is mounted with its stack entry's parameters; Account takes none.
withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({}) });

const accountStore = useAccountStore();

/** The account's presence status; null while none is set. */
const status = ref<AccountStatus | null>(null);
const statusLoading = ref(false);
/** True when the status read (or a clear) failed; the block shows the error. */
const statusFailed = ref(false);
/** True while the clear-status confirmation sheet is up. */
const clearMenu = ref(false);

const clearOptions: Option[] = [
  { id: 'clear', label: t('account_clear_status') },
  { id: 'keep', label: t('action_cancel') },
];

/**
 * The square profile picture, when the profile carries one. `fileUrl` maps the
 * drive file id to the same origin the banner uses.
 */
const pfp = computed(() => {
  const picture = accountStore.account?.profile?.picture;
  return picture ? fileUrl(picture.id) : '';
});

/** 0..100 for the level progress bar; the server sends 0..1. */
const levelPercent = computed(() => {
  const progress = accountStore.account?.profile?.levelingProgress ?? 0;
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
});

/** The bio, or '' when the profile (or account) has none. */
const bio = computed(() => accountStore.account?.profile?.bio ?? '');

/** "YYYY-MM" of account creation, '' when the server sent no date. */
const joinedLabel = computed(() => formatYearMonth(accountStore.account?.createdAt ?? ''));

/** "YYYY-MM-DD HH:MM" — a compact, locale-free stamp for the auto-clear time. */
function formatStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => (n < 10 ? '0' + n : String(n));
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  );
}

/** "YYYY-MM" of an ISO timestamp; '' when it does not parse. */
function formatYearMonth(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const d = new Date(at);
  const month = d.getMonth() + 1;
  return d.getFullYear() + '-' + (month < 10 ? '0' + month : String(month));
}

/**
 * The QR encodes the code-prefilled verification page when the server sent
 * one, and the bare page otherwise — the same payload the watch scans.
 */
const qrData = computed(() => {
  const payload = accountStore.verificationUriComplete || accountStore.verificationUri;
  return payload ? qrDataUrl(payload) : '';
});

/** Fetches the presence status, best-effort; the rest of the page stays. */
async function loadStatus(): Promise<void> {
  if (accountStore.phase !== 'signed-in') return;
  statusLoading.value = true;
  statusFailed.value = false;
  try {
    status.value = await fetchAccountStatus();
  } catch (error) {
    statusFailed.value = true;
  } finally {
    statusLoading.value = false;
  }
}

/** Opens the status composer with the current status as the seed. */
function openStatusEditor(): void {
  push('status-edit', { status: JSON.stringify(status.value) });
}

/** The destructive path asks once more before the DELETE goes out. */
function confirmClearStatus(): void {
  clearMenu.value = true;
}

async function onClearChoice(choice: string): Promise<void> {
  clearMenu.value = false;
  if (choice !== 'clear') return;
  statusFailed.value = false;
  try {
    await clearAccountStatus();
    status.value = null;
  } catch (error) {
    statusFailed.value = true;
  }
}

onMounted(() => {
  // The hardware Back key is the way up (the design guide's Back/Clear rule).
  setBaseSoftkeys(() => ({
    center: { label: t('action_open') },
    // The code is dead the moment the flow is cancelled: offer the way out
    // while the user is still waiting for the other device.
    right:
      accountStore.phase === 'signing-in'
        ? { label: t('action_cancel'), onPress: cancelSignIn }
        : { label: '' },
  }));
  void loadStatus();
});

// Leaving mid-poll must not keep polling in the background: the device code
// stays valid server-side until it expires, but this app stops asking.
onBeforeUnmount(() => {
  cancelSignIn();
});
</script>
