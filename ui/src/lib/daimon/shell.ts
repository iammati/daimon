import { shell } from "./rpc";
import type { AttachInfo, ShellContext } from "./rpc";

export type LsEntry = {
  perms: string;     // e.g. "drwxr-xr-x"
  links: string;
  user: string;
  group: string;
  size: number;
  month: string;
  day: string;
  time: string;      // time or year
  name: string;
  link?: string;     // symlink target
};

/** One changed file in `git status`; add/del are line counts (absent for binaries). */
export type GitStatusFile = { xy: string; path: string; from?: string; add?: number; del?: number };

/** One local branch from `git branch`, with its inferred parent (git doesn't record one). */
export type GitBranchNode = {
  name: string; current: boolean; parent: string | null;
  /** Commits on this branch / on its parent since they diverged. */
  ahead: number; behind: number;
  hash: string; upstream: string | null; upAhead: number; upBehind: number; upGone: boolean;
  date: string; subject: string;
};

export type Out =
  | { kind: "lines"; lines: string[]; tone?: "normal" | "muted" | "bad" | "good" }
  | { kind: "ansi"; html: string }
  | { kind: "image"; src: string }
  | { kind: "files"; items: { name: string; dir: boolean; size?: number | undefined }[] }
  | { kind: "lslong"; entries: LsEntry[]; total: string }
  | { kind: "table"; head: string[]; rows: string[][]; accentCol?: number }
  | { kind: "pairs"; pairs: [string, string][] }
  | { kind: "gitlog"; entries: { hash: string; fullHash: string; date: string; subject: string; author: string; isHead?: boolean }[]; cwd: string }
  | { kind: "gitbranches"; branches: string[]; current: string; trunk?: string | null; nodes?: GitBranchNode[] }
  | { kind: "gitstatus"; branch: string; upstream?: string | null; ahead: number; behind: number; staged: GitStatusFile[]; unstaged: GitStatusFile[]; untracked: string[]; added?: number; removed?: number }
  | { kind: "gitdiff"; raw: string }
  | { kind: "logfmt"; lines: Record<string, string>[] }
  | { kind: "pretty"; format: "json" | "yaml"; text: string };

export type Block = {
  id: string;
  input: string;
  cwd: string[];
  ctx: string;
  at: string;
  /** Epoch ms the command started. Absent on blocks built before this field existed. */
  ts?: number;
  ms: number;
  /** Set once the command has ended but the block is still finalising: `ms` is final, stop ticking. */
  settled?: boolean;
  code: number;
  out: Out[];
  pending?: boolean;
};

export type State = { cwd: string[]; ctx: { name: string }; gitBranch?: string };

