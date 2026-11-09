/// WebSocket transport shim — identical shell API surface to the Electrobun RPC version.
/// Connects to the Rust pty-daemon at ws://localhost:7878.

const WS_URL = "ws://localhost:7878";

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

function request<T>(msg: object): Promise<T> {
  const req_id = `r${++reqSeq}`;
  const json = JSON.stringify({ ...msg, req_id });
  return new Promise<T>((resolve, reject) => {
    pendingRequests.set(req_id, {
      resolve: (v) => resolve(v as T),
      reject,
    });
    if (ws?.readyState === WebSocket.OPEN) ws.send(json);
    else pending.push(json);
  });
}

// ── WebSocket (auto-reconnect) ───────────────────────────────────────────────

let ws: WebSocket | null = null;
const pending: string[] = [];

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => { while (pending.length) ws!.send(pending.shift()!); };
  ws.onclose = () => { ws = null; setTimeout(connect, 1500); };
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
connect();

function send(msg: object) {
  const json = JSON.stringify(msg);
  if (ws?.readyState === WebSocket.OPEN) ws.send(json);
  else pending.push(json);
}

// ── shell API ────────────────────────────────────────────────────────────────

type GitStatus = { branch: string; ahead: number; behind: number; staged: { xy: string; path: string }[]; unstaged: { xy: string; path: string }[]; untracked: string[] };
type LogEntry  = { hash: string; fullHash: string; date: string; subject: string; author: string; isHead?: boolean };
type CommitDetail = { files: { status: string; path: string; additions: number; deletions: number }[]; body: string };

type AltScreenListener = (tabId: string, enter: boolean) => void;
const altScreenListeners = new Set<AltScreenListener>();

export const shell = {
  onOutput:       (fn: OutputListener)       => { outputListeners.add(fn);        return () => outputListeners.delete(fn); },
  onExit:         (fn: ExitListener)         => { exitListeners.add(fn);          return () => exitListeners.delete(fn); },
  onContext:      (fn: ContextListener)      => { contextListeners.add(fn);       return () => contextListeners.delete(fn); },
  onCommandStart: (fn: CommandStartListener) => { commandStartListeners.add(fn);  return () => commandStartListeners.delete(fn); },
  onAltScreen:    (fn: AltScreenListener)    => { altScreenListeners.add(fn);     return () => altScreenListeners.delete(fn); },

  write:  (tabId: string, data: string) => { send({ type: "write", tab_id: tabId, data }); return Promise.resolve(); },
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
  listBranches:        (cwd: string) => request<{ branches: string[]; current: string }>({ type: "gitBranch", cwd }),
  listLog:             (cwd: string, limit?: number) => request<LogEntry[]>({ type: "gitLog", cwd, limit: limit ?? 50 }),
  gitDiff:             (cwd: string, args?: string[]) => request<{ raw: string }>({ type: "gitDiff", cwd, args: args ?? [] }),
  getCommitDetail:     (hash: string, cwd: string) => request<CommitDetail>({ type: "commitDetail", hash, cwd }),
  getFileDiff:         (hash: string, filePath: string, cwd: string) => request<string>({ type: "fileDiff", hash, file_path: filePath, cwd }),

  // ── Persistent store ────────────────────────────────────────────────────────
  historyAdd:          (cmd: string, ts: number) => request<boolean>({ type: "historyAdd", cmd, ts }),
  historyList:         (limit?: number) => request<{ id: number; cmd: string; ts: number; source: string }[]>({ type: "historyList", limit: limit ?? 2000 }),
  blockSave:           (block: { id: string; session_id: string; input: string; cwd: string; ctx: string; ts: number; exit_code: number; output_json: string }) =>
    request<boolean>({ type: "blockSave", block }),
  blockList:           (session_id: string, limit?: number) =>
    request<{ id: string; session_id: string; input: string; cwd: string; ctx: string; ts: number; exit_code: number; output_json: string }[]>({ type: "blockList", session_id, limit: limit ?? 500 }),
  blockRecent:         (limit?: number) =>
    request<{ id: string; session_id: string; input: string; cwd: string; ctx: string; ts: number; exit_code: number; output_json: string }[]>({ type: "blockRecent", limit: limit ?? 200 }),
  blockClear:          (session_id: string) => request<boolean>({ type: "blockClear", session_id }),
  prefSet:             (key: string, value: string) => request<boolean>({ type: "prefSet", key, value }),
  prefGet:             (key: string) => request<string | null>({ type: "prefGet", key }),
  describeResource:    () => Promise.resolve(""),
  getNodeEvents:       () => Promise.resolve([] as { type: string; reason: string; age: string; message: string }[]),
};
