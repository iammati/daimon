import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast, Toaster } from "sonner";
import { PlusIcon, XIcon, SunIcon, ZapIcon, PanelLeftIcon, GitBranchIcon, SearchIcon, EyeOffIcon, EyeIcon, SplitSquareHorizontalIcon, ArrowUpRightIcon, LinkIcon } from "lucide-react";
import { BlockMeta, BlockView, PresentationModeContext } from "@/components/daimon/BlockView";
import { CommandIcon } from "@/components/daimon/CommandIcon";
import { Composer } from "@/components/daimon/Composer";
import { HistoryPanel } from "@/components/daimon/HistoryPanel";
import { ContextSwitcher } from "@/components/daimon/ContextSwitcher";
import { run, sendRaw, resizePty, notifyAltScreen, onAltScreenChange, onTuiChange, STREAMING_INTERACTIVE_RE, isStreamingSession, isWarpified, abandonRun, finishRun, setNotifConfig, type Block, type State } from "@/lib/daimon/shell";
import { shell, onReconnect, type AttachInfo } from "@/lib/daimon/rpc";
import { startBench } from "@/lib/daimon/bench";
import { displayPath } from "@/lib/daimon/world";
import kubernetesIcon from "@/assets/kubernetes-icon.svg";
import { LandingPage } from "@/components/daimon/LandingPage";
import { CommandPalette } from "@/components/daimon/CommandPalette";
import { GlobalSearch } from "@/components/daimon/GlobalSearch";
import { HeaderExtensionSlot, OpenStackBadge } from "@/components/daimon/HeaderExtension";
import { KeyboardShortcutsModal } from "@/components/daimon/KeyboardShortcutsModal";
import { SettingsModal } from "@/components/daimon/SettingsModal";
import { PowerlineStatus } from "@/components/daimon/PowerlineStatus";
import { TitleBar } from "@/components/daimon/TitleBar";
import { describeEl, focusLog, requestPageFocus } from "@/lib/daimon/focusLog";
import { usePresence } from "@/lib/daimon/presence";

const TITLE = "daimon — a terminal for Converged Cloud operators";
const DESC =
  "daimon is a light, block-based terminal: ghost autocomplete, folder-aware suggestions, and a kube context switcher built for Converged Cloud regions.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
    ],
  }),
  component: Daimon,
});

declare const __HOME__: string;
const HOME_PATH = __HOME__.replace(/^\//, "").split("/");
const START: State = { cwd: HOME_PATH, ctx: { name: "" } };

const now = () =>
  new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

type Session = {
  id: string;
  customName?: string;
  lastCmd?: string;
  draft?: string;
  state: State;
  blocks: Block[];
  history: string[];
  historyTs: number[];
  splitId?: string;
};

let nextSessionNum = 1;

function makeSession(customName?: string): Session {
  const num = nextSessionNum++;
  const s: Session = {
    id: Math.random().toString(36).slice(2),
    state: START,
    blocks: [],
    history: [],
    historyTs: [],
  };
  const name = customName ?? (num === 1 ? "main" : undefined);
  if (name) s.customName = name;
  return s;
}

function sessionLabel(s: Session): string {
  return s.customName ?? s.lastCmd ?? "New session";
}

function removeSplit(s: Session): Session {
  const { splitId: _, ...rest } = s;
  return rest as Session;
}

type Theme = "light" | "dracula";

function applyTheme(t: Theme) {
  const el = document.documentElement;
  el.classList.remove("dark", "dracula");
  if (t === "dracula") el.classList.add("dracula");
}

const THEME_ICONS: Record<Theme, React.ReactNode> = {
  light: <SunIcon className="size-3.5" />,
  dracula: <ZapIcon className="size-3.5" />,
};

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-signal/20 text-signal not-italic">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

// Detect if a program is actively prompting for user input (Y/n, password, etc.)
// Only drives styling/masking: stdin input is always accepted while a command runs.
const INPUT_PROMPT_RE = /[?:>]\s*$|\[[yn]\/[yn]\]\s*$|\((yes\/no|[yn]\/[yn])[^)]*\)\s*$/i;
// sudo ("[sudo] password for dev:"), ssh keys ("Enter passphrase for key …:"), PINs, tokens.
const SECRET_PROMPT_RE = /(pass(word|phrase)|\bpin\b|secret|token|otp|verification code)[^\n]*[:>]\s*$/i;
function lastOutputLine(b: Block): string {
  return blockOutputText(b).trimEnd().split("\n").pop() ?? "";
}
function isPromptingForInput(b: Block): boolean {
  return INPUT_PROMPT_RE.test(lastOutputLine(b));
}
function isPromptingForSecret(b: Block): boolean {
  return SECRET_PROMPT_RE.test(lastOutputLine(b));
}

function blockOutputText(b: Block): string {
  return b.out.flatMap(o => {
    if (o.kind === "lines") return o.lines;
    if (o.kind === "ansi") return [o.html.replace(/<[^>]+>/g, "")];
    if (o.kind === "pairs") return o.pairs.map(([k, v]) => `${k}: ${v}`);
    if (o.kind === "table") return [o.head.join("\t"), ...o.rows.map(r => r.join("\t"))];
    if (o.kind === "logfmt") return o.lines.map(l => Object.entries(l).map(([k,v]) => `${k}=${v}`).join(" "));
    if (o.kind === "pretty") return [o.text];
    if (o.kind === "gitlog") return o.entries.map(e => `${e.fullHash} ${e.date} ${e.subject} ${e.author}`);
    if (o.kind === "gitbranches") return o.branches.map(b => b === o.current ? `* ${b}` : `  ${b}`);
    if (o.kind === "gitdiff") return [o.raw];
    if (o.kind === "lslong") return [`total ${o.total}`, ...o.entries.map(e => `${e.perms} ${e.links} ${e.user} ${e.group} ${e.size} ${e.month} ${e.day} ${e.time} ${e.name}${e.link ? ` -> ${e.link}` : ""}`)];
    if (o.kind === "files") return o.items.map(f => `${f.dir ? "d" : "-"} ${f.name}${f.size !== undefined ? `  ${f.size}` : ""}`);
    if (o.kind === "gitstatus") {
      // Mirrors real `git status` so pasted output reads familiar.
      const word: Record<string, string> = { M: "modified", A: "new file", D: "deleted", R: "renamed", C: "copied", T: "typechange", U: "both modified" };
      const row = (f: { xy: string; path: string; from?: string }) => `\t${(word[f.xy.toUpperCase()] ?? f.xy) + ":"}`.padEnd(14) + (f.from ? `${f.from} -> ${f.path}` : f.path);
      const lines: string[] = [`On branch ${o.branch}`];
      if (o.upstream) {
        if (o.ahead && o.behind) lines.push(`Your branch and '${o.upstream}' have diverged (${o.ahead} and ${o.behind} commits).`);
        else if (o.ahead) lines.push(`Your branch is ahead of '${o.upstream}' by ${o.ahead} commit${o.ahead > 1 ? "s" : ""}.`);
        else if (o.behind) lines.push(`Your branch is behind '${o.upstream}' by ${o.behind} commit${o.behind > 1 ? "s" : ""}.`);
        else lines.push(`Your branch is up to date with '${o.upstream}'.`);
      }
      if (o.staged.length) lines.push("", "Changes to be committed:", ...o.staged.map(row));
      if (o.unstaged.length) lines.push("", "Changes not staged for commit:", ...o.unstaged.map(row));
      if (o.untracked.length) lines.push("", "Untracked files:", ...o.untracked.map((f) => `\t${f}`));
      if (!o.staged.length && !o.unstaged.length && !o.untracked.length) lines.push("", "nothing to commit, working tree clean");
      return lines;
    }
    return [];
  }).join("\n");
}

