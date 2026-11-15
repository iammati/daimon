// Background opacity + blur ("glass") settings. Applied as CSS variables on <html>
// so every surface (body, sidebar, header, cards, modals) picks them up instantly.

export type Glass = { opacity: number; blur: number }; // opacity 0–100 (%), blur px

export const GLASS_DEFAULT: Glass = { opacity: 85, blur: 24 };
/** Hard floor — below this the terminal text becomes unreadable over the desktop. */
export const GLASS_MIN_OPACITY = 50;

const KEY = "daimon-glass";

export function loadGlass(): Glass {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const g = JSON.parse(raw) as Partial<Glass>;
      return {
        opacity: clamp(Number(g.opacity ?? GLASS_DEFAULT.opacity), GLASS_MIN_OPACITY, 100),
        blur: clamp(Number(g.blur ?? GLASS_DEFAULT.blur), 0, 60),
      };
    }
  } catch { /* storage unavailable */ }
  return { ...GLASS_DEFAULT };
}

export function applyGlass(g: Glass) {
  const s = document.documentElement.style;
  s.setProperty("--bg-alpha", String(clamp(g.opacity, GLASS_MIN_OPACITY, 100) / 100));
  s.setProperty("--glass-blur", `${g.blur}px`);
  // Native shell (Windows): the compositor blurs the desktop behind the window, and
  // picks its backdrop from this value. No-op in a browser / other shells.
  try {
    (window as { __electrobunSendToHost?: (m: unknown) => void }).__electrobunSendToHost?.({ type: "glass", blur: g.blur });
  } catch { /* shell bridge unavailable */ }
}

/**
 * How the native window blurs the desktop behind it, if it does:
 * "variable" = continuously (Windows, helper DLL), "steps" = fixed looks (Windows/DWM fallback).
 */
export function nativeBlurMode(): "variable" | "steps" | null {
  const mode = document.documentElement.dataset["nativeBlur"];
  return mode === "variable" || mode === "steps" ? mode : null;
}

/** What the blur slider shows for a native blur. Mirrors app/src/bun/winBackdrop.ts. */
export function nativeBlurLabel(blur: number, mode: "variable" | "steps"): string {
  if (mode === "variable") return `${blur}px`;
  return blur <= 0 ? "off" : blur <= 30 ? "soft" : "frosted";
}

export function saveGlass(g: Glass) {
  applyGlass(g);
  try { localStorage.setItem(KEY, JSON.stringify(g)); } catch { /* ignore */ }
}

function clamp(n: number, lo: number, hi: number) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : hi;
}
