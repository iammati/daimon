// Bridges CSS theme tokens into places that can't read CSS variables (xterm.js).

import type { Terminal } from "@xterm/xterm";

/**
 * Resolve a CSS color token (e.g. `--selection`, which may be `color-mix(…oklch…)`)
 * to an `rgba()` string xterm can parse. Round-trips through a 1×1 canvas so any
 * color syntax the browser understands comes out as plain sRGB.
 */
export function resolveCssColor(token: string, fallback: string): string {
  try {
    const probe = document.createElement("span");
    probe.style.cssText = `position:absolute;visibility:hidden;color:var(${token})`;
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    if (!computed) return fallback;
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!ctx) return fallback;
    ctx.canvas.width = ctx.canvas.height = 1;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = computed;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    if (a === 0) return fallback;
    return `rgba(${r}, ${g}, ${b}, ${(a! / 255).toFixed(3)})`;
  } catch {
    return fallback;
  }
}

/**
 * Keep a terminal's selection color in sync with the theme accent. Re-applies
 * whenever the theme class on <html> changes. Returns a disposer.
 */
export function syncTerminalSelection(term: Terminal, fallback = "rgba(88, 101, 242, 0.4)"): () => void {
  let last = "";
  const apply = () => {
    const sel = resolveCssColor("--selection", fallback);
    if (sel === last) return; // <html> class flips for unrelated reasons (e.g. repaint-keepalive)
    last = sel;
    term.options.theme = { ...term.options.theme, selectionBackground: sel, selectionInactiveBackground: sel };
  };
  apply();
  const mo = new MutationObserver(apply);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => mo.disconnect();
}
