import { onBeforeUnmount, ref, type Ref } from 'vue';

/**
 * Voice dictation: speech to text through the platform's Web Speech API.
 *
 * KaiOS 2.5 is Gecko 48, which ships no speech service of its own; KaiOS adds
 * `SpeechRecognition` on top and gates it behind the `speech-recognition`
 * privilege in the manifest (`audio-capture` covers the microphone). Whether a
 * given handset carries a *working* recognition backend is a firmware and
 * carrier question — the constructor can exist and still end every session the
 * moment it starts — so the whole feature is optional by design:
 * `canDictate()` hides the tool where the API is missing, and a session that
 * ends immediately simply stops listening.
 *
 * The fallback in the other direction — recording audio and sending it
 * somewhere to be transcribed — is deliberately absent: the recorder's bytes
 * are a voice message (`src/kaios/recorder.ts`), and there is no transcription
 * endpoint to post them to.
 *
 * `useDictation` is the consumer-facing half: it owns a session's lifecycle and
 * appends finished phrases to a draft the caller provides. Nothing here touches
 * the DOM.
 */

/** What the composer gets back while a session runs. */
export interface DictationCallbacks {
  /** A settled phrase, ready to keep. */
  onFinal: (text: string) => void;
  /** The phrase still being recognised; '' between phrases. */
  onInterim: (text: string) => void;
  /** A failure worth a line on screen, as an l10n key. */
  onError: (key: string) => void;
  /** The session is over, for any reason. Fires at most once. */
  onEnd: () => void;
}

/** A session in progress. The microphone belongs to it until it ends. */
export interface ActiveDictation {
  /** Ends the session after the current phrase; the backend still reports it. */
  stop(): void;
  /** Ends the session at once, discarding the phrase in flight. */
  abort(): void;
}

/* --- The platform's shape, as Gecko 48 / KaiOS presents it ----------------- */

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  /** The first result the event covers; earlier ones are already reported. */
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

interface WindowWithSpeech extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

/** `event.error` → the line to show. Unlisted codes get the generic one. */
const ERROR_KEYS: Record<string, string> = {
  'not-allowed': 'dictation_denied',
  'service-not-allowed': 'dictation_denied',
  'audio-capture': 'dictation_denied',
  'no-speech': 'dictation_no_speech',
  network: 'dictation_network',
};

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  const host = window as WindowWithSpeech;
  // The prefixed name is what WebKit-era builds — and some KaiOS firmwares —
  // expose; the standard name is what newer Gecko and the dev browser answer.
  return host.SpeechRecognition || host.webkitSpeechRecognition || null;
}

/**
 * Whether this host can dictate at all. A device without the constructor keeps
 * the text field as its only write path, which is why the composers ask.
 */
export function canDictate(): boolean {
  return recognitionConstructor() !== null;
}

/**
 * The language to listen in. The platform l10n library stamps the resolved
 * locale on `<html lang>` as it applies it, so the UI language and the
 * recognition language agree; before it loads (or without it) the navigator's
 * own language is the next best answer.
 */
function dictationLanguage(): string {
  return document.documentElement.lang || navigator.language || 'en-US';
}

/**
 * Starts a session, or returns `null` when the platform has no recognition or
 * refuses to start one (a refused `start()` is a permission problem, and the
 * caller reports it). The handle owns the microphone until `stop()`, `abort()`,
 * or the backend's own end; after that, no callback fires again.
 */
