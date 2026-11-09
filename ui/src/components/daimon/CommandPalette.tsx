import { useEffect, useRef, useState } from "react";
import { shell } from "@/lib/daimon/rpc";

type Props = {
  open: boolean;
  onClose: () => void;
  onRun: (cmd: string) => void;
  onCd: (path: string) => void;
  history: string[];
  sessions: { id: string; title: string }[];
  onSwitchSession: (id: string) => void;
};

export function CommandPalette({ open, onClose, onRun, onCd, history, sessions, onSwitchSession }: Props) {
  const [query, setQuery] = useState("");
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
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

  if (!open) return null;

  const q = query.toLowerCase();
  const filteredHistory = history
    .filter((c) => !q || c.toLowerCase().includes(q))
    .slice(-5)
    .reverse();
  const filteredDirs = recentDirs
    .filter((d) => !q || d.toLowerCase().includes(q))
    .slice(0, 5);
  const filteredSessions = sessions
    .filter((s) => !q || s.title.toLowerCase().includes(q));

  type Item =
    | { kind: "history"; value: string }
    | { kind: "dir"; value: string }
    | { kind: "session"; id: string; title: string };

  const items: Item[] = [
    ...filteredHistory.map((c) => ({ kind: "history" as const, value: c })),
    ...filteredDirs.map((d) => ({ kind: "dir" as const, value: d })),
    ...filteredSessions.map((s) => ({ kind: "session" as const, id: s.id, title: s.title })),
  ];

  const select = (item: Item) => {
    if (item.kind === "history") onRun(item.value);
    else if (item.kind === "dir") onCd(item.value);
    else onSwitchSession(item.id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === "Enter") { const item = items[cursor]; if (item) select(item); }
  };

  const sectionLabel = (kind: string) =>
    kind === "history" ? "History" : kind === "dir" ? "Recent Dirs" : "Sessions";

  let prevKind = "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[560px] rounded-xl border border-border bg-card shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="font-mono text-xs text-muted-foreground">⌘P</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
            onKeyDown={onKeyDown}
            placeholder="Search history, dirs, sessions…"
            className="flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground/40"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {items.length > 0 ? (
          <ul className="max-h-80 overflow-y-auto py-1">
            {items.map((item, i) => {
              const kind = item.kind;
              const showSection = kind !== prevKind;
              prevKind = kind;
              const label = item.kind === "session" ? item.title : item.value;
              return (
                <li key={i}>
                  {showSection && (
                    <div className="px-4 pt-2 pb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">
                      {sectionLabel(kind)}
                    </div>
                  )}
                  <button
                    className={`w-full flex items-center gap-3 px-4 py-2 text-left font-mono text-[13px] transition-colors ${i === cursor ? "bg-signal/10 text-foreground" : "text-foreground/80 hover:bg-accent"}`}
                    onClick={() => select(item)}
                    onMouseEnter={() => setCursor(i)}
                  >
                    <span className="shrink-0 text-[10px] text-muted-foreground/50 w-4">
                      {kind === "history" ? "$" : kind === "dir" ? "~" : "#"}
                    </span>
                    <span className="truncate">{label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-4 py-4 font-mono text-[12px] text-muted-foreground/50">No results</p>
        )}
      </div>
    </div>
  );
}
