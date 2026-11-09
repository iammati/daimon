import { useRef, useState, useEffect, useCallback } from "react";
import { XIcon } from "lucide-react";

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function formatDaySeparator(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short",
  }).formatToParts(d);
  const hour = parts.find(p => p.type === "hour")?.value ?? "";
  const minute = parts.find(p => p.type === "minute")?.value ?? "";
  const second = parts.find(p => p.type === "second")?.value ?? "";
  const period = (parts.find(p => p.type === "dayPeriod")?.value ?? "").toUpperCase();
  const tz = parts.find(p => p.type === "timeZoneName")?.value ?? "";
  return `${hour}:${minute}:${second} ${period} ${tz}`;
}

const MIN_H = 120;
const DEFAULT_H = 320;
const MAX_H = 600;

export function HistoryPanel({
  history,
  historyTs,
  onSelect,
  onClose,
}: {
  history: string[];
  historyTs: number[];
  onSelect: (cmd: string) => void;
  onClose: () => void;
}) {
  const [height, setHeight] = useState(DEFAULT_H);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = height;
  }, [height]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      // dragging up increases height
      const delta = startY.current - e.clientY;
      setHeight(Math.min(MAX_H, Math.max(MIN_H, startH.current + delta)));
    };
    const onUp = () => { dragging.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // Build display rows (reverse chronological), insert day separators
  type Row =
    | { kind: "sep"; label: string; key: string }
    | { kind: "entry"; cmd: string; ts: number | undefined; idx: number };

  const rows: Row[] = [];
  let lastDay: string | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const ts = historyTs[i];
    if (ts !== undefined) {
      const dk = dayKey(ts);
      if (dk !== lastDay) {
        rows.push({ kind: "sep", label: formatDaySeparator(ts), key: dk });
        lastDay = dk;
      }
    }
    rows.push({ kind: "entry", cmd: history[i]!, ts, idx: i });
  }

  return (
    <div
      className="relative flex flex-col border-t border-border bg-background/95 backdrop-blur-xl"
      style={{ height }}
    >
      {/* Drag handle */}
      <div
        className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize group"
        onMouseDown={onMouseDown}
      >
        <div className="mx-auto mt-0.5 h-0.5 w-10 rounded-full bg-border group-hover:bg-muted-foreground/40 transition-colors" />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-3 pb-1 shrink-0">
        <span className="font-mono text-[11px] font-semibold tracking-widest text-muted-foreground/60 uppercase">History</span>
        <button onClick={onClose} className="rounded p-1 text-muted-foreground/40 hover:text-muted-foreground transition-colors">
          <XIcon className="size-3.5" />
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-6 pb-2">
        {rows.length === 0 && (
          <p className="py-4 font-mono text-[12px] text-muted-foreground/40">No history yet.</p>
        )}
        {rows.map((row) =>
          row.kind === "sep" ? (
            <div key={row.key} className="flex items-center gap-3 py-1.5">
              <div className="h-px flex-1 bg-border/60" />
              <span className="font-mono text-[10px] text-muted-foreground/40 shrink-0">{row.label}</span>
              <div className="h-px flex-1 bg-border/60" />
            </div>
          ) : (
            <button
              key={row.idx}
              className="flex w-full items-baseline justify-between gap-6 rounded-md px-2 py-1 text-left hover:bg-accent transition-colors group"
              onClick={() => onSelect(row.cmd)}
            >
              <span className="flex items-baseline gap-2 min-w-0">
                <span className="font-mono text-[12px] text-muted-foreground/40 shrink-0">›</span>
                <span className="font-mono text-[13px] text-foreground truncate">{row.cmd}</span>
              </span>
              {row.ts !== undefined ? (
                <span className="font-mono text-[11px] text-muted-foreground/40 shrink-0 group-hover:text-muted-foreground/60 transition-colors">
                  {formatTime(row.ts)}
                </span>
              ) : (
                <span className="font-mono text-[11px] text-muted-foreground/20 shrink-0">—</span>
              )}
            </button>
          )
        )}
      </div>

      {/* Footer hints */}
      <div className="flex items-center gap-4 border-t border-border px-6 py-1.5 font-mono text-[10px] text-muted-foreground/40 shrink-0">
        <span>↑ ↓ to navigate</span>
        <span>esc to dismiss</span>
      </div>
    </div>
  );
}
