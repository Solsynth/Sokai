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
  /** The bio text, or '' when the server sent none. */
  bio: string;
  /** The account's level, 1 when the server sent none. */
  level: number;
  /** Total experience points earned. */
  experience: number;
  /** 0..1 progress toward the next level. */
  levelingProgress: number;
}

export interface Account {
  id: string;
  /** The unique handle, rendered as `@name`. */
  name: string;
  /** The pretty display name, or null when the server sent none. */
  nick: string | null;
  display: string;
  profile: AccountProfile | null;
  /** ISO timestamp of account creation, '' when the server sent none. */
  createdAt: string;
  /** The account's language code, or '' when the server sent none. */
  language: string;
  /** The account's region code, or '' when the server sent none. */
  region: string;
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
  /**
   * l10n key for a note shown on the signed-out screen — why the session
   * ended (an expired, unrenewable token), distinct from `errorKey` which is
   * the device flow's own failures. '' when there is nothing to say.
   */
  const noticeKey = ref('');

  /** Back to the signed-out state, dropping every sign-in trace. */
  function reset(): void {
    phase.value = 'anonymous';
    account.value = null;
    userCode.value = '';
    verificationUri.value = '';
    verificationUriComplete.value = '';
    waiting.value = false;
    errorKey.value = '';
    noticeKey.value = '';
  }

  return {
    phase,
    account,
    userCode,
    verificationUri,
    verificationUriComplete,
    waiting,
    errorKey,
    noticeKey,
    reset,
  };
});
