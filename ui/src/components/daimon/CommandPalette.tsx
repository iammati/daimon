import { useEffect, useRef, useState, useCallback } from "react";
import {
  TabletSmartphoneIcon,
  ArrowUpDownIcon,
  XCircleIcon,
  SearchIcon,
  PlusSquareIcon,
  SplitSquareHorizontalIcon,
  PanelLeftIcon,
  CommandIcon,
  KeyboardIcon,
  SunMoonIcon,
  FolderOpenIcon,
  TerminalIcon,
  CheckCircleIcon,
  XIcon as XCircle2Icon,
  ServerIcon,
} from "lucide-react";
import { Keys } from "./Kbd";
import { shell } from "@/lib/daimon/rpc";
import { usePresence } from "@/lib/daimon/presence";

type Command = { id: string; label: string; description?: string; run: () => void };

type Props = {
  open: boolean;
  onClose: () => void;
  onRun: (cmd: string) => void;
  onCd: (path: string) => void;
  history: string[];
  sessions: { id: string; title: string }[];
  onSwitchSession: (id: string) => void;
  commands?: Command[];
};

const SHORTCUT_LIST = [
  { Icon: TabletSmartphoneIcon, label: "Complete",     key: "Tab"  },
  { Icon: ArrowUpDownIcon,      label: "History",      key: "↑ ↓" },
  { Icon: XCircleIcon,          label: "Clear",        key: "⌘K"  },
  { Icon: SearchIcon,           label: "Search",       key: "⌘F"  },
  { Icon: PlusSquareIcon,       label: "New session",  key: "⌘T"  },
  { Icon: SplitSquareHorizontalIcon, label: "Split pane", key: "⌘D" },
  { Icon: PanelLeftIcon,        label: "Sidebar",      key: "⌘B"  },
  { Icon: CommandIcon,          label: "Commands",     key: "⌘P"  },
];

const COMMAND_ICONS: Record<string, React.FC<{ className?: string }>> = {
  "theme":       SunMoonIcon,
  "new-session": PlusSquareIcon,
  "split":       SplitSquareHorizontalIcon,
  "search":      SearchIcon,
  "sidebar":     PanelLeftIcon,
  "keys":        KeyboardIcon,
  "ssh":         ServerIcon,
};

type BlockResult = { id: string; input: string; cwd: string; ts: number; exit_code: number };
type HistResult  = { id: number; cmd: string; ts: number; source: string };

