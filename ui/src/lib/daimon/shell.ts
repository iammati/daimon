import { shell } from "./rpc";
import { perf, type AttachInfo, type ShellContext } from "./rpc";
import { now, LIVE_WINDOW, OutputStream, type Out } from "./parse";
import { renderScreen } from "./screen";
import { outputParser } from "./parseClient";
export { OutputStream, parseOutput, capOutput, normalizeTerminal, LIVE_WINDOW, splitHtmlLines, looksLikeYaml } from "./parse";
export type { Out, LsEntry, GitStatusFile, GitBranchNode, GitLogRef } from "./parse";

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

// Terminal state changes that mean nothing in a text block: private mode set/reset,
// cursor save/restore (ESC 7 / ESC 8) and scroll-region set/reset (CSI r). Full-screen
// programs (claude, vim) send these before their first frame, i.e. before TUI detection.
const PTY_STATE_RE = /\x1b\[\?[0-9;]*[hlsur]|\x1b[78]|\x1b\[[0-9;]*r/g;

// Per-tab alt-screen state — driven by daemon altScreenEnter/Exit events.
const inAltScreenMap = new Map<string, boolean>();
function isAltScreen(tabId: string) { return inAltScreenMap.get(tabId) ?? false; }
export function getAltScreen(tabId: string) { return inAltScreenMap.get(tabId) ?? false; }
// Programs like nano and less redraw on SIGWINCH by leaving and re-entering the alt screen
// (1049l + 1049h back to back). Taken literally, the exit unmounts the inline terminal and the
// enter mounts a fresh one, whose fit resizes the PTY again: an endless remount loop. So an
// exit only counts once the program has stayed out of the alt screen for a moment.
const ALT_EXIT_GRACE_MS = 150;
const altExitTimers = new Map<string, ReturnType<typeof setTimeout>>();
function cancelAltExit(tabId: string) {
  const t = altExitTimers.get(tabId);
  if (t) { clearTimeout(t); altExitTimers.delete(tabId); }
}
function applyAltScreen(tabId: string, enter: boolean) {
  inAltScreenMap.set(tabId, enter);
  altScreenListenerMap.get(tabId)?.forEach((fn) => fn(enter));
  // Also fire TUI notification so BlockView mounts the terminal
  if (enter) tuiListenerMap.get(tabId)?.forEach((fn) => fn(true));
}
shell.onAltScreen((tabId, enter) => {
  cancelAltExit(tabId);
  if (enter) {
    if (!isAltScreen(tabId)) applyAltScreen(tabId, true); // else: a redraw cycle — nothing changed
    return;
  }
  altExitTimers.set(tabId, setTimeout(() => { altExitTimers.delete(tabId); applyAltScreen(tabId, false); }, ALT_EXIT_GRACE_MS));
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
/** Finalise a tab's running block with the output it has (its end marker was missed). */
export function finishRun(tabId: string) {
  activeCleanups.get(tabId)?.();
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
  cancelAltExit(tabId);
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

// Only the end is kept (whole chunks, at least REPLAY_KEEP chars): a full-screen program
// redraws its screen anyway, and the daemon's own reattach replay is capped the same way.
// Keeping every byte held a second copy of any big output for the whole command.
const REPLAY_KEEP = 2 << 20;
/** The output a cursor-moving command leaves on screen, parsed like any other output. */
function screenOutput(input: string, raw: string): Out[] {
  const text = renderScreen(raw);
  const stream = new OutputStream(input);
  stream.push(text);
  return stream.final(text);
}
/** Most output (chars) a command may send and still be redrawn as a screen at its end (see run). */
const RAW_KEEP = 1 << 20;
const replaySize = new Map<string, number>();
function startReplay(tabId: string) { replayBufMap.set(tabId, []); replaySize.set(tabId, 0); }
function appendReplay(tabId: string, data: string) {
  const buf = replayBufMap.get(tabId);
  if (!buf) return;
  buf.push(data);
  let size = (replaySize.get(tabId) ?? 0) + data.length;
  let drop = 0;
  while (drop < buf.length - 1 && size - buf[drop]!.length >= REPLAY_KEEP) size -= buf[drop++]!.length;
  if (drop) buf.splice(0, drop);
  replaySize.set(tabId, size);
}
function clearReplay(tabId: string) { replayBufMap.delete(tabId); replaySize.delete(tabId); }

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

/**
 * Split a command line the way a shell would for plain words and quotes. Returns null if it
 * needs a real shell (pipes, redirects, `;`/`&&`, `$VAR`, `$(…)`, backticks, globs), so the
 * caller can leave the command to the terminal.
 */
export function splitPlainArgs(line: string): string[] | null {
  const out: string[] = [];
  let cur = "", has = false, quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) cur += line[++i];
      else if (c === "$" || c === "`") return null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === "\\") { if (i + 1 < line.length) { cur += line[++i]; has = true; } continue; }
    if (/\s/.test(c)) { if (has) { out.push(cur); cur = ""; has = false; } continue; }
    if ("|;&<>`$*?[()".includes(c)) return null;
    if ((c === "~" || c === "#") && !has) return null; // home dir / comment at word start
    if (c === "{" && /^\{[^}\s]*,/.test(line.slice(i))) return null; // brace expansion; `@{u}` is literal
    cur += c; has = true;
  }
  if (quote) return null;
  if (has) out.push(cur);
  return out;
}

/** `git log` flags that change what's printed — the rich view can't show those, the terminal can. */
const GIT_LOG_RAW_ONLY = /^(-p|-u|-s|-z|-h|-L.*|-W|--patch.*|--stat.*|--numstat|--shortstat|--dirstat.*|--compact-summary|--name-only|--name-status|--raw|--summary|--graph|--oneline|--pretty.*|--format.*|--output.*|--help|--cc|--word-diff.*|--check|--function-context|--show-signature|--log-size|--line-prefix.*|--notes.*|--show-notes.*)$/;

/** Bundled short flags like `-ps` or `-in5`: raw-only if a flag before any value-taking one (n/S/G/L) is p/u/s/z/h. */
function bundlesRawFlag(a: string): boolean {
  const m = /^-([a-zA-Z]{2,})/.exec(a);
  if (!m) return false;
  for (const f of m[1]!) {
    if ("nSGL".includes(f)) return f === "L";
    if ("puszhW".includes(f)) return true;
  }
  return false;
}

/** Extra args for the rich `git log` view, or null when the terminal should run it as typed. */
export function gitLogArgs(input: string): string[] | null {
  const words = splitPlainArgs(input);
  if (!words || words[0] !== "git") return null;
  let i = 1;
  if (words[i] === "--no-pager") i++;
  if (words[i] !== "log") return null;
  const args = words.slice(i + 1);
  const dashdash = args.indexOf("--");
  const opts = dashdash === -1 ? args : args.slice(0, dashdash);
  if (opts.some((a) => GIT_LOG_RAW_ONLY.test(a) || bundlesRawFlag(a))) return null;
  return args;
}

/**
 * A finished command. `outputJson`: its output as JSON for saving, when the parse worker made
 * it. `complete`: the block shows the end of a long output for now; this is the whole of it.
 */
export type RunResult = {
  block: Block;
  next: State;
  clear?: boolean;
  outputJson?: Promise<string>;
  complete?: Promise<{ out: Out[]; outputJson?: Promise<string> }>;
};

export async function run(
  raw: string,
  state: State,
  tabId: string,
  onProgress: (block: Block) => void,
  /** Pick up a command that's already running in the daemon (after the UI restarted). */
  resume?: AttachInfo,
): Promise<RunResult> {
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
  const logArgs = resume ? null : gitLogArgs(input);
  if (logArgs) {
    const t = Date.now();
    const id = Math.random().toString(36).slice(2);
    try {
      const res = await shell.listLog(cwdStr, 2000, logArgs);
      if (!Array.isArray(res)) {
        const msg = res.error || "git log failed";
        return { block: { id, input, cwd: state.cwd, ctx: state.ctx.name, at: now(), ts: Date.now(), ms: Date.now() - t, code: 128, out: [{ kind: "lines", lines: msg.split("\n"), tone: "bad" }] }, next: state };
      }
      const out: Out[] = [{ kind: "gitlog", entries: res, cwd: cwdStr }];
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
  // Parsed in a worker (parseClient.ts): the main thread only receives output and paints.
  const parser = outputParser(effectiveInput);
  let lastOut: Out[] = [];
  let exitCode = 0;
  let finalCtx: ShellContext | null = null;
  const id = Math.random().toString(36).slice(2);

  let detectedTUI = false;
  // The command's output as sent (up to RAW_KEEP chars), and whether it ever took over the
  // screen: output that only moves the cursor about (fastfetch, progress bars) is shown in the
  // inline terminal while it runs, then becomes the block's output as that screen ended up.
  let rawRun: string | null = "";
  let sawAltScreen = false;
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
    parser.snapshot(LIVE_WINDOW, (out) => {
      if (done) return;
      lastOut = out;
      const painted = performance.now();
      onProgress({ ...pendingBlock, ms: elapsed(), out, pending: true });
      perf.paintMs += performance.now() - painted;
      // A big block can take longer than a frame to lay out. When that happens, leave the UI
      // twice that long to itself before the next update so typing and scrolling stay smooth.
      requestAnimationFrame(() => {
        const cost = performance.now() - painted;
        if (cost > 50) progressHoldUntil = performance.now() + Math.min(cost * 2, 1000);
      });
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
    parser.push(text);
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
      appendOutput(resume.output.replace(PTY_STATE_RE, ""));
    }
  }

  return new Promise<RunResult>((resolve) => {
    globalOutputOff?.(); globalContextOff?.(); globalExitOff?.(); globalCommandStartOff?.();

    globalOutputOff = shell.onOutput((tid, data) => {
      if (tid !== tabId) return;
      if (!commandWritten) return; // discard pre-command PTY noise
      if (isAltScreen(tabId)) { sawAltScreen = true; return; }
      // Buffer every byte for replay
      appendReplay(tabId, data);
      // Strip PTY mode-set sequences before buffering
      const cleanData = data.replace(PTY_STATE_RE, "");
      if (rawRun !== null) rawRun = rawRun.length + cleanData.length > RAW_KEEP ? null : rawRun + cleanData;
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
      // Freeze the clock now; what follows is finalisation, not command time.
      tEnd ??= Date.now();
      pendingBlock.settled = true;
      onProgress({ ...pendingBlock, ms: elapsed(), out: lastOut, pending: true });
      // All of the command's output is already here: the daemon sends a chunk's output
      // before its prompt event, over one ordered socket. Finalise on the next tick — a
      // longer wait only kept the block pending (and the composer disabled) for nothing.
      setTimeout(cleanup, 0);
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
      // The parser has followed all of the output already (falling back to a full parse
      // itself for output it can't follow); the finished, capped result is a message away.
      // The end of a long output is on screen already: finish the block with the latest live
      // view and swap in the complete output (head + capped tail) when the parser has it —
      // the command is done the moment its output is, as in any terminal. A short output's
      // live view is the whole output: finish with the parser's final result directly.
      perf.finalAskAt = performance.now();
      // Cursor-moving output that never went full screen: the block shows the screen it drew.
      const screen = detectedTUI && !sawAltScreen && !isInteractive && !resumedAlt && rawRun !== null
        ? screenOutput(effectiveInput, rawRun)
        : null;
      // `latest` before `final`: the worker answers in order, and `final` ends the command there.
      const liveNow = screen ? null : parser.latest(LIVE_WINDOW);
      const complete = parser.final();
      if (screen) void complete.then(() => finish(screen, undefined, false));
      else void liveNow!.then(({ out: live, partial }) => (partial ? finish(live, complete) : complete.then((out) => finish(out))));
      const finish = (out: Out[], later?: Promise<Out[]>, fromParser = true) => {
        perf.finalGotAt = performance.now();
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
        const shown = (o: Out[]): Out[] => wasCancelled
          ? [...o, ...cancelledOut]
          : (o.length ? o : (cmdCode !== 0 && !detectedTUI) ? [{ kind: "lines", lines: ["(no output)"], tone: "muted" }] : []);
        const finalBlock: Block = {
          ...pendingBlock, ms, code: wasCancelled ? 130 : cmdCode,
          ctx: finalCtx?.k8sContext ?? state.ctx.name,
          out: shown(out),
          pending: false,
        };
        perf.resolvedAt = performance.now();
        // The worker encodes its output for saving; only usable if the block shows exactly that.
        const json = (o: Out[]) => (fromParser && shown(o) === o ? { outputJson: parser.outputJson() } : {});
        if (!later) { resolve({ block: finalBlock, next: nextState, ...json(out) }); return; }
        resolve({ block: finalBlock, next: nextState, complete: later.then((o) => ({ out: shown(o), ...json(o) })) });
      };
    }

    activeCleanups.set(tabId, cleanup);
    if (resume) return; // already running — nothing to send
    ensureReady(tabId).then(() => { commandWritten = true; shell.writeCommand(tabId, effectiveInput + "\n", input).catch(() => cleanup()); });
  });
}

