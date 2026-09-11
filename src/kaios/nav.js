import { computed, nextTick, reactive, shallowRef } from 'vue';

/**
 * D-pad navigation and softkey state.
 *
 * Components register themselves as selectable; this module owns *which* one is
 * selected and what the three hardware keys do. Selection is tracked by a uid
 * rather than a DOM attribute so Vue's rendering stays authoritative — nothing
 * here writes to the DOM except `focus()`/`scrollIntoView()`.
 *
 * Design-guide behaviour implemented here:
 *  - list views loop: DOWN at the last item goes to the first, UP at the first
 *    goes to the last (design-guide/basic-navigation)
 *  - the softkey bar reflects the current selection (design-guide/key)
 */

export const nav = reactive({
  /** uid of the selected entry, or 0 when nothing is selected. */
  current: 0,
  /** Bumped on every registry change so computeds re-evaluate. */
  revision: 0,
});

let nextUid = 0;
let refreshScheduled = false;

/** @type {Array<{ uid: number, el: object, onEnter: Function|null }>} */
const registry = [];

const DOCUMENT_POSITION_PRECEDING = 0x02;
const DOCUMENT_POSITION_FOLLOWING = 0x04;

function emptyBase() {
  return {
    left: { label: '', onPress: null },
    center: { label: '' },
    right: { label: '', onPress: null },
  };
}

const baseFactory = shallowRef(emptyBase);

function isLive(entry) {
  const node = entry.el.value;
  // `isConnected` is FF53+; parentNode is enough for a mounted node.
  return Boolean(node) && Boolean(node.parentNode || node === document.documentElement);
}

function inDocumentOrder(a, b) {
  const x = a.el.value;
  const y = b.el.value;
  if (x === y) return 0;

  const position = x.compareDocumentPosition(y);
  if (position & DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

function ordered() {
  return registry.filter(isLive).sort(inDocumentOrder);
}

function select(entry) {
  nav.current = entry.uid;

  const node = entry.el.value;
  if (!node) return;

  // Focus moves the native scroll region and puts the platform's own input
  // handling (text edit mode) on the right element.
  if (typeof node.focus === 'function') node.focus();
  if (typeof node.scrollIntoView === 'function') {
    node.scrollIntoView({ block: 'nearest' });
  }
}

function scheduleRefresh() {
  if (refreshScheduled) return;
  refreshScheduled = true;
  // Registration happens during mount, before template refs are assigned and
  // before the DOM is patched, so selection has to be resolved afterwards.
  nextTick(() => {
    refreshScheduled = false;
    refresh();
  });
}

function refresh() {
  nav.revision += 1;

  const list = ordered();
  if (!list.length) {
    nav.current = 0;
    return;
  }

  if (!list.some((entry) => entry.uid === nav.current)) {
    select(list[0]);
  }
}

/**
 * @param {{ el: object, onEnter?: Function|null }} entry `el` is a template ref
 * @returns {number} uid to pass back to `unregisterSelectable`
 */
export function registerSelectable({ el, onEnter = null }) {
  const entry = { uid: ++nextUid, el, onEnter };
  registry.push(entry);
  scheduleRefresh();
  return entry.uid;
}

export function unregisterSelectable(uid) {
  const index = registry.findIndex((entry) => entry.uid === uid);
  if (index !== -1) registry.splice(index, 1);
  scheduleRefresh();
}

/** One design-guide row: 4rem at the 1rem = 10px baseline. */
const SCROLL_STEP_PX = 40;

/**
 * Scrolls the view's content region. On a device there is no touch and no wheel,
 * and the key handler consumes the arrow keys, so nothing else will ever scroll a
 * page that has no highlight to move — the rest of the content would simply be
 * unreachable. `.kai-content` is the layout contract documented in
 * `src/styles/kaios.css`.
 */
function scrollContent(delta) {
  const scroller = document.querySelector('.kai-content');
  if (!scroller) return;
  scroller.scrollTop += delta * SCROLL_STEP_PX;
}

/**
 * Moves the highlight by `delta`, wrapping at the ends of the list
 * (design-guide: list views loop). With fewer than two selectable elements there
 * is nothing to move between, so the press scrolls the view instead.
 */
export function move(delta) {
  const list = ordered();

  if (list.length < 2) {
    scrollContent(delta);
    return;
  }

  let index = list.findIndex((entry) => entry.uid === nav.current);
  index = index === -1 ? 0 : (index + delta + list.length) % list.length;

  select(list[index]);
}

const currentEntry = computed(() => {
  void nav.revision;
  return registry.find((entry) => entry.uid === nav.current) || null;
});

/**
 * Softkey bar contents. `center` always activates the highlighted item, so
 * views only choose the label.
 *
 * @param {() => { left?: object, center?: object, right?: object }} factory
 *   Called on every recompute, so labels derived from `t()` stay current when
 *   the locale changes.
 */
export function setBaseSoftkeys(factory) {
  baseFactory.value = typeof factory === 'function' ? factory : () => factory;
  nav.revision += 1;
}

export const softkeys = computed(() => {
  void nav.revision;

  const base = Object.assign(emptyBase(), baseFactory.value());
  const entry = currentEntry.value;

  return {
    left: base.left || { label: '', onPress: null },
    center: {
      label: base.center.label || '',
      onPress: activate,
    },
    right: base.right || { label: '', onPress: null },
  };
});

/** Runs the highlighted item's action (centre software key). */
export function activate() {
  const entry = currentEntry.value;
  if (entry && typeof entry.onEnter === 'function') entry.onEnter();
}

/** Runs the press handler of a side softkey. */
export function press(side) {
  const key = softkeys.value[side];
  if (key && typeof key.onPress === 'function') key.onPress();
}