function formatTs(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms > 9999999999 ? ms : ms * 1000);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function formatCwd(cwd: string): string {
  const home = typeof window !== "undefined" ? (window as any).__HOME__ ?? "" : "";
  if (home && cwd === home) return "~";
  if (home && cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

export function CommandPalette({ open, onClose, onRun, onCd, history, sessions, onSwitchSession, commands = [] }: Props) {
  const shown = usePresence(open);   // stays mounted while it animates out
  const [query, setQuery] = useState("");
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [blockResults, setBlockResults] = useState<BlockResult[]>([]);
  const [histResults, setHistResults] = useState<HistResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    setBlockResults([]);
    setHistResults([]);
    setTimeout(() => inputRef.current?.focus(), 0);
    shell.blockRecent(100).then((blocks) => {
      const seen = new Set<string>();
      const dirs: string[] = [];
      for (const b of blocks) {
        if (b.cwd && !seen.has(b.cwd)) { seen.add(b.cwd); dirs.push(b.cwd); }
      }
      setRecentDirs(dirs);
    }).catch(() => {});
  }, [open]);

  // FTS search on query change
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!query.trim()) { setBlockResults([]); setHistResults([]); return; }
    searchDebounce.current = setTimeout(() => {
      shell.blockSearch(query, 20).then((rows) =>
        setBlockResults(rows.map(r => ({ id: r.id, input: r.input, cwd: r.cwd, ts: r.ts, exit_code: r.exit_code })))
      ).catch(() => {});
      shell.historySearch(query, 50).then((rows) =>
        setHistResults(rows.filter(r => !/^history(\s|$)/.test(r.cmd)))
      ).catch(() => {});
    }, 120);
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); };
  }, [query]);

  if (!shown) return null;

  const q = query.toLowerCase();
  const filteredHistory = history
    .filter((c) => {
      if (q && !c.toLowerCase().includes(q)) return false;
      // Filter out meta history-search commands when their argument matches the query
      if (q && /^history(\s|$)/.test(c)) return false;
      return true;
    })
    .slice(-5)
    .reverse();
  const filteredDirs = recentDirs.filter((d) => !q || d.toLowerCase().includes(q)).slice(0, 5);
  const filteredSessions = sessions.filter((s) => !q || s.title.toLowerCase().includes(q));
  const filteredCommands = commands.filter((c) => !q || c.label.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q));

  // Deduplicate FTS block results against in-memory history
  const histResultCmds = new Set(filteredHistory.map(c => c.toLowerCase()));
  const filteredBlockResults = blockResults.filter(b => !histResultCmds.has(b.input.toLowerCase()));

  type Item =
    | { kind: "command"; value: Command }
    | { kind: "history"; value: string }
    | { kind: "dir"; value: string }
    | { kind: "session"; id: string; title: string }
    | { kind: "block"; value: BlockResult }
    | { kind: "histsearch"; value: HistResult };

  const items: Item[] = [
    ...filteredCommands.map((c) => ({ kind: "command" as const, value: c })),
    ...filteredHistory.map((c) => ({ kind: "history" as const, value: c })),
    ...(q ? filteredBlockResults.map((b) => ({ kind: "block" as const, value: b })) : []),
    ...(q ? histResults.filter(h => !histResultCmds.has(h.cmd.toLowerCase())).map(h => ({ kind: "histsearch" as const, value: h })) : []),
    ...filteredDirs.map((d) => ({ kind: "dir" as const, value: d })),
    ...filteredSessions.map((s) => ({ kind: "session" as const, id: s.id, title: s.title })),
  ];

  const select = (item: Item) => {
    if (item.kind === "command") item.value.run();
    else if (item.kind === "history") onRun(item.value);
    else if (item.kind === "block") onRun(item.value.input);
    else if (item.kind === "histsearch") onRun(item.value.cmd);
    else if (item.kind === "dir") onCd(item.value);
    else onSwitchSession(item.id);
    if (item.kind !== "command" || item.value.id !== "keys") onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === "Enter") { const item = items[cursor]; if (item) select(item); }
  };

  const SECTION_LABELS: Record<string, string> = {
    command: "Commands",
    history: "Recent",
    block: "Blocks",
    histsearch: "History",
    dir: "Dirs",
    session: "Sessions",
  };

  let prevKind = "";

  return (
    <div
      data-state={open ? "open" : "closed"}
      className="modal-backdrop fixed inset-0 z-50 flex items-start justify-center pt-[14vh] bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div data-state={open ? "open" : "closed"} className="modal-panel w-[700px] border border-border bg-card/90 glass shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
              onKeyDown={onKeyDown}
              placeholder="Search history, commands, blocks…"
              className="flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground/50"
              autoComplete="off"
              spellCheck={false}
            />
            <Keys combo="⌘P" size="xs" />
          </div>

          {items.length > 0 ? (
            <ul className="max-h-96 overflow-y-auto py-1">
              {items.map((item, i) => {
                const kind = item.kind;
                const showSection = kind !== prevKind;
                prevKind = kind;

                let label = "";
                let sub = "";
                let ts = 0;
                let exitCode = 0;
                if (item.kind === "session") { label = item.title; }
                else if (item.kind === "command") { label = item.value.label; sub = item.value.description ?? ""; }
                else if (item.kind === "history") { label = item.value; }
                else if (item.kind === "dir") { label = item.value; }
                else if (item.kind === "block") { label = item.value.input; sub = formatCwd(item.value.cwd); ts = item.value.ts; exitCode = item.value.exit_code; }
                else if (item.kind === "histsearch") { label = item.value.cmd; ts = item.value.ts; }

                return (
                  <li key={i}>
                    {showSection && (
                      <div className="px-4 pt-3 pb-1 font-sans text-[11px] font-medium tracking-widest text-muted-foreground/70 uppercase">
                        {SECTION_LABELS[kind]}
                      </div>
                    )}
                    <button
                      className={`w-full flex items-center gap-3 px-4 py-2 text-left font-sans text-[13px] transition-colors ${
                        i === cursor ? "bg-signal/10 text-foreground" : "text-foreground/90 hover:bg-accent"
                      }`}
                      onClick={() => select(item)}
                      onMouseEnter={() => setCursor(i)}
                    >
                      {(() => {
                        const CmdIcon = item.kind === "command" ? COMMAND_ICONS[item.value.id] : null;
                        if (CmdIcon) return <CmdIcon className="size-3.5 shrink-0 text-muted-foreground/60" />;
                        if (kind === "block") return exitCode !== 0
                          ? <XCircle2Icon className="size-3 shrink-0 text-alarm/70" />
                          : <CheckCircleIcon className="size-3 shrink-0 text-signal/50" />;
                        if (kind === "histsearch") return <TerminalIcon className="size-3 shrink-0 text-muted-foreground/50" />;
                        return (
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground/55 w-3.5 text-center">
                            {kind === "history" ? "$" : kind === "dir" ? "~" : kind === "session" ? "#" : ">"}
                          </span>
                        );
                      })()}
                      <span className="flex-1 min-w-0">
                        <span className="block truncate font-mono text-[13px]" title={label}>{label}</span>
                        {/* For long commands, show the tail so the distinguishing suffix is visible */}
                        {!sub && label.length > 80 && (
                          <span className="block truncate font-mono text-[11px] text-muted-foreground/45 direction-rtl text-left">…{label.slice(-60)}</span>
                        )}
                        {sub && <span className="block truncate font-mono text-[11px] text-muted-foreground/50">{sub}</span>}
                      </span>
                      {ts > 0 && (
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/40">{formatTs(ts)}</span>
                      )}
                      {item.kind === "command" && item.value.description && !sub && (
                        /^[⌘⌥⇧⌃^]/.test(item.value.description)
                          ? <Keys combo={item.value.description} size="xs" className="ml-auto" />
                          : <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/65">{item.value.description}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-4 py-4 font-mono text-[11px] text-muted-foreground/40">{query ? "No results" : "Type to search…"}</p>
          )}
        </div>
    </div>
  );
}