// Alt-screen enter sequence.
const FULLSCREEN_MODE = /\x1b\[\?1049h/;

// Commands that stream interactively in daimon's own block view (no terminal takeover).
// Input is forwarded via the composer; output streams into the block as plain lines.
// ssh/sftp/mosh: connect + auth (password, host-key, 2FA) via forwarded stdin, banner
// streams as block output, then the warpify bootstrap flips the session to block mode.
export const STREAMING_INTERACTIVE_RE = /^\s*(ssh\b|sftp\b|mosh\b|nc\s+|ncat\s+|telnet\s+)/;

// Commands that need the inline terminal (alt-screen TUI).
// Only list commands where we MUST route before any output (interactive shells, exec/attach).
// All other TUI apps (vim, k9s, claude, htop, etc.) are auto-detected via TUI_RE on first output.
const INTERACTIVE_RE = /^\s*(scp|ipmitool|ipmi|kubectl\s+(exec|attach|debug)|oc\s+(exec|attach)|docker\s+(exec|run\s+-it?)|podman\s+(exec|run\s+-it?)|sudo\s+(-[siSI]\s+)?(-u\s+\S+\s+)?(-[siSI]\s+)?(su|bash|zsh|sh|fish)\b|su\s+|bash\s+-i|zsh\s+-i|python\s+-c|python3\s+-c)/;

// TUI sequences that signal an interactive program.
// Covers: cursor-up redraws, hide/show cursor (spinners/menus),
// cursor-absolute-position (full-screen apps: k9s, lazygit, etc emit \x1b[H or \x1b[r;cH),
// erase-display (\x1b[2J / \x1b[3J), enable mouse tracking (\x1b[?1000h).
// Not erase-line (\x1b[2K): on its own that's a one-line progress redraw (vite, npm),
// which normalizeTerminal replays in the block.
const TUI_RE = /\x1b\[\d*A|\x1b\[\d*;\d*H|\x1b\[H\b|\x1b\[2J|\x1b\[3J|\x1b\[\?1000h|\x1b\[\?1049[lh]/;

// Per-tab alt-screen state — driven by daemon altScreenEnter/Exit events.
const inAltScreenMap = new Map<string, boolean>();
function isAltScreen(tabId: string) { return inAltScreenMap.get(tabId) ?? false; }
export function getAltScreen(tabId: string) { return inAltScreenMap.get(tabId) ?? false; }
shell.onAltScreen((tabId, enter) => {
  inAltScreenMap.set(tabId, enter);
  altScreenListenerMap.get(tabId)?.forEach((fn) => fn(enter));
  if (enter) {
    // Also fire TUI notification so BlockView mounts the terminal
    tuiListenerMap.get(tabId)?.forEach((fn) => fn(true));
  }
});

// Per-tab streaming-interactive state (ssh/mosh/telnet running as streaming block).
const inStreamingSessionMap = new Map<string, boolean>();
export function isStreamingSession(tabId: string) { return inStreamingSessionMap.get(tabId) ?? false; }

// Per-tab warpify state — a streaming SSH session whose remote shell has accepted
// daimon's OSC 133 bootstrap (markers are flowing). When true, remote commands route
// through the normal block path instead of raw PTY passthrough.
const inWarpifiedMap = new Map<string, boolean>();
export function isWarpified(tabId: string) { return inWarpifiedMap.get(tabId) ?? false; }

// Base64 of shell-integration/warpify.zsh — pure-zsh OSC 133 bootstrap pushed over SSH.
// Regenerate on payload change: `base64 -i shell-integration/warpify.zsh | tr -d '\n'`.
const WARPIFY_PAYLOAD_B64 =
  "IyBkYWltb24gcmVtb3RlIHdhcnBpZnkgcGF5bG9hZCDigJQgc291cmNlZCBpbnRvIGEgcmVtb3RlIHpzaCBvdmVyIFNTSC4KIyBQdXJlIHpzaCwgbm8gYmluYXJ5OiBlbWl0cyB0aGUgc2FtZSBPU0MgMTMzIG1hcmtlcnMgZGFpbW9uJ3MgbG9jYWwgaW50ZWdyYXRpb24gZW1pdHMsCiMgc28gdGhlIGRhZW1vbiBwYXJzZXMgcmVtb3RlIGNvbW1hbmQgYm91bmRhcmllcyBleGFjdGx5IGxpa2UgbG9jYWwgb25lcy4KIyBHaXQgaW5mbyB2aWEgYGdpdGAgc3VicHJvY2VzcyAobGliZ2l0MiB1bmF2YWlsYWJsZSByZW1vdGVseSk7IHNpbGVudCB3aGVuIGdpdCBhYnNlbnQuCgpfZGFpbW9uX3JlbW90ZV9wcmVjbWQoKSB7CiAgbG9jYWwgY29kZT0kPwogIGxvY2FsIHB3ZD0iJHtQV0R9IgogIGxvY2FsIGJyYW5jaD0iIiBkaXJ0eT1mYWxzZQogIGlmIGNvbW1hbmQgZ2l0IHJldi1wYXJzZSAtLWlzLWluc2lkZS13b3JrLXRyZWUgJj4vZGV2L251bGw7IHRoZW4KICAgIGJyYW5jaD0kKGNvbW1hbmQgZ2l0IHN5bWJvbGljLXJlZiAtLXNob3J0IEhFQUQgMj4vZGV2L251bGwgfHwgY29tbWFuZCBnaXQgcmV2LXBhcnNlIC0tc2hvcnQgSEVBRCAyPi9kZXYvbnVsbCkKICAgIGNvbW1hbmQgZ2l0IGRpZmYgLS1xdWlldCAmPi9kZXYvbnVsbCAmJiBjb21tYW5kIGdpdCBkaWZmIC0tY2FjaGVkIC0tcXVpZXQgJj4vZGV2L251bGwgfHwgZGlydHk9dHJ1ZQogIGZpCiAgIyBIYW5kLWJ1aWx0IEpTT04gKG5vIGpxKTsgZXNjYXBlIGJhY2tzbGFzaCB0aGVuIGRvdWJsZS1xdW90ZSBpbiBwd2QuCiAgbG9jYWwgZXNjPSIke3B3ZC8vXFwvXFxcXH0iOyBlc2M9IiR7ZXNjLy9cIi9cXFwifSIKICBsb2NhbCBqc29uPSJ7XCJwd2RcIjpcIiR7ZXNjfVwiLFwiZXhpdENvZGVcIjoke2NvZGV9IgogIGlmIFtbIC1uICIkYnJhbmNoIiBdXTsgdGhlbgogICAgbG9jYWwgYmVzYz0iJHticmFuY2gvL1xcL1xcXFx9IjsgYmVzYz0iJHtiZXNjLy9cIi9cXFwifSIKICAgIGpzb24rPSIsXCJnaXRCcmFuY2hcIjpcIiR7YmVzY31cIixcImdpdERpcnR5XCI6JHtkaXJ0eX0iCiAgZmkKICBqc29uKz0ifSIKICBwcmludGYgJ1xlXTEzMztBJXNcZVxcJyAiJGpzb24iCn0KCl9kYWltb25fcmVtb3RlX3ByZWV4ZWMoKSB7IHByaW50ZiAnXGVdMTMzO0NcZVxcJzsgfQoKcHJlY21kX2Z1bmN0aW9ucys9KF9kYWltb25fcmVtb3RlX3ByZWNtZCkKcHJlZXhlY19mdW5jdGlvbnMrPShfZGFpbW9uX3JlbW90ZV9wcmVleGVjKQoKIyBNaW5pbWFsIHByb21wdCDigJQgZGFpbW9uIHJlbmRlcnMgaXRzIG93biBjaHJvbWUuClBST01QVD0nICcKUlBST01QVD0nJwp1bnNldG9wdCBQUk9NUFRfQ1IgUFJPTVBUX1NQIDI+L2Rldi9udWxsIHx8IHRydWUK";

// Injected as one line, no temp files: decode the bootstrap and source it into the
// remote zsh. Leading space keeps it out of remote history (HIST_IGNORE_SPACE).
const WARPIFY_INJECT = ` printf %s ${WARPIFY_PAYLOAD_B64} | base64 -d | source /dev/stdin\n`;

// Warpify state: set once the remote shell accepts the bootstrap (markers flowing).
function notifyWarpify(tabId: string, active: boolean) {
  inWarpifiedMap.set(tabId, active);
}

// Standing exit listener: a warpified SSH session ends when its PTY dies (remote `exit`).
// run()'s per-command subscriptions are transient, so clear warpify/streaming state here
// — otherwise a dead remote session would mis-route the next (now local) command.
shell.onExit((tabId) => {
  if (inWarpifiedMap.get(tabId) || inStreamingSessionMap.get(tabId)) {
    inStreamingSessionMap.delete(tabId);
    notifyWarpify(tabId, false);
  }
});

// Active run cleanups — lets cancel button force-abandon a stuck run. Keyed per run id so a
// newer run can't orphan an older hung one (each run registers its own cleanup).
const activeCleanups = new Map<string, (opts?: { cancelled?: boolean }) => void>();
export function abandonRun(tabId: string) {
  activeCleanups.get(tabId)?.({ cancelled: true });
}

// Apply backspace
function applyBackspace(s: string): string {
  if (!s.includes("\x08")) return s;
  let out = "";
  for (const ch of s) {
    if (ch === "\x08") out = out.slice(0, -1);
    else out += ch;
  }
  return out;
}

const ANSI = (s: string) =>
  // Nothing to strip without a control character (tab and newline are kept).
  !/[\x00-\x08\x0b-\x1f]/.test(s) ? s : applyBackspace(s)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][AB012B]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/\x1b[MDE]/g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

// Standard ANSI 256-color palette
const ANSI16 = ["#000","#ff3b30","#27ae60","#e6a817","#3498db","#8e44ad","#16a085","#bdc3c7",
                 "#7f8c8d","#ff453a","#2ecc71","#f1c40f","#5dade2","#a569bd","#1abc9c","#ecf0f1"];

// Build full xterm 256-color palette
const ANSI256: string[] = [...ANSI16];
// 216 color cube (indices 16–231): 6×6×6 RGB
for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
  const v = (n: number) => n === 0 ? 0 : 55 + n * 40;
  ANSI256.push(`#${v(r).toString(16).padStart(2,"0")}${v(g).toString(16).padStart(2,"0")}${v(b).toString(16).padStart(2,"0")}`);
}
// 24 grayscale ramp (indices 232–255)
for (let i = 0; i < 24; i++) {
  const v = (8 + i * 10).toString(16).padStart(2, "0");
  ANSI256.push(`#${v}${v}${v}`);
}

/**
 * The text attributes in effect at some point of the output. SGR sequences add up — "\x1b[33m"
 * then "\x1b[1m" is bold yellow — and stay in effect across newlines until reset, so this is
 * carried from sequence to sequence and from line to line. Never mutated: sgrApply returns a copy.
 */
type Sgr = { fg: string; bg: string; bold: boolean; dim: boolean; italic: boolean; underline: boolean };
const SGR_NONE: Sgr = { fg: "", bg: "", bold: false, dim: false, italic: false, underline: false };
const SGR_RE = /\x1b\[([0-9;]*)m/g;

/** `s` after one SGR sequence with the parameters `params` ("1;33"). */
function sgrApply(s: Sgr, params: string): Sgr {
  const codes = params.split(";").map(Number);   // "" → [0], a reset
  const n = { ...s };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 0) Object.assign(n, SGR_NONE);
    else if (c === 1) n.bold = true;
    else if (c === 2) n.dim = true;
    else if (c === 3) n.italic = true;
    else if (c === 4) n.underline = true;
    else if (c === 22) n.bold = n.dim = false;
    else if (c === 23) n.italic = false;
    else if (c === 24) n.underline = false;
    else if (c === 38 || c === 48) {
      // 256-color (38;5;n) or truecolor (38;2;r;g;b)
      const len = codes[i + 1] === 5 ? 3 : codes[i + 1] === 2 ? 5 : 0;
      if (len && codes[i + len - 1] !== undefined) {
        const v = codes.slice(i, i + len).join(";");
        if (c === 38) n.fg = v; else n.bg = v;
        i += len - 1;
      }
    }
    else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) n.fg = String(c);
    else if (c === 39) n.fg = "";
    else if ((c >= 40 && c <= 47) || (c >= 100 && c <= 107)) n.bg = String(c);
    else if (c === 49) n.bg = "";
  }
  return n;
}

/** The one SGR sequence that turns a reset terminal into `s` ("" for no attributes). */
function sgrSeq(s: Sgr): string {
  const p: string[] = [];
  if (s.bold) p.push("1");
  if (s.dim) p.push("2");
  if (s.italic) p.push("3");
  if (s.underline) p.push("4");
  if (s.fg) p.push(s.fg);
  if (s.bg) p.push(s.bg);
  return p.length ? `\x1b[${p.join(";")}m` : "";
}

/** A color as sgrApply stored it ("33", "92", "38;5;208", "48;2;1;2;3") → CSS. */
function sgrColor(v: string, fallback: string): string {
  const p = v.split(";").map(Number);
  if (p.length === 1) return ANSI16[(p[0]! % 10) + (p[0]! >= 90 ? 8 : 0)]!;
  if (p[1] === 5) return ANSI256[p[2]!] ?? fallback;
  return `rgb(${p[2]},${p[3]},${p[4]})`;
}

function sgrCss(s: Sgr): string {
  let style = "";
  if (s.bold) style += "font-weight:600;";
  if (s.dim) style += "opacity:0.7;";
  if (s.italic) style += "font-style:italic;";
  if (s.underline) style += "text-decoration:underline;";
  if (s.fg) style += `color:${sgrColor(s.fg, "#ccc")};`;
  if (s.bg) style += `background:${sgrColor(s.bg, "#333")};`;
  return style;
}

/** The span/link left open at the end of a piece of text, so output can be converted in pieces. */
type AnsiHtmlState = { open: boolean; curStyle: string; linkOpen: boolean; sgr: Sgr };
const newAnsiHtmlState = (): AnsiHtmlState => ({ open: false, curStyle: "", linkOpen: false, sgr: SGR_NONE });
const ansiHtmlClose = (st: AnsiHtmlState) => (st.open ? "</span>" : "") + (st.linkOpen ? "</a>" : "");

/** Convert one piece of text, continuing from `st`. Close with ansiHtmlClose() after the last piece. */
function ansiHtmlChunk(raw: string, st: AnsiHtmlState): string {
  const s = applyBackspace(raw)
    .replace(/\x1b\](?!8;)[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")   // OSC 8 (hyperlinks) handled below
    .replace(/(\x1b\]8;[^\x07\x1b]*)\x07/g, "$1\x1b\\")              // …BEL-terminated → ST, so the control-char strip keeps them whole
    .replace(/\x1b[()][AB012B]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/\x1b[MDE]/g, "")
    .replace(/\x1b\[[0-9;?]*[A-LN-Za-ln-z]/g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/g, "");

  let out = "";
  let { open, curStyle, linkOpen, sgr } = st;
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // SGR, or an OSC 8 hyperlink open (with URL) / close (empty URL)
  const re = /\x1b\[([0-9;]*)m|\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let last = 0;

  for (const m of s.matchAll(re)) {
    out += esc(s.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    if (m[2] !== undefined) {
      // Keep <a> and the style <span>s properly nested: close the span, switch the link, reopen.
      if (open) out += "</span>";
      if (linkOpen) { out += "</a>"; linkOpen = false; }
      const url = m[2];
      if (/^(?:https?|mailto):/i.test(url)) {
        out += `<a href="${esc(url).replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer" class="text-signal underline underline-offset-2 hover:text-signal/80">`;
        linkOpen = true;
      }
      if (open) out += `<span style="${curStyle}">`;
      continue;
    }
    sgr = sgrApply(sgr, m[1] ?? "");
    const style = sgrCss(sgr);
    if (open) { out += "</span>"; open = false; }
    if (style) { out += `<span style="${style}">`; open = true; }
    curStyle = style;
  }
  out += esc(s.slice(last));
  st.open = open; st.curStyle = curStyle; st.linkOpen = linkOpen; st.sgr = sgr;
  return out;
}

function ansiToHtml(raw: string): string {
  const st = newAnsiHtmlState();
  const out = ansiHtmlChunk(raw, st);
  return out + ansiHtmlClose(st);
}

// Returns true if the string contains ANSI color/style escape sequences or OSC 8
// hyperlinks — anything that needs the html renderer.
const hasColor = (s: string) => /\x1b\[[0-9;]*m|\x1b\]8;/.test(s);

const now = () =>
  new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// Strip PTY command echo: compare stripped version, keep raw line
function stripEcho(text: string, input: string): string {
  const cmd = input.trim();
  return text.split("\n").filter((l) => ANSI(l).trim() !== cmd).join("\n").trim();
}

// Strip shell prompt lines — compare stripped version, keep raw line
// Matches: user@host ... $ / % / # (with optional trailing spaces or command echo)
const PROMPT_RE = /^\S+@\S+.*[$%#]\s*/;
function stripPromptLines(text: string): string {
  return text.split("\n").filter((l) => !PROMPT_RE.test(ANSI(l).trim())).join("\n").trim();
}

// ── Line-level terminal emulation ──────────────────────────────────────────
// Progress output (git push/clone, curl, cargo, pip…) redraws one line in place
// with \r, ESC[K and backspace. Replay those on a per-line cell grid so only the
// final state of each line survives — and live updates overwrite instead of piling up.
const LINE_CTRL_RE = /[\r\x08]|\x1b\[\d*[KGCD]/;
const LINE_TOKEN_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]|[\r\x08]|[\s\S]/gu;

/** The attributes in effect at the end of the previous line; renderTermLine moves it on. */
type SgrCarry = { sgr: Sgr };

function renderTermLine(line: string, carry: SgrCarry): string {
  if (!LINE_CTRL_RE.test(line)) {
    if (line.includes("\x1b[")) for (const m of line.matchAll(SGR_RE)) carry.sgr = sgrApply(carry.sgr, m[1]!);
    return line;
  }
  type Cell = { ch: string; style: string; pre: string };
  const cells: Cell[] = [];
  let col = 0;
  let sgr = carry.sgr;
  const start = sgrSeq(sgr);   // what the text before this line left switched on
  let style = start;           // the SGR sequence for the attributes in effect
  let pre = "";     // non-SGR escapes (OSC 8 links etc.) carried onto the next cell
  const blank = (): Cell => ({ ch: " ", style: "", pre: "" });
  for (const m of line.matchAll(LINE_TOKEN_RE)) {
    const t = m[0];
    if (t === "\r") { col = 0; continue; }
    if (t === "\x08") { col = Math.max(0, col - 1); continue; }
    if (t.startsWith("\x1b[")) {
      const final = t[t.length - 1]!;
      const arg = t.slice(2, -1);
      const n = parseInt(arg, 10);
      if (final === "m" && !arg.includes("?")) { sgr = sgrApply(sgr, arg); style = sgrSeq(sgr); continue; }
      if (final === "K") {
        if (!arg || arg === "0") cells.length = Math.min(cells.length, col);
        else if (arg === "1") for (let i = 0; i <= col && i < cells.length; i++) cells[i] = blank();
        else if (arg === "2") cells.length = 0;
        continue;
      }
      if (final === "G") { col = Math.max(0, (isNaN(n) ? 1 : n) - 1); continue; }
      if (final === "C") { col += isNaN(n) ? 1 : n; continue; }
      if (final === "D") { col = Math.max(0, col - (isNaN(n) ? 1 : n)); continue; }
      pre += t; // other CSI: pass through untouched
      continue;
    }
    if (t.startsWith("\x1b")) { pre += t; continue; }
    while (cells.length < col) cells.push(blank());
    cells[col] = { ch: t, style, pre };
    pre = "";
    col++;
  }
  let out = "";
  let cur = start;
  for (const c of cells) {
    if (c.style !== cur) { out += "\x1b[0m" + c.style; cur = c.style; }
    out += c.pre + c.ch;
  }
  // Leave the attributes as the line left them: a color opened here runs on into the next lines.
  if (cur !== style) out += "\x1b[0m" + style;
  carry.sgr = sgr;
  return out + pre;
}

/** Collapse in-place redraws so each logical line keeps only what a terminal would show. */
export function normalizeTerminal(raw: string): string {
  if (!LINE_CTRL_RE.test(raw)) return raw;
  const carry: SgrCarry = { sgr: SGR_NONE };
  return raw.replace(/\r+\n/g, "\n").split("\n").map((l) => renderTermLine(l, carry)).join("\n");
}

/**
 * Strict YAML sniffing for command output. Progress/log prose ("remote: Resolving deltas: 100%",
 * "Total 36 (delta 26)") must stay plain text — only treat it as YAML when nearly every line is
 * structurally YAML: `key: value` (key without spaces), `- item`, `---`, or an indented continuation.
 */
export function looksLikeYaml(text: string): boolean {
  const st = newYamlScan();
  for (const l of text.split("\n")) yamlFeed(st, l);
  return yamlVerdict(st);
}

/** looksLikeYaml's running state, so streaming output can be checked a line at a time. */
type YamlScan = {
  // Keys seen per indent level within the current mapping. A mapping can't repeat a key, so
  // "remote: …" / "remote: …" or "error: …" / "error: …" is prose, not YAML.
  seen: Map<number, Set<string>>;
  keys: number; structural: number; count: number;
  bad: boolean;
};
const newYamlScan = (): YamlScan => ({ seen: new Map(), keys: 0, structural: 0, count: 0, bad: false });
const cloneYamlScan = (st: YamlScan): YamlScan =>
  ({ ...st, seen: new Map([...st.seen].map(([k, v]) => [k, new Set(v)])) });
const yamlVerdict = (st: YamlScan) =>
  !st.bad && st.count >= 3 && st.keys >= 2 && st.structural / st.count >= 0.9;

const YAML_KEY_RE = /^(\s*)(?:- )?(["']?)[\w./-]+\2:(?:\s+(.*))?$/;
const YAML_ITEM_RE = /^\s*- \S/;
const YAML_DOC_RE = /^(?:---|\.\.\.)\s*$/;

function yamlFeed(st: YamlScan, l: string): void {
  if (st.bad || !l.trim() || /^\s*#/.test(l)) return;
  st.count++;
  const seen = st.seen;
  const resetFrom = (indent: number) => { for (const k of [...seen.keys()]) if (k >= indent) seen.delete(k); };
  if (YAML_DOC_RE.test(l)) { seen.clear(); st.structural++; return; }
  const m = YAML_KEY_RE.exec(l);
  if (m) {
    const value = m[3] ?? "";
    // Unquoted values can't contain ": " in YAML — that's prose like "remote: Resolving deltas: 100%".
    if (!/^["'{[|>]/.test(value) && /:\s/.test(value)) { st.bad = true; return; }
    const isItem = /^\s*- /.test(l);
    const indent = m[1]!.length + (isItem ? 2 : 0);
    if (isItem) resetFrom(indent);       // "- key:" starts a fresh mapping
    else resetFrom(indent + 1);          // leaving deeper mappings
    const name = l.slice(0, l.indexOf(":")).replace(/^\s*(?:- )?["']?/, "").replace(/["']$/, "");
    const set = seen.get(indent) ?? new Set<string>();
    if (set.has(name)) { st.bad = true; return; }
    set.add(name);
    seen.set(indent, set);
    st.keys++; st.structural++;
  } else if (YAML_ITEM_RE.test(l)) {
    resetFrom(l.search(/\S/));
    st.structural++;
  } else if (/^\s+\S/.test(l)) {
    st.structural++;
  }
}

// OSC 1337 imgcat: ESC ] 1337 ; File=inline=1[;...] : <base64> BEL
const OSC1337_RE = /\x1b\]1337;File=[^\x07\x1b]*:([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/g;

// ── Output classifiers ─────────────────────────────────────────────────────
// Shared by parse() (whole text) and OutputStream (a line at a time).

/** Unified/git diff, judged on the first few lines of the text. */
const looksLikeDiff = (firstLines: string) =>
  /^(diff --git |--- [^\n]+\n\+\+\+ )/m.test(firstLines) || /^@@\s+-\d/m.test(firstLines);

/** JSON text → table / pairs / pretty block; null when it isn't valid JSON. */
function jsonOut(text: string): Out[] | null {
  try {
    const val = JSON.parse(text);
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && val[0] !== null) {
      // Check if flat (all values are primitives)
      const isFlat = val.every((row: unknown) =>
        typeof row === "object" && row !== null &&
        Object.values(row as Record<string, unknown>).every((v) => v === null || typeof v !== "object")
      );
      if (isFlat) {
        const head = Object.keys(val[0]!);
        const rows = val.map((row: Record<string, unknown>) => head.map((k) => String(row[k] ?? "")));
        return [{ kind: "table", head, rows }];
      }
      // Nested array of objects -> pretty
      return [{ kind: "pretty", format: "json", text: JSON.stringify(val, null, 2) }];
    }
    if (typeof val === "object" && !Array.isArray(val)) {
      // Check if flat (all values are primitives)
      const isFlat = Object.values(val as Record<string, unknown>).every((v) => v === null || typeof v !== "object");
      if (isFlat) {
        return [{ kind: "pairs", pairs: Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, String(v)] as [string, string]) }];
      }
      // Nested object -> pretty
      return [{ kind: "pretty", format: "json", text: JSON.stringify(val, null, 2) }];
    }
    // Other valid JSON (primitives, empty arrays) -> pretty
    return [{ kind: "pretty", format: "json", text: JSON.stringify(val, null, 2) }];
  } catch {
    return null;
  }
}

const LS_ENTRY_RE = /^([dlcbsp-][rwx-]{9}[@+.]?)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\w{3})\s+(\d+)\s+(\d{2}:\d{2}|\d{4})\s+(.*)/;

/** One `ls -l` line → entry; null for anything else. */
function lsEntry(line: string): LsEntry | null {
  const m = LS_ENTRY_RE.exec(line.trim());
  if (!m) return null;
  const nameRaw = m[9]!.trim();
  const arrowIdx = nameRaw.indexOf(" -> ");
  return {
    perms: m[1]!, links: m[2]!, user: m[3]!, group: m[4]!,
    size: parseInt(m[5]!, 10), month: m[6]!, day: m[7]!, time: m[8]!,
    name: arrowIdx >= 0 ? nameRaw.slice(0, arrowIdx) : nameRaw,
    ...(arrowIdx >= 0 ? { link: nameRaw.slice(arrowIdx + 4) } : {}),
  };
}

/**
 * Column names and start offsets of a table header line; null when the line isn't one.
 * Position-based: find where each header word starts. This handles kubectl-style headers with
 * multi-word column names like "NOMINATED NODE" and "READINESS GATES" that share a single space.
 */
function tableHeader(firstLine: string): { starts: number[]; names: string[] } | null {
  // Skip help/usage text: section headers end with ":" or first line is indented
  if (firstLine.trimStart() !== firstLine || firstLine.trimEnd().endsWith(":")) return null;
  const starts: number[] = [];
  const names: string[] = [];
  // Runs of non-space chars separated by 2+ spaces give the column positions
  const headerColRe = /\S[\S ]*?(?=\s{2}|\s*$)/g;
  let hm: RegExpExecArray | null;
  while ((hm = headerColRe.exec(firstLine)) !== null) {
    starts.push(hm.index);
    names.push(hm[0].trim());
  }
  return names.length >= 2 ? { starts, names } : null;
}
/** Slice a row by the header's column start positions. */
const tableRow = (starts: number[], l: string) =>
  starts.map((start, i) => l.slice(start, starts[i + 1] ?? l.length).trim());
// Valid table: every row has a non-empty first cell and a second column
const tableRowOk = (r: string[]) => !!r[0] && r[1] !== undefined;

const LOGFMT_RE = /^(\w[\w.-]*)=("(?:[^"\\]|\\.)*"|\S*)/;
/** One logfmt line → its key/value pairs; null with fewer than two pairs. */
function logfmtLine(l: string): Record<string, string> | null {
  const obj: Record<string, string> = {};
  let rest = l.trim();
  while (rest.length > 0) {
    const m = LOGFMT_RE.exec(rest);
    if (!m) break;
    const k = m[1]!;
    const raw = m[2]!;
    obj[k] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\"/g, '"') : raw;
    rest = rest.slice(m[0].length).trimStart();
  }
  return Object.keys(obj).length >= 2 ? obj : null;
}
const logfmtMarked = (l: string) => l.includes("time=") || l.includes("level=");

function parse(rawText: string): Out[] {
  // Extract OSC 1337 imgcat sequences before any stripping
  const imgOuts: Out[] = [];
  const textWithoutImgs = rawText.replace(OSC1337_RE, (_, b64: string) => {
    imgOuts.push({ kind: "image", src: `data:image/png;base64,${b64}` });
    return "";
  });
  if (imgOuts.length > 0) {
    // Parse the remaining text too and combine
    const rest = parse(textWithoutImgs);
    return [...imgOuts, ...rest];
  }

  const cleaned = normalizeTerminal(rawText);
  if (hasColor(cleaned)) {
    const stripped = ANSI(cleaned).trim();
    if (!stripped) return [];
    // git diff produces colored output — detect on stripped text before falling back to ansi
    if (looksLikeDiff(stripped.split("\n").slice(0, 6).join("\n"))) {
      return [{ kind: "gitdiff", raw: stripped }];
    }
    return [{ kind: "ansi", html: ansiToHtml(cleaned).trim() }];
  }

  const text = cleaned.trim();
  if (!text) return [];

  if (text.startsWith("{") || text.startsWith("[")) {
    const json = jsonOut(text);
    if (json) return json;
  }

  // ls -l / ls -la long-listing format:
  // optional "total N" header, then lines starting with permission chars [dlcbsp-][rwx-]{9}
  const lsLines = text.split("\n");
  const entries = lsLines.map(lsEntry).filter((e): e is LsEntry => e !== null);
  if (entries.length >= 2 || (entries.length >= 1 && lsLines[0]?.startsWith("total "))) {
    const total = lsLines[0]?.startsWith("total ") ? lsLines[0].slice(6).trim() : "";
    return [{ kind: "lslong", entries, total }];
  }

  const lines = text.split("\n");
  if (lines.length >= 2) {
    const head = tableHeader(lines[0]!);
    if (head) {
      const rows = lines.slice(1).filter(Boolean).map((l) => tableRow(head.starts, l));
      if (rows.length > 0 && rows.every(tableRowOk)) {
        return [{ kind: "table", head: head.names, rows, accentCol: head.names.length - 1 }];
      }
    }
  }

  // Logfmt: lines with key="value" or key=value pairs (at least time= and msg= or level=)
  {
    const logfmtLines = lines.filter((l) => l.trim().length > 0);
    const parsed = logfmtLines.map(logfmtLine);
    const matchCount = parsed.filter(Boolean).length;
    // Allow a few junk lines at the top (PTY echo, escape sequences) — need ≥3 logfmt lines and ≥50% match
    const hasLogfmt = matchCount >= 3 && matchCount >= logfmtLines.length * 0.5;
    const hasTimestampOrLevel = logfmtLines.some(logfmtMarked);
    if (hasLogfmt && hasTimestampOrLevel) {
      // Drop non-matching header lines, keep only parsed logfmt rows
      return [{ kind: "logfmt", lines: parsed.filter(Boolean) as Record<string, string>[] }];
    }
  }

  // Unified diff output (cat *.diff / *.patch)
  if (looksLikeDiff(text.split("\n").slice(0, 6).join("\n"))) {
    return [{ kind: "gitdiff", raw: text }];
  }

  if (looksLikeYaml(text)) return [{ kind: "pretty", format: "yaml", text }];

  // Strip uniform leading whitespace (e.g. git branch `  branch-name` padding)
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length > 0) {
    // A loop, not Math.min(...): spreading ~125k+ lines as arguments overflows the stack.
    let minIndent = Infinity;
    for (const l of nonEmpty) minIndent = Math.min(minIndent, l.match(/^(\s*)/)?.[1]?.length ?? 0);
    if (minIndent > 0) {
      return [{ kind: "lines", lines: lines.map((l) => l.slice(minIndent)) }];
    }
  }
  return [{ kind: "lines", lines }];
}

/** What a command's raw PTY text shows as: echo and prompt lines dropped, the rest parsed. */
function parseOutput(raw: string, input: string): Out[] {
  const stripped = stripPromptLines(stripEcho(ANSI(raw).trim(), input));
  const forParse = stripPromptLines(stripEcho(raw, input));
  const hasImg = /\x1b\]1337;File=/.test(forParse);
  return (stripped || hasImg) ? parse(forParse) : [];
}

// ── Streaming parse ────────────────────────────────────────────────────────
// parseOutput() re-reads the whole buffer, which is too slow to repeat every frame while a
// command is still printing. OutputStream gives the same answer for the text received so far,
// but does the per-line work (echo/prompt filtering, redraw collapsing, HTML conversion, the
// classifiers) once per finished line and only re-reads the unfinished end.
//
// Text it can't split into lines safely — inline images, an escape sequence or a backspace
// that reaches across a newline — makes it defer to parseOutput().

const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
/** An OSC that isn't closed on its own line (as ANSI() reads it), so it may run on into the next one. */
const hasOpenOsc = (l: string) =>
  l.includes("]") && l.includes("\x1b") &&
  applyBackspace(l).replace(CSI_RE, "").replace(OSC_RE, "").includes("\x1b]");
/** A backspace with nothing before it on its line — in the whole text it would eat the newline. */
function backspaceUnderflows(l: string): boolean {
  let n = 0;
  for (let i = 0; i < l.length; i++) {
    if (l.charCodeAt(i) !== 8) n++;
    else if (n === 0) return true;
    else n--;
  }
  return false;
}
// Line endings are "\r\n" on a PTY; normalizeTerminal drops that "\r" before collapsing redraws.
const renderLine = (l: string, carry: SgrCarry) => renderTermLine(l.replace(/\r+$/, ""), carry);
const isBlank = (l: string) => l.trim() === "";

/** Drop blank lines at the given ends and trim the lines left there — String.trim() on a line list. */
function trimLines(lines: string[], start: boolean): string[] {
  let a = 0;
  let b = lines.length;
  if (start) while (a < b && isBlank(lines[a]!)) a++;
  while (b > a && isBlank(lines[b - 1]!)) b--;
  const out = lines.slice(a, b);
  if (!out.length) return out;
  if (start) out[0] = out[0]!.trimStart();
  out[out.length - 1] = out[out.length - 1]!.trimEnd();
  return out;
}

class OutputStream {
  private readonly cmd: string;
  private complex = false;      // can't be split into lines; snapshot() defers to parseOutput()
  private tail = "";            // raw text after the last newline
  private visible = false;      // some kept line has printable text
  private started = false;      // past the leading blank lines
  // Kept raw lines whose final form isn't known yet: the last non-blank one and the blanks
  // after it. They are trimmed away for as long as nothing printable follows them.
  private held: string[] = [];
  // Finished lines, redraws collapsed. Everything below reads from here.
  private done: string[] = [];
  private color = false;
  private carry: SgrCarry = { sgr: SGR_NONE };   // attributes at the end of the last line in `done`
  private first = -1;           // first / last non-blank index in `done`
  private last = -1;

  // Colored output → html (or a colored diff → its plain text).
  private aNext = 0;
  private aHtml = "";
  private aState = newAnsiHtmlState();
  private aText = "";           // escape-free text of the finished lines, until `diff` is settled
  private aFirst = -1;          // first / last index in `done` with printable text
  private aLast = -1;
  private diff: boolean | null = null;

  // Plain output: the lines of the trimmed text that can no longer change, and what each
  // classifier has made of them.
  private pNext = 0;
  private lines: string[] = [];
  private text = "";
  private ls: LsEntry[] = [];
  private head: { starts: number[]; names: string[] } | null = null;
  private rows: string[][] | null = null;   // null once a row doesn't fit the header
  private logfmt: Record<string, string>[] = [];
  private logfmtSeen = 0;
  private logfmtMark = false;
  private yaml = newYamlScan();

  constructor(private readonly input: string) {
    this.cmd = input.trim();
  }

  push(data: string): void {
    if (this.complex) return;
    let i = data.indexOf("\n");
    if (i < 0) { this.tail += data; return; }
    let start = 0;
    let line = this.tail + data.slice(0, i);
    for (;;) {
      this.addRaw(line);
      if (this.complex) return;
      start = i + 1;
      i = data.indexOf("\n", start);
      if (i < 0) break;
      line = data.slice(start, i);
    }
    this.tail = data.slice(start);
  }

  /** The parsed output of everything pushed so far. `raw` is that same text, for the fallback. */
  snapshot(raw: string): Out[] {
    if (this.complex) return parseOutput(raw, this.input);
    const tail = this.tail;
    if (tail.includes("\x1b]1337;File=") || backspaceUnderflows(tail)) return parseOutput(raw, this.input);
    const tailText = ANSI(tail).trim();
    const tailKept = tailText !== this.cmd && !PROMPT_RE.test(tailText);
    if (!this.visible && !(tailKept && tailText)) return [];

    // The unfinished end: held lines plus the partial last line, trimmed as the end of the text.
    const carry: SgrCarry = { sgr: this.carry.sgr };
    const open = trimLines(tailKept ? [...this.held, tail] : this.held, !this.started).map((l) => renderLine(l, carry));
    if (!open.length) return [];
    for (let i = 0; i < open.length; i++) {
      if (open[i]!.includes("\x08") || (i < open.length - 1 && hasOpenOsc(open[i]!))) return parseOutput(raw, this.input);
    }
    return this.color || open.some(hasColor) ? this.ansiOut(open) : this.plainOut(open);
  }

  /** One finished raw line. */
  private addRaw(l: string): void {
    if (l.includes("\x1b]1337;File=") || hasOpenOsc(l) || backspaceUnderflows(l)) { this.complex = true; return; }
    const text = ANSI(l).trim();
    if (text === this.cmd || PROMPT_RE.test(text)) return;   // command echo / prompt line
    if (text) this.visible = true;
    if (isBlank(l)) { if (this.started) this.held.push(l); return; }
    for (const h of this.held) this.addDone(renderLine(h, this.carry));
    this.held = [this.started ? l : l.trimStart()];
    this.started = true;
  }

  private addDone(r: string): void {
    if (r.includes("\x08") || hasOpenOsc(r)) { this.complex = true; return; }
    if (!this.color && hasColor(r)) this.color = true;
    if (!isBlank(r)) {
      if (this.first < 0) this.first = this.done.length;
      this.last = this.done.length;
    }
    this.done.push(r);
  }

  private ansiOut(open: string[]): Out[] {
    for (; this.aNext < this.done.length; this.aNext++) {
      const r = this.done[this.aNext]!;
      this.aHtml += ansiHtmlChunk(r + "\n", this.aState);
      if (this.diff === false) continue;
      const text = ANSI(r);
      if (!isBlank(text)) {
        if (this.aFirst < 0) this.aFirst = this.aNext;
        this.aLast = this.aNext;
      }
      this.aText += text + "\n";
    }
    if (this.diff !== false) {
      const text = (this.aText + open.map(ANSI).join("\n")).trim();
      if (!text) return [];
      const isDiff = this.diff ?? looksLikeDiff(text.split("\n", 6).join("\n"));
      // Settled once the lines it is judged on can no longer be the (trimmed) end of the text.
      if (this.aFirst >= 0 && this.aLast >= this.aFirst + 6) {
        this.diff = isDiff;
        if (!isDiff) this.aText = "";
      }
      if (isDiff) return [{ kind: "gitdiff", raw: text }];
    }
    const st = { ...this.aState };
    const html = this.aHtml + ansiHtmlChunk(open.join("\n"), st) + ansiHtmlClose(st);
    return [{ kind: "ansi", html: html.trim() }];
  }

  private plainOut(open: string[]): Out[] {
    // Everything before the last non-blank finished line is final; that line may still turn
    // out to be the end of the text (and lose its trailing whitespace), so it stays open.
    if (this.first >= 0) {
      if (this.pNext < this.first) this.pNext = this.first;
      for (; this.pNext < this.last; this.pNext++) {
        const r = this.done[this.pNext]!;
        this.addLine(this.pNext === this.first ? r.trimStart() : r);
      }
    }
    const lines = this.lines;
    const end = trimLines(this.first >= 0 ? [...this.done.slice(this.last), ...open] : open, !lines.length);
    if (!end.length) return [];
    const count = lines.length + end.length;
    const line0 = lines[0] ?? end[0]!;
    const lastLine = end[end.length - 1]!;
    const text = () => (lines.length ? this.text + "\n" : "") + end.join("\n");

    // Valid JSON closes the bracket it opens with, so anything else needn't be tried.
    if ((line0[0] === "{" && lastLine.endsWith("}")) || (line0[0] === "[" && lastLine.endsWith("]"))) {
      const json = jsonOut(text());
      if (json) return json;
    }

    const endLs = end.map(lsEntry).filter((e): e is LsEntry => e !== null);
    const lsCount = this.ls.length + endLs.length;
    const hasTotal = line0.startsWith("total ");
    if (lsCount >= 2 || (lsCount >= 1 && hasTotal)) {
      return [{ kind: "lslong", entries: [...this.ls, ...endLs], total: hasTotal ? line0.slice(6).trim() : "" }];
    }

    if (count >= 2) {
      const head = lines.length ? this.head : tableHeader(line0);
      const rows = lines.length ? this.rows : [];
      if (head && rows) {
        const endRows = (lines.length ? end : end.slice(1)).filter(Boolean).map((l) => tableRow(head.starts, l));
        if (rows.length + endRows.length > 0 && endRows.every(tableRowOk)) {
          return [{ kind: "table", head: head.names, rows: [...rows, ...endRows], accentCol: head.names.length - 1 }];
        }
      }
    }

    const endFilled = end.filter((l) => !isBlank(l));
    const endLogfmt = endFilled.map(logfmtLine).filter((o): o is Record<string, string> => o !== null);
    const matchCount = this.logfmt.length + endLogfmt.length;
    if (matchCount >= 3 && matchCount >= (this.logfmtSeen + endFilled.length) * 0.5
        && (this.logfmtMark || endFilled.some(logfmtMarked))) {
      return [{ kind: "logfmt", lines: [...this.logfmt, ...endLogfmt] }];
    }

    const firstLines = lines.length >= 6 ? lines.slice(0, 6) : [...lines, ...end].slice(0, 6);
    if (looksLikeDiff(firstLines.join("\n"))) return [{ kind: "gitdiff", raw: text() }];

    if (!this.yaml.bad) {
      // ponytail: copies the open mappings' keys every frame. Fine for real YAML (a handful of
      // keys per level); one flat mapping with ~100k keys would want an undo log instead.
      const scan = cloneYamlScan(this.yaml);
      for (const l of end) yamlFeed(scan, l);
      if (yamlVerdict(scan)) return [{ kind: "pretty", format: "yaml", text: text() }];
    }

    return [{ kind: "lines", lines: [...lines, ...end] }];
  }

  /** One more final line of the trimmed plain text. */
  private addLine(l: string): void {
    if (!this.lines.length) {
      this.head = tableHeader(l);
      this.rows = this.head ? [] : null;
      this.text = l;
    } else {
      this.text += "\n" + l;
      if (this.rows && l) {
        const row = tableRow(this.head!.starts, l);
        if (tableRowOk(row)) this.rows.push(row);
        else this.rows = null;
      }
    }
    this.lines.push(l);
    const entry = lsEntry(l);
    if (entry) this.ls.push(entry);
    if (!isBlank(l)) {
      this.logfmtSeen++;
      const pairs = logfmtLine(l);
      if (pairs) this.logfmt.push(pairs);
      if (logfmtMarked(l)) this.logfmtMark = true;
    }
    yamlFeed(this.yaml, l);
  }
}

// Notification config — call setNotifConfig() from the UI to configure
let notifEnabled = true;
let notifThreshold = 10_000;

export function setNotifConfig(enabled: boolean, thresholdMs: number) {
  notifEnabled = enabled;
  notifThreshold = thresholdMs;
  if (enabled && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function maybeNotify(cmd: string, ms: number) {
  if (!notifEnabled) return;
  if (ms < notifThreshold) return;
  if (!document.hidden) return;
  if (Notification.permission !== "granted") return;
  new Notification("daimon", { body: `${cmd} — ${Math.round(ms / 1000)}s`, icon: "/favicon.ico" });
}

let globalOutputOff: (() => void) | null = null;
let globalContextOff: (() => void) | null = null;
let globalExitOff: (() => void) | null = null;
let globalCommandStartOff: (() => void) | null = null;

// Per-tab alt-screen listeners.
type AltScreenListener = (active: boolean) => void;
const altScreenListenerMap = new Map<string, Set<AltScreenListener>>();

export function onAltScreenChange(tabId: string, fn: AltScreenListener): () => void {
  let s = altScreenListenerMap.get(tabId);
  if (!s) { s = new Set(); altScreenListenerMap.set(tabId, s); }
  s.add(fn);
  return () => s!.delete(fn);
}

export function notifyAltScreen(tabId: string, active: boolean) {
  inAltScreenMap.set(tabId, active);
  altScreenListenerMap.get(tabId)?.forEach((fn) => fn(active));
}

// Separate TUI-detected listeners (inline block rendering, not overlay).
type TuiListener = (active: boolean) => void;
const tuiListenerMap = new Map<string, Set<TuiListener>>();

export function onTuiChange(tabId: string, fn: TuiListener): () => void {
  let s = tuiListenerMap.get(tabId);
  if (!s) { s = new Set(); tuiListenerMap.set(tabId, s); }
  s.add(fn);
  return () => s!.delete(fn);
}

function notifyTui(tabId: string, active: boolean) {
  tuiListenerMap.get(tabId)?.forEach((fn) => fn(active));
}

// Per-tab PTY replay buffer — accumulates bytes from command start so late inline-terminal
// subscribers can replay what they missed before their subscription was created.
const replayBufMap = new Map<string, string[]>();

export function getTuiReplayBuffer(tabId: string): string[] {
  return replayBufMap.get(tabId) ?? [];
}

function startReplay(tabId: string) { replayBufMap.set(tabId, []); }
function appendReplay(tabId: string, data: string) { replayBufMap.get(tabId)?.push(data); }
function clearReplay(tabId: string) { replayBufMap.delete(tabId); }

// Per-tab ready promises — triggers session open, resolves immediately.
const readyPromiseMap = new Map<string, Promise<void>>();

function ensureReady(tabId: string): Promise<void> {
  let p = readyPromiseMap.get(tabId);
  if (!p) {
    p = shell.ready(tabId).catch(() => {});
    readyPromiseMap.set(tabId, p);
  }
  return p;
}

// Tabs whose full-screen program was resumed and should repaint once the inline
// terminal is mounted (BlockView calls takeRedraw).
const redrawPending = new Set<string>();

/** True once per resumed full-screen program: the caller should ask it to repaint. */
export function takeRedraw(tabId: string): boolean {
  return redrawPending.delete(tabId);
}

export function sendRaw(tabId: string, data: string) {
  shell.write(tabId, data).catch(() => {});
}

export function resizePty(tabId: string, cols: number, rows: number) {
  shell.resize(tabId, cols, rows).catch(() => {});
}

export async function run(
  raw: string,
  state: State,
  tabId: string,
  onProgress: (block: Block) => void,
  /** Pick up a command that's already running in the daemon (after the UI restarted). */
  resume?: AttachInfo,
): Promise<{ block: Block; next: State; clear?: boolean }> {
  const input = raw.trim();

  if (!input && !resume) {
    const block: Block = { id: Math.random().toString(36).slice(2), input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ts: Date.now(), ms: 0, code: 0, out: [] };
    return { block, next: state };
  }

  if (!resume && input === "clear") {
    const block: Block = { id: Math.random().toString(36).slice(2), input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ts: Date.now(), ms: 0, code: 0, out: [] };
    return { block, next: state, clear: true };
  }

  // Git commands — intercepted and rendered with rich UI
  const cwdStr = "/" + state.cwd.join("/");
  if (!resume && /^git\s+status(\s|$)/.test(input)) {
    const t = Date.now();
    const id = Math.random().toString(36).slice(2);
    try {
      const gs = await shell.gitStatus(cwdStr);
      const out: Out[] = [{ kind: "gitstatus", ...gs }];
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ts: Date.now(), ms: Date.now() - t, code: 0, out }, next: state };
    } catch {
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ts: Date.now(), ms: Date.now() - t, code: 1, out: [{ kind: "lines", lines: ["not a git repository"], tone: "bad" }] }, next: state };
    }
  }
  if (!resume && /^git\s+log(\s|$)/.test(input)) {
    const t = Date.now();
    const id = Math.random().toString(36).slice(2);
    try {
      const entries = await shell.listLog(cwdStr, 2000);
      const out: Out[] = [{ kind: "gitlog", entries, cwd: cwdStr }];
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ts: Date.now(), ms: Date.now() - t, code: 0, out }, next: state };
    } catch {
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ts: Date.now(), ms: Date.now() - t, code: 1, out: [{ kind: "lines", lines: ["not a git repository"], tone: "bad" }] }, next: state };
    }
  }
  if (!resume && /^git\s+branch(\s+(-v|-vv|--list|-l))*\s*$/.test(input)) {
    const t = Date.now();
    const id = Math.random().toString(36).slice(2);
    try {
      const res = await shell.listBranches(cwdStr);
      const out: Out[] = [{ kind: "gitbranches", ...res }];
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ts: Date.now(), ms: Date.now() - t, code: 0, out }, next: state };
    } catch {
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ts: Date.now(), ms: Date.now() - t, code: 1, out: [{ kind: "lines", lines: ["not a git repository"], tone: "bad" }] }, next: state };
    }
  }
  if (!resume && /^git\s+(--no-pager\s+)?diff(\s|$)/.test(input)) {
    const t = Date.now();
    const id = Math.random().toString(36).slice(2);
    try {
      // Extract any extra args after "diff"
      const extraArgs = input.replace(/^git\s+(--no-pager\s+)?diff\s*/, "").trim();
      const args = extraArgs ? extraArgs.split(/\s+/) : [];
      const { raw } = await shell.gitDiff(cwdStr, args);
      const out: Out[] = raw.trim() ? [{ kind: "gitdiff", raw }] : [{ kind: "lines", lines: ["no changes"], tone: "muted" }];
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ts: Date.now(), ms: Date.now() - t, code: 0, out }, next: state };
    } catch {
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ts: Date.now(), ms: Date.now() - t, code: 1, out: [{ kind: "lines", lines: ["not a git repository"], tone: "bad" }] }, next: state };
    }
  }

  // Rewrite git diff/show/log to use --no-pager so less never launches
  const noPagerRewrite = input.replace(/^(git)\s+(diff|show|log|blame)(\s|$)/, "git --no-pager $2$3");
  const effectiveInput = noPagerRewrite !== input ? noPagerRewrite : input;

  const t0 = resume?.startedAt || Date.now();
  // Duration is measured from the shell's command-start marker to its end marker, not from
  // when run() was called to when the block finished finalising (which adds a fixed delay).
  let tStart = t0;
  let tEnd: number | null = null;
  const elapsed = () => Math.max(0, (tEnd ?? Date.now()) - tStart);
  let normalBuf = "";
  const stream = new OutputStream(effectiveInput);
  let exitCode = 0;
  let finalCtx: ShellContext | null = null;
  const id = Math.random().toString(36).slice(2);

  let detectedTUI = false;
  const isInteractive = INTERACTIVE_RE.test(input);
  const isStreamingInteractive = STREAMING_INTERACTIVE_RE.test(input);
  // If a streaming-interactive session (ssh/mosh) is active, commands sent here go to the
  // remote shell which never emits onContext — resolve on PTY exit instead.
  const insideInteractiveSession = isStreamingSession(tabId) || isAltScreen(tabId);
  // Start buffering all PTY bytes from this command so the inline terminal can replay on mount
  startReplay(tabId);
  if (isInteractive) notifyAltScreen(tabId, true);
  if (isStreamingInteractive) inStreamingSessionMap.set(tabId, true);

  const pendingBlock: Block = { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ts: t0, ms: 0, code: 0, out: [], pending: true };
  onProgress(pendingBlock);

  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let progressFrame: number | null = null;
  let progressQueued = false;
  let progressHoldUntil = 0;
  let done = false;
  let commandWritten = !!resume;
  let commandStarted = !!resume;
  // Warpify (ssh only): quiet-period debounce → inject OSC 133 bootstrap → confirm on first remote Prompt.
  // ponytail: timing heuristic. Ceiling: a slow link or a >600ms-gapped MOTD banner can
  // trip the injection early; the retry + marker-confirm cover the common cases. Swap to a
  // sentinel probe only if real hosts prove flaky.
  let warpInjectTimer: ReturnType<typeof setTimeout> | null = null;
  let warpRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let warpInjected = false;
  const injectWarpify = () => {
    if (done || warpInjected) return;
    warpInjected = true;
    shell.write(tabId, WARPIFY_INJECT).catch(() => {});
    // If no remote marker confirms within 1.5s, try once more, then give up (stays raw).
    warpRetryTimer = setTimeout(() => {
      if (done || isWarpified(tabId)) return;
      shell.write(tabId, WARPIFY_INJECT).catch(() => {});
    }, 1500);
  };
  const armWarpifyInject = () => {
    if (warpInjected) return;
    if (warpInjectTimer) clearTimeout(warpInjectTimer);
    warpInjectTimer = setTimeout(injectWarpify, 600);
  };
  // Show new output once per painted frame, however many chunks arrived in between.
  const paintProgress = () => {
    progressFrame = null;
    progressQueued = false;
    if (done) return;
    const painted = performance.now();
    onProgress({ ...pendingBlock, ms: elapsed(), out: stream.snapshot(normalBuf), pending: true });
    // A big block can take longer than a frame to lay out. When that happens, leave the UI
    // twice that long to itself before the next update so typing and scrolling stay smooth.
    requestAnimationFrame(() => {
      const cost = performance.now() - painted;
      if (cost > 50) progressHoldUntil = performance.now() + Math.min(cost * 2, 1000);
    });
  };
  const queueProgressFrame = () => {
    progressTimer = null;
    progressFrame = requestAnimationFrame(paintProgress);
  };
  const emitProgress = () => {
    if (progressQueued || done) return;
    progressQueued = true;
    const wait = progressHoldUntil - performance.now();
    if (wait > 0) progressTimer = setTimeout(queueProgressFrame, wait);
    else queueProgressFrame();
  };
  const appendOutput = (text: string) => {
    normalBuf += text;
    stream.push(text);
    emitProgress();
  };

  // Resuming: start from what the daemon kept. A full-screen program gets the inline
  // terminal (with its modes restored) and is asked to repaint once that's mounted.
  const resumedAlt = !!resume?.altScreen;
  if (resume) {
    appendReplay(tabId, resume.output);
    if (resumedAlt) { notifyAltScreen(tabId, true); redrawPending.add(tabId); }
    if (resumedAlt || TUI_RE.test(resume.output)) {
      detectedTUI = true;
      notifyTui(tabId, true);
    } else if (resume.output) {
      appendOutput(resume.output.replace(/\x1b\[\?[0-9;]*[hlsur]/g, ""));
    }
  }

  return new Promise<{ block: Block; next: State; clear?: boolean }>((resolve) => {
    globalOutputOff?.(); globalContextOff?.(); globalExitOff?.(); globalCommandStartOff?.();

    globalOutputOff = shell.onOutput((tid, data) => {
      if (tid !== tabId) return;
      if (!commandWritten) return; // discard pre-command PTY noise
      if (isAltScreen(tabId)) return;
      // Buffer every byte for replay
      appendReplay(tabId, data);
      // Strip PTY mode-set sequences before buffering
      const cleanData = data.replace(/\x1b\[\?[0-9;]*[hlsur]/g, "");
      // Streaming interactive (ssh etc): always pipe output to block, no TUI takeover
      if (isStreamingInteractive) {
        appendOutput(cleanData);
        // ssh: once the remote shell settles (quiet period), push the warpify bootstrap.
        if (!isWarpified(tabId)) armWarpifyInject();
        return;
      }
      // Auto-detect TUI: first cursor-up / erase-line / hide-cursor / alt-screen → inline block rendering
      // Note: 1049h is stripped by daemon before forwarding; alt-screen is signaled via altScreenEnter event
      if (!detectedTUI && TUI_RE.test(data)) {
        detectedTUI = true;
        // Keep normalBuf — logs before the TUI/spinner phase are valid output to preserve
        notifyTui(tabId, true);
        return;
      }
      if (detectedTUI) return;
      appendOutput(cleanData);
    });

    globalExitOff = shell.onExit((tid, code) => {
      if (tid !== tabId) return;
      exitCode = code;
      // Interactive/TUI commands: remote shell never fires onContext, so resolve on exit.
      if (isInteractive || isStreamingInteractive || detectedTUI || insideInteractiveSession) {
        tEnd ??= Date.now();
        // Give onContext a brief window to arrive first (local shell emits it quickly after exit)
        setTimeout(() => { if (!done) cleanup(); }, 300);
      }
    });

    globalCommandStartOff = shell.onCommandStart((tid) => {
      if (tid !== tabId) return;
      commandStarted = true;
      if (!resume) { tStart = Date.now(); pendingBlock.ts = tStart; }
    });

    globalContextOff = shell.onContext((tid, ctx) => {
      if (tid !== tabId) return;
      if (!commandWritten) return;
      // ssh connection block: the first remote OSC 133;A confirms the bootstrap took.
      // Flip the session to warpified, then resolve THIS block as a finished "connected"
      // marker. The live SSH channel is the PTY itself; each later remote command gets
      // its own run()/block. We must resolve here because the next run() replaces the
      // module-level exit/output subscriptions, so this promise would otherwise hang.
      if (isStreamingInteractive) {
        if (!isWarpified(tabId)) {
          notifyWarpify(tabId, true);
          finalCtx = ctx;
          cleanup({ keepSession: true });
        }
        return;
      }
      if (!commandStarted) return; // ignore startup precmd prompt — wait for real command
      finalCtx = ctx;
      // Stop buffering immediately — the prompt line arrives after context and
      // would pollute normalBuf, causing parse() to produce different output than
      // the last emitProgress call (flicker). Unsubscribe now, then cleanup shortly after.
      globalOutputOff?.(); globalOutputOff = null;
      // Freeze the clock now; the 100ms below is finalisation, not command time.
      tEnd ??= Date.now();
      pendingBlock.settled = true;
      onProgress({ ...pendingBlock, ms: elapsed(), out: stream.snapshot(normalBuf), pending: true });
      setTimeout(cleanup, 100);
    });

    function cleanup(opts?: { keepSession?: boolean; cancelled?: boolean }) {
      const keepSession = opts?.keepSession === true;
      const cancelled = opts?.cancelled === true;
      if (done) return;
      done = true;
      activeCleanups.delete(tabId);
      if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
      if (progressFrame !== null) { cancelAnimationFrame(progressFrame); progressFrame = null; }
      if (warpInjectTimer) { clearTimeout(warpInjectTimer); warpInjectTimer = null; }
      if (warpRetryTimer) { clearTimeout(warpRetryTimer); warpRetryTimer = null; }
      globalOutputOff?.(); globalOutputOff = null;
      globalContextOff?.(); globalContextOff = null;
      globalExitOff?.(); globalExitOff = null;
      globalCommandStartOff?.(); globalCommandStartOff = null;
      clearReplay(tabId);

      if (isInteractive || detectedTUI) {
        notifyTui(tabId, false);
        if (isInteractive || resumedAlt) notifyAltScreen(tabId, false);
      }
      redrawPending.delete(tabId);
      // keepSession: warpify-confirm resolve — leave ssh streaming+warpified state set so
      // later remote commands keep routing as blocks over the same live PTY.
      if (isStreamingInteractive && !keepSession) { inStreamingSessionMap.delete(tabId); notifyWarpify(tabId, false); }

      const ms = elapsed();
      maybeNotify(input, ms);
      const out = parseOutput(normalBuf, effectiveInput);

      const gb = finalCtx?.gitBranch ?? state.gitBranch;
      const nextState: State = {
        cwd: finalCtx?.pwd ? finalCtx.pwd.split("/").filter(Boolean) : state.cwd,
        ctx: { ...state.ctx, name: finalCtx?.k8sContext ?? state.ctx.name },
        ...(gb ? { gitBranch: gb } : {}),
      };

      const rawCode = finalCtx?.exitCode ?? exitCode;
      // Signal exits from TUI apps are clean exits (130=Ctrl-C, 141=SIGPIPE, 143=SIGTERM)
      const cmdCode = (rawCode === 130 || rawCode === 141 || rawCode === 143) ? 0 : rawCode;
      // A command is "cancelled" if the user abandoned it, or it exited via SIGINT (130) — show a
      // clear marker instead of leaving a bare "^C" in the output or a silent empty block.
      const wasCancelled = cancelled || rawCode === 130;
      const cancelledOut: Out[] = wasCancelled
        ? [{ kind: "lines", lines: ["✕ cancelled"], tone: "bad" }]
        : [];
      const finalBlock: Block = {
        ...pendingBlock, ms, code: wasCancelled ? 130 : cmdCode,
        ctx: finalCtx?.k8sContext ?? state.ctx.name,
        out: wasCancelled
          ? [...out, ...cancelledOut]
          : (out.length ? out : (cmdCode !== 0 && !detectedTUI) ? [{ kind: "lines", lines: ["(no output)"], tone: "muted" }] : []),
        pending: false,
      };
      resolve({ block: finalBlock, next: nextState });
    }

    activeCleanups.set(tabId, cleanup);
    if (resume) return; // already running — nothing to send
    ensureReady(tabId).then(() => { commandWritten = true; shell.writeCommand(tabId, effectiveInput + "\n", input).catch(() => cleanup()); });
  });
}
