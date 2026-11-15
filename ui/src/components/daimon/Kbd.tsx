// Keycap rendering: every key in a combo gets its own keycap ("⌘⇧D" → [Ctrl][Shift][D]).

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

export function Kbd({ children, size = "sm", className = "" }: { children: React.ReactNode; size?: Size; className?: string }) {
  return (
    <kbd
      className={`inline-flex items-center justify-center rounded-[3px] border border-foreground/15 border-b-foreground/25 bg-muted/80 font-mono font-semibold uppercase leading-none tracking-wide text-foreground/80 ${SIZE[size]} ${className}`}
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
