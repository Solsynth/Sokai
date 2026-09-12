/**
 * The system status bar.
 *
 * `manifest.webapp` does not request `fullscreen`, and the bar is drawn *over*
 * the app only when it forces that (`chrome.statusbar: "overlap"`). By default
 * the platform sizes the app's window to sit below the 26px bar, so the app's
 * top edge already clears it and any space the app reserves there is a band of
 * empty header — at 26px more than half again the header's own 36px, which is
 * what makes the bar read as twice its height.
 *
 * The one case that needs the inset is a handset whose viewport covers the
 * whole panel: the bar then sits on top of the header, and the header has to
 * grow so the title clears it. Nothing else has a system bar over the page at
 * all — `screen` is a monitor in a desktop browser, the simulator, the dev
 * server and the gates — so nothing else gets an inset.
 */

export const STATUS_BAR_PX = 26;

/** Wider than any KaiOS panel; a match beyond this is a desktop monitor. */
const PANEL_MAX_PX = 480;

export interface ScreenMetrics {
  screenWidth: number;
  screenHeight: number;
  innerWidth: number;
  innerHeight: number;
}

/** Pixels the app must leave clear at the top. */
export function statusBarInset(metrics: ScreenMetrics): number {
  const onHandset =
    Math.abs(metrics.screenWidth - metrics.innerWidth) <= 1 && metrics.screenWidth <= PANEL_MAX_PX;

  // A monitor has no system bar over the page — the platform draws and paints
  // it (`theme-color`) outside the window — so there is nothing to clear.
  if (!onHandset) return 0;

  // A viewport a bar shorter than the panel is a window the platform has put
  // *below* the bar already; reserving the space again doubles the gap.
  if (metrics.screenHeight - metrics.innerHeight >= STATUS_BAR_PX) return 0;

  return STATUS_BAR_PX;
}

/**
 * The dev server and `npm run preview` are desktop browsers; a handset is a
 * panel no wider than `PANEL_MAX_PX`. Hash path sync (see `hash.ts`) runs
 * where this is true and nowhere else — a KaiOS panel has no address bar, and
 * browser-history entries would fight the platform's Back key.
 */
export function isMonitor(): boolean {
  const screen = window.screen || {};
  const screenWidth = screen.width || 0;
  const innerWidth = window.innerWidth || 0;
  const onHandset = Math.abs(screenWidth - innerWidth) <= 1 && screenWidth <= PANEL_MAX_PX;
  return !onHandset;
}

/**
 * Publishes the inset as `--kai-safe-top` on the document element; the header
 * consumes it. Called once at startup, before mount, so the first paint is
 * right — and again on every resize, because the window the app is given can
 * settle *after* that first paint (the platform laying out its own chrome), and
 * a stale inset is exactly the band of empty header the measurement exists to
 * avoid.
 */
export function applyStatusBarInset(): number {
  const publish = (): number => {
    const screen = window.screen || {};
    const inset = statusBarInset({
      screenWidth: screen.width || 0,
      screenHeight: screen.height || 0,
      innerWidth: window.innerWidth || 0,
      innerHeight: window.innerHeight || 0,
    });

    document.documentElement.style.setProperty('--kai-safe-top', inset + 'px');
    return inset;
  };

  window.addEventListener('resize', publish);

  return publish();
}
