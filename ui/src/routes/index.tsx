import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast, Toaster } from "sonner";
import { PlusIcon, XIcon, SunIcon, ZapIcon, PanelLeftIcon, GitBranchIcon, SearchIcon, EyeOffIcon, EyeIcon } from "lucide-react";
import { BlockView, PresentationModeContext } from "@/components/daimon/BlockView";
import { Composer } from "@/components/daimon/Composer";
import { HistoryPanel } from "@/components/daimon/HistoryPanel";
import { ContextSwitcher } from "@/components/daimon/ContextSwitcher";
import { XTermPanel, type XTermHandle } from "@/components/daimon/XTermPanel";
import { run, sendRaw, resizePty, notifyAltScreen, onAltScreenChange, onTuiChange, STREAMING_INTERACTIVE_RE, isStreamingSession, abandonRun, type Block, type State } from "@/lib/daimon/shell";
import { shell } from "@/lib/daimon/rpc";
import { displayPath } from "@/lib/daimon/world";
import kubernetesIcon from "@/assets/kubernetes-icon.svg";
import { LandingPage } from "@/components/daimon/LandingPage";
import { CommandPalette } from "@/components/daimon/CommandPalette";
import { GlobalSearch } from "@/components/daimon/GlobalSearch";
import { HeaderExtensionSlot, OpenStackBadge } from "@/components/daimon/HeaderExtension";

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
  state: State;
  blocks: Block[];
  history: string[];
  historyTs: number[];
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
      <mark className="bg-signal/20 text-signal rounded-[2px] not-italic">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

// Detect if a program is actively prompting for user input (Y/n, password, etc.)
const INPUT_PROMPT_RE = /\?\s*$|\[y\/n\]\s*$|\(yes\/no\)\s*$|password[:\s]*$/i;
function isPromptingForInput(b: Block): boolean {
  const text = blockOutputText(b);
  const lastLine = text.trimEnd().split("\n").pop() ?? "";
  return INPUT_PROMPT_RE.test(lastLine);
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
      const lines: string[] = [`On branch ${o.branch}`];
      if (o.ahead) lines.push(`ahead ${o.ahead}`);
      if (o.behind) lines.push(`behind ${o.behind}`);
      if (o.staged.length) { lines.push("staged:"); o.staged.forEach(f => lines.push(`  ${f.xy} ${f.path}`)); }
      if (o.unstaged.length) { lines.push("not staged:"); o.unstaged.forEach(f => lines.push(`  ${f.xy} ${f.path}`)); }
      if (o.untracked.length) { lines.push("untracked:"); o.untracked.forEach(f => lines.push(`  ${f}`)); }
      return lines;
    }
    return [];
  }).join("\n");
}

