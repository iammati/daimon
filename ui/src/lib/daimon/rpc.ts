import type { GitBranchNode } from "./shell";
/// WebSocket transport shim — identical shell API surface to the Electrobun RPC version.
/// Connects to the Rust pty-daemon at ws://localhost:<port>/?token=<token>.
///
/// The daemon only accepts clients with its token. The app passes it (and the port) in
/// the page URL — ?daimon_token=…&daimon_port=… — and we keep it in sessionStorage so
/// reloads work after the URL is cleaned up. In a plain browser on the Vite dev server,
/// it comes from the dev server's /__daimon endpoint instead (same-origin only).

type Creds = { token: string; port: number };
const CREDS_KEY = "daimon-daemon";

function credsFromUrl(): Creds | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("daimon_token");
  if (!token) return null;
  const port = Number(url.searchParams.get("daimon_port")) || 7878;
  url.searchParams.delete("daimon_token");
  url.searchParams.delete("daimon_port");
  history.replaceState(history.state, "", url);
  return { token, port };
}

let creds: Creds | null = (() => {
  const fromUrl = credsFromUrl();
  if (fromUrl) { try { sessionStorage.setItem(CREDS_KEY, JSON.stringify(fromUrl)); } catch { /**/ } return fromUrl; }
  try { const saved = sessionStorage.getItem(CREDS_KEY); return saved ? JSON.parse(saved) as Creds : null; } catch { return null; }
})();

async function fetchDevCreds(): Promise<Creds | null> {
  try {
    const r = await fetch("/__daimon", { cache: "no-store" });
    if (!r.ok) return null;
    const c = await r.json() as Creds;
    return c.token ? c : null;
  } catch { return null; }
}

export type ShellContext = {
  region?: string;
  project?: string;
  domain?: string;
  ccloudPrompt?: string;
  k8sContext?: string;
  k8sNamespace?: string;
  pwd?: string;
  gitBranch?: string;
  gitAhead?: number;
  gitBehind?: number;
  gitDirty?: boolean;
  gitAdded?: number;
  gitRemoved?: number;
  exitCode?: number;
  cmdDuration?: number;
  cmdTimestamp?: number;
  promptLen?: number;
};

type DaemonEvent =
  | { type: "output"; tab_id: string; data: string }
  | { type: "exit"; tab_id: string; code: number }
  | { type: "prompt"; tab_id: string; context: string }
  | { type: "commandStart"; tab_id: string }
  | { type: "altScreenEnter"; tab_id: string }
  | { type: "altScreenExit"; tab_id: string }
  | { type: "response"; req_id: string; ok: boolean; data: unknown };

type OutputListener        = (tabId: string, data: string) => void;
type ExitListener          = (tabId: string, code: number) => void;
type ContextListener       = (tabId: string, ctx: ShellContext) => void;
type CommandStartListener  = (tabId: string) => void;

const outputListeners       = new Set<OutputListener>();
const exitListeners         = new Set<ExitListener>();
const contextListeners      = new Set<ContextListener>();
const commandStartListeners = new Set<CommandStartListener>();

// Cache last context per tab so late onContext subscribers get it immediately
const lastContext = new Map<string, ShellContext>();

// Pending request/response promises keyed by req_id
let reqSeq = 0;
const pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function request<T>(msg: object, timeoutMs = 5000): Promise<T> {
  const req_id = `r${++reqSeq}`;
  const json = JSON.stringify({ ...msg, req_id });
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(req_id);
      reject(new Error("rpc timeout"));
    }, timeoutMs);
    pendingRequests.set(req_id, {
      resolve: (v) => { clearTimeout(timer); resolve(v as T); },
      reject:  (e) => { clearTimeout(timer); reject(e); },
    });
    if (ws?.readyState === WebSocket.OPEN) ws.send(json);
    else pending.push(json);
  });
}

// ── WebSocket (auto-reconnect) ───────────────────────────────────────────────

let ws: WebSocket | null = null;
const pending: string[] = [];
let failures = 0;

