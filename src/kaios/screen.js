/**
 * The system status bar.
 *
 * `manifest.webapp` does not request `fullscreen`, so KaiOS shows its 26px
 * status bar above the app. Whether the platform *reserves* that space or draws
 * the bar *over* the app varies by build, and there is no API that reports
 * which: the app is told the viewport it got and nothing more. The difference is
 * visible here — with the space reserved the viewport is 26px shorter than the
 * device panel; with the bar drawn over the app the viewport is the whole panel.
 *
 * So it is derived: a panel-sized viewport that also fills the panel's height
 * means the bar is on top of the app and the header has to clear it. The panel
 * check (`screen.width` matching the viewport, at phone width) is what keeps a
 * desktop window — where `screen` is the monitor — inset-free, which is also why
 * `npm run verify` and the dev server stay pixel-identical to before.
 */

export const STATUS_BAR_PX = 26;

/** Wider than any KaiOS panel; a match beyond this is a desktop monitor. */
const PANEL_MAX_PX = 480;

/**
 * @param {{ screenWidth: number, screenHeight: number, innerWidth: number, innerHeight: number }} metrics
 * @returns {number} pixels the app must leave clear at the top
 */
export function statusBarInset(metrics) {
  const panelMatchesViewport =
    Math.abs(metrics.screenWidth - metrics.innerWidth) <= 1 && metrics.screenWidth <= PANEL_MAX_PX;
  if (!panelMatchesViewport) return 0;

  // The viewport is shorter than the panel: the platform already reserved the
  // bar's space, so the app starts below it.
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