function Daimon() {
  const [sessions, setSessions] = useState<Session[]>(() => [makeSession()]);
  const [activeId, setActiveId] = useState(() => sessions[0]!.id);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  // Per-session xterm handles (kept for potential future use) and TUI block tracking
  const xtermHandlesRef = useRef<Map<string, XTermHandle>>(new Map());
  // sessionId -> blockId for currently-active inline TUI blocks
  const [tuiBlockIds, setTuiBlockIds] = useState<Map<string, string>>(new Map());
  const [altScreenActive, setAltScreenActive] = useState(false);
  const [presentationMode, setPresentationMode] = useState(false);
  const togglePresentation = () => setPresentationMode((p) => {
    toast(!p ? "Presentation mode on — secrets redacted" : "Presentation mode off", { duration: 2500 });
    return !p;
  });
  const [theme, setTheme] = useState<Theme>("light");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [gitDirty, setGitDirty] = useState(false);
  const [gitAhead, setGitAhead] = useState(0);
  const [gitBehind, setGitBehind] = useState(0);
  const [osRegion, setOsRegion] = useState<string | null>(null);
  const [osProject, setOsProject] = useState<string | null>(null);
  const [osDomain, setOsDomain] = useState<string | null>(null);
  const [k8sContext, setK8sContext] = useState<string | null>(null);
  const [k8sNamespace, setK8sNamespace] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [ctxSwitcherOpen, setCtxSwitcherOpen] = useState(0);
  const [ctxSwitcherClose, setCtxSwitcherClose] = useState(0);
  const ctxSwitcherIsOpen = useRef(false);
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);
  const [blockModActive, setBlockModActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pagerActive, setPagerActive] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
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

  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => { localStorage.setItem("daimon-font-size", String(fontSize)); }, [fontSize]);

  // Load persisted data from DB on mount
  useEffect(() => {
    const sid = sessions[0]!.id;
    Promise.all([
      shell.historyList(2000),
      shell.blockList(sid, 500),
      shell.prefGet("theme"),
    ]).then(([histEntries, blockRows, savedTheme]) => {
      // History: sorted oldest-first for array index stability
      const sorted = [...histEntries].sort((a, b) => a.ts - b.ts);
      const history = sorted.map(e => e.cmd);
      const historyTs = sorted.map(e => e.ts);

      // Blocks: decode output_json back to Block shape
      const blocks: import("@/lib/daimon/shell").Block[] = blockRows.map(r => ({
        id: r.id,
        input: r.input,
        cwd: r.cwd.split("/").filter(Boolean),
        ctx: r.ctx,
        at: new Date(r.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        ms: 0,
        code: r.exit_code,
        out: (() => { try { return JSON.parse(r.output_json); } catch { return []; } })(),
        pending: false,
      }));

      setSessions(prev => prev.map((s, i) => i === 0 ? { ...s, history, historyTs, blocks } : s));

      if (savedTheme === "dracula" || savedTheme === "light") {
        setTheme(savedTheme as Theme);
      }
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

  // Track git branch from shell context updates
  useEffect(() => {
    const off = shell.onContext((_tabId, ctx) => {
      if (ctx.gitBranch !== undefined) setGitBranch(ctx.gitBranch || null);
      if (ctx.gitDirty !== undefined) setGitDirty(!!ctx.gitDirty);
      if (ctx.gitAhead !== undefined) setGitAhead(Number(ctx.gitAhead) || 0);
      if (ctx.gitBehind !== undefined) setGitBehind(Number(ctx.gitBehind) || 0);
      if (ctx.region !== undefined) setOsRegion(ctx.region || null);
      if (ctx.project !== undefined) setOsProject(ctx.project || null);
      if (ctx.domain !== undefined) setOsDomain(ctx.domain || null);
      if (ctx.k8sContext !== undefined) setK8sContext(ctx.k8sContext || null);
      if (ctx.k8sNamespace !== undefined) setK8sNamespace(ctx.k8sNamespace || null);
    });
    return () => { off(); };
  }, []);

  // Gaze → block id mapping
  const cycleTheme = () => {
    const next: Theme = theme === "light" ? "dracula" : "light";
    setTheme(next);
    shell.prefSet("theme", next).catch(() => {});
  };

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]!;
  const cmdDisabled = active.blocks.some((b) => b.pending && !STREAMING_INTERACTIVE_RE.test(b.input));
  const cmdPrompting = cmdDisabled && active.blocks.some((b) => b.pending && !STREAMING_INTERACTIVE_RE.test(b.input) && isPromptingForInput(b));
  const hideBottomBar = altScreenActive || tuiBlockIds.has(activeId) || pagerActive;
  const effectiveHoveredBlockId = pagerActive ? null : hoveredBlockId;
  const effectiveBlockModActive = pagerActive ? false : blockModActive;

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
    });
  };

  const isAtBottom = () => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
  };

  const updateSession = (id: string, patch: Partial<Session>) => {
    setSessions((prev) => prev.map((s) => s.id === id ? { ...s, ...patch } : s));
  };

  useEffect(() => {
    if (!atBottomRef.current) {
      toast("↓ New output", { id: "new-output", duration: Infinity });
      return;
    }
    scrollToBottom();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.blocks]);

  // PTY output is now consumed directly by BlockView's inline xterm subscription

  // Both alt-screen (vim/nano/ssh) and TUI-detected (hammer/fzf) render inline in the block.
  // No overlay — BlockView creates its own xterm when isTuiActive=true.
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
    xtermHandlesRef.current.delete(id);
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

  const focusComposer = () => window.dispatchEvent(new CustomEvent("focus-composer"));

  useEffect(() => { focusComposer(); }, [activeId]);

  useEffect(() => {
    window.addEventListener("focus", focusComposer);
    return () => window.removeEventListener("focus", focusComposer);
  }, []);

  useEffect(() => {
    const onOpen = () => setPagerActive(true);
    const onClose = () => setPagerActive(false);
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
        shell.blockClear(activeId).catch(() => {});
        updateSession(activeId, { blocks: [] });
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
      if (e.key === "w") {
        e.preventDefault();
        closeTab(activeId);
        return;
      }
      if (e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key) - 1;
        const target = sessions[idx];
        if (target) { e.preventDefault(); setActiveId(target.id); }
        return;
      }
      if (e.key === "c") {
        // Ctrl-C with pending command → SIGINT to PTY, abandon after 2s if stuck
        if (e.ctrlKey && !e.metaKey) {
          const sess = sessions.find((s) => s.id === activeId);
          if (sess?.blocks.some((b) => b.pending)) {
            e.preventDefault();
            sendRaw(activeId, "\x03");
            setTimeout(() => abandonRun(activeId), 2000);
            return;
          }
        }
        const sel = window.getSelection()?.toString() ?? "";
        if (!sel) return;
        navigator.clipboard.writeText(sel).catch(() => {});
        clip("Copied", sel);
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

  // Block hover shortcuts: ⌘⇧ (or ⌃⇧) + C/I/O/R
  const blockModRef = useRef(false);
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const mod = (e.metaKey || e.ctrlKey) && e.shiftKey;
      if (mod && !blockModRef.current) { blockModRef.current = true; if (!pagerActive) setBlockModActive(true); }
      if (!mod || !hoveredBlockId || pagerActive) return;
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
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) { blockModRef.current = false; setBlockModActive(false); }
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => { window.removeEventListener("keydown", onDown); window.removeEventListener("keyup", onUp); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredBlockId, active.blocks]);

  const handleScroll = () => {
    atBottomRef.current = isAtBottom();
    if (atBottomRef.current) toast.dismiss("new-output");
  };

  const submit = async (cmd: string) => {
    const sessionId = activeId;
    atBottomRef.current = true;

    // If a streaming-interactive session (ssh/mosh) is active, forward input to PTY directly.
    // Check module-level map — immune to React stale closure.
    if (isStreamingSession(sessionId)) {
      sendRaw(sessionId, cmd + "\n");
      return;
    }

    // Legacy stale-closure fallback (belt-and-suspenders)
    const pendingStreamBlock = active.blocks.find(
      (b) => b.pending && STREAMING_INTERACTIVE_RE.test(b.input)
    );
    if (pendingStreamBlock) {
      sendRaw(sessionId, cmd + "\n");
      return;
    }

    // Any pending command (e.g. Y/n prompt, password, script input) — forward as stdin
    if (active.blocks.some((b) => b.pending)) {
      // Control characters (e.g. \x03 SIGINT) go raw without newline
      const isCtrl = cmd.length === 1 && cmd.charCodeAt(0) < 32;
      sendRaw(sessionId, isCtrl ? cmd : cmd + "\n");
      if (isCtrl && cmd.charCodeAt(0) === 3) setTimeout(() => abandonRun(sessionId), 2000);
      return;
    }

    const isDup = active.history[active.history.length - 1] === cmd;
    const ts = Date.now();
    const newHistory = isDup ? active.history : [...active.history, cmd];
    const newHistoryTs = isDup ? active.historyTs : [...active.historyTs, ts];
    if (!isDup) shell.historyAdd(cmd, ts).catch(() => {});
    updateSession(sessionId, { history: newHistory, historyTs: newHistoryTs });
    const pendingId = Math.random().toString(36).slice(2);
    setSessions((prev) => prev.map((s) => s.id === sessionId ? {
      ...s,
      blocks: [...s.blocks, { id: pendingId, input: cmd, cwd: s.state.cwd, ctx: s.state.ctx.name, at: now(), ms: 0, code: 0, out: [], pending: true }],
    } : s));

    const runPromise = run(cmd, active.state, sessionId, (updated) => {
      setSessions((prev) => prev.map((s) => s.id === sessionId ? {
        ...s,
        blocks: s.blocks.map((x) => x.id === pendingId ? { ...updated, id: pendingId } : x),
      } : s));
    });
    window.dispatchEvent(new CustomEvent("focus-composer"));
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
          ts: Date.now(),
          exit_code: block.code ?? 0,
          output_json: JSON.stringify(block.out ?? []),
        }).catch(() => {});
      } else {
        shell.blockClear(sessionId).catch(() => {});
      }
      return { ...s, state: next, lastCmd: cmd, blocks: newBlocks };
    }));
    atBottomRef.current = true;
    scrollToBottom();
    setTimeout(() => window.dispatchEvent(new CustomEvent("focus-composer")), 1);
  };

  const pickCtx = (name: string) => submit(`u8s set --context ${name} && u8s sync`);

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
      shell.blockRecent(2000).then((rows) => {
        const matches = rows
          .filter((r) => r.input.toLowerCase().includes(q) || r.output_json.toLowerCase().includes(q))
          .slice(0, 30)
          .map((r) => {
            // Extract a short output snippet for display
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
        setGlobalSearchResults(matches);
        setGlobalSearchLoading(false);
      }).catch(() => setGlobalSearchLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [globalSearchQuery]);

  return (
    <PresentationModeContext.Provider value={presentationMode}>
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      <Toaster position="top-center" />

      {/* Sidebar */}
      <aside className={`shrink-0 flex-col border-r border-border bg-sidebar lg:flex transition-all duration-200 overflow-hidden ${sidebarOpen ? "w-56" : "w-0 border-r-0"}`}>
        {/* Wordmark */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <span className="font-mono text-[15px] font-semibold tracking-tight text-sidebar-foreground">daimon</span>
          <div className="flex items-center gap-1">
            <button
              onClick={cycleTheme}
              title={`Theme: ${theme} — click to cycle`}
              className="rounded-md p-1.5 text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              {THEME_ICONS[theme]}
            </button>
            <button
              onClick={newTab}
              className="rounded-md p-1.5 text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
              title="New session (⌘T)"
            >
              <PlusIcon className="size-3.5" />
            </button>
          </div>
        </div>

        {/* Sessions */}
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          <ul className="space-y-0.5">
            {sessions.map((s) => (
              <li key={s.id}>
                <div
                  onClick={() => { if (renamingId !== s.id) setActiveId(s.id); }}
                  onDoubleClick={() => {
                    setActiveId(s.id);
                    setRenamingId(s.id);
                    setTimeout(() => { renameRef.current?.select(); }, 0);
                  }}
                  className={`group/sess flex w-full items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors ${
                    s.id === activeId
                      ? "bg-sidebar-accent text-sidebar-foreground"
                      : "text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                  }`}
                >
                  <span className="shrink-0 flex items-center justify-center size-6 rounded bg-sidebar-foreground/10 font-mono text-[11px] text-sidebar-foreground/60">&gt;_</span>
                  {renamingId === s.id ? (
                    <input
                      ref={renameRef}
                      defaultValue={s.customName ?? s.lastCmd ?? ""}
                      placeholder={s.lastCmd ?? "name…"}
                      className="flex-1 min-w-0 bg-transparent font-mono text-[12px] text-sidebar-foreground outline-none"
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        setSessions((prev) => prev.map((x) => {
                          if (x.id !== s.id) return x;
                          if (v) return { ...x, customName: v };
                          const { customName: _, ...rest } = x;
                          return rest as Session;
                        }));
                        setRenamingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") { e.currentTarget.value = s.customName ?? s.lastCmd ?? ""; e.currentTarget.blur(); }
                        e.stopPropagation();
                      }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="font-mono text-[12px] truncate leading-tight">{sessionLabel(s)}</span>
                      <span className="font-mono text-[10px] truncate leading-tight opacity-50">{displayPath(s.state.cwd)}</span>
                    </div>
                  )}
                  {sessions.length > 1 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); closeTab(s.id); }}
                      className="rounded p-0.5 opacity-0 group-hover/sess:opacity-100 transition-opacity"
                    >
                      <XIcon className="size-2.5" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Footer keybinds */}
        <div className="border-t border-sidebar-border px-4 py-3">
          <dl className="space-y-1 font-mono text-[10px] text-sidebar-foreground/40">
            {[["⌘K", "clear"], ["⌘T", "session"], ["⌘F", "search"], ["⌘H", "history"], ["⌘⇧P", "present"], ["Tab", "complete"]].map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <dt>{v}</dt>
                <dd className="rounded bg-sidebar-accent px-1 py-0.5 leading-none">{k}</dd>
              </div>
            ))}
          </dl>
        </div>
      </aside>

      {/* Main */}
      <main className="relative flex min-w-0 flex-1 flex-col">
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
        {searchOpen && (
          <div className="absolute top-16 right-4 z-50 w-96 rounded-xl border border-border bg-card shadow-2xl">
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
        <header className={`sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/80 px-4 py-3 backdrop-blur-xl${pagerActive ? " hidden" : ""}`}>
          <button
            onClick={() => setSidebarOpen((o) => !o)}
            title="Toggle sidebar (⌘B)"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <PanelLeftIcon className="size-4" />
          </button>

          <HeaderExtensionSlot extensions={[<OpenStackBadge region={osRegion} project={osProject} domain={osDomain} />]} />

          {/* Kubernetes context widget — only when k8s context is set */}
          {k8sContext && (
            <div className="flex items-center gap-2.5 rounded-md border border-border/40 bg-card/60 px-2.5 py-1">
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

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden font-mono text-[11px] tabular-nums text-muted-foreground sm:inline">
              {active.blocks.length} {active.blocks.length === 1 ? "run" : "runs"}
            </span>
            <button
              onClick={togglePresentation}
              title={presentationMode ? "Presentation mode on (⌘⇧P)" : "Presentation mode off (⌘⇧P)"}
              className={`rounded-md p-1.5 transition-colors ${presentationMode ? "text-amber-400 bg-amber-400/10 hover:bg-amber-400/20" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
            >
              {presentationMode ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
            </button>
            <ContextSwitcher ctxName={active.state.ctx.name} onPick={pickCtx} forceOpen={ctxSwitcherOpen} forceClose={ctxSwitcherClose} onOpenChange={(o) => { ctxSwitcherIsOpen.current = o; }} />
          </div>
        </header>

        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-6 py-8" style={{ "--terminal-font-size": fontSize + "px" } as React.CSSProperties}>
          <div className="w-full">
            {active.blocks.length === 0 ? (
              <LandingPage
                blocks={active.blocks}
                onResume={() => {}}
                onCd={(path) => submit(`cd ${path}`)}
              />
            ) : (
              <div className="divide-y divide-border/50">
                {active.blocks.map((b, i) => (
                  <div
                    key={b.id}
                    ref={(el) => { if (el) blockRefsMap.current.set(b.id, el); else blockRefsMap.current.delete(b.id); }}
                    className={`relative py-7 rounded-lg transition-all duration-100 ${effectiveHoveredBlockId === b.id && effectiveBlockModActive ? "outline outline-2 outline-dashed outline-signal/50 outline-offset-4 bg-signal/[0.03]" : ""}`}
                    onMouseEnter={() => { if (!pagerActive) setHoveredBlockId(b.id); }}
                    onMouseLeave={() => setHoveredBlockId(null)}
                  >
                    <BlockView block={b} onRerun={submit} isLast={i === active.blocks.length - 1} currentCtx={active.state.ctx.name} sessionId={active.id} isTuiActive={tuiBlockIds.get(active.id) === b.id} promptingForInput={cmdPrompting && !!b.pending} />
                    {effectiveHoveredBlockId === b.id && effectiveBlockModActive && (
                      <div className="absolute top-2 right-2 flex items-center gap-1 rounded-md border border-signal/30 bg-card/90 px-2 py-1 backdrop-blur-sm shadow-sm">
                        {[["C","copy all"],["I","cmd"],["O","output"],["R","re-run"]].map(([k, label]) => (
                          <span key={k} className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                            <kbd className="rounded bg-signal/15 px-1 py-0.5 text-signal font-semibold">{k}</kbd>
                            <span>{label}</span>
                            {k !== "R" && <span className="text-border mx-0.5">·</span>}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div />
          </div>
        </div>

        <div className={`sticky bottom-0 border-t border-border bg-background/80 backdrop-blur-xl${hideBottomBar ? " hidden" : ""}`}>
          {historyOpen && (
            <HistoryPanel
              history={active.history}
              historyTs={active.historyTs}
              onSelect={(cmd) => { setHistoryOpen(false); submit(cmd); }}
              onClose={() => setHistoryOpen(false)}
            />
          )}
          <div className="px-6 py-3">
            <div className="w-full">
              <Composer
              cwd={active.state.cwd}
              ctx={active.state.ctx.name}
              history={active.history}
              historyTs={active.historyTs}
              onSubmit={submit}
              gitBranch={gitBranch}
              gitDirty={gitDirty}
              gitAhead={gitAhead}
              gitBehind={gitBehind}
              sessionId={active.id}
              disabled={cmdDisabled}
              streamingActive={active.blocks.some((b) => b.pending && STREAMING_INTERACTIVE_RE.test(b.input))}
              promptingForInput={cmdPrompting}
            />
            </div>
          </div>
        </div>
      </main>

      {/* per-session XTermPanels removed — all TUI now renders inline in BlockView */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onRun={submit}
        onCd={(path) => submit("cd " + path)}
        history={active.history}
        sessions={sessions.map((s) => ({ id: s.id, title: sessionLabel(s) }))}
        onSwitchSession={setActiveId}
      />
    </div>
    </PresentationModeContext.Provider>
  );
}
