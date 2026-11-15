// Keycap rendering: every key in a combo gets its own keycap ("⌘⇧D" → [Ctrl][Shift][D]).
// Keycaps light up in the theme accent while their physical key is held down.

import { useSyncExternalStore } from "react";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// Modifier glyphs → platform label. On macOS the glyphs are the native convention;
// elsewhere words read far better (and Geist Mono has no ⌘ glyph on Linux).
const LABELS: Record<string, string> = IS_MAC
  ? { "⌘": "⌘", "⌥": "⌥", "⇧": "⇧", "⌃": "⌃", "^": "⌃", "↵": "↵", Enter: "↵" }
  : { "⌘": "Ctrl", "⌥": "Alt", "⇧": "Shift", "⌃": "Ctrl", "^": "Ctrl", "↵": "Enter", Enter: "Enter" };

const TOKEN_RE = /⌘|⌥|⇧|⌃|\^|Tab|Esc|Enter|Space|Del|↑|↓|←|→|↵|[A-Za-z0-9]|[^\s]/g;

export function splitCombo(combo: string): string[] {
  return (combo.match(TOKEN_RE) ?? [combo]).map((t) => LABELS[t] ?? t.toUpperCase());
}

type Size = "xs" | "sm" | "md";

const SIZE: Record<Size, string> = {
  xs: "h-4 min-w-4 px-1 text-[9px] border-b-[2px]",
  sm: "h-5 min-w-5 px-1.5 text-[10px] border-b-[2px]",
  md: "h-6 min-w-6 px-2 text-[11px] border-b-[3px]",
};

// ── Held-key tracking ─────────────────────────────────────────────────────────
// One global capture-phase listener; keycaps subscribe to "is my key down?".

const held = new Set<string>();
const listeners = new Set<() => void>();
let installed = false;

const KEY_NAMES: Record<string, string> = {
  Control: "ctrl", Meta: "meta", OS: "meta", Shift: "shift", Alt: "alt",
  Enter: "enter", Escape: "esc", Tab: "tab", " ": "space", Delete: "del", Backspace: "del",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
};

/** Normalized name of the physical key (layout/shift independent for letters & digits). */
function eventKeyName(e: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  return KEY_NAMES[e.key] ?? e.key.toLowerCase();
}

const LABEL_NAMES: Record<string, string> = {
  "⌘": "meta", "⌥": "alt", "⇧": "shift", "⌃": "ctrl", "^": "ctrl", "↵": "enter",
  cmd: "meta", option: "alt", opt: "alt", escape: "esc", return: "enter", delete: "del",
};

/** Normalized name of the key a keycap label stands for ("Ctrl" → "ctrl", "⌘" → "meta"). */
function labelKeyName(label: string): string {
  const l = label.trim().toLowerCase();
  return LABEL_NAMES[label.trim()] ?? LABEL_NAMES[l] ?? l;
}

function emit() { listeners.forEach((l) => l()); }

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const down = (e: KeyboardEvent) => {
    const k = eventKeyName(e);
    if (!held.has(k)) { held.add(k); emit(); }
  };
  const up = (e: KeyboardEvent) => {
    const k = eventKeyName(e);
    // macOS swallows keyups of other keys while ⌘ is held — release everything with it.
    if (k === "meta") { if (held.size) { held.clear(); emit(); } return; }
    if (held.delete(k)) emit();
  };
  const reset = () => { if (held.size) { held.clear(); emit(); } };
  window.addEventListener("keydown", down, true);
  window.addEventListener("keyup", up, true);
  window.addEventListener("blur", reset);
  document.addEventListener("visibilitychange", reset);
}

function subscribe(cb: () => void) {
  install();
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function useKeyHeld(name: string | null): boolean {
  return useSyncExternalStore(subscribe, () => (name ? held.has(name) : false), () => false);
}

export function Kbd({ children, size = "sm", className = "" }: { children: React.ReactNode; size?: Size; className?: string }) {
  const active = useKeyHeld(typeof children === "string" ? labelKeyName(children) : null);
  return (
    <kbd
      data-active={active || undefined}
      className={`inline-flex items-center justify-center rounded-[3px] border font-mono font-semibold uppercase leading-none tracking-wide transition-[color,background-color,border-color,transform] duration-75 ${
        active
          ? "translate-y-px border-signal/60 border-b-signal/80 bg-signal/20 text-signal"
          : "border-foreground/15 border-b-foreground/25 bg-muted/80 text-foreground/80"
      } ${SIZE[size]} ${className}`}
    >
      {children}
    </kbd>
  );
}

/** Renders a combo string as separate keycaps. */
export function Keys({ combo, size = "sm", className = "" }: { combo: string; size?: Size; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 ${className}`}>
      {splitCombo(combo).map((t, i) => (
        <Kbd key={i} size={size}>{t}</Kbd>
      ))}
    </span>
  );
}
