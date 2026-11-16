// Kitty keyboard protocol for xterm.js (https://sw.kovidgoyal.net/kitty/keyboard-protocol/).
//
// Legacy terminal key encoding is ambiguous (Tab = Ctrl+I, Esc = Ctrl+[, no
// Shift+Enter, no key release). Programs opt in to the kitty encoding by pushing
// "progressive enhancement" flags; keys then arrive as CSI <key> ; <mods> u.
// xterm.js 5 doesn't implement it, so this module tracks the flags (one stack per
// screen) and encodes keys itself while any flag is set. Flags 0 = untouched xterm.
//
// Flags: 1 disambiguate · 2 report event types (repeat/release) · 4 report alternate
// keys · 8 report all keys as escape codes · 16 report associated text.
import type { IDisposable, Terminal } from "@xterm/xterm";

const DISAMBIGUATE = 1, EVENT_TYPES = 2, ALTERNATE_KEYS = 4, ALL_KEYS = 8, ASSOCIATED_TEXT = 16;
const STACK_MAX = 16;

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

// Functional keys: KeyboardEvent.key → [number, final]. Final "u" is CSI number;mods u,
// "~" is CSI number;mods ~, a letter is CSI 1;mods <letter> (CSI <letter> unmodified).
const FUNCTIONAL: Record<string, [number, string]> = {
  Escape: [27, "u"], Enter: [13, "u"], Tab: [9, "u"], Backspace: [127, "u"],
  Insert: [2, "~"], Delete: [3, "~"], PageUp: [5, "~"], PageDown: [6, "~"],
  ArrowUp: [1, "A"], ArrowDown: [1, "B"], ArrowRight: [1, "C"], ArrowLeft: [1, "D"],
  Home: [1, "H"], End: [1, "F"],
  F1: [1, "P"], F2: [1, "Q"], F3: [13, "~"], F4: [1, "S"],
  F5: [15, "~"], F6: [17, "~"], F7: [18, "~"], F8: [19, "~"], F9: [20, "~"],
  F10: [21, "~"], F11: [23, "~"], F12: [24, "~"],
  CapsLock: [57358, "u"], ScrollLock: [57359, "u"], NumLock: [57360, "u"],
  PrintScreen: [57361, "u"], Pause: [57362, "u"], ContextMenu: [57363, "u"],
};
// Modifier keys themselves (only reported with ALL_KEYS) — by KeyboardEvent.code.
const MODIFIER_KEYS: Record<string, number> = {
  ShiftLeft: 57441, ControlLeft: 57442, AltLeft: 57443, MetaLeft: 57444,
  ShiftRight: 57447, ControlRight: 57448, AltRight: 57449, MetaRight: 57450,
};
// The unshifted key for KeyboardEvent.code on a US layout (Shift+1 → "1", Option+a → "a").
const BASE_KEYS: Record<string, string> = {
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Backquote: "`", Comma: ",", Period: ".", Slash: "/", Space: " ",
};

/**
 * The key's unshifted character. Letters come from the active layout (Ctrl+Z on a German
 * keyboard is "z"); symbols under Shift and macOS Option compositions fall back to the
 * physical key on a US layout (Shift+1 → "1", Option+a → "a").
 */
function baseKey(e: KeyboardEvent): string | null {
  const k = e.key;
  const single = [...k].length === 1;
  const isLetter = single && k.toLowerCase() !== k.toUpperCase();
  if (single && !(isMac && e.altKey) && (!e.shiftKey || isLetter)) return k.toLowerCase();
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (BASE_KEYS[c]) return BASE_KEYS[c]!;
  return single ? k.toLowerCase() : null;
}

/** Modifier field: 1 + shift 1 · alt 2 · ctrl 4 · super 8 · caps 64 · num 128. */
function modifierBits(e: KeyboardEvent, locks: boolean): number {
  let m = 0;
  if (e.shiftKey) m |= 1;
  if (e.altKey) m |= 2;
  if (e.ctrlKey) m |= 4;
  if (e.metaKey) m |= 8;
  if (locks && e.getModifierState?.("CapsLock")) m |= 64;
  if (locks && e.getModifierState?.("NumLock")) m |= 128;
  return m;
}

/**
 * Encode one key event, or null to let xterm handle it (legacy encoding).
 * `type`: 1 press, 2 repeat, 3 release.
 */