export function startDictation(callbacks: DictationCallbacks): ActiveDictation | null {
  const Recognition = recognitionConstructor();
  if (!Recognition) return null;

  let recognition: SpeechRecognitionLike;
  try {
    recognition = new Recognition();
  } catch (error) {
    return null;
  }

  recognition.lang = dictationLanguage();
  // A dictation is several phrases, and the live one is what tells the user the
  // microphone is working — so it runs until it is stopped, and reports the
  // phrase in flight as well as the settled ones.
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let finished = false;

  recognition.onresult = (event) => {
    if (finished) return;
    let final = '';
    let interim = '';
    const results = event.results;
    for (let index = event.resultIndex; index < results.length; index += 1) {
      const result = results[index];
      const alternative = result[0];
      if (!alternative) continue;
      if (result.isFinal) final += alternative.transcript;
      else interim += alternative.transcript;
    }
    if (final) callbacks.onFinal(final);
    callbacks.onInterim(interim);
  };

  recognition.onerror = (event) => {
    // An abort is ours, not a failure: the caller that aborted is unmounting
    // and has nothing left to show.
    if (finished) return;
    callbacks.onError(ERROR_KEYS[event.error] || 'dictation_error');
  };

  recognition.onend = () => {
    if (finished) return;
    finished = true;
    callbacks.onEnd();
  };

  try {
    recognition.start();
  } catch (error) {
    // Some builds throw here instead of reporting: a missing service, a
    // refused privilege, or a session that is somehow already open.
    return null;
  }

  return {
    stop: () => {
      if (finished) return;
      try {
        recognition.stop();
      } catch (error) {
        // Nothing to stop any more; `onend` has already told the caller.
      }
    },
    abort: () => {
      if (finished) return;
      finished = true;
      try {
        recognition.abort();
      } catch (error) {
        // Same as `stop()`: the session is over either way.
      }
    },
  };
}

/* --- The composer's half -------------------------------------------------- */

export interface DictationOptions {
  /** The draft as it stands; a finished phrase is appended to what this reads. */
  read: () => string;
  /** Stores the draft again once a phrase has landed. */
  write: (value: string) => void;
}

export interface Dictation {
  /** Whether this device offers speech at all; false hides the tool. */
  supported: boolean;
  /** A session is running; the backend owns the microphone until it ends. */
  listening: Ref<boolean>;
  /** The phrase being recognised, for the live line; '' between phrases. */
  interim: Ref<string>;
  /** l10n key for the last failure; '' while healthy. */
  errorKey: Ref<string>;
  start(): void;
  stop(): void;
  toggle(): void;
}

/**
 * Dictation for one composer. A phrase is appended to whatever the draft holds
 * *now* — never written over it: the user can type, or a store can replace the
 * draft, while the microphone is open, and tracking our own range through that
 * would cost the caret the field owns. The phrase in flight is shown by the
 * caller instead of being typed, which is also what keeps the draft's text
 * always something the user meant to keep.
 *
 * Call in `setup()`: an unmount releases the microphone, because a session left
 * running keeps the device's microphone indicator on.
 */
export function useDictation(options: DictationOptions): Dictation {
  const session = ref<ActiveDictation | null>(null);
  const listening = ref(false);
  const interim = ref('');
  const errorKey = ref('');

  function append(text: string): void {
    const phrase = text.trim();
    if (!phrase) return;
    const current = options.read();
    // Only a separator is added: the draft is markdown, so a trailing newline
    // is a deliberate break and must not gain a space after it.
    const separator = current === '' || /\s$/.test(current) ? '' : ' ';
    options.write(current + separator + phrase);
  }

  function finish(): void {
    session.value = null;
    listening.value = false;
    interim.value = '';
  }

  function start(): void {
    if (listening.value) return;
    errorKey.value = '';
    interim.value = '';
    // A backend that ends the session inside `start()` — the shape of a device
    // whose recognition service is not there — must not leave the button
    // latched, so the end signal is taken before the handle is adopted.
    let ended = false;
    const started = startDictation({
      onFinal: append,
      onInterim: (text) => {
        interim.value = text;
      },
      onError: (key) => {
        errorKey.value = key;
      },
      onEnd: () => {
        ended = true;
        finish();
      },
    });
    if (!started) {
      errorKey.value = 'dictation_error';
      return;
    }
    if (ended) return;
    session.value = started;
    listening.value = true;
  }

  function stop(): void {
    if (session.value) session.value.stop();
  }

  function toggle(): void {
    if (listening.value) stop();
    else start();
  }

  onBeforeUnmount(() => {
    if (session.value) session.value.abort();
  });

  return { supported: canDictate(), listening, interim, errorKey, start, stop, toggle };
}
