import { useEffect, useRef } from "react";
import { SearchIcon, XIcon } from "lucide-react";

type Result = {
  input: string;
  cwd: string;
  ts: number;
  exit_code: number;
  output: string;
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

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
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

export function GlobalSearch({ open, query, onQueryChange, results, loading, onSelect, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[620px] rounded-xl border border-border bg-card shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground/50" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            placeholder="Search all blocks…"
            className="flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground/40"
            autoComplete="off"
            spellCheck={false}
          />
          {loading && (
            <span className="font-mono text-[11px] text-muted-foreground/50">…</span>
          )}
          {!loading && query && (
            <span className="font-mono text-[11px] text-muted-foreground/50">{results.length}</span>
          )}
          <button onClick={onClose}>
            <XIcon className="size-4 text-muted-foreground/50 hover:text-foreground" />
          </button>
        </div>

        {results.length > 0 ? (
          <ul className="max-h-96 overflow-y-auto py-1">
            {results.map((r, i) => (
              <li key={i}>
                <button
                  className="w-full flex items-start gap-3 px-4 py-2.5 text-left hover:bg-accent transition-colors"
                  onClick={() => { onSelect(r.input, r.cwd); onClose(); }}
                >
                  <span className={`shrink-0 mt-0.5 font-mono text-[10px] ${r.exit_code !== 0 ? "text-red-500" : "text-muted-foreground/30"}`}>
                    {r.exit_code !== 0 ? `✕${r.exit_code}` : "$"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[13px] text-foreground truncate">
                      {highlightMatch(r.input, query)}
                    </div>
                    <div className="font-mono text-[11px] text-muted-foreground/50 truncate">
                      {shortenPath(r.cwd)}
                    </div>
                    {r.output && (
                      <div className="font-mono text-[11px] text-muted-foreground/40 truncate mt-0.5">
                        {highlightMatch(r.output.slice(0, 120), query)}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground/40 whitespace-nowrap">
                    {timeAgo(r.ts)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : query && !loading ? (
          <p className="px-4 py-4 font-mono text-[12px] text-muted-foreground/50">No results</p>
        ) : null}
      </div>
    </div>
  );
}
