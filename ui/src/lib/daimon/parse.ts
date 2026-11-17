/// Output parsing: PTY text → the blocks' structured output (Out). Pure — no DOM, no daemon
/// connection — so it runs in the parse worker (parseWorker.ts) as well as on the page.

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

/** A branch/tag pointing at a commit in `git log` (see `parse_decorations` in the daemon). */
export type GitLogRef = { name: string; kind: "local" | "remote" | "tag"; current: boolean; trunk: boolean; synced: string[] };

export type Out =
  | { kind: "lines"; lines: string[]; tone?: "normal" | "muted" | "bad" | "good" }
  /** `lines`: the same html split per line (self-contained), when the parser already has it.
   *  Non-enumerable — for rendering only, never persisted or copied. */
  | { kind: "ansi"; html: string; lines?: string[] }
  | { kind: "image"; src: string }
  | { kind: "files"; items: { name: string; dir: boolean; size?: number | undefined }[] }
  | { kind: "lslong"; entries: LsEntry[]; total: string }
  | { kind: "table"; head: string[]; rows: string[][]; accentCol?: number }
  | { kind: "pairs"; pairs: [string, string][] }
  | { kind: "gitlog"; entries: { hash: string; fullHash: string; date: string; subject: string; author: string; isHead?: boolean; unpushed?: boolean; unpushedTo?: string; refs?: GitLogRef[] }[]; cwd: string }
  | { kind: "gitbranches"; branches: string[]; current: string; trunk?: string | null; nodes?: GitBranchNode[] }
  | { kind: "gitstatus"; branch: string; upstream?: string | null; ahead: number; behind: number; staged: GitStatusFile[]; unstaged: GitStatusFile[]; untracked: string[]; added?: number; removed?: number }
  | { kind: "gitdiff"; raw: string }
  | { kind: "logfmt"; lines: Record<string, string>[] }
  | { kind: "pretty"; format: "json" | "yaml"; text: string };

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