export function encodeKey(e: KeyboardEvent, flags: number, type: 1 | 2 | 3): string | null {
  if (!flags) return null;
  const all = (flags & ALL_KEYS) !== 0;
  const events = (flags & EVENT_TYPES) !== 0;
  if (!events) {
    if (type === 3) return null;
    type = 1; // without event types, a repeat is just another press
  }

  const mods = modifierBits(e, all);
  const evSuffix = type !== 1 ? `:${type}` : "";

  // Modifier keys on their own.
  const modCode = MODIFIER_KEYS[e.code];
  if (modCode !== undefined) return all ? `\x1b[${modCode};${1 + mods}${evSuffix}u` : null;
  if (["Shift", "Control", "Alt", "Meta", "AltGraph", "OS"].includes(e.key)) return null;

  const fn = FUNCTIONAL[e.key];
  if (fn) {
    const [num, final] = fn;
    if (num >= 57358 && !all) return null; // lock/system keys only with ALL_KEYS
    if (!all) {
      // Enter/Tab/Backspace keep their legacy bytes unless modified (so `reset` still
      // works after a crashed program), and never report repeat/release.
      const legacyText = e.key === "Enter" || e.key === "Tab" || e.key === "Backspace";
      if (legacyText && (mods === 0 || type !== 1)) return null;
      // Other unmodified keys: legacy bytes are already right (xterm sends them),
      // except Esc, which is the whole point of disambiguation.
      if (mods === 0 && !events && e.key !== "Escape") return null;
    }
    if (mods === 0 && !evSuffix) {
      if (final === "u") return `\x1b[${num}u`;
      if (final === "~") return `\x1b[${num}~`;
      return `\x1b[${final}`;
    }
    const modField = `${1 + mods}${evSuffix}`;
    if (final === "u" || final === "~") return `\x1b[${num};${modField}${final}`;
    return `\x1b[1;${modField}${final}`;
  }

  // Text-producing keys.
  const base = baseKey(e);
  if (base === null) return null;
  const altGraph = e.getModifierState?.("AltGraph") ?? false;
  // Modifiers that make a key more than text (Shift and lock keys don't).
  const textMods = altGraph ? 0 : mods & ~(1 | 64 | 128);
  if (!all) {
    // Plain (or shifted / AltGr) text stays plain text: xterm sends it.
    if (textMods === 0) return null;
    if (!(flags & DISAMBIGUATE)) return null;
  }
  let keyField = String(base.codePointAt(0)!);
  if (flags & ALTERNATE_KEYS && e.shiftKey && [...e.key].length === 1 && e.key !== base) {
    keyField += `:${e.key.codePointAt(0)}`;
  }
  const text = all && flags & ASSOCIATED_TEXT && type !== 3 && textMods === 0 && [...e.key].length === 1
    ? String(e.key.codePointAt(0))
    : "";
  const reportedMods = altGraph ? mods & ~(2 | 4) : mods;
  const modField = reportedMods || evSuffix || text ? `${1 + reportedMods}${evSuffix}` : "";
  return `\x1b[${keyField}${modField ? ";" + modField : ""}${text ? ";" + text : ""}u`;
}

/**
 * Teach an xterm.js terminal the kitty keyboard protocol. Keys go out through `send`
 * (the same sink as term.onData). Returns a disposable.
 */
export function attachKittyKeyboard(term: Terminal, send: (data: string) => void): IDisposable {
  const stacks = { main: [] as number[], alt: [] as number[] };
  const stack = () => (term.buffer.active.type === "alternate" ? stacks.alt : stacks.main);
  const flags = () => { const s = stack(); return s.length ? s[s.length - 1]! : 0; };
  const param = (params: (number | number[])[], i: number, dflt: number) => {
    const p = params[i];
    const v = Array.isArray(p) ? p[0] : p;
    return v === undefined || v === -1 ? dflt : v;
  };

  const handlers: IDisposable[] = [
    // CSI > flags u — push
    term.parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
      const s = stack();
      s.push(param(params, 0, 0));
      if (s.length > STACK_MAX) s.shift();
      return true;
    }),
    // CSI < n u — pop n entries
    term.parser.registerCsiHandler({ prefix: "<", final: "u" }, (params) => {
      const s = stack();
      s.splice(Math.max(0, s.length - Math.max(1, param(params, 0, 1))));
      return true;
    }),
    // CSI = flags ; mode u — 1 set · 2 or · 3 and-not (on the top entry)
    term.parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
      const s = stack();
      const f = param(params, 0, 0);
      const mode = param(params, 1, 1);
      const cur = s.length ? s[s.length - 1]! : 0;
      const next = mode === 2 ? cur | f : mode === 3 ? cur & ~f : f;
      if (s.length) s[s.length - 1] = next; else s.push(next);
      return true;
    }),
    // CSI ? u — query current flags
    term.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
      send(`\x1b[?${flags()}u`);
      return true;
    }),
    // Leaving the alternate screen drops its stack (the spec keeps one per screen).
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (params.some((p) => (Array.isArray(p) ? p[0] : p) === 1049 || (Array.isArray(p) ? p[0] : p) === 47 || (Array.isArray(p) ? p[0] : p) === 1047)) {
        stacks.alt = [];
      }
      return false; // let xterm handle the mode change itself
    }),
  ];

  // Keys we sent an escape code for — only those get repeat/release events.
  const encodedDown = new Set<string>();
  term.attachCustomKeyEventHandler((e) => {
    const f = flags();
    if (!f) return true;
    if (e.isComposing || e.keyCode === 229) return true; // IME
    // macOS Cmd shortcuts (copy, paste, new tab …) belong to the app.
    if (isMac && e.metaKey && e.type === "keydown" && !(f & ALL_KEYS)) return true;
    if (e.type === "keypress") return !encodedDown.has(e.code);

    const type: 1 | 2 | 3 = e.type === "keyup" ? 3 : e.repeat ? 2 : 1;
    if (type === 3 && !encodedDown.has(e.code)) return true;
    const seq = encodeKey(e, f, type);
    if (type === 3) encodedDown.delete(e.code);
    if (seq === null) return true;
    if (type !== 3) encodedDown.add(e.code);
    e.preventDefault();
    send(seq);
    return false;
  });

  return {
    dispose() {
      handlers.forEach((h) => h.dispose());
      term.attachCustomKeyEventHandler(() => true);
    },
  };
}
