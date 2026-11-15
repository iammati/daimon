import { useEffect, useRef, useState } from "react";
import { SearchIcon, XIcon, ArrowUpIcon, ArrowDownIcon, ChevronRightIcon } from "lucide-react";

// Splits e.g. "⇧↵" → ["⇧","↵"], "^H" → ["^","H"], "Tab" → ["Tab"]
function Keys({ combo }: { combo: string }) {
  const tokens = combo.match(/⌘|⌥|⇧|⌃|\^|Tab|Esc|Enter|↑|↓|←|→|↵|[A-Za-z0-9]|[^\s]/g) ?? [combo];
  return (
    <span className="inline-flex items-center gap-[2px]">
      {tokens.map((t, i) => (
        <kbd key={i} className="inline-flex items-center justify-center px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground/75 bg-muted border border-border/60 shadow-[0_1px_0_0_oklch(0_0_0/0.4)] leading-none min-w-[1.25rem]">
          {t}
        </kbd>
      ))}
    </span>
  );
}

type Result = {
  input: string;
  cwd: string;
  ts: number;
  exit_code: number;
  output: string;
};

type GroupedResult = {
  input: string;
  cwd: string;
  count: number;
  // most recent execution
  ts: number;
  exit_code: number;
  output: string;
  // all executions newest-first (for detail view)
  runs: Result[];
};

type Props = {
  open: boolean;
  query: string;
  onQueryChange: (q: string) => void;
  results: Result[];
  loading: boolean;
  onSelect: (cmd: string, cwd: string) => void;
  onClose: () => void;
};

type SortKey = "relevance" | "recent" | "oldest";
const SORTS: SortKey[] = ["relevance", "recent", "oldest"];

function timeAgo(ts: number): string {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fullDateTime(ts: number): string {
  if (!ts) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "long",
  }).format(new Date(ts));
}

function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-signal/30 text-foreground rounded-sm">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function groupResults(results: Result[]): GroupedResult[] {
  const map = new Map<string, GroupedResult>();
  for (const r of results) {
    const key = `${r.input}\0${r.cwd}`;
    const g = map.get(key);
    if (!g) {
      map.set(key, { input: r.input, cwd: r.cwd, count: 1, ts: r.ts, exit_code: r.exit_code, output: r.output, runs: [r] });
    } else {
      g.count++;
      g.runs.push(r);
      if (r.ts > g.ts) { g.ts = r.ts; g.exit_code = r.exit_code; g.output = r.output; }
    }
  }
  // sort runs within each group newest-first
  for (const g of map.values()) g.runs.sort((a, b) => b.ts - a.ts);
  return [...map.values()];
}

// ── Detail panel ─────────────────────────────────────────────────────────────

