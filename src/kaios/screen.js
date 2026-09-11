/**
 * The system status bar.
 *
 * `manifest.webapp` does not request `fullscreen`, so KaiOS shows its 26px
 * status bar above the app. The app reserves that space by default — the header
 * carries it as top padding, so its background runs under the bar — because
 * that is the safe side of the one thing the platform does not tell us: whether
 * the bar is drawn *over* the app or the space is *reserved* for it. Reserving
 * twice costs a strip of empty title bar; not reserving loses the title.
 *
 * The single case that is detectable is the platform having reserved it already,
 * and only on a handset: the panel matches the viewport's width and is a bar
 * taller than it is. `screen` on anything else is a monitor, so a desktop
 * browser, the dev server and the gates all get the reserved space too — which
 * keeps what you see off-device the same layout as on it.
 */

export const STATUS_BAR_PX = 26;

/** Wider than any KaiOS panel; a match beyond this is a desktop monitor. */
const PANEL_MAX_PX = 480;

/**
 * @param {{ screenWidth: number, screenHeight: number, innerWidth: number, innerHeight: number }} metrics
 * @returns {number} pixels the app must leave clear at the top
 */
export function statusBarInset(metrics) {
  const onHandset =
    Math.abs(metrics.screenWidth - metrics.innerWidth) <= 1 && metrics.screenWidth <= PANEL_MAX_PX;
  if (!onHandset) return STATUS_BAR_PX;

  // On a handset a viewport shorter than the panel means the platform already
  // reserved the bar's space, and reserving it again would double the gap.
  if (metrics.screenHeight - metrics.innerHeight >= STATUS_BAR_PX) return 0;

  return STATUS_BAR_PX;
}

/**
 * Publishes the inset as `--kai-safe-top` on the document element; the header
 * consumes it. Called once at startup, before mount.
 * @returns {number} the inset that was applied
 */
export function applyStatusBarInset() {
  const screen = window.screen || {};
  const inset = statusBarInset({
    screenWidth: screen.width || 0,
    screenHeight: screen.height || 0,
    innerWidth: window.innerWidth || 0,
    innerHeight: window.innerHeight || 0,
  });

  document.documentElement.style.setProperty('--kai-safe-top', inset + 'px');
  return inset;
}