async function connect() {
  // No token yet, or it keeps getting refused (daemon replaced): ask the dev server.
  if (!creds || failures >= 2) {
    const dev = await fetchDevCreds();
    if (dev) { creds = dev; try { sessionStorage.setItem(CREDS_KEY, JSON.stringify(dev)); } catch { /**/ } }
  }
  // No token anywhere: try without one. Only a daemon from before token auth accepts
  // that (a dev session started by an old dev.sh); current daemons refuse it.
  if (!creds) console.warn("[rpc] no daemon token — start daimon through the app (or dev.sh)");
  let opened = false;
  ws = new WebSocket(creds
    ? `ws://localhost:${creds.port}/?token=${encodeURIComponent(creds.token)}`
    : "ws://localhost:7878");
  ws.onopen = () => { opened = true; failures = 0; while (pending.length) ws!.send(pending.shift()!); };
  ws.onclose = () => {
    ws = null;
    if (!opened) failures++;
    // Reject all pending requests so callers don't hang across reconnect
    for (const [, p] of pendingRequests) p.reject(new Error("disconnected"));
    pendingRequests.clear();
    setTimeout(connect, 1500);
  };
  ws.onmessage = (e: MessageEvent) => {
    const ev: DaemonEvent = JSON.parse(e.data as string);
    if (ev.type === "output") outputListeners.forEach((fn) => fn(ev.tab_id, ev.data));
    else if (ev.type === "exit") exitListeners.forEach((fn) => fn(ev.tab_id, ev.code));
    else if (ev.type === "prompt") {
      let ctx: ShellContext = {};
      if (ev.context) {
        try { ctx = JSON.parse(ev.context); } catch { /* bare prompt */ }
      }
      lastContext.set(ev.tab_id, ctx);
      contextListeners.forEach((fn) => fn(ev.tab_id, ctx));
    } else if (ev.type === "commandStart") {
      commandStartListeners.forEach((fn) => fn(ev.tab_id));
    } else if (ev.type === "altScreenEnter") {
      altScreenListeners.forEach((fn) => fn(ev.tab_id, true));
    } else if (ev.type === "altScreenExit") {
      altScreenListeners.forEach((fn) => fn(ev.tab_id, false));
    } else if (ev.type === "response") {
      const p = pendingRequests.get(ev.req_id);
      if (p) {
        pendingRequests.delete(ev.req_id);
        if (ev.ok) p.resolve(ev.data);
        else p.reject(new Error(String(ev.data)));
      }
    }
  };
}
void connect();

function send(msg: object) {
  const json = JSON.stringify(msg);
  if (ws?.readyState === WebSocket.OPEN) ws.send(json);
  else pending.push(json);
}

// ── shell API ────────────────────────────────────────────────────────────────

type GitStatusFile = { xy: string; path: string; from?: string; add?: number; del?: number };
type GitStatus = { branch: string; upstream?: string | null; ahead: number; behind: number; staged: GitStatusFile[]; unstaged: GitStatusFile[]; untracked: string[]; added?: number; removed?: number; error?: string };
type LogEntry  = { hash: string; fullHash: string; date: string; subject: string; author: string; isHead?: boolean };
type CommitDetail = { files: { status: string; path: string; additions: number; deletions: number }[]; body: string };

/** A shell as the daemon has it (see `attach`). */
export type AttachInfo = {
  exists: boolean;
  running: boolean;
  command: string | null;
  startedAt: number;
  altScreen: boolean;
  /** Running command: output so far, or (full-screen programs) the modes to restore. */
  output: string;
  context: string | null;
};

type AltScreenListener = (tabId: string, enter: boolean) => void;
const altScreenListeners = new Set<AltScreenListener>();

