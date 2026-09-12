import { activate, move, press } from '~/src/kaios/nav.js';

/**
 * Hardware key names reported by KaiOS as `KeyboardEvent.key`.
 * Source: design-guide/key, and the softkey example in
 * getting-started/main-concepts/softkeys.
 */
export const KEY = {
  UP: 'ArrowUp',
  DOWN: 'ArrowDown',
  LEFT: 'ArrowLeft',
  RIGHT: 'ArrowRight',
  /** Centre software key (CSK). */
  CENTER: 'Enter',
  SOFT_LEFT: 'SoftLeft',
  SOFT_RIGHT: 'SoftRight',
  /** Back/Clear key. On combined-key devices this is also End/Power. */
  BACK: 'Backspace',
  /** The phone pad: 2 up, 4 left, 6 right, 8 down — how a zoomed picture pans. */
  PAD_UP: '2',
  PAD_LEFT: '4',
  PAD_RIGHT: '6',
  PAD_DOWN: '8',
  /** 1 turns counterclockwise, 3 turns clockwise. */
  ROTATE_CCW: '1',
  ROTATE_CW: '3',
} as const;

/**
 * Handles the Back key. Must return `true` when it consumed the key; returning
 * anything else lets the platform take it, which is how the app is left at the
 * top level (design-guide/key).
 */
let backHandler: (() => boolean) | null = null;

export function setBackHandler(handler: (() => boolean) | null): void {
  backHandler = handler;
}

/**
 * The text entry the platform owns while it has focus, or null. Inside one the
 * guide gives the D-pad to the caret and Back to clearing a character
 * (design-guide/key) — but only for a press the caret can actually use, which
 * is what `caretHasLine` decides. Handing every press to the field would trap
 * the D-pad there: the highlight could never reach the rest of the screen.
 */
function focusedTextEntry(): HTMLInputElement | HTMLTextAreaElement | null {
  const element = document.activeElement as HTMLElement | null;
  if (!element) return null;
  if (element.tagName === 'INPUT') return element as HTMLInputElement;
  if (element.tagName === 'TEXTAREA') return element as HTMLTextAreaElement;
  return null;
}

/**
 * Whether the caret has a line to move to inside `entry`. A one-line `<input>`
 * never has one. A `<textarea>` has one line per newline on that side of the
 * caret — the logical lines are all a key handler can see; soft wraps are
 * layout. Where there is no line the field has no use for the press, so the
 * highlight takes it and `select()` moves focus off the field. That is the
 * D-pad's way out, and the reason a compose draft is never a dead end.
 *
 * @param delta -1 for UP, 1 for DOWN
 */
function caretHasLine(entry: HTMLInputElement | HTMLTextAreaElement, delta: number): boolean {
  if (entry.tagName !== 'TEXTAREA') return false;
  // A host may report no caret at all (`null`); the start of the draft is the
  // safe reading, so the first press leaves a field it cannot place the caret in.
  const caret = entry.selectionStart ?? 0;
  return delta < 0
    ? entry.value.slice(0, caret).indexOf('\n') !== -1
    : entry.value.slice(caret).indexOf('\n') !== -1;
}

function onKeydown(event: Event): void {
  const key = (event as KeyboardEvent).key;
  const textEntry = focusedTextEntry();

  switch (key) {
    case KEY.UP:
    case KEY.DOWN: {
      // Inside a text field the D-pad moves the caret (design-guide/key) until
      // the caret runs out of lines; then the press belongs to the highlight,
      // which is how the screen is left again.
      const delta = key === KEY.UP ? -1 : 1;
      if (textEntry && caretHasLine(textEntry, delta)) return;
      move(delta);
      break;
    }

    case KEY.CENTER:
      // A multi-line field takes Enter for its newline — the draft is markdown,
      // and consuming the key here would make a line break impossible. A
      // one-line field has no native use for Enter, so it runs the app's action
      // instead (committing the search).
      if (textEntry && textEntry.tagName === 'TEXTAREA') return;
      activate();
      break;

    case KEY.SOFT_LEFT:
      press('left');
      break;

    case KEY.SOFT_RIGHT:
      press('right');
      break;

    case KEY.BACK:
      // In a text field Back clears a character; the platform owns that —
      // but only while there is a character to clear. An empty field has
      // nothing for Back to do, so the press works like the normal case and
      // goes up a level (the design guide's Back/Clear rule).
      if (textEntry && textEntry.value.length > 0) return;
      if (!backHandler || backHandler() !== true) return;
      break;

    default:
      return;
  }

  event.preventDefault();
}

/** @returns uninstall */
export function installKeyHandler(target: EventTarget = document): () => void {
  target.addEventListener('keydown', onKeydown);
  return () => target.removeEventListener('keydown', onKeydown);
}
