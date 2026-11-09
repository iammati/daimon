import { useEffect, useRef, useState } from "react";
import { FolderIcon, FileIcon, GitBranchIcon, ClockIcon } from "lucide-react";
import { applySuggestion, completeNative, type Suggestion } from "@/lib/daimon/complete";
import { displayPath } from "@/lib/daimon/world";
import { sendRaw, onAltScreenChange, getAltScreen } from "@/lib/daimon/shell";
import { shell } from "@/lib/daimon/rpc";

function formatTs(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "yesterday";
  const diffDays = Math.floor((now.getTime() - ts) / 86400000);
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function Composer({
  cwd,
  ctx,
  history,
  historyTs = [],
  onSubmit,
  gitBranch,
  gitDirty,
  gitAhead,
  gitBehind,
  sessionId = "",
  disabled = false,
  streamingActive: _streamingActive = false,
  promptingForInput = false,
}: {
  cwd: string[];
  ctx: string;
  history: string[];
  historyTs?: number[];
  onSubmit: (cmd: string) => void;
  gitBranch?: string | null;
  gitDirty?: boolean;
  gitAhead?: number;
  gitBehind?: number;
  sessionId?: string;
  disabled?: boolean;
  streamingActive?: boolean;
  promptingForInput?: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef("");
  const [value, setValue] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const dismissed = useRef(false);
  const justAccepted = useRef(false);
  const histNavPrefix = useRef<string | null>(null); // frozen prefix for history navigation
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [token, setToken] = useState("");
  const completeDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completePromise = useRef<Promise<{ items: Suggestion[]; token: string }> | null>(null);

  const setInputValue = (v: string) => {
    valueRef.current = v;
    setValue(v);
    if (inputRef.current) {
      inputRef.current.value = v;
      const end = v.length;
      inputRef.current.setSelectionRange(end, end);
      autoResize();
    }
  };

  const autoResize = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };

  useEffect(() => {
    setItems([]);
    setToken("");
    if (!justAccepted.current) dismissed.current = false;
    justAccepted.current = false;
    if (completeDebounce.current) clearTimeout(completeDebounce.current);
    if (!value.trim()) { completePromise.current = null; return; }
    const cwdStr = "/" + cwd.join("/");
    const p = completeNative(value, cwdStr, history, historyTs);
    completePromise.current = p;
    completeDebounce.current = setTimeout(async () => {
      const result = await p;
      if (completePromise.current === p) { setItems(result.items); setToken(result.token); }
    }, 60);
    return () => { if (completeDebounce.current) clearTimeout(completeDebounce.current); };
  }, [value, cwd, history]);

  const visible = open && items.length >= 2;
  const top = items[Math.min(active, items.length - 1)];
  // Inline ghost: top token-replacing suggestion whose value extends the typed token.
  const specGhost = top && top.replace === "token" && top.kind !== "file" && top.kind !== "dir" && token && top.value.toLowerCase().startsWith(token.toLowerCase())
    ? top.value.slice(token.length)
    : "";

  // History ghost: most-recent match for the full input — only when no spec/flag completions available
  const hasNativeItems = items.some(i => i.kind !== "history");
  const historyGhost = !specGhost && !hasNativeItems && value.trim().length > 0
    ? (() => {
        const lower = value.toLowerCase();
        for (let i = history.length - 1; i >= 0; i--) {
          const h = history[i]!;
          if (h.toLowerCase().startsWith(lower) && h.length > value.length) return h.slice(value.length);
        }
        return "";
      })()
    : "";

  const ghost = specGhost || historyGhost;

  useEffect(() => {
    setActive(0);
    if (items.length === 0) { setOpen(false); }
    // Auto-open only for non-filesystem completions (flags, subcommands, commands)
    else if (!dismissed.current && items.length >= 2 && items.every(i => i.kind !== "file" && i.kind !== "dir")) setOpen(true);
  }, [items]);

  const [interactive, setInteractive] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchQ, setBranchQ] = useState("");

  useEffect(() => {
    setInteractive(getAltScreen(sessionId));
    return onAltScreenChange(sessionId, setInteractive);
  }, [sessionId]);
  useEffect(() => { if (interactive) inputRef.current?.blur(); }, [interactive]);

  useEffect(() => {
    const focus = (e: KeyboardEvent) => {
      if (e.key === "/" && !interactive && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    const focusFromEvent = () => { if (!interactive) inputRef.current?.focus(); };
    window.addEventListener("keydown", focus);
    window.addEventListener("focus-composer", focusFromEvent);
    return () => {
      window.removeEventListener("keydown", focus);
      window.removeEventListener("focus-composer", focusFromEvent);
    };
  }, [interactive]);

  const accept = (i = active): string => {
    const s = items[i];
    if (!s) return valueRef.current;
    const next = applySuggestion(valueRef.current, token, s.value, s);
    const trailing = (s.kind === "file" || s.kind === "dir") && s.value.endsWith("/") ? next : next + " ";
    const final = s.replace === "all" ? next + " " : trailing;
    // Suppress the re-completion that fires immediately after Tab acceptance
    dismissed.current = true;
    justAccepted.current = true;
    setInputValue(final);
    setOpen(false);
    return final;
  };

  const acceptGhost = async () => {
    // If dropdown visible, Tab accepts highlighted item
    if (visible) { accept(); return; }
    // If no items yet but completion in-flight, wait for it
    let current = items;
    if (current.length === 0 && completePromise.current) {
      const result = await completePromise.current;
      if (result) { current = result.items; setItems(result.items); setToken(result.token); }
    }
    if (current.length === 1 || (current.length > 0 && specGhost)) { accept(); return; }
    if (current.length > 1) { dismissed.current = false; setOpen(true); return; }
    if (historyGhost) { setInputValue(value + historyGhost); setOpen(false); return; }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (interactive) return;
    // disabled = command running (stdin mode) — allow input but skip completions/history
    if (disabled) {
      if (e.ctrlKey && e.key === "c") {
        e.preventDefault();
        onSubmit("\x03");
        setInputValue("");
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const val = inputRef.current?.value ?? "";
        onSubmit(val);
        setInputValue("");
      }
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      acceptGhost();
      return;
    }

    if (e.key === "ArrowRight") {
      // Accept ghost only when cursor is at end of input
      const el = inputRef.current;
      if (ghost && el && el.selectionStart === value.length && el.selectionEnd === value.length) {
        e.preventDefault();
        acceptGhost();
        return;
      }
    }

    if (e.key === "Escape") {
      dismissed.current = true;
      setOpen(false);
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key === "a") {
      e.stopPropagation();
      inputRef.current?.select();
      return;
    }

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const dir = e.key === "ArrowDown" ? 1 : -1;
      if (visible) {
        e.preventDefault();
        setActive((a) => (a + dir + items.length) % items.length);
        return;
      }
      if (history.length) {
        e.preventDefault();
        // Freeze the prefix when navigation starts; reuse it on subsequent arrow presses
        if (histIndex === null) histNavPrefix.current = valueRef.current;
        const prefix = histNavPrefix.current ?? "";
        const filtered = prefix.trim()
          ? history.filter((h) => h.toLowerCase().startsWith(prefix.toLowerCase()) && h !== prefix)
          : history;
        if (!filtered.length) return;
        const i =
          histIndex === null
            ? dir === -1 ? filtered.length - 1 : null
            : Math.min(filtered.length, Math.max(0, histIndex + dir));
        if (i === null || i >= filtered.length) {
          setHistIndex(null);
          histNavPrefix.current = null;
          if (!prefix.trim()) setInputValue("");
          else setInputValue(prefix);
        } else {
          setHistIndex(i);
          setInputValue(filtered[i] ?? "");
        }
      }
      return;
    }

    if (e.key === "Enter") {
      // Shift+Enter = newline in textarea
      if (e.shiftKey) return;
      if (visible) {
        e.preventDefault();
        const final = accept();
        const cmd = final.trim();
        if (cmd) { onSubmit(cmd); setInputValue(""); setHistIndex(null); }
        return;
      }
      e.preventDefault();
      const cmd = (inputRef.current?.value ?? "").trim();
      if (!cmd) return;
      onSubmit(cmd);
      setInputValue("");
      setHistIndex(null);
      setOpen(false);
    }
  };

  if (interactive) return null;

  return (
    <div className="relative">
      {visible && (
        <div className="absolute bottom-[calc(100%+0.5rem)] left-0 w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-[0_18px_50px_-24px_oklch(0.2_0.02_265_/_0.35)]">
          <ul className="max-h-64 overflow-y-auto py-1">
            {items.map((s, i) => (
              <li key={`${s.kind}:${s.value}:${i}`}>
                <button
                  onMouseDown={(e) => { e.preventDefault(); accept(i); }}
                  onMouseEnter={() => setActive(i)}
                  className={`flex w-full items-baseline justify-between gap-6 px-3.5 py-1.5 text-left ${i === active ? "bg-accent" : ""}`}
                >
                  <span className="truncate font-mono text-[13px] text-foreground">{s.label}</span>
                  {s.kind === "file"
                    ? <FileIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
                    : s.kind === "dir"
                    ? <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
                    : s.kind === "history"
                    ? <span className="flex items-center gap-1 shrink-0 text-[10px] text-muted-foreground/50"><ClockIcon className="size-3 shrink-0" />{s.ts ? formatTs(s.ts) : ""}</span>
                    : <span className="truncate font-sans text-[11px] text-muted-foreground">{s.hint}</span>
                  }
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3 border-t border-border px-3.5 py-1.5 font-mono text-[10px] text-muted-foreground">
            <span>tab accept</span>
            <span>↑↓ move</span>
            <span>esc dismiss</span>
          </div>
        </div>
      )}

      {/* Borderless full-area composer */}
        <div
        className="flex items-start gap-3 px-1 py-2"
        onClick={() => { if (!interactive) inputRef.current?.focus(); }}
      >
        {interactive
          ? <span className="flex items-center gap-1.5 font-mono text-[11px] text-signal pt-0.5">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-signal" />
              interactive — keys forwarded to terminal
            </span>
          : <span className="font-mono text-[13px] text-muted-foreground/60 pt-0.5 shrink-0 select-none">{displayPath(cwd)}</span>
        }
        {/* Branch pill — left of ›, clickable to switch branches */}
        {gitBranch && !interactive && !disabled && (
          <div className="relative shrink-0">
            <button
              className="flex items-center gap-1 pt-0.5 font-mono text-[11px] text-purple-400/80 hover:text-purple-400 transition-colors select-none"
              onClick={(e) => {
                e.stopPropagation();
                if (!branchOpen) {
                  const cwdStr = "/" + cwd.join("/");
                  shell.listBranches(cwdStr).then(({ branches }) => { if (branches.length) setBranches(branches); }).catch(() => {});
                }
                setBranchOpen((o) => !o);
                setBranchQ("");
              }}
              title="Switch branch"
            >
              <GitBranchIcon className="size-3" />
              <span className="max-w-[140px] truncate">{gitBranch}</span>
              {gitDirty && <span className="text-amber-400/70">●</span>}
              {(gitAhead ?? 0) > 0 && <span className="text-purple-400/50">↑{gitAhead}</span>}
              {(gitBehind ?? 0) > 0 && <span className="text-purple-400/50">↓{gitBehind}</span>}
            </button>
            {branchOpen && (
              <div className="absolute bottom-[calc(100%+0.5rem)] left-0 z-30 w-64 overflow-hidden rounded-xl border border-border bg-card shadow-[0_18px_50px_-24px_oklch(0.2_0.02_265_/_0.35)]">
                <div className="border-b border-border px-3 py-2">
                  <input
                    autoFocus
                    value={branchQ}
                    onChange={(e) => setBranchQ(e.target.value)}
                    placeholder="Filter branches…"
                    autoComplete="off" autoCorrect="off" spellCheck={false}
                    className="w-full bg-transparent font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground/50"
                    onKeyDown={(e) => { if (e.key === "Escape") setBranchOpen(false); e.stopPropagation(); }}
                  />
                </div>
                <ul className="max-h-56 overflow-y-auto py-1">
                  {(branchQ ? branches.filter((b) => b.toLowerCase().includes(branchQ.toLowerCase())) : branches).map((b) => (
                    <li key={b}>
                      <button
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent transition-colors font-mono text-[12px] ${b === gitBranch ? "text-signal" : "text-foreground"}`}
                        onClick={() => { setBranchOpen(false); onSubmit(`git checkout ${b}`); }}
                      >
                        <GitBranchIcon className={`size-3 shrink-0 ${b === gitBranch ? "text-signal" : "text-muted-foreground/40"}`} />
                        <span className="truncate">{b}</span>
                        {b === gitBranch && <span className="ml-auto text-[10px] text-signal">current</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <span className="font-mono text-[13px] text-signal pt-0.5 shrink-0 select-none">›</span>
        <div className="relative flex-1 min-w-0">
          {disabled && !promptingForInput
            ? <span className="font-mono text-[13px] text-muted-foreground/40 pt-0.5 select-none animate-pulse">running…</span>
            : (<>
          {ghost && (
            <div className="pointer-events-none absolute top-0 left-0 right-0 font-mono text-[14px] leading-6 whitespace-pre-wrap break-words">
              <span className="invisible">{value}</span>
              <span className="text-muted-foreground/45">{ghost}</span>
            </div>
          )}
          <textarea
            ref={inputRef}
            rows={1}
            defaultValue=""
            onChange={(e) => {
              valueRef.current = e.target.value;
              setValue(e.target.value);
              setHistIndex(null);
              histNavPrefix.current = null;
              autoResize();
            }}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              if (disabled) {
                e.preventDefault();
                const text = e.clipboardData.getData("text");
                onSubmit("\x1b[200~" + text + "\x1b[201~");
              }
            }}
            onBlur={() => setOpen(false)}
            disabled={interactive}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            aria-label={`Command in ${ctx}`}
            // placeholder={"Type a command, or press Tab to see everything"}
            className="relative w-full resize-none overflow-hidden bg-transparent font-mono text-[14px] leading-6 text-foreground [caret-color:var(--color-foreground)] outline-none placeholder:text-muted-foreground/40"
            style={{ height: "1.5rem" }}
          />
          </>)}
        </div>
      </div>
    </div>
  );
}