function Daimon() {
  const [sessions, setSessions] = useState<Session[]>(() => [makeSession()]);
  const [activeId, setActiveId] = useState(() => sessions[0]!.id);
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]!;
  // The block whose command line has scrolled out above the active pane's viewport — shown in the header.
  const [headerBlockId, setHeaderBlockId] = useState<string | null>(null);
  // Split children are not top-level tabs
  const splitChildIds = new Set(sessions.flatMap((s) => s.splitId ? [s.splitId] : []));
  const topLevelSessions = sessions.filter((s) => !splitChildIds.has(s.id));
  // Split pane: scoped to the active session via session.splitId
  const splitSessionId = active.splitId ?? null;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  // sessionId -> blockId for currently-active inline TUI blocks
  const [tuiBlockIds, setTuiBlockIds] = useState<Map<string, string>>(new Map());
  const [altScreenActive, setAltScreenActive] = useState(false);
  // Not while a TUI (claude, vim, k9s, …) owns the pane: the command above it means nothing there.
  const tuiInActive = tuiBlockIds.has(active.id) || altScreenActive;
  const headerBlock = headerBlockId && !tuiInActive ? active.blocks.find((b) => b.id === headerBlockId) : undefined;
  const [presentationMode, setPresentationMode] = useState(false);
  // Toast outside the state updater — updaters can run twice (StrictMode / batching), which would
  // fire the toast twice. Derive the next value from current state here instead.
  const togglePresentation = () => {
    setPresentationMode((p) => !p);
    toast(!presentationMode ? "Presentation mode on — secrets redacted" : "Presentation mode off", { duration: 2500, id: "presentation-mode" });
  };
  const [theme, setTheme] = useState<Theme>("light");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [gitDirty, setGitDirty] = useState(false);
  const [gitAhead, setGitAhead] = useState(0);
  const [gitBehind, setGitBehind] = useState(0);
  const [gitAdded, setGitAdded] = useState(0);
  const [gitRemoved, setGitRemoved] = useState(0);
  const [osRegion, setOsRegion] = useState<string | null>(null);
  const [osProject, setOsProject] = useState<string | null>(null);
  const [osDomain, setOsDomain] = useState<string | null>(null);
  const [k8sContext, setK8sContext] = useState<string | null>(null);
  const [k8sNamespace, setK8sNamespace] = useState<string | null>(null);
  const [showBadges, setShowBadges] = useState(true);
  const [showPowerline, setShowPowerline] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchShown = usePresence(searchOpen);   // stays mounted while it animates out
  const [historyOpen, setHistoryOpen] = useState(false);
  const [ctxSwitcherOpen, setCtxSwitcherOpen] = useState(0);
  const [ctxSwitcherClose, setCtxSwitcherClose] = useState(0);
  const ctxSwitcherIsOpen = useRef(false);
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);
  const [blockModActive, setBlockModActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Open fullscreen pagers (git log / git diff) per pane id; "" = unscoped.
  const [pagerPanes, setPagerPanes] = useState<Record<string, number>>({});
  const pagerActive = Object.values(pagerPanes).some((n) => n > 0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [keysModalOpen, setKeysModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<{blockId: string; blockInput: string; snippet: string}[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const blockRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchResults, setGlobalSearchResults] = useState<{input: string; cwd: string; ts: number; exit_code: number; output: string}[]>([]);
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = localStorage.getItem("daimon-font-size");
    return saved ? parseInt(saved, 10) : 13;
  });
  const [splitRatio, setSplitRatio] = useState(0.5);
  const splitDragging = useRef(false);
  // Which pane currently has keyboard focus (affects composer focus, git status display)
  const [focusedPane, setFocusedPane] = useState<"left" | "right">("left");

  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => { localStorage.setItem("daimon-font-size", String(fontSize)); }, [fontSize]);

  // Load persisted data from DB on mount
  useEffect(() => {
    Promise.all([
      shell.historyList(),
      shell.prefGet("theme"),
      shell.prefGet("sessions"),
      shell.prefGet("notif-enabled"),
      shell.prefGet("notif-threshold"),
      shell.prefGet("show-badges"),
      shell.prefGet("show-powerline"),
    ]).then(async ([histEntries, savedTheme, savedSessionsJson, notifEnabledPref, notifThresholdPref, badgesPref, powerlinePref]) => {
      // History: sorted oldest-first for array index stability
      const sorted = [...histEntries].sort((a, b) => a.ts - b.ts);
      const history = sorted.map(e => e.cmd);
      const historyTs = sorted.map(e => e.ts);

      // Restore saved sessions if any
      type SavedSession = { id: string; customName?: string; lastCmd?: string; state?: { cwd: string[]; ctx: { name: string } } };
      let savedSessions: SavedSession[] = [];
      try { if (savedSessionsJson) savedSessions = JSON.parse(savedSessionsJson); } catch { /**/ }

      // Decode block rows → Block[]
      const decodeBlocks = (rows: { id: string; session_id: string; input: string; cwd: string; ctx: string; ts: number; exit_code: number; output_json: string }[]) =>
        rows.map(r => ({
          id: r.id,
          input: r.input,
          cwd: r.cwd.split("/").filter(Boolean),
          ctx: r.ctx,
          at: new Date(r.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          ts: r.ts,
          ms: 0,
          code: r.exit_code,
          out: (() => { try { return JSON.parse(r.output_json); } catch { return []; } })(),
          pending: false,
        }));

      if (savedSessions.length > 0) {
        // Restore each saved session and load its blocks in parallel
        const sessionsWithBlocks = await Promise.all(savedSessions.map(async (saved) => {
          const blockRows = await shell.blockList(saved.id, 500).catch(() => []);
          const blocks = decodeBlocks(blockRows);
          const s: Session = {
            id: saved.id,
            state: saved.state ?? START,
            blocks,
            history,
            historyTs,
          };
          if (saved.customName) s.customName = saved.customName;
          if (saved.lastCmd) s.lastCmd = saved.lastCmd;
          return s;
        }));
        setSessions(sessionsWithBlocks);
        setActiveId(sessionsWithBlocks[0]!.id);
        void reattach(sessionsWithBlocks.map((s) => s.id));
      } else {
        // First launch: load blocks for the default session
        const sid = sessions[0]!.id;
        const blockRows = await shell.blockList(sid, 500).catch(() => []);
        const blocks = decodeBlocks(blockRows);
        setSessions(prev => prev.map((s, i) => i === 0 ? { ...s, history, historyTs, blocks } : s));
        void reattach([sid]);
      }

      if (savedTheme === "dracula" || savedTheme === "light") {
        setTheme(savedTheme as Theme);
      }
      // Init notification config from persisted prefs
      setNotifConfig(
        notifEnabledPref !== "false",
        notifThresholdPref ? parseInt(notifThresholdPref, 10) : 10_000,
      );
      // Context display prefs (badges default on, powerline default off)
      setShowBadges(badgesPref !== "0");
      setShowPowerline(powerlinePref === "1");
      // One-time cleanup of old localStorage keys
      try {
        localStorage.removeItem("daimon-history-v1");
        localStorage.removeItem("daimon-history-ts-v1");
        localStorage.removeItem("daimon-blocks-v1");
        localStorage.removeItem("daimon-theme");
      } catch { /**/ }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist sessions metadata (not blocks — those save individually) on change
  useEffect(() => {
    const toSave = sessions.map(s => ({
      id: s.id,
      customName: s.customName,
      lastCmd: s.lastCmd,
      state: s.state,
    }));
    shell.prefSet("sessions", JSON.stringify(toSave)).catch(() => {});
  }, [sessions]);

  // Track git branch from shell context updates
  useEffect(() => {
    const off = shell.onContext((_tabId, ctx) => {
      if (ctx.gitBranch !== undefined) setGitBranch(ctx.gitBranch || null);
      if (ctx.gitDirty !== undefined) setGitDirty(!!ctx.gitDirty);
      if (ctx.gitAhead !== undefined) setGitAhead(Number(ctx.gitAhead) || 0);
      if (ctx.gitBehind !== undefined) setGitBehind(Number(ctx.gitBehind) || 0);
      if (ctx.gitAdded !== undefined) setGitAdded(Number(ctx.gitAdded) || 0);
      if (ctx.gitRemoved !== undefined) setGitRemoved(Number(ctx.gitRemoved) || 0);
      if (ctx.region !== undefined) setOsRegion(ctx.region || null);
      if (ctx.project !== undefined) setOsProject(ctx.project || null);
      if (ctx.domain !== undefined) setOsDomain(ctx.domain || null);
      if (ctx.k8sContext !== undefined) setK8sContext(ctx.k8sContext || null);
      if (ctx.k8sNamespace !== undefined) setK8sNamespace(ctx.k8sNamespace || null);
    });
    return () => { off(); };
  }, []);

  // The shell context above only arrives when a command goes through the shell prompt.
  // Commands daimon renders itself (git status / log / diff …) and changes made elsewhere
  // (editor, another terminal, a commit) never trigger it — so also ask the daemon directly:
  // when a command finishes, when the window regains focus, and every few seconds while visible.
  const gitCwd = "/" + active.state.cwd.join("/");
  const gitLastBlock = active.blocks[active.blocks.length - 1];
  const gitRefreshKey = `${gitLastBlock?.id ?? ""}:${gitLastBlock?.pending ? 1 : 0}`;
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (document.hidden) return;
      shell.gitStatus(gitCwd).then((s) => {
        if (cancelled) return;
        if (!s || s.error || !s.branch) { setGitBranch(null); return; }
        setGitBranch(s.branch);
        setGitDirty(s.staged.length > 0 || s.unstaged.length > 0);
        setGitAhead(s.ahead || 0);
        setGitBehind(s.behind || 0);
        // (A daemon started before this field existed doesn't send counts — keep the shell's.)
        if (s.added !== undefined) setGitAdded(s.added);
        if (s.removed !== undefined) setGitRemoved(s.removed);
      }).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [gitCwd, gitRefreshKey]);

  // Gaze → block id mapping
  const cycleTheme = () => {
    const next: Theme = theme === "light" ? "dracula" : "light";
    setTheme(next);
    shell.prefSet("theme", next).catch(() => {});
  };

  const cmdDisabled = active.blocks.some((b) => b.pending && !STREAMING_INTERACTIVE_RE.test(b.input));
  const cmdPrompting = cmdDisabled && active.blocks.some((b) => b.pending && !STREAMING_INTERACTIVE_RE.test(b.input) && isPromptingForInput(b));
  const effectiveHoveredBlockId = pagerActive ? null : hoveredBlockId;
  const effectiveBlockModActive = pagerActive ? false : blockModActive;

  const scrollContainersRef = useRef<Map<string, HTMLDivElement>>(new Map());
  // Per session: does its pane follow new output down? It stops only when the user scrolls up
  // and starts again once they are back at the very bottom. Deciding it from the position on
  // every scroll event isn't enough: the browser scrolls on its own too (an earlier block
  // collapsing, scroll anchoring), and that must not stop the following.
  const followRef = useRef<Map<string, boolean>>(new Map());
  const lastScrollTopRef = useRef<Map<string, number>>(new Map());
  const contentHeightRef = useRef<Map<string, number>>(new Map());
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const follows = (sessionId: string) => followRef.current.get(sessionId) ?? true;

  const scrollToBottom = (sessionId?: string) => {
    requestAnimationFrame(() => {
      const container = scrollContainersRef.current.get(sessionId ?? activeId);
      if (!container) return;
      container.scrollTop = container.scrollHeight;
    });
  };

  const atBottom = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop <= 2;

  /** For the active session: the last block whose own header is above the top of the viewport. */
  const updateHeaderBlock = (sessionId: string) => {
    if (sessionId !== activeIdRef.current) return;
    const el = scrollContainersRef.current.get(sessionId);
    let id: string | null = null;
    if (el) {
      const top = el.getBoundingClientRect().top;
      const blocks = el.querySelectorAll<HTMLElement>("[data-block-id]");
      // Block headers go down the page in order: binary-search the last one that is out above.
      let lo = 0, hi = blocks.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const b = blocks[mid]!;
        const head = b.querySelector("header") ?? b;
        if (head.getBoundingClientRect().bottom <= top) { id = b.dataset["blockId"] ?? null; lo = mid + 1; }
        else hi = mid - 1;
      }
    }
    setHeaderBlockId(id);
  };

  /** A pane's content changed size: keep it scrolled down, or tell the user there is more below. */
  const onContentResize = (sessionId: string) => {
    const el = scrollContainersRef.current.get(sessionId);
    if (!el) return;
    const prev = contentHeightRef.current.get(sessionId) ?? 0;
    contentHeightRef.current.set(sessionId, el.scrollHeight);
    if (follows(sessionId)) {
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current.set(sessionId, el.scrollTop);
    } else if (el.scrollHeight > prev && sessionId === activeIdRef.current) {
      toast("↓ New output", { id: "new-output", duration: Infinity });
    }
    updateHeaderBlock(sessionId);
  };

  // One observer for the content of every pane; each observed element names its session.
  const contentObserver = useMemo(() => typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
    for (const e of entries) {
      const id = (e.target as HTMLElement).dataset["followSession"];
      if (id) onContentResize(id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs only
  }), []);
  const observedContentRef = useRef<Map<string, HTMLElement>>(new Map());
  const observeContent = (sessionId: string, el: HTMLElement | null) => {
    const old = observedContentRef.current.get(sessionId);
    if (el) {
      if (old === el) return;
      if (old) contentObserver?.unobserve(old);
      contentObserver?.observe(el);
      observedContentRef.current.set(sessionId, el);
    } else if (old) {
      // null comes on every re-render too (inline ref); only let go of a pane that is gone.
      queueMicrotask(() => {
        if (old.isConnected || observedContentRef.current.get(sessionId) !== old) return;
        contentObserver?.unobserve(old);
        observedContentRef.current.delete(sessionId);
      });
    }
  };
  useEffect(() => {
    // (Re)attach what the refs registered. StrictMode runs this cleanup + setup once on mount,
    // after the refs already ran; without re-observing here the disconnect below would leave
    // every pane unobserved (no auto-scroll) until its elements happened to be replaced.
    for (const el of observedContentRef.current.values()) contentObserver?.observe(el);
    return () => contentObserver?.disconnect();
  }, [contentObserver]);

  const updateSession = (id: string, patch: Partial<Session>) => {
    setSessions((prev) => prev.map((s) => s.id === id ? { ...s, ...patch } : s));
  };

  // Switching to a session that is still following: nothing to tell about the one left behind.
  useEffect(() => {
    if (follows(activeId)) toast.dismiss("new-output");
    updateHeaderBlock(activeId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // PTY output is now consumed directly by BlockView's inline terminal subscription

  // Both alt-screen (vim/nano/ssh) and TUI-detected (hammer/fzf) render inline in the block.
  // No overlay — BlockView creates its own terminal when isTuiActive=true.
  const setInlineActive = (sessionId: string, active: boolean) => {
    setSessions((prev) => {
      const sessionBlocks = prev.find((s) => s.id === sessionId)?.blocks ?? [];
      const pendingBlock = [...sessionBlocks].reverse().find((b: Block) => b.pending);
      if (active && pendingBlock) {
        setTuiBlockIds((m) => new Map(m).set(sessionId, pendingBlock.id));
      } else if (!active) {
        setTuiBlockIds((m) => { const next = new Map(m); next.delete(sessionId); return next; });
      }
      return prev;
    });
  };

  useEffect(() => {
    const offs = sessions.flatMap((s) => [
      onAltScreenChange(s.id, (active) => setInlineActive(s.id, active)),
      onTuiChange(s.id, (active) => setInlineActive(s.id, active)),
    ]);
    return () => { offs.forEach((off) => off()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.map((s) => s.id).join(",")]);

  // ── Session persistence ─────────────────────────────────────────────────────
  // The daemon outlives the app, so a restored tab may still have its shell — maybe
  // mid-command. Reattach: take over the shell's current context (cwd, git …) and show
  // a running command as a live block again. Declared after the TUI listeners above so
  // those exist before a resumed full-screen program announces itself.
  const [pendingResumes, setPendingResumes] = useState<[string, AttachInfo][]>([]);
  const reattach = async (ids: string[]) => {
    const infos = await Promise.all(ids.map((id) =>
      shell.attach(id).then((info) => [id, info] as [string, AttachInfo]).catch(() => null)));
    const live = infos.filter((x): x is [string, AttachInfo] => !!x && x[1].exists);
    if (!live.length) return;
    setSessions((prev) => prev.map((s) => {
      const info = live.find(([id]) => id === s.id)?.[1];
      if (!info?.context) return s;
      try {
        const ctx = JSON.parse(info.context) as { pwd?: string; gitBranch?: string; k8sContext?: string };
        return {
          ...s,
          state: {
            ...s.state,
            ...(ctx.pwd ? { cwd: ctx.pwd.split("/").filter(Boolean) } : {}),
            ...(ctx.gitBranch ? { gitBranch: ctx.gitBranch } : {}),
            ...(ctx.k8sContext ? { ctx: { ...s.state.ctx, name: ctx.k8sContext } } : {}),
          },
        };
      } catch { return s; }
    }));
    setPendingResumes(live.filter(([, info]) => info.running));
  };
  // After a dropped connection (daemon restart, or it gave up on a stalled UI) events were
  // lost: close blocks still waiting for an end marker, then reattach like at startup, which
  // resumes commands still running with the output the daemon kept.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const reattachRef = useRef(reattach);
  reattachRef.current = reattach;
  useEffect(() => onReconnect(() => {
    const all = sessionsRef.current;
    for (const s of all) {
      if (s.blocks.some((b) => b.pending) && !isStreamingSession(s.id)) finishRun(s.id);
    }
    void reattachRef.current(all.map((s) => s.id));
  }), []);

  useEffect(() => {
    if (!pendingResumes.length) return;
    setPendingResumes([]);
    for (const [id, info] of pendingResumes) {
      const sess = sessions.find((s) => s.id === id);
      if (!sess || sess.blocks.some((b) => b.pending)) continue;
      void runBlock(id, info.command ?? "(running command)", sess.state, info);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingResumes]);

  useEffect(() => {
    setAltScreenActive(false);
    return onAltScreenChange(activeId, setAltScreenActive);
  }, [activeId]);

  const newTab = () => {
    const s = makeSession();
    setSessions((prev) => [...prev, s]);
    setActiveId(s.id);
  };

  const closeTab = (id: string) => {
    setSessions((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((s) => s.id === id);
      const next = prev.filter((s) => s.id !== id);
      if (id === activeId) {
        setActiveId(next[Math.max(0, idx - 1)]!.id);
      }
      return next;
    });
  };

  const focusComposer = (sessionId?: string) =>
    window.dispatchEvent(new CustomEvent("focus-composer", { detail: sessionId ? { sessionId } : undefined }));

  useEffect(() => { focusComposer(); }, [activeId]);

  // When focused pane changes, focus that pane's composer
  useEffect(() => {
    const sid = focusedPane === "right" && splitSessionId ? splitSessionId : activeId;
    focusComposer(sid);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedPane, splitSessionId]);

  const focusedSidRef = useRef(activeId);
  focusedSidRef.current = focusedPane === "right" && splitSessionId ? splitSessionId : activeId;

  const anyModalOpen = paletteOpen || keysModalOpen || settingsOpen || globalSearchOpen || searchOpen || historyOpen;
  const prevModalOpenRef = useRef(false);
  const anyModalOpenRef = useRef(anyModalOpen);
  anyModalOpenRef.current = anyModalOpen;

  /**
   * The one auto-focus routine: put the caret in the last active pane's command input —
   * unless a modal is open, another text field holds focus (pager search, rename…) or a
   * pager owns the keyboard. Used on window return, modal/pager close and full-screen exit.
   */
  const autoFocusComposer = (why: string) => {
    requestAnimationFrame(() => {
      if (anyModalOpenRef.current) { focusLog(`skip (${why}): modal open`); return; }
      const ae = document.activeElement as HTMLElement | null;
      // Another text field kept focus (pager search, rename…) — leave it. The composer
      // itself doesn't count: it's often still activeElement while the webview had no
      // keyboard focus, and re-focusing it is what puts the caret back.
      const otherField = ae && !ae.hasAttribute("data-composer") &&
        (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
      if (otherField) { focusLog(`skip (${why}): another field has focus`); return; }
      // A fullscreen pager owns the keyboard (j/k, q…); the composer under it must not grab focus.
      if (document.querySelector(".pager-overlay")) { focusLog(`skip (${why}): pager open`); return; }
      // The window is back but the webview itself has no keyboard focus (Windows/WebView2
      // after an un-minimize or maximize): ask the host for it. Its `focus` event brings
      // us back here with document.hasFocus() true.
      if (!document.hasFocus()) {
        focusLog(`page lacks focus (${why}) → ${requestPageFocus() ? "asked host" : "not asking (no host / asked <500ms ago)"}`);
        return;
      }
      focusComposer(focusedSidRef.current);
      focusLog(`focused composer (${why}) session=${focusedSidRef.current}`);
    });
  };
  /** Same, once the UI has re-rendered (the thing that held focus is only just gone). */
  const refocusComposer = (why = "overlay closed") =>
    requestAnimationFrame(() => setTimeout(() => autoFocusComposer(why), 0));

  // Window restored / refocused (un-minimize, alt-tab back).
  useEffect(() => {
    const onReturn = (e: Event) => {
      focusLog(`event ${e.type}`);
      if (document.visibilityState === "hidden") return;
      autoFocusComposer(e.type);
    };
    const onBlur = () => focusLog("event blur");
    // Every DOM focus move, to see what takes focus away from the command input.
    const onFocusOut = (e: FocusEvent) =>
      focusLog(`focusout ${describeEl(e.target as Element)} → ${describeEl(e.relatedTarget as Element | null)}`);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("focus", onReturn);
    window.addEventListener("blur", onBlur);
    window.addEventListener("daimon:host-focus", onReturn); // sent by the native host on window activation
    window.addEventListener("daimon:window-state", onReturn); // (un)maximized
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("daimon:host-focus", onReturn);
      window.removeEventListener("daimon:window-state", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Any modal closing → back to the command input.
    if (prevModalOpenRef.current && !anyModalOpen) refocusComposer("modal closed");
    prevModalOpenRef.current = anyModalOpen;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyModalOpen]);

  useEffect(() => {
    const bump = (e: Event, d: number) => {
      const pane = ((e as CustomEvent).detail?.paneId as string | null | undefined) ?? "";
      setPagerPanes((prev) => {
        const n = Math.max(0, (prev[pane] ?? 0) + d);
        const next = { ...prev };
        if (n) next[pane] = n; else delete next[pane];
        return next;
      });
    };
    const onOpen = (e: Event) => bump(e, 1);
    const onClose = (e: Event) => {
      bump(e, -1);
      // Composer is unhidden on the next render — focus it once that has painted.
      refocusComposer("pager closed");
    };
    window.addEventListener("pager-open", onOpen);
    window.addEventListener("pager-close", onClose);
    return () => { window.removeEventListener("pager-open", onOpen); window.removeEventListener("pager-close", onClose); };
  }, []);

  useEffect(() => {
    const clip = (label: string, text: string) => {
      const preview = text.length > 80 ? text.slice(0, 80) + "…" : text;
      toast.success(`${label} ${preview}`, { duration: 2000 });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Escape closes panels if open
      if (e.key === "Escape" && globalSearchOpen) { setGlobalSearchOpen(false); setGlobalSearchQuery(""); return; }
      if (e.key === "Escape" && historyOpen) {
        setHistoryOpen(false);
        return;
      }
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.shiftKey && (e.key === "P" || e.key === "p")) {
        e.preventDefault();
        togglePresentation();
        return;
      }
      if (!e.shiftKey && e.key === "p") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (e.key === "f") {
        e.preventDefault();
        setGlobalSearchOpen(true);
        return;
      }
      if (e.key === "=" || e.key === "+") { e.preventDefault(); setFontSize(s => Math.min(s + 1, 20)); return; }
      if (e.key === "-") { e.preventDefault(); setFontSize(s => Math.max(s - 1, 10)); return; }
      if (e.key === "k") {
        e.preventDefault();
        setKeysModalOpen(true);
        return;
      }
      if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (e.key === "b") {
        e.preventDefault();
        setSidebarOpen((o) => !o);
        return;
      }
      if (e.key === "h") {
        e.preventDefault();
        setHistoryOpen((o) => !o);
        return;
      }
      if (e.key === "j") {
        e.preventDefault();
        if (ctxSwitcherIsOpen.current) {
          setCtxSwitcherClose((n) => n + 1);
          ctxSwitcherIsOpen.current = false;
          focusComposer();
        } else {
          setCtxSwitcherOpen((n) => n + 1);
          ctxSwitcherIsOpen.current = true;
        }
        return;
      }
      if (e.key === "t") {
        e.preventDefault();
        newTab();
        return;
      }
      if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        if (e.shiftKey) {
          // ⌘⇧D — close split
          setSessions((prev) => prev.map((s) => s.id === activeId ? removeSplit(s) : s));
          setFocusedPane("left");
        } else {
          // ⌘D — open split or toggle pane focus
          if (!splitSessionId) {
            const s = makeSession();
            setSessions((prev) => [...prev, s].map((x) => x.id === activeId ? { ...x, splitId: s.id } : x));
            setFocusedPane("right");
          } else {
            setFocusedPane((p) => p === "left" ? "right" : "left");
          }
        }
        return;
      }
      if (e.key === "w") {
        e.preventDefault();
        closeTab(activeId);
        return;
      }
      if (e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key) - 1;
        const target = topLevelSessions[idx];
        if (target) { e.preventDefault(); setActiveId(target.id); setFocusedPane("left"); }
        return;
      }
      if (e.key === "c") {
        // Ctrl-C with pending command → SIGINT to PTY, abandon after 2s if stuck.
        // With text marked it copies instead (below) and drops the selection, so the
        // command keeps running; a second Ctrl-C interrupts.
        const marked = window.getSelection()?.toString() ?? "";
        if (e.ctrlKey && !e.metaKey && !marked) {
          const sess = sessions.find((s) => s.id === activeId);
          if (sess?.blocks.some((b) => b.pending)) {
            e.preventDefault();
            sendRaw(activeId, "\x03");
            setTimeout(() => abandonRun(activeId), 2000);
            return;
          }
        }
        const sel = marked;
        if (!sel) return;
        navigator.clipboard.writeText(sel).catch(() => {});
        clip("Copied", sel);
        if (e.ctrlKey && !e.metaKey) window.getSelection()?.removeAllRanges();
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text") ?? "";
      if (!text) return;
      clip("Pasted", text);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("paste", onPaste);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, sessions, historyOpen]);

  // Block hover shortcuts: ⌘⇧ (or ⌃⇧) + C/I/O/R/E
  const blockModRef = useRef(false);
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const mod = (e.metaKey || e.ctrlKey) && e.shiftKey;
      const tuiActive = altScreenActive || tuiBlockIds.has(activeId);
      if (mod && !blockModRef.current) { blockModRef.current = true; if (!pagerActive && !tuiActive) setBlockModActive(true); }
      if (!mod || !hoveredBlockId || pagerActive || tuiActive) return;
      const block = active.blocks.find(b => b.id === hoveredBlockId);
      if (!block) return;
      const key = e.key.toUpperCase();
      if (key === "C") {
        e.preventDefault();
        const text = `$ ${block.input}\n${blockOutputText(block)}`.trimEnd();
        navigator.clipboard.writeText(text).then(() => toast.success("Block copied", { duration: 1500 }));
      } else if (key === "I") {
        e.preventDefault();
        navigator.clipboard.writeText(block.input).then(() => toast.success("Command copied", { duration: 1500 }));
      } else if (key === "O") {
        e.preventDefault();
        const out = blockOutputText(block);
        if (out) navigator.clipboard.writeText(out).then(() => toast.success("Output copied", { duration: 1500 }));
      } else if (key === "R") {
        e.preventDefault();
        submit(block.input);
      } else if (key === "E") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("block-toggle-collapse", { detail: { blockId: block.id } }));
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) { blockModRef.current = false; setBlockModActive(false); }
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => { window.removeEventListener("keydown", onDown); window.removeEventListener("keyup", onUp); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredBlockId, active.blocks, altScreenActive, tuiBlockIds]);

  // Leaving a full-screen program (nano, less, htop…): back to the command input, and — if the
  // pane was following — straight to the bottom (the block just swapped terminal for output).
  const prevTuiRef = useRef(tuiInActive);
  useEffect(() => {
    if (prevTuiRef.current && !tuiInActive) {
      refocusComposer("left fullscreen");
      if (follows(activeId)) scrollToBottom(activeId);
    }
    prevTuiRef.current = tuiInActive;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tuiInActive]);

  // Only the user stops the following: wheel, touch, keys or a drag on the pane (scrollbar).
  // An upward scroll without that is the browser clamping/anchoring after the content
  // changed (a TUI block swapping back to output, a block collapsing) and must not count.
  // -Infinity, not 0: "0" would read as a scroll at page load, so for the first 500ms every
  // browser-made scroll (restored blocks laying out) would count as the user's and stop following.
  const userScrollAtRef = useRef(-Infinity);
  const pointerDownRef = useRef(false);
  const markUserScroll = () => { userScrollAtRef.current = performance.now(); };
  useEffect(() => {
    const up = () => { pointerDownRef.current = false; };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => { window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
  }, []);
  const userIsScrolling = () => pointerDownRef.current || performance.now() - userScrollAtRef.current < 500;

  const handleScroll = (sessionId: string, el: HTMLElement) => {
    updateHeaderBlock(sessionId);
    const prev = lastScrollTopRef.current.get(sessionId) ?? el.scrollTop;
    lastScrollTopRef.current.set(sessionId, el.scrollTop);
    if (atBottom(el)) {
      followRef.current.set(sessionId, true);
      if (sessionId === activeIdRef.current) toast.dismiss("new-output");
    } else if (el.scrollTop < prev && userIsScrolling()) {
      followRef.current.set(sessionId, false);
    }
  };

  const onSplitDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    splitDragging.current = true;
    const onMove = (ev: MouseEvent) => {
      const main = (e.target as HTMLElement).closest("[data-split-root]") as HTMLElement | null;
      if (!main) return;
      const rect = main.getBoundingClientRect();
      const ratio = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width));
      setSplitRatio(ratio);
    };
    const onUp = () => {
      splitDragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const submit = async (cmd: string, forSessionId?: string) => {
    const sessionId = forSessionId ?? activeId;
    const sess = sessions.find((s) => s.id === sessionId) ?? sessions[0]!;
    followRef.current.set(sessionId, true);

    // If a streaming-interactive session (ssh/mosh) is active, forward input to PTY directly.
    // Check module-level map — immune to React stale closure.
    // Exception: once the session is warpified (remote shell emits OSC 133), fall through
    // to the normal run() block path so each remote command renders as its own block.
    if (isStreamingSession(sessionId) && !isWarpified(sessionId)) {
      sendRaw(sessionId, cmd + "\n");
      return;
    }

    // Legacy stale-closure fallback (belt-and-suspenders)
    const pendingStreamBlock = sess.blocks.find(
      (b) => b.pending && STREAMING_INTERACTIVE_RE.test(b.input)
    );
    if (pendingStreamBlock && !isWarpified(sessionId)) {
      sendRaw(sessionId, cmd + "\n");
      return;
    }

    // Any pending command (e.g. Y/n prompt, password, script input) — forward as stdin.
    // Skip when warpified: the ssh connection block stays pending for the session's life,
    // so remote commands must go through run() (block path), not raw stdin.
    if (sess.blocks.some((b) => b.pending) && !isWarpified(sessionId)) {
      // Control characters (e.g. \x03 SIGINT) go raw without newline
      const isCtrl = cmd.length === 1 && cmd.charCodeAt(0) < 32;
      sendRaw(sessionId, isCtrl ? cmd : cmd + "\n");
      if (isCtrl && cmd.charCodeAt(0) === 3) setTimeout(() => abandonRun(sessionId), 2000);
      return;
    }

    const isDup = sess.history[sess.history.length - 1] === cmd;
    const ts = Date.now();
    const newHistory = isDup ? sess.history : [...sess.history, cmd];
    const newHistoryTs = isDup ? sess.historyTs : [...sess.historyTs, ts];
    if (!isDup) shell.historyAdd(cmd, ts).catch(() => {});
    updateSession(sessionId, { history: newHistory, historyTs: newHistoryTs });
    await runBlock(sessionId, cmd, sess.state);
  };

  /**
   * Run `cmd` as a new block in a session — or, with `resume`, show a command that is
   * already running in the daemon (the UI restarted while it ran) as that block.
   */
  const runBlock = async (sessionId: string, cmd: string, state: State, resume?: AttachInfo) => {
    const pendingId = Math.random().toString(36).slice(2);
    setSessions((prev) => prev.map((s) => s.id === sessionId ? {
      ...s,
      blocks: [...s.blocks, { id: pendingId, input: cmd, cwd: s.state.cwd, ctx: s.state.ctx.name, at: now(), ts: resume?.startedAt || Date.now(), ms: 0, code: 0, out: [], pending: true }],
    } : s));

    const runPromise = run(cmd, state, sessionId, (updated) => {
      setSessions((prev) => prev.map((s) => s.id === sessionId ? {
        ...s,
        blocks: s.blocks.map((x) => x.id === pendingId ? { ...updated, id: pendingId } : x),
      } : s));
    }, resume);
    window.dispatchEvent(new CustomEvent("focus-composer", { detail: { sessionId } }));
    const { block, next, clear } = await runPromise;
    setSessions((prev) => prev.map((s) => {
      if (s.id !== sessionId) return s;
      const newBlocks = clear ? [] : s.blocks.map((x) => x.id === pendingId ? { ...block, id: pendingId } : x);
      if (!clear) {
        shell.blockSave({
          id: block.id ?? pendingId,
          session_id: sessionId,
          input: block.input,
          cwd: Array.isArray(block.cwd) ? "/" + block.cwd.join("/") : (block.cwd ?? ""),
          ctx: block.ctx ?? "",
          ts: block.ts ?? Date.now(),
          exit_code: block.code ?? 0,
          output_json: JSON.stringify(block.out ?? []),
        }).catch(() => {});
      } else {
        shell.blockClear(sessionId).catch(() => {});
      }
      return { ...s, state: next, lastCmd: cmd, blocks: newBlocks };
    }));
    followRef.current.set(sessionId, true);
    scrollToBottom(sessionId);
    setTimeout(() => window.dispatchEvent(new CustomEvent("focus-composer", { detail: { sessionId } })), 1);
  };

  // Benchmark mode (DAIMON_BENCH): drives the active session through the normal submit path.
  const benchApi = useRef<{ submit: (cmd: string) => Promise<void>; busy: () => boolean }>({ submit: () => Promise.resolve(), busy: () => true });
  benchApi.current = {
    submit: (cmd: string) => submit(cmd),
    busy: () => (sessions.find((s) => s.id === activeId) ?? sessions[0]!).blocks.some((b) => b.pending),
  };
  useEffect(() => { startBench(() => benchApi.current); }, []);

  const pickCtx = (name: string) => submit(`u8s set --context ${name} && u8s sync`);

  const renderPane = (paneSessionId: string, isFocused: boolean) => {
    const pane = sessions.find((s) => s.id === paneSessionId) ?? sessions[0]!;
    const paneDisabled = pane.blocks.some((b) => b.pending && !STREAMING_INTERACTIVE_RE.test(b.input));
    const panePrompting = paneDisabled && pane.blocks.some((b) => b.pending && !STREAMING_INTERACTIVE_RE.test(b.input) && isPromptingForInput(b));
    const paneSecret = paneDisabled && pane.blocks.some((b) => b.pending && !STREAMING_INTERACTIVE_RE.test(b.input) && isPromptingForSecret(b));
    const paneHideBar = (altScreenActive && paneSessionId === activeId) || tuiBlockIds.has(paneSessionId) || !!pagerPanes[paneSessionId] || !!pagerPanes[""];
    return (
      <>
        <div
          // Observed too: when the pane itself shrinks (the composer/status bar coming back as a
          // command finishes) the content size is unchanged, but the bottom would slide out of view.
          data-follow-session={paneSessionId}
          ref={(el) => {
            if (el) scrollContainersRef.current.set(paneSessionId, el);
            else scrollContainersRef.current.delete(paneSessionId);
            observeContent(`${paneSessionId}\u0000pane`, el);
          }}
          onScroll={(e) => handleScroll(paneSessionId, e.currentTarget)}
          onWheel={markUserScroll}
          onTouchMove={markUserScroll}
          onKeyDown={markUserScroll}
          onPointerDown={() => { pointerDownRef.current = true; markUserScroll(); }}
          className={`flex-1 overflow-y-auto px-6 py-8 ${isFocused ? "" : "cursor-pointer"}`}
          style={{ "--terminal-font-size": fontSize + "px" } as React.CSSProperties}
          onClick={() => { if (!isFocused) setFocusedPane(splitSessionId && paneSessionId === splitSessionId ? "right" : "left"); }}
        >
          <div className="w-full" data-follow-session={paneSessionId} ref={(el) => observeContent(paneSessionId, el)}>
            {pane.blocks.length === 0 ? (
              <LandingPage
                blocks={pane.blocks}
                history={pane.history}
                onCd={(path) => submit(`cd ${/[\s"'$`\\]/.test(path) ? JSON.stringify(path) : path}`, paneSessionId)}
                onRun={(cmd) => submit(cmd, paneSessionId)}
                onOpenPalette={() => setPaletteOpen(true)}
              />
            ) : (
              <div className="divide-y divide-border/50">
                {pane.blocks.map((b, i) => (
                  <div
                    key={b.id}
                    data-block-id={b.id}
                    ref={(el) => { if (el) blockRefsMap.current.set(b.id, el); else blockRefsMap.current.delete(b.id); }}
                    data-ring={effectiveHoveredBlockId === b.id && effectiveBlockModActive ? "on" : undefined}
                    className="block-ring relative py-7 rounded-lg"
                    onMouseEnter={() => { if (!pagerActive) setHoveredBlockId(b.id); if (!isFocused) setFocusedPane(splitSessionId && paneSessionId === splitSessionId ? "right" : "left"); }}
                    onMouseLeave={() => setHoveredBlockId(null)}
                  >
                    <BlockView block={b} modeActive={effectiveHoveredBlockId === b.id && effectiveBlockModActive} onRerun={(cmd) => submit(cmd, paneSessionId)} isLast={i === pane.blocks.length - 1} currentCtx={pane.state.ctx.name} sessionId={pane.id} isTuiActive={tuiBlockIds.get(pane.id) === b.id} promptingForInput={panePrompting && !!b.pending} onSearch={(q) => { setGlobalSearchQuery(q); setGlobalSearchOpen(true); }} onPathClick={(path) => { const expanded = path.startsWith("~") ? __HOME__ + path.slice(1) : path; const hasExt = /\.[^/]+$/.test(expanded.split("/").pop() ?? ""); const dir = hasExt ? expanded.split("/").slice(0, -1).join("/") || "/" : expanded; submit("cd " + JSON.stringify(dir), paneSessionId); toast("cd " + dir, { duration: 2000 }); }} />
                  </div>
                ))}
              </div>
            )}
            <div />
          </div>
        </div>
        <div className={`sticky bottom-0 border-t border-border bg-background/60 glass chrome-surface${paneHideBar ? " hidden" : ""}`}>
          {showPowerline && isFocused && (
            <PowerlineStatus
              k8sContext={k8sContext}
              k8sNamespace={k8sNamespace}
              osRegion={osRegion}
              osProject={osProject}
              osDomain={osDomain}
              gitBranch={gitBranch}
              gitDirty={gitDirty}
              gitAdded={gitAdded}
              gitRemoved={gitRemoved}
            />
          )}
          <div className="px-6 py-3">
            <div className="w-full">
              <Composer
                key={paneSessionId}
                cwd={pane.state.cwd}
                ctx={pane.state.ctx.name}
                history={pane.history}
                historyTs={pane.historyTs}
                initialValue={pane.draft ?? ""}
                onDraftChange={(v) => setSessions((prev) => prev.map((s) => s.id === paneSessionId ? { ...s, draft: v } : s))}
                onSubmit={(cmd) => { if (!isFocused) setFocusedPane(splitSessionId && paneSessionId === splitSessionId ? "right" : "left"); submit(cmd, paneSessionId); }}
                gitBranch={isFocused ? gitBranch : null}
                gitDirty={isFocused ? gitDirty : false}
                gitAhead={isFocused ? gitAhead : 0}
                gitBehind={isFocused ? gitBehind : 0}
                sessionId={pane.id}
                disabled={paneDisabled}
                streamingActive={pane.blocks.some((b) => b.pending && STREAMING_INTERACTIVE_RE.test(b.input))}
                promptingForInput={panePrompting}
                secretInput={paneSecret}
              />
            </div>
          </div>
        </div>
      </>
    );
  };

  const searchBlocks = (query: string) => {
    if (!query) { setSearchResults([]); return; }
    const q = query.toLowerCase();
    const results: {blockId: string; blockInput: string; snippet: string}[] = [];
    for (const block of active.blocks) {
      let found: string | null = null;
      if (block.input.toLowerCase().includes(q)) found = block.input;
      if (!found) {
        for (const out of block.out) {
          if (out.kind === "lines") {
            const match = out.lines.find((l) => l.toLowerCase().includes(q));
            if (match) { found = match; break; }
          } else if (out.kind === "pairs") {
            const match = out.pairs.find(([k, v]) => `${k} ${v}`.toLowerCase().includes(q));
            if (match) { found = match.join(": "); break; }
          } else if (out.kind === "table") {
            const match = out.rows.find((r) => r.join(" ").toLowerCase().includes(q));
            if (match) { found = match.join(" "); break; }
          } else if (out.kind === "logfmt") {
            const match = out.lines.find((f) => Object.values(f).join(" ").toLowerCase().includes(q));
            if (match) { found = Object.values(match).join(" "); break; }
          } else if (out.kind === "ansi") {
            const text = out.html.replace(/<[^>]+>/g, "");
            if (text.toLowerCase().includes(q)) { found = text.slice(0, 100); break; }
          }
        }
      }
      if (found) results.push({ blockId: block.id, blockInput: block.input, snippet: found.slice(0, 80) });
    }
    setSearchResults(results);
  };

  useEffect(() => {
    if (!globalSearchQuery) { setGlobalSearchResults([]); return; }
    setGlobalSearchLoading(true);
    const q = globalSearchQuery.toLowerCase();
    const t = setTimeout(() => {
      Promise.all([
        shell.blockRecent(2000),
        shell.historySearch(globalSearchQuery, 100),
      ]).then(([rows, histRows]) => {
        const blockMatches = rows
          .filter((r) => r.input.toLowerCase().includes(q) || r.output_json.toLowerCase().includes(q))
          .slice(0, 30)
          .map((r) => {
            let output = "";
            try {
              const parsed: {kind: string; lines?: string[]; html?: string}[] = JSON.parse(r.output_json);
              for (const o of parsed) {
                if (o.kind === "lines" && o.lines) {
                  const hit = o.lines.find((l) => l.toLowerCase().includes(q));
                  if (hit) { output = hit.slice(0, 120); break; }
                } else if (o.kind === "ansi" && o.html) {
                  const text = o.html.replace(/<[^>]+>/g, "");
                  if (text.toLowerCase().includes(q)) { output = text.slice(0, 120); break; }
                }
              }
            } catch { /* ignore */ }
            return { input: r.input, cwd: r.cwd, ts: r.ts, exit_code: r.exit_code, output };
          });

        // Merge history results, dedup against block inputs, filter meta history commands
        const blockInputs = new Set(blockMatches.map(r => r.input.toLowerCase()));
        const histMatches = histRows
          .filter(h => !/^history(\s|$)/.test(h.cmd) && !blockInputs.has(h.cmd.toLowerCase()))
          .map(h => ({ input: h.cmd, cwd: "", ts: h.ts, exit_code: 0, output: "" }));

        // Merge: blocks first (have output), then history-only entries; sort by ts desc
        const merged = [...blockMatches, ...histMatches].sort((a, b) => b.ts - a.ts).slice(0, 50);
        setGlobalSearchResults(merged);
        setGlobalSearchLoading(false);
      }).catch(() => setGlobalSearchLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [globalSearchQuery]);

  // Windows draws its own caption (html.custom-frame); the wordmark row lives in it there.
  const customFrame = document.documentElement.classList.contains("custom-frame");
  const wordmark = (
    <>
      <span className="flex items-center gap-2 font-mono text-[15px] font-semibold tracking-tight text-sidebar-foreground">
        <span className="text-sidebar-foreground/40">›_</span>
        daimon
        <span className="text-amber">.</span>
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={cycleTheme}
          title={`Theme: ${theme} — click to cycle`}
          className="no-drag rounded-md p-1.5 text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          {THEME_ICONS[theme]}
        </button>
        <button
          onClick={newTab}
          className="no-drag rounded-md p-1.5 text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
          title="New session (⌘T)"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
    </>
  );

  return (
    <PresentationModeContext.Provider value={presentationMode}>
    <div className="flex flex-col h-screen bg-transparent text-foreground overflow-hidden">
      <Toaster position="top-center" />

      <TitleBar left={sidebarOpen ? wordmark : null} />

      <div className="flex flex-1 overflow-hidden">
      {/* Sidebar */}
      <aside className={`shrink-0 flex-col border-r border-border bg-sidebar/70 glass chrome-surface lg:flex transition-all duration-200 overflow-hidden ${sidebarOpen ? "w-56" : "w-0 border-r-0"}`}>
        {/* Wordmark — on Windows it sits in the caption strip (top-left corner) instead, see TitleBar's `left` */}
        {customFrame
          ? <div style={{ height: 36 + 12 }} />
          : <div className="flex items-center justify-between px-5 pb-4" style={{ paddingTop: "calc(1.25rem + 36px)" }}>{wordmark}</div>}

        {/* Sessions */}
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          <div className="px-2 pb-2 font-mono text-[11px] uppercase tracking-wider text-sidebar-foreground/40">
            Sessions <span className="text-sidebar-foreground/25">/ {String(topLevelSessions.length).padStart(2, "0")}</span>
          </div>
          {(() => {
            const topLevel = topLevelSessions;

            const detachSplit = (parentId: string) => {
              setSessions((prev) => prev.map((s) => s.id === parentId ? removeSplit(s) : s));
              if (activeId === parentId) setFocusedPane("left");
            };

            const attachAsplit = (parentId: string, childId: string) => {
              // childId becomes split pane of parentId; remove any existing split on parent first
              setSessions((prev) => prev.map((s) => {
                if (s.id === parentId) return { ...s, splitId: childId };
                // if child was itself someone else's split, detach it
                if (s.splitId === childId) return removeSplit(s);
                return s;
              }));
              setActiveId(parentId);
              setFocusedPane("right");
            };

            return (
              <ul className="space-y-0.5">
                {topLevel.map((s) => {
                  const splitChild = s.splitId ? sessions.find((x) => x.id === s.splitId) : null;
                  const isActive = s.id === activeId;
                  // Sessions that could be attached as split (top-level, not already this session, no split of their own)
                  const attachCandidates = topLevel.filter((c) => c.id !== s.id && !c.splitId && !splitChildIds.has(c.id) && c.id !== s.splitId);

                  const sessionRow = (sess: typeof s, isParent: boolean) => {
                    const sessIsActive = isActive && (isParent ? (!splitChild || focusedPane === "left") : focusedPane === "right");
                    return (
                      <div
                        key={sess.id}
                        onClick={() => {
                          if (renamingId !== sess.id) {
                            setActiveId(s.id);
                            setFocusedPane(isParent ? "left" : "right");
                          }
                        }}
                        onDoubleClick={() => {
                          setActiveId(s.id);
                          setFocusedPane(isParent ? "left" : "right");
                          setRenamingId(sess.id);
                          setTimeout(() => { renameRef.current?.select(); }, 0);
                        }}
                        className={`group/sess flex w-full items-center gap-2 border-l-2 px-2 py-1.5 cursor-pointer transition-colors ${
                          sessIsActive
                            ? "border-amber bg-sidebar-accent text-sidebar-foreground"
                            : "border-transparent text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                        }`}
                      >
                        <span className="shrink-0 flex items-center justify-center size-6 rounded bg-sidebar-foreground/10 font-mono text-[11px] text-sidebar-foreground/60">
                          {/* What the session's last command runs (claude, k9s, git, …), kept after it finishes. */}
                          <CommandIcon cmd={sess.blocks.at(-1)?.input ?? sess.lastCmd} fallback={!isParent ? <SplitSquareHorizontalIcon className="size-3" /> : ">_"} />
                        </span>
                        {renamingId === sess.id ? (
                          <input
                            ref={renameRef}
                            defaultValue={sess.customName ?? sess.lastCmd ?? ""}
                            placeholder={sess.lastCmd ?? "name…"}
                            className="flex-1 min-w-0 bg-transparent font-mono text-[12px] text-sidebar-foreground outline-none"
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              setSessions((prev) => prev.map((x) => {
                                if (x.id !== sess.id) return x;
                                if (v) return { ...x, customName: v };
                                const { customName: _, ...rest } = x;
                                return rest as Session;
                              }));
                              setRenamingId(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") e.currentTarget.blur();
                              if (e.key === "Escape") { e.currentTarget.value = sess.customName ?? sess.lastCmd ?? ""; e.currentTarget.blur(); }
                              e.stopPropagation();
                            }}
                            onClick={(e) => e.stopPropagation()}
                            autoFocus
                          />
                        ) : (
                          <div className="flex flex-col min-w-0 flex-1">
                            <span className="font-mono text-[12px] truncate leading-tight">{sessionLabel(sess)}</span>
                            <span className="font-mono text-[10px] truncate leading-tight opacity-50">{displayPath(sess.state.cwd)}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-0.5 opacity-0 group-hover/sess:opacity-100 transition-opacity">
                          {isParent && !splitChild && attachCandidates.length > 0 && (
                            <div className="relative group/attach">
                              <button
                                title="Attach a session as split pane"
                                onClick={(e) => e.stopPropagation()}
                                className="rounded p-0.5 hover:bg-sidebar-foreground/10"
                              >
                                <SplitSquareHorizontalIcon className="size-2.5" />
                              </button>
                              <div className="absolute left-full top-0 ml-1 hidden group-hover/attach:block z-50 min-w-[140px] border border-border bg-popover shadow-xl py-1">
                                {attachCandidates.map((c) => (
                                  <button
                                    key={c.id}
                                    onClick={(e) => { e.stopPropagation(); attachAsplit(s.id, c.id); }}
                                    className="w-full px-3 py-1.5 text-left font-mono text-[11px] text-foreground/80 hover:bg-accent truncate"
                                  >
                                    {sessionLabel(c)}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                          {!isParent && (
                            <button
                              title="Detach to own tab"
                              onClick={(e) => { e.stopPropagation(); detachSplit(s.id); }}
                              className="rounded p-0.5 hover:bg-sidebar-foreground/10"
                            >
                              <ArrowUpRightIcon className="size-2.5" />
                            </button>
                          )}
                          {isParent && sessions.length > 1 && (
                            <button
                              onClick={(e) => { e.stopPropagation(); closeTab(s.id); }}
                              className="rounded p-0.5 hover:bg-sidebar-foreground/10"
                            >
                              <XIcon className="size-2.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  };

                  return (
                    <li key={s.id}>
                      {splitChild ? (
                        <div className={`border rounded-md overflow-hidden ${isActive ? "border-signal/25" : "border-border/50"}`}>
                          {sessionRow(s, true)}
                          <div className="border-t border-border/40" />
                          {sessionRow(splitChild, false)}
                        </div>
                      ) : (
                        sessionRow(s, true)
                      )}
                    </li>
                  );
                })}
              </ul>
            );
          })()}
        </div>

      </aside>

      {/* Main */}
      <main className="relative flex min-w-0 flex-1 flex-col bg-background/70 glass chrome-surface">
        <GlobalSearch
          open={globalSearchOpen}
          query={globalSearchQuery}
          onQueryChange={setGlobalSearchQuery}
          results={globalSearchResults}
          loading={globalSearchLoading}
          onSelect={(cmd, cwd) => { submit(`cd ${JSON.stringify(cwd)} && ${cmd}`); }}
          onClose={() => { setGlobalSearchOpen(false); setGlobalSearchQuery(""); }}
        />
        {/* Search overlay */}
        {searchShown && (
          <div data-state={searchOpen ? "open" : "closed"} className="popover-panel absolute top-16 right-4 z-50 w-96 rounded-xl border border-border bg-card/90 glass shadow-2xl">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <SearchIcon className="size-4 text-muted-foreground/50" />
              <input
                ref={searchRef}
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); searchBlocks(e.target.value); }}
                onKeyDown={(e) => { if (e.key === "Escape") { setSearchOpen(false); setSearchQuery(""); setSearchResults([]); } }}
                placeholder="Search commands and output..."
                className="flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground/40"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="font-mono text-[11px] text-muted-foreground/50">{searchResults.length}</span>
              <button onClick={() => { setSearchOpen(false); setSearchQuery(""); setSearchResults([]); }}>
                <XIcon className="size-4 text-muted-foreground/50 hover:text-foreground" />
              </button>
            </div>
            {searchResults.length > 0 && (
              <ul className="max-h-72 overflow-y-auto py-1">
                {searchResults.map((r) => (
                  <li key={r.blockId}>
                    <button
                      className="w-full px-3 py-2 text-left hover:bg-accent"
                      onClick={() => {
                        blockRefsMap.current.get(r.blockId)?.scrollIntoView({ behavior: "smooth", block: "center" });
                        setSearchOpen(false);
                      }}
                    >
                      <div className="font-mono text-[12px] text-foreground">{r.blockInput}</div>
                      <div className="font-mono text-[11px] text-muted-foreground/60 truncate">{r.snippet}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {searchQuery && searchResults.length === 0 && (
              <p className="px-3 py-3 font-mono text-[12px] text-muted-foreground/50">No results</p>
            )}
          </div>
        )}
        <header className={`sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/70 glass chrome-surface px-4 pb-3${pagerActive ? " hidden" : ""}`} style={{ paddingTop: "calc(0.75rem + 36px)" }}>
          <button
            onClick={() => setSidebarOpen((o) => !o)}
            title="Toggle sidebar (⌘B)"
            className="no-drag rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <PanelLeftIcon className="size-4" />
          </button>

          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="no-drag flex items-center gap-2 font-mono text-[13px] text-foreground">
              {sessionLabel(active)}
              <span className="text-muted-foreground/40">/</span>
            </span>
            {/* The command of the block scrolled out above the viewport, sticky like a section
                heading: click to scroll back to its start. */}
            {/* Always takes its line, so the header doesn't change height as you scroll. */}
            <div className="no-drag flex h-[18px] min-w-0 items-center gap-3">
              {headerBlock && (<>
                <button
                  onClick={() => blockRefsMap.current.get(headerBlock.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  title={headerBlock.input}
                  className={`min-w-0 truncate font-mono text-[12px] underline-offset-4 hover:underline ${!headerBlock.pending && headerBlock.code !== 0 ? "text-alarm" : "text-muted-foreground"}`}
                >
                  {headerBlock.input}
                </button>
                <BlockMeta block={headerBlock} className="shrink-0" />
              </>)}
            </div>
          </div>

          {showBadges && !showPowerline && <HeaderExtensionSlot extensions={[<OpenStackBadge region={osRegion} project={osProject} domain={osDomain} />]} />}

          {/* Kubernetes context widget — only when k8s context is set. Hidden while powerline is on (powerline shows it instead). */}
          {showBadges && !showPowerline && k8sContext && (
            <div className="no-drag flex items-center gap-2.5 rounded-md border border-border/40 bg-card/60 veil-surface px-2.5 py-1">
              <img src={kubernetesIcon} alt="Kubernetes" className="size-3.5 shrink-0" />
              <div className="flex items-center gap-1.5 font-mono text-[11px]">
                <span className="text-[#326DE6]/90 font-medium">{k8sContext}</span>
                {k8sNamespace && k8sNamespace !== "default" && (
                  <>
                    <span className="text-muted-foreground/40">·</span>
                    <span className="text-foreground/80">{k8sNamespace}</span>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="no-drag ml-auto flex items-center gap-3">
            <span className="hidden font-mono text-[11px] tabular-nums text-muted-foreground sm:inline">
              {active.blocks.length} {active.blocks.length === 1 ? "run" : "runs"}
            </span>
            {splitSessionId && (
              <button
                onClick={() => { setSessions((prev) => prev.map((s) => s.id === activeId ? removeSplit(s) : s)); setFocusedPane("left"); }}
                title="Close split (⌘⇧D)"
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <XIcon className="size-4" />
              </button>
            )}
            <button
              onClick={togglePresentation}
              title={presentationMode ? "Presentation mode on (⌘⇧P)" : "Presentation mode off (⌘⇧P)"}
              className={`rounded-md p-1.5 transition-colors ${presentationMode ? "text-amber-400 bg-amber-400/10 hover:bg-amber-400/20" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
            >
              {presentationMode ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
            </button>
            <ContextSwitcher ctxName={active.state.ctx.name} onPick={pickCtx} forceOpen={ctxSwitcherOpen} forceClose={ctxSwitcherClose} onOpenChange={(o) => { ctxSwitcherIsOpen.current = o; if (!o) refocusComposer(); }} />
          </div>
        </header>

        {/* Panes */}
        <div className="flex flex-1 overflow-hidden" data-split-root>
          <div
            data-pane={activeId}
            data-pane-focused={String(focusedPane === "left" || !splitSessionId)}
            onMouseDown={() => { if (splitSessionId && focusedPane !== "left") setFocusedPane("left"); }}
            className={`relative flex min-w-0 flex-col overflow-hidden transition-[flex] duration-300 ease-in-out${splitSessionId && focusedPane === "right" ? " opacity-70" : ""}`}
            style={{ flex: splitSessionId ? splitRatio : 1 }}
          >
            {renderPane(activeId, focusedPane === "left" || !splitSessionId)}
          </div>
          {splitSessionId && (
            <>
              {/* Drag handle */}
              <div
                className="group relative z-10 flex w-1 shrink-0 cursor-col-resize items-center justify-center bg-border/40 hover:bg-signal/40 transition-colors duration-150 select-none"
                onMouseDown={onSplitDragStart}
              >
                <div className="h-8 w-0.5 rounded-full bg-border group-hover:bg-signal/60 transition-colors duration-150" />
              </div>
              <div data-pane={splitSessionId} data-pane-focused={String(focusedPane === "right")} onMouseDown={() => { if (focusedPane !== "right") setFocusedPane("right"); }} className={`relative flex min-w-0 flex-col overflow-hidden animate-in slide-in-from-right-8 duration-300${focusedPane === "left" ? " opacity-70" : ""}`} style={{ flex: 1 - splitRatio }}>
                {renderPane(splitSessionId, focusedPane === "right")}
              </div>
            </>
          )}
        </div>

        {historyOpen && (
          <div className="border-t border-border">
            <HistoryPanel
              history={active.history}
              historyTs={active.historyTs}
              onSelect={(cmd) => { setHistoryOpen(false); submit(cmd); }}
              onClose={() => setHistoryOpen(false)}
            />
          </div>
        )}
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onRun={submit}
        onCd={(path) => submit("cd " + path)}
        history={active.history}
        sessions={sessions.map((s) => ({ id: s.id, title: sessionLabel(s) }))}
        onSwitchSession={setActiveId}
        commands={[
          { id: "theme", label: "Toggle theme", description: theme === "light" ? "→ dracula" : "→ light", run: cycleTheme },
          { id: "new-session", label: "New session", description: "⌘T", run: () => { setPaletteOpen(false); newTab(); } },
          { id: "split", label: "Split pane", description: "⌘D", run: () => { setPaletteOpen(false); if (!splitSessionId) { const s = makeSession(); setSessions((prev) => [...prev, s].map((x) => x.id === activeId ? { ...x, splitId: s.id } : x)); setFocusedPane("right"); } else { setSessions((prev) => prev.map((s) => s.id === activeId ? removeSplit(s) : s)); setFocusedPane("left"); } } },
          { id: "search", label: "Search blocks", description: "⌘F", run: () => { setPaletteOpen(false); setSearchOpen(true); } },
          { id: "sidebar", label: "Toggle sidebar", description: "⌘B", run: () => { setPaletteOpen(false); document.dispatchEvent(new CustomEvent("toggle-sidebar")); } },
          { id: "keys", label: "Keyboard shortcuts", description: "⌘K", run: () => { setPaletteOpen(false); setKeysModalOpen(true); } },
          { id: "ssh", label: "Connect via SSH", description: "ssh host", run: () => { setPaletteOpen(false); window.dispatchEvent(new CustomEvent("prefill-composer", { detail: { text: "ssh " } })); } },
          { id: "settings", label: "Settings", description: "⌘,", run: () => { setPaletteOpen(false); setSettingsOpen(true); } },
        ]}
      />
      <KeyboardShortcutsModal open={keysModalOpen} onClose={() => setKeysModalOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} theme={theme} onTheme={setTheme} fontSize={fontSize} onFontSize={setFontSize} showBadges={showBadges} onShowBadges={setShowBadges} showPowerline={showPowerline} onShowPowerline={setShowPowerline} />
      </div>
    </div>
    </PresentationModeContext.Provider>
  );
}
