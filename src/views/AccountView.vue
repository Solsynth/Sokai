<template>
  <div class="kai-view">
    <KaiHeader :title="t('nav_account')" />

    <main class="kai-content">
      <!-- Signed out: what sign-in is, and the action that starts it. -->
      <template v-if="accountStore.phase === 'anonymous'">
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

      <!-- Signed in: who the session is, and what it can do. The banner is
           optional — only when the profile carries one. -->
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

        <div
          class="kai-account__identity"
        >
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

        <KaiList class="kai-list--flat">
          <KaiListItem :primary="t('nav_about')" :secondary="t('nav_about_desc')" @select="push('about')" />
          <KaiListItem :primary="t('account_sign_out')" @select="signOut" />
        </KaiList>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';

import { fileUrl } from '~/src/api/solian.js';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { qrDataUrl } from '~/src/kaios/qrcode.js';
import { cancelSignIn, signOut, startSignIn } from '~/src/kaios/session.js';
import { useAccountStore } from '~/src/stores/account.js';
import { canGoBack, pop, push } from '~/src/kaios/views.js';

// Every screen is mounted with its stack entry's parameters; Account takes none.
withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({}) });

const accountStore = useAccountStore();

/**
 * The square profile picture, when the profile carries one. `fileUrl` maps the
 * drive file id to the same origin the banner uses.
 */
const pfp = computed(() => {
  const picture = accountStore.account?.profile?.picture;
  return picture ? fileUrl(picture.id) : '';
});

/**
 * The QR encodes the code-prefilled verification page when the server sent
 * one, and the bare page otherwise — the same payload the watch scans.
 */
const qrData = computed(() => {
  const payload = accountStore.verificationUriComplete || accountStore.verificationUri;
  return payload ? qrDataUrl(payload) : '';
});

onMounted(() => {
  setBaseSoftkeys(() => ({
    left: canGoBack.value ? { label: t('action_back'), onPress: pop } : { label: '' },
    center: { label: t('action_open') },
    // The code is dead the moment the flow is cancelled: offer the way out
    // while the user is still waiting for the other device.
    right:
      accountStore.phase === 'signing-in'
        ? { label: t('action_cancel'), onPress: cancelSignIn }
        : { label: '' },
  }));
});

// Leaving mid-poll must not keep polling in the background: the device code
// stays valid server-side until it expires, but this app stops asking.
onBeforeUnmount(() => {
  cancelSignIn();
});
</script>
