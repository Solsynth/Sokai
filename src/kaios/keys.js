import { activate, move, press } from './nav.js';

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
};

/**
 * Handles the Back key. Must return `true` when it consumed the key; returning
 * anything else lets the platform take it, which is how the app is left at the
 * top level (design-guide/key).
 * @type {null | (() => boolean)}
 */
let backHandler = null;

export function setBackHandler(handler) {
  backHandler = handler;
}

function isTextEntryFocused() {
  const element = document.activeElement;
  if (!element) return false;
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';
}

function onKeydown(event) {
  const textEntry = isTextEntryFocused();

  switch (event.key) {
    case KEY.UP:
    case KEY.DOWN:
      // Inside a text field the D-pad moves the caret (design-guide/key).
      if (textEntry) return;
      move(event.key === KEY.UP ? -1 : 1);
      break;

    case KEY.CENTER:
      activate();
      break;

    case KEY.SOFT_LEFT:
      press('left');
      break;

    case KEY.SOFT_RIGHT:
      press('right');
      break;

    case KEY.BACK:
      // In a text field Back clears a character; the platform owns that.
      if (textEntry) return;
      if (!backHandler || backHandler() !== true) return;
      break;

    default:
      return;
  }

  event.preventDefault();
}

/** @returns {() => void} uninstall */
export function installKeyHandler(target = document) {
  target.addEventListener('keydown', onKeydown);
  return () => target.removeEventListener('keydown', onKeydown);
}
