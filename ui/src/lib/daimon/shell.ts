import { shell } from "./rpc";
import type { ShellContext } from "./rpc";

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

export type Out =
  | { kind: "lines"; lines: string[]; tone?: "normal" | "muted" | "bad" | "good" }
  | { kind: "ansi"; html: string }
  | { kind: "files"; items: { name: string; dir: boolean; size?: number | undefined }[] }
  | { kind: "lslong"; entries: LsEntry[]; total: string }
  | { kind: "table"; head: string[]; rows: string[][]; accentCol?: number }
  | { kind: "pairs"; pairs: [string, string][] }
  | { kind: "gitlog"; entries: { hash: string; fullHash: string; date: string; subject: string; author: string; isHead?: boolean }[]; cwd: string }
  | { kind: "gitbranches"; branches: string[]; current: string }
  | { kind: "gitstatus"; branch: string; ahead: number; behind: number; staged: { xy: string; path: string }[]; unstaged: { xy: string; path: string }[]; untracked: string[] }
  | { kind: "gitdiff"; raw: string }
  | { kind: "logfmt"; lines: Record<string, string>[] }
  | { kind: "pretty"; format: "json" | "yaml"; text: string };

export type Block = {
  id: string;
  input: string;
  cwd: string[];
  ctx: string;
  at: string;
  ms: number;
  code: number;
  out: Out[];
  pending?: boolean;
};

export type State = { cwd: string[]; ctx: { name: string }; gitBranch?: string };

