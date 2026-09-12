<template>
  <div class="kai-view">
    <KaiHeader :title="t('nav_account')" />

    <main class="kai-content">
      <!-- Signed out: what sign-in is, and the action that starts it. -->
      <template v-if="session.phase === 'anonymous'">
        <p class="kai-text">{{ t('account_sign_in_intro') }}</p>

        <KaiList class="kai-list--flat">
          <KaiListItem :primary="t('account_sign_in')" @select="startSignIn" />
        </KaiList>
      </template>

      <!-- Signing in: the code to type on the approving device. -->
      <template v-else-if="session.phase === 'signing-in'">
        <p class="kai-text kai-text--secondary">
          {{ t('account_enter_code', { uri: session.verificationUri }) }}
        </p>

        <p class="kai-account__code">{{ session.userCode }}</p>

        <KaiSpinner v-if="session.waiting" :label="t('account_waiting')" />

        <p v-if="session.errorKey" class="kai-text kai-text--error">{{ t(session.errorKey) }}</p>

        <KaiList v-if="session.errorKey" class="kai-list--flat">
          <KaiListItem :primary="t('error_retry')" @select="startSignIn" />
        </KaiList>
      </template>

      <!-- Signed in: who the session is, and what it can do. -->
      <template v-else>
        <div class="kai-account__identity">
          <p class="kai-account__name">{{ session.account ? session.account.display : t('account_signed_in') }}</p>
          <p v-if="session.account && session.account.nick" class="kai-account__handle">
            @{{ session.account.nick }}
          </p>
        </div>

        <KaiList class="kai-list--flat">
          <KaiListItem :primary="t('nav_about')" :secondary="t('nav_about_desc')" @select="push('about')" />
          <KaiListItem :primary="t('account_sign_out')" @select="signOut" />
        </KaiList>
      </template>
    </main>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted } from 'vue';

import KaiHeader from '../components/KaiHeader.vue';
import KaiList from '../components/KaiList.vue';
import KaiListItem from '../components/KaiListItem.vue';
import KaiSpinner from '../components/KaiSpinner.vue';
import { t } from '../kaios/l10n.js';
import { setBaseSoftkeys } from '../kaios/nav.js';
import { cancelSignIn, session, signOut, startSignIn } from '../kaios/session.js';
import { canGoBack, pop, push } from '../kaios/views.js';

// Every screen is mounted with its stack entry's parameters; Account takes none.
defineProps({
  params: { type: Object, default: () => ({}) },
});

onMounted(() => {
  setBaseSoftkeys(() => ({
    left: canGoBack.value ? { label: t('action_back'), onPress: pop } : { label: '' },
    center: { label: t('action_open') },
    // The code is dead the moment the flow is cancelled: offer the way out
    // while the user is still waiting for the other device.
    right:
      session.phase === 'signing-in'
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