function DetailView({ group, query, onRun, onBack }: {
  group: GroupedResult;
  query: string;
  onRun: (cmd: string, cwd: string) => void;
  onBack: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => { ref.current?.focus(); }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "ArrowLeft") { e.preventDefault(); onBack(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(c => { const n = Math.min(c + 1, group.runs.length - 1); listRef.current?.children[n]?.scrollIntoView({ block: "nearest" }); return n; });
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(c => { const n = Math.max(c - 1, 0); listRef.current?.children[n]?.scrollIntoView({ block: "nearest" }); return n; });
      return;
    }
    if (e.key === "Enter") { onRun(group.input, group.runs[cursor]?.cwd ?? group.cwd); return; }
  };

  return (
    <div ref={ref} className="outline-none" tabIndex={0} onKeyDown={onKeyDown}>
      {/* Header */}
      <div className="flex items-start gap-2 px-4 py-2.5 border-b border-border bg-accent/30">
        <button onClick={onBack} className="shrink-0 text-muted-foreground/60 hover:text-foreground flex items-center gap-1 font-mono text-[12px] mt-0.5">
          ← back <kbd className="text-[10px] opacity-50">Esc</kbd>
        </button>
        <span className="font-mono text-[12px] text-muted-foreground/40 shrink-0 mt-0.5">·</span>
        <span className="font-mono text-[13px] text-foreground break-all flex-1">{highlightMatch(group.input, query)}</span>
        <span className="font-mono text-[12px] text-muted-foreground/50 shrink-0 mt-0.5">{group.count}×</span>
      </div>

      {/* Run list */}
      <ul ref={listRef} className="max-h-[32rem] overflow-y-auto py-1">
        {group.runs.map((r, i) => (
          <li key={i}>
            <button
              className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors ${
                i === cursor ? "bg-signal/10" : "hover:bg-accent"
              }`}
              onClick={() => onRun(group.input, r.cwd)}
              onMouseEnter={() => setCursor(i)}
            >
              <span className={`shrink-0 mt-0.5 font-mono text-[12px] w-8 ${r.exit_code !== 0 ? "text-alarm" : "text-signal/60"}`}>
                {r.exit_code !== 0 ? `✕${r.exit_code}` : "✓0"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[13px] text-foreground">{fullDateTime(r.ts)}</div>
                {r.cwd && (
                  <div className="font-mono text-[12px] text-muted-foreground/60">{shortenPath(r.cwd)}</div>
                )}
                {r.output && (
                  <div className="font-mono text-[12px] text-muted-foreground/50 break-all mt-0.5 whitespace-pre-wrap">
                    {r.output}
                  </div>
                )}
              </div>
              <span className="shrink-0 font-mono text-[12px] text-muted-foreground/50">{timeAgo(r.ts)}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="flex gap-4 border-t border-border px-4 py-2">
        {([["↑↓", "navigate"], ["↵", "run from here"], ["Esc", "back"]] as [string,string][]).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground/50"><Keys combo={k} /> {v}</span>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function GlobalSearch({ open, query, onQueryChange, results, loading, onSelect, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [showHistory, setShowHistory] = useState(true);
  const [sort, setSort] = useState<SortKey>("relevance");
  const [cursor, setCursor] = useState(0);
  const [detail, setDetail] = useState<GroupedResult | null>(null);

  useEffect(() => {
    if (open) { setTimeout(() => inputRef.current?.focus(), 0); setCursor(0); setDetail(null); }
  }, [open]);

  useEffect(() => { setCursor(0); setDetail(null); }, [results, showHistory, sort]);

  if (!open) return null;

  const visible = results.filter(r => showHistory || r.cwd !== "");
  const grouped = groupResults(visible);

  const sorted = [...grouped].sort((a, b) => {
    if (sort === "recent") return b.ts - a.ts;
    if (sort === "oldest") return a.ts - b.ts;
    const q = query.toLowerCase();
    const aS = a.input.toLowerCase().startsWith(q) ? 0 : 1;
    const bS = b.input.toLowerCase().startsWith(q) ? 0 : 1;
    if (aS !== bS) return aS - bS;
    return b.ts - a.ts;
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { if (detail) { setDetail(null); } else { onClose(); } return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(c => { const n = Math.min(c + 1, sorted.length - 1); listRef.current?.children[n]?.scrollIntoView({ block: "nearest" }); return n; });
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(c => { const n = Math.max(c - 1, 0); listRef.current?.children[n]?.scrollIntoView({ block: "nearest" }); return n; });
      return;
    }
    if (e.key === "Enter") {
      const g = sorted[cursor];
      if (!g) return;
      if (e.shiftKey) {
        // Shift+Enter: run immediately
        onSelect(g.input, g.cwd); onClose();
      } else {
        // Enter: open detail view
        setDetail(g);
      }
      return;
    }
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setSort(s => { const i = SORTS.indexOf(s); return e.shiftKey ? SORTS[(i - 1 + SORTS.length) % SORTS.length]! : SORTS[(i + 1) % SORTS.length]!; });
      return;
    }
    if (e.key === "h" && e.ctrlKey) { e.preventDefault(); setShowHistory(v => !v); }
  };

  if (detail) {
    return (
      <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/50 backdrop-blur-sm" onClick={onClose}>
        <div className="w-[680px] border border-border bg-card shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()} data-detail tabIndex={-1}>
          <DetailView
            group={detail}
            query={query}
            onRun={(cmd, cwd) => { onSelect(cmd, cwd); onClose(); }}
            onBack={() => { setDetail(null); setTimeout(() => inputRef.current?.focus(), 0); }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[680px] border border-border bg-card shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>

        {/* Search bar */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground/50" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search blocks & history…"
            className="flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground/40"
            autoComplete="off"
            spellCheck={false}
          />
          {loading && <span className="font-mono text-[12px] text-muted-foreground/50">…</span>}
          {!loading && query && <span className="font-mono text-[12px] text-muted-foreground/50">{sorted.length}</span>}
          <button onClick={onClose}><XIcon className="size-4 text-muted-foreground/50 hover:text-foreground" /></button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
          <span className="font-mono text-[12px] text-muted-foreground/35 mr-1">Sort:</span>
          {SORTS.map(k => (
            <button key={k} onClick={() => setSort(k)}
              className={`flex items-center gap-1 font-mono text-[12px] px-2 py-0.5 rounded transition-colors ${sort === k ? "bg-signal/20 text-signal" : "text-muted-foreground/50 hover:text-foreground"}`}>
              {k === "recent" && <ArrowDownIcon className="size-3" />}
              {k === "oldest" && <ArrowUpIcon className="size-3" />}
              {k.charAt(0).toUpperCase() + k.slice(1)}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <span className="flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground/50">History <Keys combo="^H" /></span>
            <button role="switch" aria-checked={showHistory} onClick={() => setShowHistory(v => !v)}
              className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${showHistory ? "bg-signal" : "bg-muted-foreground/25"}`}>
              <span className={`pointer-events-none inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${showHistory ? "translate-x-3" : "translate-x-0"}`} />
            </button>
          </div>
        </div>

        {sorted.length > 0 ? (
          <ul ref={listRef} className="max-h-[28rem] overflow-y-auto py-1">
            {sorted.map((g, i) => (
              <li key={i}>
                <button
                  className={`w-full flex items-start gap-3 px-4 py-2.5 text-left transition-colors ${i === cursor ? "bg-signal/10 text-foreground" : "hover:bg-accent"}`}
                  onClick={() => { setDetail(g); }}
                  onMouseEnter={() => setCursor(i)}
                >
                  <span className={`shrink-0 mt-0.5 font-mono text-[10px] ${g.exit_code !== 0 ? "text-alarm" : "text-muted-foreground/30"}`}>
                    {g.exit_code !== 0 ? `✕${g.exit_code}` : "$"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[13px] text-foreground truncate">
                      {highlightMatch(g.input, query)}
                    </div>
                    {g.cwd && <div className="font-mono text-[11px] text-muted-foreground/50 truncate">{shortenPath(g.cwd)}</div>}
                    {g.output && <div className="font-mono text-[11px] text-muted-foreground/40 truncate mt-0.5">{highlightMatch(g.output.slice(0, 120), query)}</div>}
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    {g.count > 1 && (
                      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted-foreground/15 text-muted-foreground/60">{g.count}×</span>
                    )}
                    <span className="font-mono text-[11px] text-muted-foreground/40 whitespace-nowrap">{timeAgo(g.ts)}</span>
                    <ChevronRightIcon className="size-3 text-muted-foreground/20" />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : query && !loading ? (
          <p className="px-4 py-4 font-mono text-[12px] text-muted-foreground/50">No results</p>
        ) : null}

        <div className="flex flex-wrap gap-3 border-t border-border px-4 py-2">
          {([["↑↓", "navigate"], ["↵", "details"], ["⇧↵", "run now"], ["Tab", "sort"], ["^H", "history"], ["Esc", "close"]] as [string,string][]).map(([k, v]) => (
            <span key={k} className="flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground/50"><Keys combo={k} /> {v}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
