/**
 * Picking or capturing media from the device.
 *
 * On KaiOS this is a Web Activity: the platform's Gallery answers `pick`, the
 * Camera `capture`, and the Recorder `record` — each hands the file back as a
 * Blob. No manifest permission is involved (the activities run in their own
 * apps; the permissions table has no `activity` entry). In a desktop browser
 * there is no Activity API, so a hidden file input stands in, keeping the dev
 * flow on the same code path (`capture` on the input opens the camera on
 * phones, mirroring the camera activity).
 */

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];

export interface PickedMedia {
  blob: Blob;
  name: string;
}

interface MozActivityResult {
  blob?: Blob;
  name?: string;
}

interface MozActivityLike {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  result: MozActivityResult | null;
}

interface MozActivityConstructor {
  new (spec: { name: string; data: { type: string[] } }): MozActivityLike;
}

interface WindowWithMozActivity extends Window {
  MozActivity?: MozActivityConstructor;
}

function pickViaActivity(
  name: string,
  types: string[],
  fallbackName: string,
): Promise<PickedMedia | null> {
  const { promise, resolve } = Promise.withResolvers<PickedMedia | null>();
  const activityConstructor = (window as WindowWithMozActivity).MozActivity;
  if (typeof activityConstructor !== 'function') {
    resolve(null);
    return promise;
  }

  const activity = new activityConstructor({ name, data: { type: types } });
  activity.onsuccess = () => {
    const result = activity.result;
    const blob = result && result.blob;
    resolve(blob ? { blob, name: (result && result.name) || fallbackName } : null);
  };
  // A cancelled pick is a normal outcome, not an error to surface.
  activity.onerror = () => resolve(null);
  return promise;
}

function pickViaInput(
  accept: string,
  capture: boolean,
  fallbackName: string,
): Promise<PickedMedia | null> {
  const { promise, resolve } = Promise.withResolvers<PickedMedia | null>();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  if (capture) input.capture = 'environment';
  input.style.display = 'none';
  const finish = () => {
    input.remove();
    const file = input.files && input.files[0];
    resolve(file ? { blob: file, name: file.name || fallbackName } : null);
  };
  input.addEventListener('change', finish, { once: true });
  document.body.appendChild(input);
  input.click();
  return promise;
}

/** Runs the activity, falling back to the file input when none exists. */
function pickMedia(
  activityName: string,
  types: string[],
  accept: string,
  capture: boolean,
  fallbackName: string,
): Promise<PickedMedia | null> {
  return pickViaActivity(activityName, types, fallbackName).then((picked) =>
    picked !== null ? picked : pickViaInput(accept, capture, fallbackName),
  );
}

/** Picks an image from the gallery, or `null` when the user cancels. */
export function pickImage(): Promise<PickedMedia | null> {
  return pickMedia('pick', IMAGE_TYPES, 'image/*', false, 'photo.jpg');
}

/** Takes a photo with the camera, or `null` when the user cancels. */
export function takePhoto(): Promise<PickedMedia | null> {
  return pickMedia('capture', ['image/*'], 'image/*', true, 'photo.jpg');
}

/** Records a video, or `null` when the user cancels. */
export function recordVideo(): Promise<PickedMedia | null> {
  return pickMedia('record', ['video/*'], 'video/*', false, 'clip.mp4');
}

/** Records an audio note, or `null` when the user cancels. */
export function recordAudio(): Promise<PickedMedia | null> {
  return pickMedia('record', ['audio/*'], 'audio/*', false, 'recording.m4a');
}
