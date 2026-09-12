/**
 * In-app voice recording: the device microphone, captured in the page.
 *
 * The platform's own recorder is a Web Activity — the Recorder app writes a
 * file and hands back a Blob, which is a whole app switch and gives the user
 * no way to see what the message will be. Here the mic is captured directly:
 * `getUserMedia` + `MediaRecorder`, with the elapsed time measured as it goes,
 * so the composer can show the take and the sender can stop when they are
 * done.
 *
 * Gecko 48 (KaiOS 2.5) specifics, all of which the app has to survive:
 *
 *  - `getUserMedia` is a Gecko extension on KaiOS builds (`mozGetUserMedia`);
 *    the standard `navigator.mediaDevices` form is tried first because it is
 *    what desktop Firefox and the dev browser answer.
 *  - `MediaRecorder.isTypeSupported` is not on every build, so a candidate is
 *    only *asked* for when the probe exists; otherwise the platform picks and
 *    `recorder.mimeType` says what it chose.
 *  - The privilege lives in the manifest (`audio-capture`): without it the
 *    call rejects, which is why every failure here resolves `null` rather than
 *    throwing — the caller falls back to the platform recorder.
 *
 * Nothing here touches the UI: it hands back a Blob, a file name and the
 * recorded length.
 */

/** A finished take. */
export interface Recording {
  blob: Blob;
  name: string;
  /** Measured wall-clock length of the take. */
  durationMs: number;
}

/** A take in progress: the composer polls `elapsed()` and stops when done. */
export interface ActiveRecording {
  /** Milliseconds recorded so far. */
  elapsed(): number;
  /** Stops and releases the microphone; `null` if nothing was captured. */
  stop(): Promise<Recording | null>;
  /** Stops, releases the microphone and discards the take. */
  cancel(): void;
}

/** Codec preference: Opus in Ogg is what Gecko 48 records natively. */
const MIME_CANDIDATES = ['audio/ogg;codecs=opus', 'audio/ogg', 'audio/webm', 'audio/mp4'];

/** Container → file extension, for the name the recipient sees. */
const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

/** Prefixed getUserMedia, the form KaiOS 2.5 builds actually ship. */
interface LegacyGetUserMedia {
  mozGetUserMedia?: (
    constraints: MediaStreamConstraints,
    onSuccess: (stream: MediaStream) => void,
    onError: (error: unknown) => void,
  ) => void;
}

function requestStream(): Promise<MediaStream | null> {
  const { promise, resolve } = Promise.withResolvers<MediaStream | null>();
  const constraints: MediaStreamConstraints = { audio: true };

  const mediaDevices = navigator.mediaDevices;
  if (mediaDevices && typeof mediaDevices.getUserMedia === 'function') {
    mediaDevices.getUserMedia(constraints).then(
      (stream) => resolve(stream),
      () => resolve(null),
    );
    return promise;
  }

  const legacy = navigator as unknown as LegacyGetUserMedia;
  if (typeof legacy.mozGetUserMedia === 'function') {
    legacy.mozGetUserMedia(
      constraints,
      (stream) => resolve(stream),
      () => resolve(null),
    );
    return promise;
  }

  resolve(null);
  return promise;
}

/**
 * Whether this host can record in the page at all. A device without the
 * media APIs, or without `MediaRecorder`, keeps the platform recorder as its
 * audio path — the caller checks this before offering the in-app one.
 */
export function canRecordInApp(): boolean {
  if (typeof MediaRecorder !== 'function') return false;
  const mediaDevices = navigator.mediaDevices;
  if (mediaDevices && typeof mediaDevices.getUserMedia === 'function') return true;
  return typeof (navigator as unknown as LegacyGetUserMedia).mozGetUserMedia === 'function';
}

/** The container the platform chose, as a file extension. */
function extensionFor(mimeType: string): string {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return EXTENSIONS[base] || 'ogg';
}

/** The first candidate the platform accepts; '' to let it choose. */
function pickMimeType(): string {
  // `isTypeSupported` is missing on some builds; asking a function that is not
  // there would throw, and guessing a codec the platform does not have would
  // make `start()` fail — so with no probe, the platform decides.
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  for (let index = 0; index < MIME_CANDIDATES.length; index += 1) {
    if (MediaRecorder.isTypeSupported(MIME_CANDIDATES[index])) return MIME_CANDIDATES[index];
  }
  return '';
}

let takeSeq = 0;

/**
 * Starts recording, or resolves `null` when the mic is unavailable or the user
 * refuses it. The returned handle owns the microphone: `stop()` and `cancel()`
 * both release it, and so must the caller on unmount (`cancel()`), because a
 * live track keeps the device's microphone open.
 */
export async function startRecording(): Promise<ActiveRecording | null> {
  if (!canRecordInApp()) return null;

  const stream = await requestStream();
  if (!stream) return null;

  let recorder: MediaRecorder;
  try {
    const mimeType = pickMimeType();
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch (error) {
    // A codec the platform advertised but refused: the microphone is already
    // open, so it has to be released before giving up.
    releaseStream(stream);
    return null;
  }

  const chunks: Blob[] = [];
  let startedAt = Date.now();
  let stoppedAt = 0;
  let discarded = false;
  const { promise, resolve } = Promise.withResolvers<Recording | null>();

  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstart = () => {
    // The permission prompt and the platform's spin-up happen before this, so
    // it — not the call to `start()` — is when the take actually begins.
    startedAt = Date.now();
  };
  recorder.onerror = () => {
    releaseStream(stream);
    resolve(null);
  };
  recorder.onstop = () => {
    releaseStream(stream);
    stoppedAt = Date.now();
    if (discarded || !chunks.length) {
      resolve(null);
      return;
    }
    const type = recorder.mimeType || 'audio/ogg';
    takeSeq += 1;
    resolve({
      blob: new Blob(chunks, { type }),
      name: 'voice-' + takeSeq + '.' + extensionFor(type),
      durationMs: Math.max(0, stoppedAt - startedAt),
    });
  };

  try {
    // A timeslice hands over chunks as they are captured, so a take that runs
    // into the platform's memory limits still has its earlier audio.
    recorder.start(1000);
  } catch (error) {
    releaseStream(stream);
    return null;
  }

  return {
    elapsed: () => Date.now() - startedAt,
    stop: () => {
      if (recorder.state !== 'inactive') recorder.stop();
      return promise;
    },
    cancel: () => {
      discarded = true;
      if (recorder.state !== 'inactive') recorder.stop();
      else releaseStream(stream);
    },
  };
}

/** Stops every track: an open track is what keeps the microphone light on. */
function releaseStream(stream: MediaStream): void {
  const tracks = stream.getTracks ? stream.getTracks() : [];
  for (let index = 0; index < tracks.length; index += 1) {
    if (typeof tracks[index].stop === 'function') tracks[index].stop();
  }
}
