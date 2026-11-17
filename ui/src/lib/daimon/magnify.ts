/// Ctrl + wheel magnification for Windows and Linux — the counterpart of macOS pinch-zoom
/// (WKWebView's allowsMagnification, see app/src/bun/macMagnification.ts).
///
/// Like the macOS one it is a *visual* zoom: the page is scaled as a picture around the
/// pointer, nothing reflows. It eases toward each new level instead of jumping, gives a
/// little past 100% and springs back (rubber band), and at exactly 100% the transform is
/// removed altogether so text is crisp again. Touchpad pinches arrive as ctrl+wheel too.
/// Ctrl +/- (the keyboard) is left alone.

const MAX = 4;
/** How far past 100% a zoom-out may stretch before springing back. */
const RUBBER_MIN = 0.92;
/** Zoom per wheel pixel: a mouse notch (~100px) is ~×1.22, a pinch step a little. */
const PER_PX = 0.002;
/** Share of the remaining distance covered each frame (60 fps): smooth, still snappy. */
const EASE = 0.22;
/** Wheel quiet for this long ends a gesture: an overshoot springs back to 100%. */
const SETTLE_MS = 140;

export function installMagnify(target: HTMLElement): () => void {
  // Current (drawn) and target transform: translate(x, y) scale(s), origin top-left.
  let s = 1, x = 0, y = 0;
  let ts = 1, tx = 0, ty = 0;
  let frame = 0;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Keep the scaled page covering the window: no empty margin on any side. */
  const clampPan = (scale: number, px: number, py: number): [number, number] => {
    if (scale === 1) return [0, 0];
    // Below 100% (rubber band only): shrink towards the pointer, as if pulled there.
    if (scale < 1) return [px, py];
    const w = innerWidth, h = innerHeight;
    return [Math.min(0, Math.max(w - w * scale, px)), Math.min(0, Math.max(h - h * scale, py))];
  };

  const apply = () => {
    if (s === 1 && x === 0 && y === 0) {
      target.style.transform = "";
      target.style.transformOrigin = "";
      target.style.willChange = "";
      document.body.style.overflow = "";
      return;
    }
    target.style.transformOrigin = "0 0";
    target.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    // A scaled element still counts towards the page's scroll area — no page scrollbars.
    document.body.style.overflow = "hidden";
  };

  const step = () => {
    frame = 0;
    s += (ts - s) * EASE; x += (tx - x) * EASE; y += (ty - y) * EASE;
    const done = Math.abs(ts - s) < 0.0005 && Math.abs(tx - x) < 0.05 && Math.abs(ty - y) < 0.05;
    if (done) { s = ts; x = tx; y = ty; }
    // Smooth while moving; once still, drop the hint so the text is re-rendered sharp.
    target.style.willChange = done ? "" : "transform";
    apply();
    if (!done) frame = requestAnimationFrame(step);
  };
  const animate = () => { if (!frame) frame = requestAnimationFrame(step); };

  /** Aim at `scale`, keeping the page point under (px, py) where it is on screen. */
  const zoomTo = (scale: number, px: number, py: number) => {
    const k = scale / ts;
    const [nx, ny] = clampPan(scale, px - (px - tx) * k, py - (py - ty) * k);
    ts = scale; tx = nx; ty = ny;
    animate();
  };

  const settle = () => {
    settleTimer = null;
    // Released below 100%: spring back to the plain page.
    if (ts < 1) { ts = 1; tx = 0; ty = 0; animate(); }
  };

  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey || e.metaKey) return;
    // Ours, not the webview's page zoom (which would reflow everything) — and not a scroll:
    // nothing else sees it (an output pane would take it for "the user scrolled up").
    e.preventDefault();
    e.stopPropagation();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
    // Past 100% the page resists, more the further it is pulled (rubber band).
    const resist = ts < 1 ? 0.35 : 1;
    const next = Math.min(MAX, Math.max(RUBBER_MIN, ts * Math.exp(-px * PER_PX * resist)));
    // Snap the last bit onto 100% so a zoom-out lands exactly there.
    zoomTo(Math.abs(next - 1) < 0.01 ? 1 : next, e.clientX, e.clientY);
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_MS);
  };

  // The window changed size: keep the magnified page covering it.
  const onResize = () => { [tx, ty] = clampPan(ts, tx, ty); [x, y] = clampPan(s, x, y); apply(); };

  // Capture + non-passive: before anything else sees it, and allowed to prevent the default.
  window.addEventListener("wheel", onWheel, { passive: false, capture: true });
  window.addEventListener("resize", onResize);
  return () => {
    window.removeEventListener("wheel", onWheel, { capture: true });
    window.removeEventListener("resize", onResize);
    if (frame) cancelAnimationFrame(frame);
    if (settleTimer) clearTimeout(settleTimer);
    s = ts = 1; x = y = tx = ty = 0;
    apply();
  };
}