// Alt-screen sequences detected by XTermPanel directly.
const FULLSCREEN_MODE = /\x1b\[\?1049h/;

// Commands that stream interactively in daimon's own block view (no xterm panel).
// Input is forwarded via the composer; output streams into the block.
export const STREAMING_INTERACTIVE_RE = /^\s*(ssh|sftp|mosh|nc\s+|ncat\s+|telnet\s+)/;

// Commands that need xterm panel takeover (alt-screen TUI).
// Only list commands where we MUST route before any output (interactive shells, exec/attach).
// All other TUI apps (vim, k9s, claude, htop, etc.) are auto-detected via TUI_RE on first output.
const INTERACTIVE_RE = /^\s*(scp|ipmitool|ipmi|kubectl\s+(exec|attach|debug)|oc\s+(exec|attach)|docker\s+(exec|run\s+-it?)|podman\s+(exec|run\s+-it?)|sudo\s+(-[siSI]\s+)?(-u\s+\S+\s+)?(-[siSI]\s+)?(su|bash|zsh|sh|fish)\b|su\s+|bash\s+-i|zsh\s+-i|python\s+-c|python3\s+-c)/;

// TUI sequences that signal an interactive program.
// Covers: cursor-up redraws, erase-line, hide/show cursor (spinners/menus),
// cursor-absolute-position (full-screen apps: k9s, lazygit, etc emit \x1b[H or \x1b[r;cH),
// erase-display (\x1b[2J / \x1b[3J), enable mouse tracking (\x1b[?1000h).
const TUI_RE = /\x1b\[\d*A|\x1b\[2K|\x1b\[\?25[lh]|\x1b\[\d*;\d*H|\x1b\[H\b|\x1b\[2J|\x1b\[3J|\x1b\[\?1000h|\x1b\[\?1049[lh]/;

// Per-tab alt-screen state — driven by daemon altScreenEnter/Exit events.
const inAltScreenMap = new Map<string, boolean>();
function isAltScreen(tabId: string) { return inAltScreenMap.get(tabId) ?? false; }
export function getAltScreen(tabId: string) { return inAltScreenMap.get(tabId) ?? false; }
shell.onAltScreen((tabId, enter) => {
  inAltScreenMap.set(tabId, enter);
  altScreenListenerMap.get(tabId)?.forEach((fn) => fn(enter));
  if (enter) {
    // Also fire TUI notification so BlockView mounts xterm
    tuiListenerMap.get(tabId)?.forEach((fn) => fn(true));
  }
});

// Per-tab streaming-interactive state (ssh/mosh/telnet running as streaming block).
const inStreamingSessionMap = new Map<string, boolean>();
export function isStreamingSession(tabId: string) { return inStreamingSessionMap.get(tabId) ?? false; }

// Active run cleanups — lets cancel button force-abandon a stuck run
const activeCleanups = new Map<string, () => void>();
export function abandonRun(tabId: string) {
  activeCleanups.get(tabId)?.();
}

// Apply backspace
function applyBackspace(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\x08") out = out.slice(0, -1);
    else out += ch;
  }
  return out;
}

const ANSI = (s: string) =>
  applyBackspace(s)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][AB012B]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/\x1b[MDE]/g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

// Standard ANSI 256-color palette
const ANSI16 = ["#000","#c0392b","#27ae60","#e6a817","#3498db","#8e44ad","#16a085","#bdc3c7",
                 "#7f8c8d","#e74c3c","#2ecc71","#f1c40f","#5dade2","#a569bd","#1abc9c","#ecf0f1"];

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

function ansiToHtml(raw: string): string {
  const s = applyBackspace(raw)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][AB012B]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/\x1b[MDE]/g, "")
    .replace(/\x1b\[[0-9;?]*[A-LN-Za-ln-z]/g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/g, "");

  let out = "";
  let open = false;
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;

  for (const m of s.matchAll(re)) {
    out += esc(s.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    const codes = (m[1] ?? "").split(";").map(Number);
    let style = "";
    let i = 0;
    while (i < codes.length) {
      const c = codes[i]!;
      if (c === 0) { style = ""; }
      else if (c === 1) { style += "font-weight:bold;"; }
      else if (c === 2) { style += "opacity:0.7;"; }
      else if (c === 3) { style += "font-style:italic;"; }
      else if (c === 4) { style += "text-decoration:underline;"; }
      else if (c >= 30 && c <= 37) { style += `color:${ANSI16[c - 30]};`; }
      else if (c === 38) {
        if (codes[i+1] === 5 && codes[i+2] !== undefined) {
          // 256-color foreground
          style += `color:${ANSI256[codes[i+2]!] ?? "#ccc"};`;
          i += 2;
        } else if (codes[i+1] === 2 && codes[i+4] !== undefined) {
          // Truecolor foreground: 38;2;r;g;b
          const [,, r, g, b] = codes.slice(i, i + 5);
          style += `color:rgb(${r},${g},${b});`;
          i += 4;
        }
      }
      else if (c === 39) { style += "color:inherit;"; }
      else if (c >= 40 && c <= 47) { style += `background:${ANSI16[c - 40]};`; }
      else if (c === 48) {
        if (codes[i+1] === 5 && codes[i+2] !== undefined) {
          // 256-color background
          style += `background:${ANSI256[codes[i+2]!] ?? "#333"};`;
          i += 2;
        } else if (codes[i+1] === 2 && codes[i+4] !== undefined) {
          // Truecolor background: 48;2;r;g;b
          const [,, r, g, b] = codes.slice(i, i + 5);
          style += `background:rgb(${r},${g},${b});`;
          i += 4;
        }
      }
      else if (c >= 90 && c <= 97) { style += `color:${ANSI16[c - 90 + 8]};`; }
      else if (c >= 100 && c <= 107) { style += `background:${ANSI16[c - 100 + 8]};`; }
      i++;
    }
    if (open) { out += "</span>"; open = false; }
    if (style) { out += `<span style="${style}">`; open = true; }
  }
  out += esc(s.slice(last));
  if (open) out += "</span>";
  return out;
}

// Returns true if the string contains ANSI color/style escape sequences
const hasColor = (s: string) => /\x1b\[[0-9;]*m/.test(s);

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

function parse(rawText: string): Out[] {
  const cleaned = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (hasColor(cleaned)) {
    const stripped = ANSI(cleaned).trim();
    if (!stripped) return [];
    // git diff produces colored output — detect on stripped text before falling back to ansi
    const firstLines = stripped.split("\n").slice(0, 6).join("\n");
    if (/^(diff --git |--- [^\n]+\n\+\+\+ )/m.test(firstLines) || /^@@\s+-\d/m.test(firstLines)) {
      return [{ kind: "gitdiff", raw: stripped }];
    }
    return [{ kind: "ansi", html: ansiToHtml(cleaned).trim() }];
  }

  const text = cleaned.trim();
  if (!text) return [];

  if (text.startsWith("{") || text.startsWith("[")) {
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
    } catch { /**/ }
  }

  // ls -l / ls -la long-listing format:
  // optional "total N" header, then lines starting with permission chars [dlcbsp-][rwx-]{9}
  const lsLines = text.split("\n");
  const lsEntryRe = /^([dlcbsp-][rwx-]{9}[@+.]?)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\w{3})\s+(\d+)\s+(\d{2}:\d{2}|\d{4})\s+(.*)/;
  const lsDataLines = lsLines.filter((l) => lsEntryRe.test(l.trim()));
  if (lsDataLines.length >= 2 || (lsDataLines.length >= 1 && lsLines[0]?.startsWith("total "))) {
    const total = lsLines[0]?.startsWith("total ") ? lsLines[0].slice(6).trim() : "";
    const entries: LsEntry[] = lsDataLines.map((l) => {
      const m = lsEntryRe.exec(l.trim())!;
      const nameRaw = m[9]!.trim();
      const arrowIdx = nameRaw.indexOf(" -> ");
      return {
        perms: m[1]!, links: m[2]!, user: m[3]!, group: m[4]!,
        size: parseInt(m[5]!, 10), month: m[6]!, day: m[7]!, time: m[8]!,
        name: arrowIdx >= 0 ? nameRaw.slice(0, arrowIdx) : nameRaw,
        link: arrowIdx >= 0 ? nameRaw.slice(arrowIdx + 4) : undefined,
      };
    });
    return [{ kind: "lslong", entries, total }];
  }

  const lines = text.split("\n");
  if (lines.length >= 2) {
    const firstLine = lines[0]!;
    // Skip help/usage text: section headers end with ":" or first line is indented
    const looksLikeHelp = firstLine.trimStart() !== firstLine || firstLine.trimEnd().endsWith(":");
    if (!looksLikeHelp) {
      // Position-based column detection: find where each header word starts.
      // This handles kubectl-style headers with multi-word column names like
      // "NOMINATED NODE" and "READINESS GATES" that share a single space.
      const colStarts: number[] = [];
      const colNames: string[] = [];
      const headerRe = /\S+(?:\s\S+)*/g; // greedy: match word groups separated by 2+ spaces
      // Actually find runs of non-space chars separated by 2+ spaces to get column positions
      const headerColRe = /\S[\S ]*?(?=\s{2}|\s*$)/g;
      let hm: RegExpExecArray | null;
      while ((hm = headerColRe.exec(firstLine)) !== null) {
        colStarts.push(hm.index);
        colNames.push(hm[0].trim());
      }

      if (colNames.length >= 2) {
        // Slice each row by column start positions
        const dataLines = lines.slice(1).filter(Boolean);
        const rows = dataLines.map((l) => {
          return colStarts.map((start, i) => {
            const end = colStarts[i + 1] ?? l.length;
            return l.slice(start, end).trim();
          });
        });
        // Valid table: all rows have at least 2 non-empty cells in first 2 cols
        if (rows.length > 0 && rows.every((r) => r[0] && r[1] !== undefined)) {
          return [{ kind: "table", head: colNames, rows, accentCol: colNames.length - 1 }];
        }
      }
    }
  }

  // Logfmt: lines with key="value" or key=value pairs (at least time= and msg= or level=)
  {
    const logfmtLines = lines.filter((l) => l.trim().length > 0);
    const logfmtRe = /^(\w[\w.-]*)=("(?:[^"\\]|\\.)*"|\S*)/;
    const parsed = logfmtLines.map((l) => {
      const obj: Record<string, string> = {};
      let rest = l.trim();
      while (rest.length > 0) {
        const m = logfmtRe.exec(rest);
        if (!m) break;
        const k = m[1]!;
        const raw = m[2]!;
        obj[k] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\"/g, '"') : raw;
        rest = rest.slice(m[0].length).trimStart();
      }
      return Object.keys(obj).length >= 2 ? obj : null;
    });
    const matchCount = parsed.filter(Boolean).length;
    // Allow a few junk lines at the top (PTY echo, escape sequences) — need ≥3 logfmt lines and ≥50% match
    const hasLogfmt = matchCount >= 3 && matchCount >= logfmtLines.length * 0.5;
    const hasTimestampOrLevel = logfmtLines.some((l) => l.includes("time=") || l.includes("level="));
    if (hasLogfmt && hasTimestampOrLevel) {
      // Drop non-matching header lines, keep only parsed logfmt rows
      return [{ kind: "logfmt", lines: parsed.filter(Boolean) as Record<string, string>[] }];
    }
  }

  // Unified diff output (cat *.diff / *.patch)
  const firstLines = text.split("\n").slice(0, 6).join("\n");
  if (/^(diff --git |--- [^\n]+\n\+\+\+ )/m.test(firstLines) || /^@@\s+-\d/m.test(firstLines)) {
    return [{ kind: "gitdiff", raw: text }];
  }

  // YAML detection: "---" separator, "- " list items, or "key: value" pattern, at least 3 lines
  if (lines.length >= 3) {
    const yamlKeyRe = /^\s*[\w.-]+:\s/;
    const yamlListRe = /^\s*- /;
    const yamlDocRe = /^---\s*$/;
    const yamlLines = lines.filter((l) => yamlKeyRe.test(l) || yamlListRe.test(l) || yamlDocRe.test(l));
    if (yamlLines.length >= 3 || (lines[0]?.trim() === "---" && yamlLines.length >= 2)) {
      return [{ kind: "pretty", format: "yaml", text }];
    }
  }

  // Strip uniform leading whitespace (e.g. git branch `  branch-name` padding)
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length > 0) {
    const minIndent = Math.min(...nonEmpty.map((l) => l.match(/^(\s*)/)?.[1]?.length ?? 0));
    if (minIndent > 0) {
      return [{ kind: "lines", lines: lines.map((l) => l.slice(minIndent)) }];
    }
  }
  return [{ kind: "lines", lines }];
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

// Per-tab PTY replay buffer — accumulates bytes from command start so late inline-xterm
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
  onProgress: (block: Block) => void
): Promise<{ block: Block; next: State; clear?: boolean }> {
  const input = raw.trim();

  if (!input) {
    const block: Block = { id: Math.random().toString(36).slice(2), input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ms: 0, code: 0, out: [] };
    return { block, next: state };
  }

  if (input === "clear") {
    const block: Block = { id: Math.random().toString(36).slice(2), input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ms: 0, code: 0, out: [] };
    return { block, next: state, clear: true };
  }

  // Git commands — intercepted and rendered with rich UI
  const cwdStr = "/" + state.cwd.join("/");
  if (/^git\s+status(\s|$)/.test(input)) {
    const t = Date.now();
    const id = Math.random().toString(36).slice(2);
    try {
      const gs = await shell.gitStatus(cwdStr);
      const out: Out[] = [{ kind: "gitstatus", ...gs }];
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ms: Date.now() - t, code: 0, out }, next: state };
    } catch {
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ms: Date.now() - t, code: 1, out: [{ kind: "lines", lines: ["not a git repository"], tone: "bad" }] }, next: state };
    }
  }
  if (/^git\s+log(\s|$)/.test(input)) {
    const t = Date.now();
    const id = Math.random().toString(36).slice(2);
    try {
      const entries = await shell.listLog(cwdStr, 2000);
      const out: Out[] = [{ kind: "gitlog", entries, cwd: cwdStr }];
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ms: Date.now() - t, code: 0, out }, next: state };
    } catch {
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ms: Date.now() - t, code: 1, out: [{ kind: "lines", lines: ["not a git repository"], tone: "bad" }] }, next: state };
    }
  }
  if (/^git\s+branch(\s|$)/.test(input)) {
    const t = Date.now();
    const id = Math.random().toString(36).slice(2);
    try {
      const { branches, current } = await shell.listBranches(cwdStr);
      const out: Out[] = [{ kind: "gitbranches", branches, current }];
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ms: Date.now() - t, code: 0, out }, next: state };
    } catch {
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ms: Date.now() - t, code: 1, out: [{ kind: "lines", lines: ["not a git repository"], tone: "bad" }] }, next: state };
    }
  }
  if (/^git\s+(--no-pager\s+)?diff(\s|$)/.test(input)) {
    const t = Date.now();
    const id = Math.random().toString(36).slice(2);
    try {
      // Extract any extra args after "diff"
      const extraArgs = input.replace(/^git\s+(--no-pager\s+)?diff\s*/, "").trim();
      const args = extraArgs ? extraArgs.split(/\s+/) : [];
      const { raw } = await shell.gitDiff(cwdStr, args);
      const out: Out[] = raw.trim() ? [{ kind: "gitdiff", raw }] : [{ kind: "lines", lines: ["no changes"], tone: "muted" }];
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ms: Date.now() - t, code: 0, out }, next: state };
    } catch {
      return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ms: Date.now() - t, code: 1, out: [{ kind: "lines", lines: ["not a git repository"], tone: "bad" }] }, next: state };
    }
  }

  // Rewrite git diff/show/log to use --no-pager so less never launches
  const noPagerRewrite = input.replace(/^(git)\s+(diff|show|log|blame)(\s|$)/, "git --no-pager $2$3");
  const effectiveInput = noPagerRewrite !== input ? noPagerRewrite : input;

  const t0 = Date.now();
  let normalBuf = "";
  let exitCode = 0;
  let finalCtx: ShellContext | null = null;
  const id = Math.random().toString(36).slice(2);

  let detectedTUI = false;
  const isInteractive = INTERACTIVE_RE.test(input);
  const isStreamingInteractive = STREAMING_INTERACTIVE_RE.test(input);
  // If a streaming-interactive session (ssh/mosh) is active, commands sent here go to the
  // remote shell which never emits onContext — resolve on PTY exit instead.
  const insideInteractiveSession = isStreamingSession(tabId) || isAltScreen(tabId);
  // Start buffering all PTY bytes from this command so inline xterm can replay on mount
  startReplay(tabId);
  if (isInteractive) notifyAltScreen(tabId, true);
  if (isStreamingInteractive) inStreamingSessionMap.set(tabId, true);

  const pendingBlock: Block = { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ms: 0, code: 0, out: [], pending: true };
  onProgress(pendingBlock);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  let commandWritten = false;
  let commandStarted = false;
  const emitProgress = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (done) return;
      const stripped = stripPromptLines(stripEcho(ANSI(normalBuf).trim(), effectiveInput));
      const forParse = stripPromptLines(stripEcho(normalBuf, effectiveInput));
      onProgress({ ...pendingBlock, ms: Date.now() - t0, out: stripped ? parse(forParse) : [], pending: true });
    }, 80);
  };

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
        normalBuf += cleanData;
        emitProgress();
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
      normalBuf += cleanData;
      emitProgress();
    });

    globalExitOff = shell.onExit((tid, code) => {
      if (tid !== tabId) return;
      exitCode = code;
      // Interactive/TUI commands: remote shell never fires onContext, so resolve on exit.
      if (isInteractive || isStreamingInteractive || detectedTUI || insideInteractiveSession) {
        // Give onContext a brief window to arrive first (local shell emits it quickly after exit)
        setTimeout(() => { if (!done) cleanup(); }, 300);
      }
    });

    globalCommandStartOff = shell.onCommandStart((tid) => {
      if (tid !== tabId) return;
      commandStarted = true;
    });

    globalContextOff = shell.onContext((tid, ctx) => {
      if (tid !== tabId) return;
      if (!commandWritten) return;
      if (!commandStarted) return; // ignore startup precmd prompt — wait for real command
      finalCtx = ctx;
      // Stop buffering immediately — the prompt line arrives after context and
      // would pollute normalBuf, causing parse() to produce different output than
      // the last emitProgress call (flicker). Unsubscribe now, then cleanup after
      // the emitProgress debounce (80ms) has settled.
      globalOutputOff?.(); globalOutputOff = null;
      setTimeout(cleanup, 100);
    });

    function cleanup() {
      if (done) return;
      done = true;
      activeCleanups.delete(tabId);
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      globalOutputOff?.(); globalOutputOff = null;
      globalContextOff?.(); globalContextOff = null;
      globalExitOff?.(); globalExitOff = null;
      globalCommandStartOff?.(); globalCommandStartOff = null;
      clearReplay(tabId);

      if (isInteractive || detectedTUI) {
        notifyTui(tabId, false);
        notifyAltScreen(tabId, false);
      }
      if (isStreamingInteractive) inStreamingSessionMap.delete(tabId);

      const ms = Date.now() - t0;
      const stripped = stripPromptLines(stripEcho(ANSI(normalBuf).trim(), effectiveInput));
      const forParse = stripPromptLines(stripEcho(normalBuf, effectiveInput));
      const out = stripped ? parse(forParse) : [];

      const gb = finalCtx?.gitBranch ?? state.gitBranch;
      const nextState: State = {
        cwd: finalCtx?.pwd ? finalCtx.pwd.split("/").filter(Boolean) : state.cwd,
        ctx: { ...state.ctx, name: finalCtx?.k8sContext ?? state.ctx.name },
        ...(gb ? { gitBranch: gb } : {}),
      };

      const rawCode = finalCtx?.exitCode ?? exitCode;
      // Signal exits from TUI apps are clean exits (130=Ctrl-C, 141=SIGPIPE, 143=SIGTERM)
      const cmdCode = (rawCode === 130 || rawCode === 141 || rawCode === 143) ? 0 : rawCode;
      const finalBlock: Block = {
        ...pendingBlock, ms, code: cmdCode,
        ctx: finalCtx?.k8sContext ?? state.ctx.name,
        out: out.length ? out : (cmdCode !== 0 && !detectedTUI) ? [{ kind: "lines", lines: ["(no output)"], tone: "muted" }] : [],
        pending: false,
      };
      resolve({ block: finalBlock, next: nextState });
    }

    activeCleanups.set(tabId, cleanup);
    ensureReady(tabId).then(() => { commandWritten = true; shell.write(tabId, effectiveInput + "\n").catch(() => cleanup()); });
  });
}
