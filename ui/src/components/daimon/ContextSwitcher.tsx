import { useEffect, useRef, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { shell } from "@/lib/daimon/rpc";

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

export function ContextSwitcher({ ctxName, onPick, forceOpen, forceClose, onOpenChange }: { ctxName: string; onPick: (name: string) => void; forceOpen?: number; forceClose?: number; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);

  const setOpenTracked = (next: boolean) => { setOpen(next); onOpenChange?.(next); };

  useEffect(() => {
    if (forceOpen) setOpenTracked(true);
  }, [forceOpen]);

  useEffect(() => {
    if (forceClose) setOpenTracked(false);
  }, [forceClose]);

  const [contexts, setContexts] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const load = async (sync = false) => {
    setSyncing(true);
    if (sync) await shell.syncContexts();
    const list = await shell.listContexts();
    setContexts(list);
    setSyncing(false);
    loadedRef.current = true;
  };

  useEffect(() => {
    if (open) {
      if (!loadedRef.current) load(false);
      setQ("");
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenTracked(false);
    };
    const click = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Element)) setOpenTracked(false);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", click);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", click);
    };
  }, []);

  const filtered = q ? contexts.filter((c) => c.toLowerCase().includes(q.toLowerCase())) : contexts;

  // Reset cursor when filter changes
  useEffect(() => { setCursor(0); }, [q]);

  // Scroll active item into view
  useEffect(() => {
    itemRefs.current[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "j") {
      e.preventDefault();
      e.stopPropagation();
      setOpenTracked(false);
      window.dispatchEvent(new CustomEvent("focus-composer"));
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = filtered[cursor];
      if (chosen) { onPick(chosen); setOpenTracked(false); }
    } else if (e.key === "Escape") {
      if (q) setQ(""); else setOpenTracked(false);
    }
    e.stopPropagation();
  };

  return (
    <div className="relative" ref={box}>
      <button
        onClick={() => setOpenTracked(!open)}
        className="flex items-center gap-2 rounded-full border border-border bg-card py-1.5 pl-3 pr-2.5 transition-colors hover:border-signal/50"
        aria-expanded={open}
      >
        <span className="size-1.5 rounded-full bg-signal" />
        <span className="font-mono text-[12px] text-foreground">{ctxName || "no context"}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+0.5rem)] z-20 w-72 overflow-hidden rounded-xl border border-border bg-card shadow-[0_24px_60px_-28px_oklch(0.2_0.02_265_/_0.45)]">
          <div className="flex items-center gap-2 border-b border-border px-3.5 py-2">
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search contexts…"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="flex-1 bg-transparent font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground/50"
              onKeyDown={handleInputKeyDown}
            />
            <button
              onClick={() => load(true)}
              disabled={syncing}
              title="Sync u8s contexts"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <RefreshCwIcon className={`size-3 ${syncing ? "animate-spin" : ""}`} />
            </button>
          </div>
          <ul ref={listRef} className="max-h-72 overflow-y-auto py-1">
            {contexts.length === 0 && !syncing && (
              <li className="px-3.5 py-2 font-mono text-[12px] text-muted-foreground">No contexts found</li>
            )}
            {syncing && contexts.length === 0 && (
              <li className="px-3.5 py-2 font-mono text-[12px] text-muted-foreground">Loading…</li>
            )}
            {filtered.length === 0 && contexts.length > 0 && (
              <li className="px-3.5 py-2 font-mono text-[12px] text-muted-foreground">No match</li>
            )}
            {filtered.map((c, i) => (
              <li key={c}>
                <button
                  ref={(el) => { itemRefs.current[i] = el; }}
                  onClick={() => { onPick(c); setOpenTracked(false); }}
                  onMouseMove={() => setCursor(i)}
                  className={`flex w-full items-center gap-3 px-3.5 py-2 text-left transition-colors ${i === cursor ? "bg-accent" : c === ctxName ? "bg-accent/50" : "hover:bg-accent/40"}`}
                >
                  <span className={`size-1.5 rounded-full shrink-0 ${c === ctxName ? "bg-signal" : "bg-muted-foreground/40"}`} />
                  <span className="font-mono text-[13px] text-foreground">{highlight(c, q)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