/** A control character other than tab/newline, or an escape that isn't a plain SGR colour code. */
const NOT_ONLY_SGR_RE = /[\x00-\x08\x0b-\x1a\x1c-\x1f]|\x1b(?!\[[0-9;]*m)/;
const SGR_STRIP_RE = /\x1b\[[0-9;]*m/g;

const ANSI = (s: string) =>
  // Nothing to strip without a control character (tab and newline are kept).
  !/[\x00-\x08\x0b-\x1f]/.test(s) ? s
  // Only colour codes (most coloured output): the chain below would remove just those.
  : !NOT_ONLY_SGR_RE.test(s) ? s.replace(SGR_STRIP_RE, "")
  : applyBackspace(s)
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

// Coloured output repeats a few attribute combinations endlessly, so both steps below are
// cached: states are interned (equal attributes → the same object), which lets each
// (state, params) → state step and each state's CSS be looked up instead of recomputed.
const sgrInterned = new Map<string, Sgr>();
const sgrSteps = new WeakMap<Sgr, Map<string, Sgr>>();
const sgrCssCache = new WeakMap<Sgr, string>();
const SGR_CACHE_MAX = 4096;   // distinct states; truecolor gradients could otherwise grow it

function sgrIntern(s: Sgr): Sgr {
  const key = `${s.fg}|${s.bg}|${+s.bold}${+s.dim}${+s.italic}${+s.underline}`;
  const known = sgrInterned.get(key);
  if (known) return known;
  if (sgrInterned.size >= SGR_CACHE_MAX) sgrInterned.clear();
  sgrInterned.set(key, s);
  return s;
}

/** `s` after one SGR sequence with the parameters `params` ("1;33"). */
function sgrApply(s: Sgr, params: string): Sgr {
  let steps = sgrSteps.get(s);
  const hit = steps?.get(params);
  if (hit) return hit;
  const next = sgrIntern(sgrApplyUncached(s, params));
  if (!steps) sgrSteps.set(s, (steps = new Map()));
  if (steps.size < 64) steps.set(params, next);
  return next;
}

function sgrApplyUncached(s: Sgr, params: string): Sgr {
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
  let css = sgrCssCache.get(s);
  if (css === undefined) sgrCssCache.set(s, (css = sgrCssUncached(s)));
  return css;
}

function sgrCssUncached(s: Sgr): string {
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
/** The conversion state at a point where the attributes are `sgr` (and no hyperlink is open). */
const htmlStateAt = (sgr: Sgr): AnsiHtmlState => { const css = sgrCss(sgr); return { open: css !== "", curStyle: css, linkOpen: false, sgr }; };
/** The tags open there (see splitHtmlLines). */
const openTagsAt = (sgr: Sgr): string[] => { const css = sgrCss(sgr); return css ? [`<span style="${css}">`] : []; };

/** Convert one piece of text, continuing from `st`. Close with ansiHtmlClose() after the last piece. */
/**
 * Calls fn(start, end, params) for each SGR sequence "\x1b[<params>m" in s — what
 * s.matchAll(/\x1b\[([0-9;]*)m/g) finds, without the regex machinery (this runs per line).
 */
function eachSgr(s: string, fn: (start: number, end: number, params: string) => void): void {
  for (let i = s.indexOf("\x1b["); i >= 0; ) {
    let j = i + 2;
    for (let c = s.charCodeAt(j); (c >= 48 && c <= 57) || c === 59; c = s.charCodeAt(++j));
    // Digits and ";" can't start another sequence, so the search goes on after them.
    if (s.charCodeAt(j) === 109) { fn(i, j + 1, s.slice(i + 2, j)); j++; }
    i = s.indexOf("\x1b[", j);
  }
}

const escHtml = (t: string) => (!/[&<>]/.test(t) ? t : t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));

function ansiHtmlChunk(raw: string, st: AnsiHtmlState): string {
  // Only colour codes (most coloured output): the same conversion as below, in one scan.
  if (!NOT_ONLY_SGR_RE.test(raw)) {
    const esc = /[&<>]/.test(raw) ? escHtml : (t: string) => t;
    let out = "", last = 0;
    let { open, sgr } = st;
    let curStyle = st.curStyle;
    eachSgr(raw, (start, end, params) => {
      out += esc(raw.slice(last, start));
      last = end;
      sgr = sgrApply(sgr, params);
      const style = sgrCss(sgr);
      if (open) { out += "</span>"; open = false; }
      if (style) { out += `<span style="${style}">`; open = true; }
      curStyle = style;
    });
    out += esc(raw.slice(last));
    st.open = open; st.curStyle = curStyle; st.sgr = sgr;
    return out;
  }
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
  const esc = (t: string) => (!/[&<>]/.test(t) ? t : t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
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

/**
 * Split ANSI html (from ansiToHtml: text plus <span style> / <a> tags) into one
 * self-contained html string per line: tags open across a line break are closed at its
 * end and reopened at the start of the next line.
 *
 * `open`: the tags in effect before `html` (outermost first), e.g. from a previous call.
 * It is updated in place to those in effect after it, so text can be split piece by piece.
 */
export function splitHtmlLines(html: string, open: string[] = []): string[] {
  // One line that starts and ends with nothing open is already self-contained: return it
  // as is rather than an equal copy (the stream keeps both, for every line).
  if (!open.length && !html.includes("\n")) {
    for (const m of html.matchAll(/<\/?[a-z][^>]*>/gi)) {
      if (m[0][1] === "/") open.pop(); else open.push(m[0]);
    }
    if (!open.length) return [html];
    open.length = 0; // unbalanced: take the general path from the same start
  }
  const lines: string[] = [];
  let cur = open.join("");
  const close = () => open.slice().reverse().map((t) => (t.startsWith("<a") ? "</a>" : "</span>")).join("");
  for (const m of html.matchAll(/<\/?[a-z][^>]*>|\n|[^<\n]+/gi)) {
    const t = m[0];
    if (t === "\n") { lines.push(cur + close()); cur = open.join(""); continue; }
    if (t.startsWith("</")) { open.pop(); cur += t; continue; }
    if (t.startsWith("<")) { open.push(t); cur += t; continue; }
    cur += t;
  }
  lines.push(cur + close());
  return lines;
}

/**
 * How much of one block's output is kept: the first HEAD and last TAIL lines. Other
 * terminals keep a few thousand lines of scrollback in all; keeping every line of a
 * 100 MB `cat` costs gigabytes in the webview, the database and the daemon.
 */
const KEEP_HEAD_LINES = 1_000;
const KEEP_TAIL_LINES = 50_000;
const omitted = (n: number) => `… ${n.toLocaleString("en-US")} lines omitted …`;

/**
 * While a command runs, its block shows only the last LIVE_WINDOW lines. Rendering (and
 * re-laying out) every line of a huge output on every frame is where the memory went;
 * the finished block has all of it (up to the cap above).
 */
export const LIVE_WINDOW = 5_000;
const earlierLines = (n: number) => `… ${n.toLocaleString("en-US")} earlier lines — all shown when the command finishes …`;
const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Trim a finished block's output to KEEP_HEAD_LINES + KEEP_TAIL_LINES (plain and ANSI text). */
/** Live views that show only the end of a longer output (see LIVE_WINDOW). */
const PARTIAL = new WeakSet<Out>();
export const isPartial = (o: Out) => PARTIAL.has(o);

/** "ansi" outputs whose html is exactly their lines joined with "\n" (see the parse worker). */
const HTML_IS_LINES = new WeakSet<Out>();
export const htmlIsLines = (o: Out) => HTML_IS_LINES.has(o);

/** Outputs built capped already (OutputStream.final), which capOutput leaves alone. */
const CAPPED = new WeakSet<Out>();

export function capOutput(out: Out[]): Out[] {
  return out.map((o) => {
    if (CAPPED.has(o)) return o;
    if (o.kind === "lines" && o.lines.length > KEEP_HEAD_LINES + KEEP_TAIL_LINES) {
      const n = o.lines.length - KEEP_HEAD_LINES - KEEP_TAIL_LINES;
      return { ...o, lines: [...o.lines.slice(0, KEEP_HEAD_LINES), omitted(n), ...o.lines.slice(-KEEP_TAIL_LINES)] };
    }
    if (o.kind === "ansi") {
      if (o.lines) {
        // The stream's per-line html: no need to look at (or flatten) the html string.
        if (o.lines.length <= KEEP_HEAD_LINES + KEEP_TAIL_LINES) return o;
      } else {
        // Count before splitting: most output is far below the cap.
        let count = 1;
        for (let i = o.html.indexOf("\n"); i >= 0 && count <= KEEP_HEAD_LINES + KEEP_TAIL_LINES; i = o.html.indexOf("\n", i + 1)) count++;
        if (count <= KEEP_HEAD_LINES + KEEP_TAIL_LINES) return o;
      }
      const all = o.lines ?? splitHtmlLines(o.html);
      const n = all.length - KEEP_HEAD_LINES - KEEP_TAIL_LINES;
      const lines = [...all.slice(0, KEEP_HEAD_LINES), escapeHtml(omitted(n)), ...all.slice(-KEEP_TAIL_LINES)];
      const capped: Out = { kind: "ansi", html: lines.join("\n") };
      Object.defineProperty(capped, "lines", { value: lines, enumerable: false });
      HTML_IS_LINES.add(capped);
      return capped;
    }
    return o;
  });
}

function ansiToHtml(raw: string): string {
  const st = newAnsiHtmlState();
  const out = ansiHtmlChunk(raw, st);
  return out + ansiHtmlClose(st);
}

/** Whether `s` prints something with a background colour — visible output even if it is only spaces (a colour bar). */
function paintsBg(s: string): boolean {
  if (!s.includes("\x1b[")) return false;
  let sgr = SGR_NONE;
  let last = 0;
  for (const m of s.matchAll(SGR_RE)) {
    if (sgr.bg && ANSI(s.slice(last, m.index)) !== "") return true;
    sgr = sgrApply(sgr, m[1]!);
    last = (m.index ?? 0) + m[0].length;
  }
  return !!sgr.bg && ANSI(s.slice(last)) !== "";
}

// Returns true if the string contains ANSI color/style escape sequences or OSC 8
// hyperlinks — anything that needs the html renderer.
const hasColor = (s: string) => /\x1b\[[0-9;]*m|\x1b\]8;/.test(s);

export const now = () =>
  new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * Whitespace removed, for comparing a line with the command it may echo. When the echo is wider
 * than the terminal, zsh adds " \r\x1b[K \r" at each wrap point; with the controls stripped that
 * leaves stray spaces in the line, wherever the wrap fell.
 */
const echoKey = (s: string) => s.replace(/\s+/g, "");

// Strip PTY command echo: compare stripped version, keep raw line
function stripEcho(text: string, input: string): string {
  const cmd = echoKey(input);
  return text.split("\n").filter((l) => echoKey(ANSI(l)) !== cmd).join("\n").trim();
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
    if (line.includes("\x1b[")) eachSgr(line, (_s, _e, params) => { carry.sgr = sgrApply(carry.sgr, params); });
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

export function parse(rawText: string): Out[] {
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
    if (!stripped && !paintsBg(cleaned)) return [];
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
export function parseOutput(raw: string, input: string): Out[] {
  const stripped = stripPromptLines(stripEcho(ANSI(raw).trim(), input));
  const forParse = stripPromptLines(stripEcho(raw, input));
  const hasImg = /\x1b\]1337;File=/.test(forParse);
  return (stripped || hasImg || paintsBg(forParse)) ? parse(forParse) : [];
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
  if (!l.includes("\x08")) return false;
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

export class OutputStream {
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
  // The html of the finished lines, as "\n"-joined text split in two so a snapshot can trim
  // it without touching (and copying) all of it: `aCore` has no whitespace at either end,
  // `aWs` is the whitespace after it. Their concatenation is the html so far.
  private aCore = "";
  private aWs = "";
  private aLines: string[] = [];        // the same, one self-contained html string per line
  private aLinesOpen: string[] = [];    // tags open at the end of aLines (see splitHtmlLines)
  private aState = newAnsiHtmlState();
  // Lazy conversion. Past the first KEEP_HEAD_LINES lines of coloured output, a finished
  // line is converted only when it is shown (the live view's end) or kept (the cap's tail):
  // a 150k-line output needs html for ~55k of them. Lines from `lazyFrom` on keep their raw
  // text in `done` and their starting attributes in `startSgr`; the html state at a line's
  // start follows from those (no hyperlinks in lazy lines — see `materialize`).
  private startSgr: Sgr[] = [];          // attributes at the start of each line in `done`
  private lazyFrom = -1;                  // first line left unconverted (-1: none)
  private lastLink = -1;                  // last line in `done` with a hyperlink (never lazy)
  private lazyHtml = new Map<number, string>();   // converted lazy lines (self-contained)
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
    this.cmd = echoKey(input);
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
  snapshot(raw: string, liveLines?: number, final = false): Out[] {
    if (this.complex) return parseOutput(raw, this.input);
    const tail = this.tail;
    if (tail.includes("\x1b]1337;File=") || backspaceUnderflows(tail)) return parseOutput(raw, this.input);
    const tailText = ANSI(tail).trim();
    const tailKept = echoKey(tailText) !== this.cmd && !PROMPT_RE.test(tailText);
    if (!this.visible && !(tailKept && (tailText || paintsBg(tail)))) return [];

    // The unfinished end: held lines plus the partial last line, trimmed as the end of the text.
    const carry: SgrCarry = { sgr: this.carry.sgr };
    const open = trimLines(tailKept ? [...this.held, tail] : this.held, !this.started).map((l) => renderLine(l, carry));
    if (!open.length) return [];
    for (let i = 0; i < open.length; i++) {
      if (open[i]!.includes("\x08") || (i < open.length - 1 && hasOpenOsc(open[i]!))) return parseOutput(raw, this.input);
    }
    return this.color || open.some(hasColor) ? this.ansiOut(open, liveLines, final) : this.plainOut(open, liveLines);
  }

  /** One finished raw line. */
  private addRaw(l: string): void {
    if (l.includes("\x1b]1337;File=") || hasOpenOsc(l) || backspaceUnderflows(l)) { this.complex = true; return; }
    // Without the CRLF's "\r" (ANSI drops it anyway), colour-only lines take ANSI's fast path.
    const text = ANSI(l.endsWith("\r") ? l.replace(/\r+$/, "") : l).trim();
    // Command echo / prompt line. (`text` is trimmed, so its first character is echoKey's:
    // a mismatch there settles the echo test without stripping the whole line.)
    if ((text[0] === this.cmd[0] && echoKey(text) === this.cmd) || PROMPT_RE.test(text)) return;
    if (text || paintsBg(l)) this.visible = true;
    if (isBlank(l)) { if (this.started) this.held.push(l); return; }
    for (const h of this.held) { const start = this.carry.sgr; this.addDone(renderLine(h, this.carry), start); }
    this.held = [this.started ? l : l.trimStart()];
    this.started = true;
  }

  private addDone(r: string, start: Sgr): void {
    if (r.includes("\x08") || hasOpenOsc(r)) { this.complex = true; return; }
    this.startSgr[this.done.length] = start;
    if (r.includes("\x1b]8;")) this.lastLink = this.done.length;
    if (!this.color && hasColor(r)) this.color = true;
    if (!isBlank(r)) {
      if (this.first < 0) this.first = this.done.length;
      this.last = this.done.length;
    }
    this.done.push(r);
  }

  private ansiOut(open: string[], liveLines?: number, final = false): Out[] {
    this.convertFinished();
    if (this.diff !== false) {
      const text = (this.aText + open.map(ANSI).join("\n")).trim();
      // No text but visible: background-coloured spaces, not a diff.
      const isDiff = !!text && (this.diff ?? looksLikeDiff(text.split("\n", 6).join("\n")));
      // Settled once the lines it is judged on can no longer be the (trimmed) end of the text.
      if (this.aFirst >= 0 && this.aLast >= this.aFirst + 6) {
        this.diff = isDiff;
        if (!isDiff) this.aText = "";
      }
      if (isDiff) return [{ kind: "gitdiff", raw: text }];
    }
    const lazy = this.lazyFrom >= 0;
    const st = lazy ? htmlStateAt(this.carry.sgr) : { ...this.aState };
    const openHtml = ansiHtmlChunk(open.join("\n"), st) + ansiHtmlClose(st);
    const openLines = open.length ? splitHtmlLines(openHtml, lazy ? openTagsAt(this.carry.sgr) : [...this.aLinesOpen]) : [];
    const count = this.done.length + openLines.length;
    const lineAt = (i: number) => (i < this.done.length ? this.lineHtml(i) : openLines[i - this.done.length]!);
    const linesFrom = (a: number, b: number) => { const ls: string[] = []; for (let i = a; i < b; i++) ls.push(lineAt(i)); return ls; };
    const withLines = (html: string, lines: string[]): Out[] => {
      const out: Out = { kind: "ansi", html };
      Object.defineProperty(out, "lines", { value: lines, enumerable: false });
      HTML_IS_LINES.add(out);
      return [out];
    };
    if (liveLines && count > liveLines) {
      // Live view of a long output: just its end, built from the per-line html.
      const keep = Math.max(0, liveLines - 1 - openLines.length);
      const lines = [escapeHtml(earlierLines(this.done.length - keep)), ...linesFrom(this.done.length - keep, count)];
      if (lazy) this.trimLazyCache(this.done.length - KEEP_TAIL_LINES - liveLines);
      const out = withLines(lines.join("\n"), lines);
      PARTIAL.add(out[0]!);
      return out;
    }
    if (final && count > KEEP_HEAD_LINES + KEEP_TAIL_LINES) {
      // The finished block, capped (= capOutput of the full output), converting only what it keeps.
      const lines = [...linesFrom(0, KEEP_HEAD_LINES), escapeHtml(omitted(count - KEEP_HEAD_LINES - KEEP_TAIL_LINES)), ...linesFrom(count - KEEP_TAIL_LINES, count)];
      const out = withLines(lines.join("\n"), lines);
      CAPPED.add(out[0]!);
      return out;
    }
    if (lazy) { this.materialize(); return this.ansiOut(open, liveLines, final); }
    // = (finished html + "\n" + openHtml).trim(), touching only the small end.
    const end = (this.aNext > 0 ? this.aWs + "\n" : "") + openHtml;
    const html = this.aCore ? this.aCore + end.trimEnd() : end.trim();
    const out: Out = { kind: "ansi", html };
    const lines = [...this.aLines, ...openLines];
    Object.defineProperty(out, "lines", { value: lines, enumerable: false });
    return [out];
  }

  /** Bring the html of the finished lines up to date (lazy lines excepted). */
  private convertFinished(): void {
    if (this.lazyFrom >= 0 && this.lastLink >= this.lazyFrom) this.materialize();
    for (; this.aNext < this.done.length; this.aNext++) {
      // Lazy only once the live view is a window (> LIVE_WINDOW lines): a full live snapshot
      // needs every line's html, which would undo it.
      if (this.lazyFrom >= 0 || (!this.noLazy && this.aNext >= KEEP_HEAD_LINES && this.done.length > LIVE_WINDOW
          && this.color && this.diff === false && !this.aState.linkOpen)) {
        if (this.lazyFrom < 0) this.lazyFrom = this.aNext;
        continue;   // converted when needed (lineHtml)
      }
      const r = this.done[this.aNext]!;
      // A line holds no "\n", so its html is the same with or without the separator.
      const before = this.aState.open || this.aState.linkOpen;
      const lineHtml = ansiHtmlChunk(r, this.aState);
      // Nothing open before or after: the line is self-contained as converted (no tag scan).
      if (!before && !this.aState.open && !this.aState.linkOpen && !this.aLinesOpen.length) this.aLines.push(lineHtml);
      else this.aLines.push(splitHtmlLines(lineHtml, this.aLinesOpen)[0]!);
      const piece = (this.aNext > 0 ? "\n" : "") + lineHtml;
      const kept = piece.trimEnd();
      if (!kept) this.aWs += piece;
      else if (!this.aCore) { this.aCore = (this.aWs + kept).trimStart(); this.aWs = piece.slice(kept.length); }
      else { this.aCore += this.aWs + kept; this.aWs = piece.slice(kept.length); }
      // Coloured output never goes back to the plain path: the raw line isn't needed again.
      if (this.color) this.done[this.aNext] = "";
      if (this.diff === false) continue;
      const text = ANSI(r);
      if (!isBlank(text)) {
        if (this.aFirst < 0) this.aFirst = this.aNext;
        this.aLast = this.aNext;
      }
      this.aText += text + "\n";
    }
  }

  /**
   * Convert lazy lines ahead of need, at most `budget` of them: the ones the finished block
   * will keep (its last KEEP_TAIL_LINES), oldest first so the work follows the output. The
   * parse worker calls this while it waits for output. Returns whether more is left.
   */
  prepare(budget: number): boolean {
    if (this.complex || !this.color) return false;
    this.convertFinished();
    if (this.lazyFrom < 0) return false;
    let i = Math.max(this.prepNext, this.lazyFrom, this.done.length - KEEP_TAIL_LINES);
    for (const end = this.done.length; i < end && budget > 0; i++) {
      if (!this.lazyHtml.has(i)) { this.lineHtml(i); budget--; }
    }
    this.prepNext = i;
    return i < this.done.length;
  }
  private prepNext = 0;

  /** Line i's self-contained html, converting a lazy line from its starting attributes. */
  private lineHtml(i: number): string {
    if (this.lazyFrom < 0 || i < this.lazyFrom) return this.aLines[i]!;
    let h = this.lazyHtml.get(i);
    if (h === undefined) {
      const sgr = this.startSgr[i]!;
      const st = htmlStateAt(sgr);
      const body = ansiHtmlChunk(this.done[i]!, st);
      h = (openTagsAt(sgr)[0] ?? "") + body + ansiHtmlClose(st);
      this.lazyHtml.set(i, h);
    }
    return h;
  }

  private trimLazyCache(below: number): void {
    if (this.lazyHtml.size < KEEP_TAIL_LINES + 2 * LIVE_WINDOW) return;
    for (const i of this.lazyHtml.keys()) if (i < below) this.lazyHtml.delete(i);
  }

  /** Convert the lazy lines after all, in order (the exact, uncapped html needs them all). */
  private materialize(): void {
    if (this.lazyFrom < 0) return;
    const from = this.lazyFrom;
    this.lazyFrom = -1;
    this.lazyHtml.clear();
    this.aState = htmlStateAt(this.startSgr[from]!);
    this.aLinesOpen = openTagsAt(this.startSgr[from]!);
    this.aNext = from;
    // Leaves the loop in ansiOut to do the converting, with nothing left lazy.
    this.noLazy = true;
  }
  private noLazy = false;

  /** The finished output, capped like capOutput(): with lazy lines, only what is kept is converted. */
  final(raw: string): Out[] {
    return capOutput(this.snapshot(raw, undefined, true));
  }

  private plainOut(open: string[], liveLines?: number): Out[] {
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

    if (liveLines && lines.length + end.length > liveLines) {
      // Live view of a long output: just its end.
      const keep = Math.max(0, liveLines - 1 - end.length);
      const out: Out = { kind: "lines", lines: [earlierLines(lines.length - keep), ...lines.slice(lines.length - keep), ...end] };
      PARTIAL.add(out);
      return [out];
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
