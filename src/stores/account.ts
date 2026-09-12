import { ref } from 'vue';
import { defineStore } from 'pinia';

/**
 * The account store: the one global, app-wide store (Pinia).
 *
 * It owns the public face of a session — the phase, the signed-in identity and
 * the sign-in screen's UI surface — and nothing else. The OAuth device-flow
 * mechanics (tokens, polling, refresh, localStorage persistence) stay private
 * to `~/src/kaios/session.ts`, which drives this store: views read it, the
 * flow writes it.
 */

export type AccountPhase = 'anonymous' | 'signing-in' | 'signed-in';

/** A drive file reference — any profile image (banner or picture). */
export interface ProfileFile {
  id: string;
}

/** Profile images are optional; each keeps only its file `id`. */
export interface AccountProfile {
  background: ProfileFile | null;
  picture: ProfileFile | null;
}

export interface Account {
  id: string;
  /** The unique handle, rendered as `@name`. */
  name: string;
  /** The pretty display name, or null when the server sent none. */
  nick: string | null;
  display: string;
  profile: AccountProfile | null;
}

export const useAccountStore = defineStore('account', () => {
  const phase = ref<AccountPhase>('anonymous');
  const account = ref<Account | null>(null);
  /** The code to type on the approving device, while `phase === 'signing-in'`. */
  const userCode = ref('');
  /** The page to open on that device; the code is entered there. */
  const verificationUri = ref('');
  /** The verification page with the code prefilled, when the server sent it —
   *  the QR code's payload, so scanning needs no typing. */
  const verificationUriComplete = ref('');
  /** True while a poll is in flight waiting for approval. */
  const waiting = ref(false);
  /** l10n key for the last sign-in failure; '' when the flow is healthy. */
  const errorKey = ref('');

  /** Back to the signed-out state, dropping every sign-in trace. */
  function reset(): void {
    phase.value = 'anonymous';
    account.value = null;
    userCode.value = '';
    verificationUri.value = '';
    verificationUriComplete.value = '';
    waiting.value = false;
    errorKey.value = '';
  }

  return {
    phase,
    account,
    userCode,
    verificationUri,
    verificationUriComplete,
    waiting,
    errorKey,
    reset,
  };
});