export const shell = {
  onOutput:       (fn: OutputListener)       => { outputListeners.add(fn);        return () => outputListeners.delete(fn); },
  onExit:         (fn: ExitListener)         => { exitListeners.add(fn);          return () => exitListeners.delete(fn); },
  onContext:      (fn: ContextListener)      => { contextListeners.add(fn);       return () => contextListeners.delete(fn); },
  onCommandStart: (fn: CommandStartListener) => { commandStartListeners.add(fn);  return () => commandStartListeners.delete(fn); },
  onAltScreen:    (fn: AltScreenListener)    => { altScreenListeners.add(fn);     return () => altScreenListeners.delete(fn); },

  write:  (tabId: string, data: string) => { send({ type: "write", tab_id: tabId, data }); return Promise.resolve(); },
  /** Make a resumed full-screen program repaint (resize dance → SIGWINCH). */
  redraw: (tabId: string) => { send({ type: "redraw", tab_id: tabId }); return Promise.resolve(); },
  /** Write that starts a command; the daemon remembers `command` to label it on reattach. */
  writeCommand: (tabId: string, data: string, command: string) => { send({ type: "write", tab_id: tabId, data, command }); return Promise.resolve(); },
  /**
   * Reattach to a tab's shell after the UI (re)started. Also replays the last prompt
   * context to onContext listeners, as if the prompt had just been drawn.
   */
  attach: async (tabId: string): Promise<AttachInfo> => {
    const info = await request<AttachInfo>({ type: "attach", tab_id: tabId });
    if (info.exists && info.context) {
      let ctx: ShellContext = {};
      try { ctx = JSON.parse(info.context); } catch { /* bare prompt */ }
      lastContext.set(tabId, ctx);
      if (!info.running) contextListeners.forEach((fn) => fn(tabId, ctx));
    }
    return info;
  },
  resize: (tabId: string, cols: number, rows: number) => {
    const c = Math.min(Math.max(cols, 10), 500);
    const r = Math.min(Math.max(rows, 2), 300);
    send({ type: "resize", tab_id: tabId, cols: c, rows: r });
    return Promise.resolve();
  },
  ready:  (tabId: string) => { send({ type: "write", tab_id: tabId, data: "" }); return Promise.resolve(); },
  hasReady: (tabId: string) => lastContext.has(tabId),
  close:  (tabId: string) => { send({ type: "close", tab_id: tabId }); return Promise.resolve(); },

  // Stubs — backend support needed for these
  complete:            () => Promise.resolve([] as { type: "plain" | "file" | "dir"; value: string }[]),
  listBinaries:        () => Promise.resolve([] as string[]),
  completePath:        () => Promise.resolve(""),
  listPathCompletions: (prefix: string, cwd: string, kind: string) =>
    request<{ value: string; isDir: boolean }[]>({ type: "listPaths", prefix, cwd, kind }),
  completeNative:      (buffer: string, cwd: string) =>
    request<{ text: string; description?: string; kind: string }[]>({ type: "complete", buffer, cwd }),
  listRegions:         (cwd?: string) => request<string[]>({ type: "listRegions", cwd: cwd ?? "" }),
  listContexts:        () => request<string[]>({ type: "listContexts" }),
  syncContexts:        () => request<void>({ type: "syncContexts" }),
  getCompletions:      () => Promise.resolve([] as { value: string; description?: string }[]),
  getFlagType:         () => Promise.resolve("unknown" as const),
  getBuiltinPathKind:  () => Promise.resolve(null as "file" | "dir" | "path" | null),
  loadSessions:        () => Promise.resolve([] as { id: string; title: string; icon: string }[]),
  saveSessions:        () => Promise.resolve(),
  gitStatus:           (cwd: string) => request<GitStatus>({ type: "gitStatus", cwd }),
  listBranches:        (cwd: string) => request<{ branches: string[]; current: string; trunk?: string | null; nodes?: GitBranchNode[] }>({ type: "gitBranch", cwd }),
  listLog:             (cwd: string, limit?: number) => request<LogEntry[]>({ type: "gitLog", cwd, limit: limit ?? 50 }),
  gitDiff:             (cwd: string, args?: string[]) => request<{ raw: string }>({ type: "gitDiff", cwd, args: args ?? [] }),
  getCommitDetail:     (hash: string, cwd: string) => request<CommitDetail>({ type: "commitDetail", hash, cwd }),
  getFileDiff:         (hash: string, filePath: string, cwd: string) => request<string>({ type: "fileDiff", hash, file_path: filePath, cwd }),

  // ── Persistent store ────────────────────────────────────────────────────────
  historyAdd:          (cmd: string, ts: number) => request<boolean>({ type: "historyAdd", cmd, ts }),
  historyList:         (limit?: number) => request<{ id: number; cmd: string; ts: number; source: string }[]>({ type: "historyList", limit: limit ?? 1000000 }),
  historySearch:       (query: string, limit?: number) => request<{ id: number; cmd: string; ts: number; source: string }[]>({ type: "historySearch", query, limit: limit ?? 50 }),
  blockSave:           (block: { id: string; session_id: string; input: string; cwd: string; ctx: string; ts: number; exit_code: number; output_json: string }) =>
    request<boolean>({ type: "blockSave", block }),
  blockList:           (session_id: string, limit?: number) =>
    request<{ id: string; session_id: string; input: string; cwd: string; ctx: string; ts: number; exit_code: number; output_json: string }[]>({ type: "blockList", session_id, limit: limit ?? 500 }),
  blockRecent:         (limit?: number) =>
    request<{ id: string; session_id: string; input: string; cwd: string; ctx: string; ts: number; exit_code: number; output_json: string }[]>({ type: "blockRecent", limit: limit ?? 200 }),
  blockSearch:         (query: string, limit?: number) => request<{ id: string; session_id: string; input: string; cwd: string; ctx: string; ts: number; exit_code: number; output_json: string }[]>({ type: "blockSearch", query, limit: limit ?? 50 }),
  blockClear:          (session_id: string) => request<boolean>({ type: "blockClear", session_id }),
  prefSet:             (key: string, value: string) => request<boolean>({ type: "prefSet", key, value }),
  prefGet:             (key: string) => request<string | null>({ type: "prefGet", key }),
  describeResource:    (..._args: unknown[]) => Promise.resolve(""),
  getNodeEvents:       (..._args: unknown[]) => Promise.resolve([] as { type: string; reason: string; age: string; message: string }[]),
};
