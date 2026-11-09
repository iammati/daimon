import React, { useEffect, useRef, useState, useContext, createContext, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { LoaderCircleIcon, XCircleIcon, ChevronDownIcon, GitBranchIcon, ChevronRightIcon, PlusIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { displayPath } from "@/lib/daimon/world";
import { shell } from "@/lib/daimon/rpc";
import { sendRaw, resizePty, getTuiReplayBuffer, getAltScreen, STREAMING_INTERACTIVE_RE, abandonRun } from "@/lib/daimon/shell";
import type { Block, Out, LsEntry } from "@/lib/daimon/shell";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import hljs from "highlight.js/lib/core";
import hljsBash from "highlight.js/lib/languages/bash";
import hljsJson from "highlight.js/lib/languages/json";
import hljsYaml from "highlight.js/lib/languages/yaml";
import hljsTs from "highlight.js/lib/languages/typescript";
import hljsJs from "highlight.js/lib/languages/javascript";
import hljsPython from "highlight.js/lib/languages/python";
import hljsRust from "highlight.js/lib/languages/rust";
import hljsGo from "highlight.js/lib/languages/go";
import hljsHtml from "highlight.js/lib/languages/xml";
import hljsCss from "highlight.js/lib/languages/css";
import hljsToml from "highlight.js/lib/languages/ini";


hljs.registerLanguage("bash", hljsBash);
hljs.registerLanguage("shell", hljsBash);
hljs.registerLanguage("json", hljsJson);
hljs.registerLanguage("yaml", hljsYaml);
hljs.registerLanguage("typescript", hljsTs);
hljs.registerLanguage("javascript", hljsJs);
hljs.registerLanguage("python", hljsPython);
hljs.registerLanguage("rust", hljsRust);
hljs.registerLanguage("go", hljsGo);
hljs.registerLanguage("html", hljsHtml);
hljs.registerLanguage("css", hljsCss);
hljs.registerLanguage("toml", hljsToml);

export const PresentationModeContext = createContext(false);

// Patterns that look like secrets: API keys, tokens, passwords, JWTs, private keys
const SECRET_RE = /(?:ghp_|gho_|github_pat_|xoxb-|xoxp-|sk-[a-zA-Z0-9]{20,}|pk-live_|pk-test_|AKIA)[A-Za-z0-9_\-]{8,}|eyJ[A-Za-z0-9_\-]{20,}\.eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}|(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|API_KEY|ACCESS_KEY|PRIVATE_KEY))\s*[=:]\s*\S+|(?:password|passwd|secret|token|api[_-]?key|auth[_-]?key|access[_-]?key|private[_-]?key)\s*[=:]\s*\S+/gi;

function redact(text: string): string {
  return text.replace(SECRET_RE, "[redacted by daimon]");
}

function redactNode(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  const re = new RegExp(SECRET_RE.source, "gi");
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <mark key={key++} className="bg-amber-400/25 text-amber-300 rounded-[3px] px-0.5 not-italic">[redacted by daimon]</mark>
    );
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const EXT_LANG: Record<string, string> = {
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rs: "rust", go: "go",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  html: "html", htm: "html", css: "css", scss: "css",
  md: "markdown", dockerfile: "bash",
};

function detectLang(input: string, text: string): string | null {
  // From command: cat/bat/less/head/tail/vim + filename
  const fileM = input.trim().match(/(?:cat|bat|less|head|tail|vim?|nano|code)\s+(?:.*\/)?([^/\s]+)$/i);
  if (fileM) {
    const name = fileM[1]!.toLowerCase();
    const ext = name.includes(".") ? name.split(".").pop()! : name;
    if (EXT_LANG[ext]) return EXT_LANG[ext];
    if (EXT_LANG[name]) return EXT_LANG[name]; // e.g. "dockerfile"
  }
  // From content: shebang
  if (text.startsWith("#!/bin/sh") || text.startsWith("#!/bin/bash") || text.startsWith("#!/usr/bin/env bash")) return "bash";
  if (text.startsWith("#!/usr/bin/env python") || text.startsWith("#!/usr/bin/python")) return "python";
  // JSON heuristic
  const trimmed = text.trimStart();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 10) {
    try { JSON.parse(text); return "json"; } catch { /* not json */ }
  }
  // YAML heuristic: multiple "key: value" lines, no leading dashes (flags), no prose sentences
  if (!trimmed.includes("{") && /^[a-zA-Z_][a-zA-Z0-9_-]*:\s+\S/m.test(text) &&
      text.split("\n").length > 2 && !/^--/.test(trimmed) && !/\s{2,}[A-Z]/.test(text)) return "yaml";
  return null;
}

function CodeView({ text, lang }: { text: string; lang: string }) {
  const highlighted = useMemo(() => {
    try { return hljs.highlight(text, { language: lang }).value; }
    catch { return hljs.highlightAuto(text).value; }
  }, [text, lang]);
  return (
    <pre className="font-mono text-[length:var(--terminal-font-size,13px)] leading-6 overflow-x-auto">
      <code dangerouslySetInnerHTML={{ __html: highlighted }} />
    </pre>
  );
}

const PAGE = 25;

function stateTone(v: string) {
  const bad = ["degraded", "changed", "failed", "0/1"];
  const good = ["ready", "up", "in sync", "Running", "Completed"];
  if (bad.includes(v)) return "text-alarm";
  if (good.includes(v)) return "text-signal";
  return "";
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const day = d.getUTCDate();
    const suffix = day === 1 || day === 21 || day === 31 ? "st" : day === 2 || day === 22 ? "nd" : day === 3 || day === 23 ? "rd" : "th";
    const month = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    const year = d.getUTCFullYear();
    const time = d.toLocaleString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "UTC" });
    return `${month}, ${day}${suffix} ${year} at ${time} UTC`;
  } catch { return iso; }
}

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

function linkify(text: string): React.ReactNode {
  const urlRe = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = urlRe.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <a
        key={key++}
        href={match[0]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-signal underline underline-offset-2 hover:text-signal/80 break-all"
      >
        {match[0]}
      </a>
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? text : parts.length === 1 ? parts[0] : parts;
}

type CommitDetail = { files: { status: string; path: string; additions: number; deletions: number }[]; body: string };

type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "same"; text: string; ln: number }
  | { kind: "change"; left: string | null; right: string | null; lln: number | null; rln: number | null };

// Returns spans: [text, highlighted] pairs for inline char-level diff
function charDiff(a: string, b: string): [string, boolean][][] {
  // Operate on chars; cap at 300 chars each to avoid O(n²) blowup
  const A = [...a.slice(0, 300)];
  const B = [...b.slice(0, 300)];
  const m = A.length, n = B.length;
  // LCS DP
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i]![j] = A[i-1] === B[j-1] ? dp[i-1]![j-1]! + 1 : Math.max(dp[i-1]![j]!, dp[i]![j-1]!);
  }
  // Backtrack
  const aMarked: boolean[] = new Array(m).fill(true);
  const bMarked: boolean[] = new Array(n).fill(true);
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (A[i-1] === B[j-1]) { aMarked[i-1] = false; bMarked[j-1] = false; i--; j--; }
    else if (dp[i-1]![j]! >= dp[i]![j-1]!) i--;
    else j--;
  }
  // Build runs
  const toRuns = (chars: string[], marked: boolean[]): [string, boolean][] => {
    const runs: [string, boolean][] = [];
    let cur = "", curMark = marked[0] ?? false;
    for (let k = 0; k < chars.length; k++) {
      if (marked[k] !== curMark) { if (cur) runs.push([cur, curMark]); cur = ""; curMark = marked[k]!; }
      cur += chars[k];
    }
    if (cur) runs.push([cur, curMark]);
    return runs;
  };
  return [toRuns(A, aMarked), toRuns(B, bMarked)];
}

function parseUnifiedDiff(raw: string): DiffRow[] {
  const lines = raw.split("\n");
  const hunkStart = lines.findIndex((l) => l.startsWith("@@"));
  if (hunkStart < 0) return [];

  const rows: DiffRow[] = [];
  let lln = 0, rln = 0;

  // Buffer removal lines until we see what they pair with
  const delBuf: { text: string; lln: number }[] = [];

  const flushDels = (addLines: { text: string; rln: number }[]) => {
    const len = Math.max(delBuf.length, addLines.length);
    for (let i = 0; i < len; i++) {
      rows.push({
        kind: "change",
        left: delBuf[i]?.text ?? null,
        right: addLines[i]?.text ?? null,
        lln: delBuf[i]?.lln ?? null,
        rln: addLines[i]?.rln ?? null,
      });
    }
    delBuf.length = 0;
  };

  for (const line of lines.slice(hunkStart)) {
    if (line.startsWith("@@")) {
      if (delBuf.length) flushDels([]);
      // parse @@ -l,s +l,s @@ header
      const m = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (m) { lln = parseInt(m[1]!) - 1; rln = parseInt(m[2]!) - 1; }
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      lln++;
      delBuf.push({ text: line.slice(1), lln });
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      rln++;
      // pair with a pending del if one exists, otherwise right-only
      const del = delBuf.shift();
      rows.push({ kind: "change", left: del?.text ?? null, right: line.slice(1), lln: del?.lln ?? null, rln });
      if (delBuf.length === 0) { /* nothing to flush */ }
    } else {
      if (delBuf.length) flushDels([]);
      if (!line.startsWith("---") && !line.startsWith("+++") && !line.startsWith("\\")) {
        lln++; rln++;
        rows.push({ kind: "same", text: line.slice(1), ln: lln });
      }
    }
  }
  if (delBuf.length) flushDels([]);
  return rows;
}

function DiffTable({ raw }: { raw: string }) {
  const rows = parseUnifiedDiff(raw);
  const [split, setSplit] = useState(50);
  const tableRef = useRef<HTMLTableElement>(null);

  // additions-only: no row has left content
  const additionsOnly = rows.every((r) => r.kind !== "change" || r.left === null);

  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const rect = tableRef.current!.getBoundingClientRect();
      setSplit(Math.min(90, Math.max(10, ((ev.clientX - rect.left) / rect.width) * 100)));
    };
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (additionsOnly) {
    return (
      <div className="mt-1 rounded border border-line/30 bg-background/50">
        <table className="w-full table-fixed border-collapse font-mono text-[13px] leading-5">
          <colgroup><col style={{ width: "2.5rem" }} /><col /></colgroup>
          <tbody>
            {rows.map((row, i) => {
              if (row.kind === "hunk") return <tr key={i} className="bg-secondary/30"><td colSpan={2} className="px-3 py-0.5 text-muted-foreground/60">{row.text}</td></tr>;
              if (row.kind === "same") return <tr key={i} className="hover:bg-secondary/20"><td className="select-none px-2 text-right tabular-nums text-muted-foreground/30">{row.ln}</td><td className="whitespace-pre-wrap break-all px-3 py-0 text-foreground/70">{row.text || " "}</td></tr>;
              return (
                <tr key={i}>
                  <td className="select-none px-2 text-right tabular-nums text-muted-foreground/30 bg-signal/5">{row.rln ?? ""}</td>
                  <td className="whitespace-pre-wrap break-all px-3 py-0 bg-signal/10 text-signal">{row.right ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="mt-1 rounded border border-line/30 bg-background/50">
      <table ref={tableRef} className="w-full table-fixed border-collapse font-mono text-[13px] leading-5">
        <colgroup>
          <col style={{ width: "2.5rem" }} />
          <col style={{ width: `${split}%` }} />
          <col style={{ width: "3px" }} />
          <col style={{ width: "2.5rem" }} />
          <col />
        </colgroup>
        <tbody>
          {rows.map((row, i) => {
            const divider = (
              <td
                key="div"
                rowSpan={1}
                onMouseDown={onDragStart}
                className="cursor-col-resize select-none border-x border-line/30 bg-secondary/20 hover:bg-signal/30 p-0"
              />
            );
            if (row.kind === "hunk") {
              return (
                <tr key={i} className="bg-secondary/30">
                  <td colSpan={5} className="px-3 py-0.5 text-muted-foreground/60">{row.text}</td>
                </tr>
              );
            }
            if (row.kind === "same") {
              return (
                <tr key={i} className="group hover:bg-secondary/20">
                  <td className="select-none px-2 text-right tabular-nums text-muted-foreground/30">{row.ln}</td>
                  <td className="whitespace-pre-wrap break-all px-3 py-0 overflow-hidden text-foreground/70">{row.text || " "}</td>
                  {divider}
                  <td className="select-none px-2 text-right tabular-nums text-muted-foreground/30">{row.ln}</td>
                  <td className="whitespace-pre-wrap break-all px-3 py-0 overflow-hidden text-foreground/70">{row.text || " "}</td>
                </tr>
              );
            }
            return (
              <tr key={i}>
                <td className="select-none px-2 text-right tabular-nums text-muted-foreground/30 bg-alarm/5">{row.lln ?? ""}</td>
                <td className={`overflow-hidden whitespace-pre-wrap break-all px-3 py-0 ${row.left !== null ? "bg-alarm/10 text-alarm" : "bg-transparent"}`}>
                  {row.left !== null && row.right !== null
                    ? charDiff(row.left, row.right)[0].map(([txt, hi], k) =>
                        hi ? <mark key={k} className="bg-transparent text-alarm not-italic">{txt}</mark> : <span key={k}>{txt}</span>
                      )
                    : row.left ?? ""}
                </td>
                {divider}
                <td className="select-none px-2 text-right tabular-nums text-muted-foreground/30 bg-signal/5">{row.rln ?? ""}</td>
                <td className={`overflow-hidden whitespace-pre-wrap break-all px-3 py-0 ${row.right !== null ? "bg-signal/10 text-signal" : "bg-transparent"}`}>
                  {row.left !== null && row.right !== null
                    ? charDiff(row.left, row.right)[1].map(([txt, hi], k) =>
                        hi ? <mark key={k} className="bg-transparent text-signal not-italic">{txt}</mark> : <span key={k}>{txt}</span>
                      )
                    : row.right ?? ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FileDiffView({ fullHash, filePath, cwd }: { fullHash: string; filePath: string; cwd: string }) {
  const [diff, setDiff] = useState<string | "loading">("loading");

  useEffect(() => {
    shell.getFileDiff(fullHash, filePath, cwd).then(setDiff);
  }, [fullHash, filePath, cwd]);

  if (diff === "loading") return <p className="py-1 font-mono text-[13px] text-muted-foreground">Loading diff…</p>;
  if (!diff.trim()) return <p className="py-1 font-mono text-[13px] text-muted-foreground">No diff available.</p>;

  return <DiffTable raw={diff} />;
}

function CommitDetailView({
  fullHash, cwd,
  fileCursor, openFiles, onToggleFile, fileRowRefs, onLoaded,
}: {
  fullHash: string; cwd: string;
  fileCursor: number | null;
  openFiles: Set<string>;
  onToggleFile: (path: string) => void;
  fileRowRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
  onLoaded: (files: { status: string; path: string; additions: number; deletions: number }[]) => void;
}) {
  const [detail, setDetail] = useState<CommitDetail | "loading">("loading");

  useEffect(() => {
    shell.getCommitDetail(fullHash, cwd).then((d) => { setDetail(d); onLoaded(d.files); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullHash, cwd]);

  if (detail === "loading") return <p className="py-2 font-mono text-[13px] text-muted-foreground">Loading…</p>;
  if (!detail || detail.files.length === 0) return <p className="py-2 font-mono text-[13px] text-muted-foreground">No file changes.</p>;

  return (
    <div className="mt-1">
      {detail.body && (
        <p className="mb-2 font-mono text-[13px] text-muted-foreground/70 whitespace-pre-wrap">{detail.body}</p>
      )}
      <div className="divide-y divide-line/30">
        {detail.files.map((f, fi) => {
          const fileOpen = openFiles.has(f.path);
          const fileActive = fileCursor === fi;
          return (
            <div key={f.path} ref={(el) => { fileRowRefs.current[fi] = el; }}>
              <button
                className={`flex w-full items-center gap-3 py-1.5 text-left transition-colors ${fileActive ? "bg-signal/10" : "hover:bg-secondary/40"}`}
                onClick={() => onToggleFile(f.path)}
              >
                <ChevronRightIcon className={`size-3 shrink-0 text-muted-foreground/40 transition-transform ${fileOpen ? "rotate-90" : ""}`} />
                <span className="w-10 shrink-0 text-right tabular-nums font-mono text-[13px] text-signal">+{f.additions}</span>
                <span className="w-10 shrink-0 text-right tabular-nums font-mono text-[13px] text-alarm">-{f.deletions}</span>
                <span className="flex-1 truncate font-mono text-[13px] text-foreground/80">{f.path}</span>
              </button>
              {fileOpen && (
                <div className="pb-2 pl-4">
                  <FileDiffView fullHash={fullHash} filePath={f.path} cwd={cwd} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Shared fullscreen pager shell ────────────────────────────────────────────
function FullscreenPager({
  title,
  isLast,
  collapsedSummary,
  headerMeta,
  allCollapsed,
  onToggleAll,
  onKey,
  children,
}: {
  title: string;
  isLast?: boolean;
  collapsedSummary: React.ReactNode;
  headerMeta?: React.ReactNode;
  allCollapsed: boolean;
  onToggleAll: () => void;
  onKey: (e: KeyboardEvent, inSearch: boolean) => void;
  children: React.ReactNode | ((search: string) => React.ReactNode);
}) {
  const [fullscreen, setFullscreen] = useState(() => !!isLast);
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(fullscreen ? "pager-open" : "pager-close"));
    return () => { if (fullscreen) window.dispatchEvent(new CustomEvent("pager-close")); };
  }, [fullscreen]);

  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Tab") { e.preventDefault(); return; }
      if (e.key === "q" || (e.ctrlKey && e.key === "c") || (e.metaKey && e.key === "c")) {
        e.preventDefault();
        if (document.activeElement === searchRef.current) { searchRef.current?.blur(); return; }
        setFullscreen(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        onToggleAll();
        return;
      }
      if (e.key === "/" || e.key === "f") {
        if (document.activeElement !== searchRef.current) { e.preventDefault(); searchRef.current?.focus(); return; }
      }
      const inSearch = document.activeElement === searchRef.current;
      onKey(e, inSearch);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [fullscreen, onToggleAll, onKey]);

  if (!fullscreen) {
    return (
      <button
        className="flex items-center gap-3 py-1 font-mono text-[13px] hover:opacity-80 transition-opacity"
        onClick={() => setFullscreen(true)}
      >
        {collapsedSummary}
        <span className="text-muted-foreground/40 text-[11px]">click to expand</span>
      </button>
    );
  }

  return createPortal(
    <div className="absolute inset-0 z-50 flex flex-col bg-background font-mono text-[13px]">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2 shrink-0">
        <span className="text-muted-foreground/60">{title}</span>
        {headerMeta}
        <div className="relative ml-2">
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="/ search…"
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); searchRef.current?.blur(); } }}
            className="w-48 rounded border border-line/40 bg-card px-2 py-0.5 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground/40 focus:border-signal/50"
          />
        </div>
        <span className="ml-auto flex gap-4 text-[11px] text-muted-foreground/40">
          <span>↑↓ / j k navigate</span>
          <span>← → / h l expand</span>
          <span>enter toggle</span>
          <span className={allCollapsed ? "text-signal/70" : ""}>⌘A {allCollapsed ? "expand all" : "collapse all"}</span>
          <span className="text-muted-foreground/60">q exit</span>
        </span>
      </div>
      {typeof children === "function" ? (children as (search: string) => React.ReactNode)(search) : children}
      <div className="shrink-0 border-t border-border px-4 py-1.5 flex items-center gap-4 text-[11px] text-muted-foreground/40">
        <span>q / ctrl+c — exit</span>
        <span className={allCollapsed ? "text-signal/70 font-medium" : ""}>⌘A — {allCollapsed ? "expand all" : "collapse all"}</span>
      </div>
    </div>,
    document.querySelector('main') ?? document.body
  );
}

function GitLogView({ entries: rawEntries, cwd, kind: _kind, isLast }: Extract<Out, { kind: "gitlog" }> & { isLast?: boolean }) {
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  const [commitIdx, setCommitIdx] = useState(0);
  const [fileIdx, setFileIdx] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openFiles, setOpenFiles] = useState<Record<string, Set<string>>>({});
  const [fileCounts, setFileCounts] = useState<Record<string, number>>({});
  const [allCollapsed, setAllCollapsed] = useState(false);
  const commitRowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const fileRowRefs = useRef<Record<string, (HTMLDivElement | null)[]>>({});
  const filePathsRef = useRef<Record<string, string[]>>({});

  const toggleCommit = (hash: string) => setExpanded((prev) => {
    const next = new Set(prev); if (next.has(hash)) next.delete(hash); else next.add(hash); return next;
  });
  const toggleFile = (hash: string, path: string) => setOpenFiles((prev) => {
    const s = new Set(prev[hash] ?? []); if (s.has(path)) s.delete(path); else s.add(path);
    return { ...prev, [hash]: s };
  });

  // stable ref to latest state so onKey never goes stale
  const filteredRef = useRef<typeof entries>([]);
  const stateRef = useRef({ commitIdx, fileIdx, expanded, openFiles, fileCounts });
  stateRef.current = { commitIdx, fileIdx, expanded, openFiles, fileCounts };

  const onKey = useCallback((e: KeyboardEvent, inSearch: boolean) => {
    if (inSearch) return;
    const { commitIdx, fileIdx, expanded, openFiles, fileCounts } = stateRef.current;
    const filtered = filteredRef.current;
    const entry = filtered[commitIdx];
    const isOpen = entry ? expanded.has(entry.hash) : false;
    const fileCount = entry ? (fileCounts[entry.hash] ?? 0) : 0;
    if (e.key === "ArrowRight" || e.key === "l") {
      e.preventDefault();
      if (fileIdx !== null && entry) {
        const path = filePathsRef.current[entry.hash]?.[fileIdx];
        if (path && !(openFiles[entry.hash]?.has(path))) toggleFile(entry.hash, path);
      } else if (!isOpen && entry) { toggleCommit(entry.hash); setFileIdx(null); }
      else if (isOpen && fileIdx === null && fileCount > 0) { setFileIdx(0); }
    } else if (e.key === "ArrowLeft" || e.key === "h") {
      e.preventDefault();
      if (fileIdx !== null && entry) {
        const path = filePathsRef.current[entry.hash]?.[fileIdx];
        if (path && openFiles[entry.hash]?.has(path)) toggleFile(entry.hash, path);
        else setFileIdx(null);
      } else if (isOpen && entry) { toggleCommit(entry.hash); }
    } else if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      if (fileIdx !== null) {
        if (fileIdx < fileCount - 1) setFileIdx(fileIdx + 1);
        else { setFileIdx(null); setCommitIdx((c) => Math.min(c + 1, filtered.length - 1)); }
      } else {
        if (isOpen && fileCount > 0) setFileIdx(0);
        else setCommitIdx((c) => Math.min(c + 1, filtered.length - 1));
      }
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      if (fileIdx !== null) {
        if (fileIdx > 0) setFileIdx(fileIdx - 1);
        else setFileIdx(null);
      } else {
        if (commitIdx > 0) {
          const prevEntry = filtered[commitIdx - 1];
          const prevOpen = prevEntry ? expanded.has(prevEntry.hash) : false;
          const prevCount = prevEntry ? (fileCounts[prevEntry.hash] ?? 0) : 0;
          setCommitIdx((c) => c - 1);
          if (prevOpen && prevCount > 0) setFileIdx(prevCount - 1);
        }
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (fileIdx !== null && entry) {
        const paths = filePathsRef.current[entry.hash];
        if (paths?.[fileIdx]) toggleFile(entry.hash, paths[fileIdx]!);
      } else if (entry) { toggleCommit(entry.hash); setFileIdx(null); }
    }
  }, [toggleCommit, toggleFile]);

  return (
    <FullscreenPager
      title="git log"
      isLast={isLast}
      collapsedSummary={<span className="text-muted-foreground/50">{entries.length} commit{entries.length !== 1 ? "s" : ""}</span>}
      headerMeta={<span className="text-muted-foreground/50">{entries.length} commit{entries.length !== 1 ? "s" : ""}</span>}
      allCollapsed={allCollapsed}
      onToggleAll={() => { if (allCollapsed) { setExpanded(new Set()); setAllCollapsed(false); } else { setExpanded(new Set()); setAllCollapsed(true); } }}
      onKey={onKey}
    >
      {(search: string) => {
        const filtered = search
          ? entries.filter((e) =>
              e.subject.toLowerCase().includes(search.toLowerCase()) ||
              e.author.toLowerCase().includes(search.toLowerCase()) ||
              e.hash.startsWith(search) || e.fullHash.startsWith(search)
            )
          : entries;
        filteredRef.current = filtered;
        return (
          <div className="flex-1 overflow-y-auto divide-y divide-border/30">
            {filtered.map((e, i) => {
              const open = expanded.has(e.hash);
              const active = i === commitIdx && fileIdx === null;
              const fRefs = fileRowRefs.current[e.hash] ?? (fileRowRefs.current[e.hash] = []);
              return (
                <div key={e.hash} ref={(el) => { commitRowRefs.current[i] = el; }}>
                  <button
                    className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${active ? "bg-accent" : "hover:bg-accent/50"}`}
                    onClick={() => { setCommitIdx(i); setFileIdx(null); toggleCommit(e.hash); }}
                  >
                    <ChevronRightIcon className={`size-3 shrink-0 text-muted-foreground/40 transition-transform ${open ? "rotate-90" : ""}`} />
                    <span className="w-14 shrink-0 font-mono text-[13px] text-muted-foreground/70 tabular-nums" title={e.fullHash}>{e.hash}</span>
                    {e.isHead && <span className="shrink-0 rounded border border-signal/50 bg-signal/10 px-1 py-0.5 font-mono text-[9px] text-signal leading-none">HEAD</span>}
                    <span className="flex-1 truncate font-mono text-[13px] text-foreground">{highlight(e.subject, search)}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50">{highlight(e.author, search)}</span>
                  </button>
                  {open && (
                    <div className="bg-secondary/20 pb-3 pl-8 pr-4">
                      <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-1 font-mono text-[13px]">
                        <dt className="text-muted-foreground">full hash</dt>
                        <dd className="flex items-center gap-2">
                          <span className="text-foreground break-all">{e.fullHash}</span>
                          <button onClick={(ev) => { ev.stopPropagation(); navigator.clipboard.writeText(e.fullHash); toast.success(`Copied: ${e.fullHash.slice(0, 12)}…`); }}
                            className="shrink-0 rounded px-1.5 py-0.5 text-[13px] border border-line/50 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors">copy</button>
                        </dd>
                        <dt className="text-muted-foreground">date</dt><dd className="text-foreground">{formatDate(e.date)}</dd>
                        <dt className="text-muted-foreground">author</dt><dd className="text-foreground">{e.author}</dd>
                      </dl>
                      <div className="mt-2 border-t border-line/30 pt-2">
                        <p className="mb-1 font-mono text-[13px] text-muted-foreground/50 tracking-wide">changed files</p>
                        <CommitDetailView
                          fullHash={e.fullHash} cwd={cwd}
                          fileCursor={i === commitIdx ? fileIdx : null}
                          openFiles={openFiles[e.hash] ?? new Set()}
                          onToggleFile={(path) => toggleFile(e.hash, path)}
                          fileRowRefs={{ current: fRefs }}
                          onLoaded={(files) => {
                            setFileCounts((prev) => ({ ...prev, [e.hash]: files.length }));
                            filePathsRef.current[e.hash] = files.map((f) => f.path);
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && <p className="px-4 py-3 font-mono text-[13px] text-muted-foreground">No matching commits.</p>}
          </div>
        );
      }}
    </FullscreenPager>
  );
}

function humanSize(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024) return `${bytes}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

function PermBadge({ perms }: { perms: string }) {
  const bits = perms.slice(1, 10);
  const canRead  = bits[0] === "r";
  const canWrite = bits[1] === "w";
  const canExec  = bits[2] === "x" || bits[2] === "s";
  const raw = perms.slice(0, 10);
  return (
    <span
      className="flex items-center gap-px select-none cursor-pointer"
      title={raw}
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(raw); toast.success(`Copied: ${raw}`); }}
    >
      <span className={`font-mono text-[12px] ${canRead  ? "text-foreground/65" : "text-foreground/18"}`}>r</span>
      <span className={`font-mono text-[12px] ${canWrite ? "text-[#e3b341]/65"  : "text-foreground/18"}`}>w</span>
      <span className={`font-mono text-[12px] ${canExec  ? "text-[#3fb950]/65"  : "text-foreground/18"}`}>x</span>
    </span>
  );
}

function lsDate(month: string, day: string, time: string): string {
  // time is either HH:MM or YYYY
  const isYear = /^\d{4}$/.test(time);
  const d = day.padStart(2, " ");
  if (isYear) return `${month} ${d}  ${time}`;
  return `${month} ${d} ${time}`;
}

function LsLongView({ entries, total }: Extract<Out, { kind: "lslong" }>) {
  const hidden = entries.filter((e) => e.name.startsWith("."));
  const visible = entries.filter((e) => !e.name.startsWith("."));
  const sorted = [...hidden, ...visible];

  return (
    <div className="w-full">
      {total && (
        <p className="mb-1.5 font-mono text-[11px] text-muted-foreground/35 select-none">
          {entries.length} entries · {total} blocks
        </p>
      )}
      <div className="w-full">
        {sorted.map((e) => {
          const isDir = e.perms[0] === "d";
          const isLink = e.perms[0] === "l";
          const isExec = e.perms[3] === "x" || e.perms[6] === "x" || e.perms[9] === "x";
          const isHidden = e.name.startsWith(".");
          const nameColor = isDir
            ? "text-[#58a6ff]"
            : isLink
            ? "text-[#d2a8ff]"
            : isExec
            ? "text-[#3fb950]"
            : isHidden
            ? "text-foreground/40"
            : "text-foreground/85";

          return (
            <div
              key={e.name}
              className={`group flex items-center gap-3 rounded px-1 py-[2px] font-mono text-[13px] leading-[1.6] transition-colors hover:bg-secondary/30 ${isHidden ? "opacity-60 hover:opacity-100" : ""}`}
            >
              <PermBadge perms={e.perms} />
              <span className="w-[3.5rem] shrink-0 text-right tabular-nums text-[12px] text-foreground/40">{humanSize(e.size)}</span>
              <span className="w-[5.5rem] shrink-0 text-[12px] text-muted-foreground/45 tabular-nums">{lsDate(e.month, e.day, e.time)}</span>
              <span className={`flex-1 truncate ${nameColor}`}>
                {e.name}{isDir && <span className="text-foreground/30">/</span>}
                {e.link && <span className="ml-1 text-foreground/30">&#8594; {e.link}</span>}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground/25 opacity-0 group-hover:opacity-100 transition-opacity">{e.user}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GitBranchesView({ branches, current }: Extract<Out, { kind: "gitbranches" }>) {
  return (
    <div className="space-y-0.5">
      {branches.map((b) => (
        <div key={b} className="flex items-center gap-2 font-mono text-[13px] leading-6">
          {b === current
            ? <><span className="text-signal">*</span><span className="text-signal">{b}</span></>
            : <><span className="w-3 shrink-0" /><span className="text-foreground">{b}</span></>
          }
          {b === current && (
            <span className="flex items-center gap-1 text-[10px] text-signal/70">
              <GitBranchIcon className="size-2.5" />
              current
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

const GIT_XY: Record<string, { label: string; cls: string }> = {
  M: { label: "modified", cls: "text-amber-400" },
  A: { label: "added", cls: "text-signal" },
  D: { label: "deleted", cls: "text-alarm" },
  R: { label: "renamed", cls: "text-blue-400" },
  C: { label: "copied", cls: "text-blue-400" },
  U: { label: "unmerged", cls: "text-alarm" },
};

function GitStatusView({ branch, ahead, behind, staged, unstaged, untracked }: Extract<Out, { kind: "gitstatus" }>) {
  if (!branch) return <div className="font-mono text-[13px] text-muted-foreground/50">not a git repository</div>;
  const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;
  const Section = ({ title, items, cls }: { title: string; items: { xy: string; path: string }[]; cls: string }) => (
    <div className="space-y-0.5">
      <div className="font-mono text-[11px] text-muted-foreground/50 tracking-wide pb-0.5">{title}</div>
      {items.map(({ xy, path }) => {
        const info = GIT_XY[xy.toUpperCase()] ?? { label: xy, cls: "text-muted-foreground" };
        return (
          <div key={path} className="flex items-baseline gap-3 font-mono text-[13px]">
            <span className={`w-16 shrink-0 text-[11px] ${cls || info.cls}`}>{info.label}</span>
            <span className="text-foreground">{path}</span>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Branch line */}
      <div className="flex items-center gap-2 font-mono text-[13px]">
        <GitBranchIcon className="size-3 text-purple-400/70" />
        <span className="text-purple-400">{branch}</span>
        {ahead > 0 && <span className="text-muted-foreground/50">↑{ahead}</span>}
        {behind > 0 && <span className="text-muted-foreground/50">↓{behind}</span>}
        {clean && <span className="text-signal/60 text-[11px] ml-1">clean</span>}
      </div>
      {staged.length > 0 && <Section title="staged" items={staged} cls="text-signal" />}
      {unstaged.length > 0 && <Section title="not staged" items={unstaged} cls="" />}
      {untracked.length > 0 && (
        <div className="space-y-0.5">
          <div className="font-mono text-[11px] text-muted-foreground/50 tracking-wide pb-0.5">untracked</div>
          {untracked.map((p) => (
            <div key={p} className="flex items-baseline gap-3 font-mono text-[13px]">
              <span className="w-16 shrink-0 text-[11px] text-muted-foreground/50">new</span>
              <span className="text-foreground/70">{p}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type NodeCondition = { type: string; status: string; reason: string; message: string; lastTransition: string };
type NodeEvent = { type: string; reason: string; age: string; message: string };
type ParsedNode = {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  conditions: NodeCondition[];
  capacity: Record<string, string>;
  allocatable: Record<string, string>;
  nodeInfo: Record<string, string>;
  taints: { key: string; effect: string; value?: string }[];
  raw: unknown;
};

function parseNodeJson(json: string): ParsedNode | null {
  try {
    // eslint-disable-next-line no-control-regex
    const clean = json.replace(/\x1b\[[0-9;]*[mGKHF]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trim();
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    console.log("[parseNodeJson] input len=", json.length, "clean len=", clean.length, "start=", start, "end=", end, "first80=", clean.slice(0, 80));
    if (start < 0 || end < 0) { console.warn("[parseNodeJson] no braces found, len=", clean.length); return null; }
    const o = JSON.parse(clean.slice(start, end + 1)) as Record<string, unknown>;
    if (!o || typeof o !== "object") return null;
    const spec = (o.spec ?? {}) as Record<string, unknown>;
    const status = (o.status ?? {}) as Record<string, unknown>;
    const meta = (o.metadata ?? {}) as Record<string, unknown>;

    const conditions: NodeCondition[] = ((status.conditions ?? []) as Record<string, string>[]).map((c) => ({
      type: c.type ?? "",
      status: c.status ?? "",
      reason: c.reason ?? "",
      message: c.message ?? "",
      lastTransition: c.lastTransitionTime ?? "",
    }));

    const capacity: Record<string, string> = { ...((status.capacity ?? {}) as Record<string, string>) };
    const allocatable: Record<string, string> = { ...((status.allocatable ?? {}) as Record<string, string>) };
    const nodeInfo: Record<string, string> = { ...((status.nodeInfo ?? {}) as Record<string, string>) };

    const taints: { key: string; effect: string; value?: string }[] =
      ((spec.taints ?? []) as { key: string; effect: string; value?: string }[]).map((t) => ({
        key: t.key, effect: t.effect, ...(t.value ? { value: t.value } : {}),
      }));

    return {
      labels: { ...((meta.labels ?? {}) as Record<string, string>) },
      annotations: { ...((meta.annotations ?? {}) as Record<string, string>) },
      conditions,
      capacity,
      allocatable,
      nodeInfo,
      taints,
      raw: o,
    };
  } catch (e) { console.error("[parseNodeJson] parse error:", e); return null; }
}

function humanBytes(raw: string): string {
  const kiMatch = raw.match(/^(\d+)Ki$/);
  if (kiMatch) {
    const ki = parseInt(kiMatch[1]!);
    if (ki >= 1024 * 1024) return `${(ki / 1024 / 1024).toFixed(0)} GiB`;
    if (ki >= 1024) return `${(ki / 1024).toFixed(0)} MiB`;
    return `${ki} KiB`;
  }
  return raw;
}

function PrettyView({ format, text }: { format: "json" | "yaml"; text: string }) {
  const [raw, setRaw] = useState(false);
  if (raw) {
    return (
      <div className="relative">
        <button
          onClick={() => setRaw(false)}
          className="absolute right-1 top-1 rounded border border-line/40 bg-card px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground transition-colors z-10"
        >pretty</button>
        <pre className="whitespace-pre-wrap font-mono text-[length:var(--terminal-font-size,13px)] leading-6 text-foreground">{text}</pre>
      </div>
    );
  }
  const lines = text.split("\n");
  const highlighted = format === "json"
    ? lines.map((line, i) => {
        // JSON: keys in muted, strings in signal, numbers in amber, booleans/null in purple
        const parts: React.ReactNode[] = [];
        let rest = line;
        let key = 0;
        // Match key: "..."
        const keyMatch = rest.match(/^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)/);
        if (keyMatch) {
          parts.push(<span key={key++}>{keyMatch[1]}</span>);
          parts.push(<span key={key++} className="text-foreground/70">{keyMatch[2]}</span>);
          parts.push(<span key={key++}>{keyMatch[3]}</span>);
          rest = rest.slice(keyMatch[0].length);
        }
        // Match value
        const strMatch = rest.match(/^("(?:[^"\\]|\\.)*")(,?\s*)$/);
        if (strMatch) {
          parts.push(<span key={key++} className="text-signal">{strMatch[1]}</span>);
          parts.push(<span key={key++}>{strMatch[2]}</span>);
          return <div key={i}>{parts}</div>;
        }
        const numMatch = rest.match(/^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(,?\s*)$/);
        if (numMatch) {
          parts.push(<span key={key++} className="text-amber-400">{numMatch[1]}</span>);
          parts.push(<span key={key++}>{numMatch[2]}</span>);
          return <div key={i}>{parts}</div>;
        }
        const boolMatch = rest.match(/^(true|false|null)(,?\s*)$/);
        if (boolMatch) {
          parts.push(<span key={key++} className="text-purple-400">{boolMatch[1]}</span>);
          parts.push(<span key={key++}>{boolMatch[2]}</span>);
          return <div key={i}>{parts}</div>;
        }
        parts.push(<span key={key++}>{rest}</span>);
        return <div key={i}>{parts}</div>;
      })
    : lines.map((line, i) => {
        // YAML: "---" in muted, comments in muted, keys before ":" in muted, numbers in amber, strings in signal
        if (/^---\s*$/.test(line)) return <div key={i} className="text-muted-foreground/40">{line}</div>;
        if (/^\s*#/.test(line)) return <div key={i} className="text-muted-foreground/50">{line}</div>;
        const kvMatch = line.match(/^(\s*)([\w.-]+)(:)(.*)$/);
        if (kvMatch) {
          const [, indent, k, colon, val = ""] = kvMatch;
          const valTrimmed = val.trim();
          const numMatch = valTrimmed.match(/^-?\d+(?:\.\d+)?$/);
          const valClass = numMatch ? "text-amber-400" : valTrimmed ? "text-signal" : "";
          return (
            <div key={i}>
              <span>{indent}</span>
              <span className="text-foreground/70">{k}</span>
              <span>{colon}</span>
              <span className={valClass}>{val}</span>
            </div>
          );
        }
        return <div key={i}>{line}</div>;
      });
  return (
    <div className="relative">
      <button
        onClick={() => setRaw(true)}
        className="absolute right-1 top-1 rounded border border-line/40 bg-card px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground transition-colors z-10"
      >raw</button>
      <pre className="whitespace-pre-wrap font-mono text-[length:var(--terminal-font-size,13px)] leading-6">{highlighted}</pre>
    </div>
  );
}

function LogfmtView({ lines }: { lines: Record<string, string>[] }) {
  const LEVEL_CLS: Record<string, string> = {
    error: "text-alarm bg-alarm/10",
    fatal: "text-alarm bg-alarm/20",
    warn:  "text-amber-400 bg-amber-400/10",
    warning: "text-amber-400 bg-amber-400/10",
    info:  "text-signal bg-signal/10",
    debug: "text-muted-foreground bg-secondary/30",
    trace: "text-muted-foreground/50 bg-secondary/20",
  };

  return (
    <div className="space-y-px font-mono text-[length:var(--terminal-font-size,13px)]">
      {lines.map((fields, i) => {
        const level = (fields["level"] ?? fields["lvl"] ?? "").toLowerCase();
        const msg = fields["msg"] ?? fields["message"] ?? "";
        const time = fields["time"] ?? fields["ts"] ?? fields["timestamp"] ?? "";
        const levelCls = LEVEL_CLS[level] ?? "text-muted-foreground bg-secondary/20";
        // short time: keep only HH:MM:SS portion if ISO
        const shortTime = time.length > 10 ? (time.match(/T(\d{2}:\d{2}:\d{2})/)?.[1] ?? time.slice(0, 19).replace("T", " ")) : time;
        const extras = Object.entries(fields).filter(([k]) => k !== "time" && k !== "ts" && k !== "timestamp" && k !== "level" && k !== "lvl" && k !== "msg" && k !== "message");
        return (
          <div key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-1.5 py-0.5 hover:bg-secondary/20">
            {shortTime && <span className="shrink-0 tabular-nums text-muted-foreground/40 text-[12px]">{shortTime}</span>}
            {level && <span className={`shrink-0 rounded px-1 py-px text-[10px] font-semibold uppercase tracking-wider leading-none ${levelCls}`}>{level}</span>}
            <span className="flex-1 text-foreground/90 break-all">{msg}</span>
            {extras.map(([k, v]) => (
              <span key={k} className="shrink-0 text-[12px]">
                <span className="text-muted-foreground/40">{k}=</span>
                <span className="text-muted-foreground/70">{v}</span>
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}


function parseKubeCmd(input: string): { kubeCmd: string; resource: string; namespace?: string; isDescribe?: boolean } | null {
  const t = input.trim();
  // kubectl get <resource> — expandable rows
  const getM = t.match(/^(u8s\s+kubectl|u8s\s+k|kubectl|k)\s+get\s+(\S+)(?:\s+.*)?$/);
  if (getM) {
    const nsM = t.match(/(?:-n|--namespace)\s+(\S+)/);
    return { kubeCmd: getM[1]!.replace(/\s+/, " "), resource: getM[2]!, namespace: nsM?.[1] };
  }
  // kubectl describe <resource> <name> — whole output is one describe
  const descM = t.match(/^(u8s\s+kubectl|u8s\s+k|kubectl|k)\s+describe\s+(\S+)\s+(\S+)(?:\s+.*)?$/);
  if (descM) {
    const nsM = t.match(/(?:-n|--namespace)\s+(\S+)/);
    return { kubeCmd: descM[1]!.replace(/\s+/, " "), resource: descM[2]!, namespace: nsM?.[1], isDescribe: true };
  }
  return null;
}

function LabelExplorer({ entries }: { entries: Record<string, string> }) {
  const [filter, setFilter] = useState("");
  const pairs = Object.entries(entries);
  const q = filter.toLowerCase();
  const filtered = q ? pairs.filter(([k, v]) => k.toLowerCase().includes(q) || v.toLowerCase().includes(q)) : pairs;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded border border-border/30 bg-secondary/20 px-3 py-1.5">
        <svg className="size-3.5 shrink-0 text-muted-foreground/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter key or value"
          autoComplete="off" spellCheck={false}
          className="flex-1 bg-transparent font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground/40"
        />
        {filter && (
          <button onClick={() => setFilter("")} className="text-muted-foreground/50 hover:text-muted-foreground">
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      <div className="divide-y divide-border/15">
        {filtered.map(([k, v]) => {
          const slash = k.lastIndexOf("/");
          const domain = slash > 0 ? k.slice(0, slash) : "";
          const suffix = slash > 0 ? k.slice(slash + 1) : k;
          return (
            <div key={k} className="py-1.5">
              <div className="font-mono text-[12px] text-muted-foreground/50">
                {domain ? <>{domain}/<span className="text-muted-foreground/70">{suffix}</span></> : k}
              </div>
              <div className="font-mono text-[14px] text-foreground">{v || '""'}</div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="py-3 text-center font-mono text-[13px] text-muted-foreground/40">no matches</div>
        )}
      </div>
    </div>
  );
}

const CONDITION_HEALTHY: Record<string, string> = { Ready: "True", MemoryPressure: "False", DiskPressure: "False", PIDPressure: "False", NetworkUnavailable: "False" };

type NodePanelState = { labelsOpen: boolean; annotationsOpen: boolean; rawOpen: boolean; eventsOpen: boolean; events: NodeEvent[] | null };
const nodePanelStateCache = new Map<string, NodePanelState>();

function NodeDetailPanel({ json, nodeName, ctx }: { json: string; nodeName: string; ctx: string }) {
  const p = parseNodeJson(json);
  const cacheKey = `${ctx}/${nodeName}`;
  const cached = nodePanelStateCache.get(cacheKey);

  const [labelsOpen, setLabelsOpenRaw] = useState(cached?.labelsOpen ?? false);
  const [annotationsOpen, setAnnotationsOpenRaw] = useState(cached?.annotationsOpen ?? false);
  const [rawOpen, setRawOpenRaw] = useState(cached?.rawOpen ?? false);
  const [events, setEventsRaw] = useState<NodeEvent[] | null>(cached?.events ?? null);
  const [eventsOpen, setEventsOpenRaw] = useState(cached?.eventsOpen ?? false);

  const persist = (patch: Partial<NodePanelState>) => {
    const prev = nodePanelStateCache.get(cacheKey) ?? { labelsOpen, annotationsOpen, rawOpen, eventsOpen, events };
    nodePanelStateCache.set(cacheKey, { ...prev, ...patch });
  };

  const setLabelsOpen = (v: boolean | ((x: boolean) => boolean)) => {
    setLabelsOpenRaw((prev) => { const next = typeof v === "function" ? v(prev) : v; persist({ labelsOpen: next }); return next; });
  };
  const setAnnotationsOpen = (v: boolean | ((x: boolean) => boolean)) => {
    setAnnotationsOpenRaw((prev) => { const next = typeof v === "function" ? v(prev) : v; persist({ annotationsOpen: next }); return next; });
  };
  const setRawOpen = (v: boolean | ((x: boolean) => boolean)) => {
    setRawOpenRaw((prev) => { const next = typeof v === "function" ? v(prev) : v; persist({ rawOpen: next }); return next; });
  };
  const setEventsOpen = (v: boolean | ((x: boolean) => boolean)) => {
    setEventsOpenRaw((prev) => { const next = typeof v === "function" ? v(prev) : v; persist({ eventsOpen: next }); return next; });
  };
  const setEvents = (ev: NodeEvent[] | null) => {
    setEventsRaw(ev); persist({ events: ev });
  };

  const toggleEvents = async () => {
    if (!eventsOpen && events === null) {
      const ev = await shell.getNodeEvents(nodeName, ctx || undefined);
      setEvents(ev);
    }
    setEventsOpen((x) => !x);
  };

  if (!p) return (
    <pre className="font-mono text-[13px] text-muted-foreground/60 whitespace-pre-wrap">{json}</pre>
  );

  const L = p.labels;
  const region   = L["topology.kubernetes.io/region"]   ?? L["failure-domain.beta.kubernetes.io/region"] ?? "";
  const zone     = L["topology.kubernetes.io/zone"]     ?? L["failure-domain.beta.kubernetes.io/zone"]   ?? "";
  const cluster  = L["kubernetes.metal.cloud.sap/cluster"] ?? "";
  const pool     = L["worker.gardener.cloud/pool"]      ?? L["worker.garden.sapcloud.io/group"]          ?? "";
  const hw       = L["kubernetes.metal.cloud.sap/type"] ?? "";
  const bb       = L["kubernetes.metal.cloud.sap/bb"]   ?? "";
  const nodename = L["kubernetes.metal.cloud.sap/nodename"] ?? "";
  const maintState   = L["cloud.sap/maintenance-state"]   ?? "";
  const maintProfile = L["cloud.sap/maintenance-profile"] ?? "";
  const clusterRole  = cluster.startsWith("m-") ? "metal" : cluster.startsWith("rt-") ? "runtime" : cluster.startsWith("mgmt-") ? "mgmt" : "";

  const ni = p.nodeInfo;
  const kubelet = ni["kubeletVersion"] ?? "";
  const runtime = (ni["containerRuntimeVersion"] ?? "").replace(/^containerd:\/\//, "containerd ");
  const cpu = p.capacity["cpu"] ?? "";
  const mem = p.capacity["memory"] ? humanBytes(p.capacity["memory"]) : "";
  const pods = p.capacity["pods"] ?? "";

  const badConditions = p.conditions.filter((c) => CONDITION_HEALTHY[c.type] !== undefined && CONDITION_HEALTHY[c.type] !== c.status);
  const isHealthy = badConditions.length === 0;

  const slots: [string, string][] = [
    ["region",   region],
    ["zone",     zone],
    ["cluster",  clusterRole ? `${cluster} (${clusterRole})` : cluster],
    ["pool",     pool],
    ["hardware", hw],
    ["node",     [bb, nodename].filter(Boolean).join(" · ")],
  ].filter(([, v]) => v) as [string, string][];

  const StatCard = ({ label, value }: { label: string; value: string }) => (
    <div className="flex flex-col gap-0.5 rounded border border-border/40 bg-card px-3 py-2">
      <span className="font-mono text-[11px] text-muted-foreground/60 leading-none">{label}</span>
      <span className="font-mono text-[15px] text-foreground leading-snug break-all">{value}</span>
    </div>
  );

  const DisclosureBtn = ({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) => (
    <button onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="flex items-center gap-1.5 font-mono text-[13px] text-muted-foreground/50 hover:text-muted-foreground transition-colors">
      <ChevronRightIcon className={`size-3 transition-transform ${open ? "rotate-90" : ""}`} />
      {label}
    </button>
  );

  return (
    <div className="py-2 space-y-3">
      {/* Health */}
      <div className={`flex items-center gap-2 font-mono text-[15px] ${isHealthy ? "text-signal" : "text-alarm"}`}>
        <span className={`size-2.5 rounded-full shrink-0 ${isHealthy ? "bg-signal" : "bg-alarm"}`} />
        {isHealthy ? "healthy" : badConditions.map((c) => `${c.type}${c.reason ? ` — ${c.reason}` : ""}`).join(", ")}
      </div>

      {/* Stat grid */}
      {slots.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {slots.map(([label, value]) => <StatCard key={label} label={label} value={value} />)}
        </div>
      )}

      {/* Resources */}
      {(cpu || mem || kubelet || runtime) && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-[15px]">
          {cpu     && <span><span className="text-muted-foreground/50 text-[11px] mr-1.5">cpu</span>{cpu}</span>}
          {mem     && <span><span className="text-muted-foreground/50 text-[11px] mr-1.5">mem</span>{mem}</span>}
          {pods    && <span><span className="text-muted-foreground/50 text-[11px] mr-1.5">pods</span>{pods}</span>}
          {kubelet && <span><span className="text-muted-foreground/50 text-[11px] mr-1.5">kubelet</span>{kubelet}</span>}
          {runtime && <span><span className="text-muted-foreground/50 text-[11px] mr-1.5">runtime</span>{runtime}</span>}
        </div>
      )}

      {/* Maintenance */}
      {maintState && maintState !== "operational" && (
        <div className="font-mono text-[15px] text-amber-400">
          <span className="text-[11px] mr-1.5 text-amber-400/60">maintenance</span>
          {maintState}{maintProfile ? ` / ${maintProfile}` : ""}
        </div>
      )}

      {/* Taints */}
      {p.taints.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {p.taints.map((t) => (
            <span key={t.key} className="font-mono text-[12px] rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-amber-400">
              {t.key}{t.value ? `=${t.value}` : ""}:{t.effect}
            </span>
          ))}
        </div>
      )}

      {/* Conditions */}
      {p.conditions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {p.conditions.map((c) => {
            const bad = CONDITION_HEALTHY[c.type] !== undefined && CONDITION_HEALTHY[c.type] !== c.status;
            return (
              <span key={c.type}
                title={[c.reason, c.message].filter(Boolean).join(": ") || undefined}
                className={`font-mono text-[13px] flex items-center gap-1.5 rounded border px-2.5 py-1 ${bad ? "border-alarm/40 bg-alarm/10 text-alarm" : "border-border/30 bg-secondary/30 text-muted-foreground"}`}
              >
                <span className={`size-1.5 rounded-full shrink-0 ${bad ? "bg-alarm" : "bg-signal/50"}`} />
                {c.type}
              </span>
            );
          })}
        </div>
      )}

      {/* Disclosures */}
      <div className="flex flex-wrap items-center gap-5 border-t border-border/25 pt-2">
        {Object.keys(L).length > 0 && <DisclosureBtn open={labelsOpen} onClick={() => setLabelsOpen((x) => !x)} label={`labels (${Object.keys(L).length})`} />}
        {Object.keys(p.annotations).length > 0 && <DisclosureBtn open={annotationsOpen} onClick={() => setAnnotationsOpen((x) => !x)} label={`annotations (${Object.keys(p.annotations).length})`} />}
        <DisclosureBtn open={eventsOpen} onClick={toggleEvents} label="events" />
        <DisclosureBtn open={rawOpen} onClick={() => setRawOpen((x) => !x)} label="raw json" />
      </div>

      {labelsOpen && <div className="rounded border border-border/25 bg-secondary/10 p-3"><LabelExplorer entries={L} /></div>}
      {annotationsOpen && <div className="rounded border border-border/25 bg-secondary/10 p-3"><LabelExplorer entries={p.annotations} /></div>}

      {/* Events */}
      {eventsOpen && (
        <div className="space-y-1">
          {events === null
            ? <span className="font-mono text-[13px] text-muted-foreground/50">loading…</span>
            : events.length === 0
              ? <span className="font-mono text-[13px] text-muted-foreground/40">no events</span>
              : <table className="w-full border-collapse font-mono text-[13px]">
                  <thead>
                    <tr>
                      {["type","reason","age","message"].map((h) => (
                        <th key={h} className="border-b border-border/25 pb-1 text-left font-medium text-[11px] uppercase tracking-widest text-muted-foreground/50 pr-4">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((ev, i) => (
                      <tr key={i} className="border-b border-border/15 hover:bg-secondary/30">
                        <td className={`py-1 pr-4 ${ev.type === "Warning" ? "text-amber-400" : "text-muted-foreground/60"}`}>{ev.type}</td>
                        <td className="py-1 pr-4 text-foreground/80">{ev.reason}</td>
                        <td className="py-1 pr-4 text-muted-foreground/60 whitespace-nowrap">{ev.age ? new Date(ev.age).toLocaleString() : ""}</td>
                        <td className="py-1 text-muted-foreground/70 break-all">{ev.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
          }
        </div>
      )}

      {rawOpen && (
        <pre className="max-h-72 overflow-auto rounded border border-border/25 bg-secondary/20 p-3 font-mono text-[12px] leading-5 text-foreground/50 whitespace-pre-wrap">
          {JSON.stringify(p.raw, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ExpandableTableView({ out, input, ctx }: { out: Extract<Out, { kind: "table" }>; input: string; ctx: string }) {
  const kubeInfo = parseKubeCmd(input);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [describeData, setDescribeData] = useState<Record<number, string>>({});
  const [loadingRow, setLoadingRow] = useState<number | null>(null);

  const toggleRow = async (i: number, name: string) => {
    if (expandedRow === i) { setExpandedRow(null); return; }
    setExpandedRow(i);
    if (!kubeInfo || describeData[i] !== undefined) return;
    setLoadingRow(i);
    const raw = await shell.describeResource(kubeInfo.resource, name, kubeInfo.namespace, ctx);
    setDescribeData((prev) => ({ ...prev, [i]: raw }));
    setLoadingRow(null);
  };

  return (
    <table className="w-full border-collapse text-left">
      <thead>
        <tr>
          {kubeInfo && <th className="w-4 border-b border-line pb-1.5" />}
          {out.head.map((h) => (
            <th key={h} className="border-b border-line pb-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {out.rows.map((r, i) => {
          const name = r[0] ?? "";
          const isOpen = expandedRow === i;
          const raw = describeData[i];
          return (
            <React.Fragment key={i}>
              <tr
                className={`group/row transition-colors ${kubeInfo ? "cursor-pointer hover:bg-secondary/60" : ""} ${isOpen ? "bg-secondary/40" : ""}`}
                onClick={() => kubeInfo ? toggleRow(i, name) : undefined}
              >
                {kubeInfo && (
                  <td className="border-b border-line/60 py-1.5 pr-2 w-4">
                    {isOpen
                      ? <ChevronUpIcon className="size-3 text-muted-foreground/60" />
                      : <ChevronRightIcon className="size-3 text-muted-foreground/30 group-hover/row:text-muted-foreground/60" />
                    }
                  </td>
                )}
                {r.map((c, j) => (
                  <td key={j} className={`border-b border-line/60 py-1.5 pr-6 font-mono text-[13px] ${j === out.accentCol ? stateTone(c) : j === 0 ? "text-foreground" : "text-muted-foreground"}`}>
                    {c}
                  </td>
                ))}
              </tr>
              {isOpen && (
                <tr>
                  <td />
                  <td colSpan={out.head.length} className="pb-3 pt-2">
                    {loadingRow === i && (
                      <div className="flex items-center gap-2 py-2 font-mono text-[11px] text-muted-foreground/50">
                        <LoaderCircleIcon className="size-3 animate-spin" /> loading…
                      </div>
                    )}
                    {raw !== undefined && raw.length > 0 && <NodeDetailPanel json={raw} nodeName={r[0] ?? ""} ctx={ctx} />}
                    {raw !== undefined && raw.length === 0 && (
                      <p className="py-2 font-mono text-[11px] text-muted-foreground/40">No describe output.</p>
                    )}
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function GitDiffView({ raw, isLast }: { raw: string; isLast?: boolean }) {
  const files = React.useMemo(() => {
    const sections: { path: string; raw: string; additions: number; deletions: number }[] = [];
    const parts = raw.split(/^(?=diff --git )/m).filter(Boolean);
    for (const part of parts) {
      const header = part.match(/^diff --git a\/.+ b\/(.+)$/m);
      const path = header?.[1] ?? part.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? "unknown";
      const lines = part.split("\n");
      const additions = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
      const deletions = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
      sections.push({ path, raw: part, additions, deletions });
    }
    return sections;
  }, [raw]);

  const [openFiles, setOpenFiles] = useState<Set<string>>(() => new Set(files.map((f) => f.path)));
  const [cursor, setCursor] = useState(0);
  const [allCollapsed, setAllCollapsed] = useState(false);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const filesRef = useRef(files);
  filesRef.current = files;
  const stateRef = useRef({ cursor, openFiles, allCollapsed });
  stateRef.current = { cursor, openFiles, allCollapsed };

  const toggle = useCallback((path: string) =>
    setOpenFiles((prev) => { const s = new Set(prev); s.has(path) ? s.delete(path) : s.add(path); return s; }), []);

  const onKey = useCallback((e: KeyboardEvent, inSearch: boolean) => {
    if (inSearch) return;
    const { cursor, openFiles } = stateRef.current;
    const files = filesRef.current;
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      setCursor((c) => { const next = Math.min(c + 1, files.length - 1); rowRefs.current[next]?.scrollIntoView({ block: "nearest" }); return next; });
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      setCursor((c) => { const next = Math.max(c - 1, 0); rowRefs.current[next]?.scrollIntoView({ block: "nearest" }); return next; });
    } else if (e.key === "ArrowRight" || e.key === "l") {
      e.preventDefault();
      const f = files[cursor];
      if (f && !openFiles.has(f.path)) setOpenFiles((prev) => { const s = new Set(prev); s.add(f.path); return s; });
    } else if (e.key === "ArrowLeft" || e.key === "h") {
      e.preventDefault();
      const f = files[cursor];
      if (f && openFiles.has(f.path)) setOpenFiles((prev) => { const s = new Set(prev); s.delete(f.path); return s; });
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const f = files[cursor];
      if (f) toggle(f.path);
    }
  }, [toggle]);

  if (files.length === 0) return <DiffTable raw={raw} />;

  const totalAdd = files.reduce((a, f) => a + f.additions, 0);
  const totalDel = files.reduce((a, f) => a + f.deletions, 0);

  return (
    <FullscreenPager
      title="git diff"
      isLast={isLast}
      collapsedSummary={<><span className="text-signal">+{totalAdd}</span><span className="text-alarm">-{totalDel}</span><span className="text-muted-foreground/50">{files.length} file{files.length !== 1 ? "s" : ""}</span></>}
      headerMeta={<><span className="text-signal">+{totalAdd}</span><span className="text-alarm">-{totalDel}</span><span className="text-muted-foreground/50">{files.length} file{files.length !== 1 ? "s" : ""}</span></>}
      allCollapsed={allCollapsed}
      onToggleAll={useCallback(() => {
        setAllCollapsed((c) => {
          if (!c) setOpenFiles(new Set());
          else setOpenFiles(new Set(filesRef.current.map((f) => f.path)));
          return !c;
        });
      }, [])}
      onKey={onKey}
    >
      {(_search: string) => (
        <div className="flex-1 overflow-y-auto divide-y divide-border/30">
          {files.map((f, i) => (
            <div key={f.path}>
              <button
                ref={(el) => { rowRefs.current[i] = el; }}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${i === cursor ? "bg-accent" : "hover:bg-accent/50"}`}
                onClick={() => { setCursor(i); toggle(f.path); }}
              >
                <ChevronRightIcon className={`size-3 shrink-0 text-muted-foreground/40 transition-transform ${openFiles.has(f.path) ? "rotate-90" : ""}`} />
                <span className="w-10 shrink-0 text-right tabular-nums text-signal">+{f.additions}</span>
                <span className="w-10 shrink-0 text-right tabular-nums text-alarm">-{f.deletions}</span>
                <span className="flex-1 truncate text-foreground/80">{f.path}</span>
              </button>
              {openFiles.has(f.path) && (
                <div className="px-4 pb-3">
                  <DiffTable raw={f.raw} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </FullscreenPager>
  );
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lq = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let last = 0, key = 0;
  let idx = text.toLowerCase().indexOf(lq, last);
  while (idx !== -1) {
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push(<mark key={key++} className="bg-signal/30 text-foreground rounded px-0.5 not-italic">{text.slice(idx, idx + query.length)}</mark>);
    last = idx + query.length;
    idx = text.toLowerCase().indexOf(lq, last);
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? text : parts;
}

function SearchableOutput({ html, lines, tone, pm }: {
  html?: string;
  lines?: string[];
  tone?: string;
  pm: boolean;
}) {
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showSearch) inputRef.current?.focus();
  }, [showSearch]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        e.stopPropagation();
        setShowSearch((s) => { if (!s) setTimeout(() => inputRef.current?.focus(), 0); return true; });
      }
      if (e.key === "Escape" && showSearch) { setSearch(""); setShowSearch(false); }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [showSearch]);

  const toneClass = tone === "bad" ? "text-alarm" : tone === "good" ? "text-signal" : tone === "muted" ? "text-muted-foreground" : "text-foreground";

  return (
    <div ref={containerRef} className="relative" tabIndex={-1}>
      {showSearch && (
        <div className="absolute right-0 top-0 z-10 flex items-center gap-1 rounded border border-line/40 bg-card px-2 py-0.5 shadow-sm">
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search…"
            autoComplete="off" spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); setSearch(""); setShowSearch(false); }
              e.stopPropagation();
            }}
            className="w-40 bg-transparent font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground/40"
          />
          {search && <span className="font-mono text-[11px] text-muted-foreground/50">{
            (() => {
              if (lines) return lines.filter((l) => l.toLowerCase().includes(search.toLowerCase())).length + " lines";
              if (html) { const raw = html.replace(/<[^>]+>/g, ""); const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"); return (raw.match(re)?.length ?? 0) + " hits"; }
              return "";
            })()
          }</span>}
          <button onClick={() => { setSearch(""); setShowSearch(false); }} className="text-muted-foreground/50 hover:text-muted-foreground"><XIcon className="size-3" /></button>
        </div>
      )}
      {lines !== undefined ? (
        <div className={`font-mono text-[13px] leading-6 whitespace-pre-wrap ${toneClass}`}>
          {(search
            ? lines.filter((l) => l.toLowerCase().includes(search.toLowerCase()))
            : lines
          ).map((line, i) => (
            <div key={i}>{search ? highlightText(pm ? line.replace(SECRET_RE, "[redacted by daimon]") : line, search) : (pm ? redactNode(line) : (linkify(line) || " "))}</div>
          ))}
        </div>
      ) : html !== undefined ? (
        <pre className="whitespace-pre-wrap font-mono text-[13px] leading-6">
          {search
            ? highlightText((pm ? redact(html) : html).replace(/<[^>]+>/g, ""), search)
            // eslint-disable-next-line react/no-danger
            : <span dangerouslySetInnerHTML={{ __html: pm ? redact(html) : html }} />
          }
        </pre>
      ) : null}
    </div>
  );
}

function OutView({ out, input = "", ctx = "", isLast = false }: { out: Out; input?: string; ctx?: string; isLast?: boolean }) {
  const pm = useContext(PresentationModeContext);
  const kubeDescribeInfo = parseKubeCmd(input);

  if ((out.kind === "ansi" || out.kind === "lines") && kubeDescribeInfo) {
    const raw = out.kind === "lines" ? out.lines.join("\n") : out.html.replace(/<[^>]+>/g, "");
    if (raw.trim().startsWith("{")) {
      // Extract node name from input: kubectl describe node <name>
      const nameM = input.trim().match(/describe\s+\S+\s+(\S+)/);
      const nodeName = nameM?.[1] ?? "";
      return <NodeDetailPanel json={raw} nodeName={nodeName} ctx={ctx} />;
    }
  }

  if (out.kind === "ansi") {
    const raw = out.html.replace(/<[^>]+>/g, "");
    const lang = detectLang(input, raw);
    if (lang) return <CodeView text={raw} lang={lang} />;
    return <SearchableOutput html={out.html} pm={pm} />;
  }

  if (out.kind === "lines") {
    const text = out.lines.join("\n");
    const lang = detectLang(input, text);
    if (lang) return <CodeView text={pm ? redact(text) : text} lang={lang} />;
    return <SearchableOutput lines={out.lines} tone={out.tone ?? undefined} pm={pm} />;
  }

  if (out.kind === "files")
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-6 gap-y-1.5">
        {out.items.map((it) => (
          <div key={it.name} className="flex items-baseline justify-between gap-3 font-mono text-[13px]">
            <span className={it.dir ? "text-signal" : "text-foreground"}>
              {it.name}{it.dir && "/"}
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground/70">
              {it.dir ? "dir" : it.size != null ? `${it.size} B` : ""}
            </span>
          </div>
        ))}
      </div>
    );

  if (out.kind === "lslong")
    return <LsLongView entries={out.entries} total={out.total} />;

  if (out.kind === "table")
    return <ExpandableTableView out={out} input={input} ctx={ctx} />;

  if (out.kind === "pairs")
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 font-mono text-[13px]">
        {out.pairs.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-muted-foreground/60">{k}</dt>
            <dd className="text-foreground">{v}</dd>
          </React.Fragment>
        ))}
      </dl>
    );

  if (out.kind === "gitlog")
    return <GitLogView entries={out.entries} cwd={out.cwd} kind="gitlog" isLast={isLast} />;

  if (out.kind === "gitbranches")
    return <GitBranchesView branches={out.branches} current={out.current} />;

  if (out.kind === "gitstatus")
    return <GitStatusView {...out} />;

  if (out.kind === "gitdiff")
    return <GitDiffView raw={out.raw} isLast={isLast} />;

  if (out.kind === "logfmt")
    return <LogfmtView lines={out.lines} />;

  if (out.kind === "pretty")
    return <PrettyView format={out.format} text={out.text} />;

  return null;
}

function StdinRow({ sessionId }: { sessionId: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="mt-2 flex items-center gap-1.5 font-mono text-[13px]">
      <span className="text-amber-400/80">›</span>
      <input
        ref={ref}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        className="flex-1 bg-transparent text-foreground outline-none [caret-color:var(--color-foreground)] placeholder:text-muted-foreground/40"
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key === "c") {
            e.preventDefault();
            sendRaw(sessionId, "\x03");
            (e.target as HTMLInputElement).value = "";
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            sendRaw(sessionId, (e.target as HTMLInputElement).value + "\n");
            (e.target as HTMLInputElement).value = "";
          }
        }}
      />
    </div>
  );
}

export function BlockView({ block, onRerun, isLast, currentCtx = "", sessionId = "", isTuiActive = false, gazeFocused = false, promptingForInput = false }: { block: Block; onRerun: (cmd: string) => void; isLast?: boolean; currentCtx?: string; sessionId?: string; isTuiActive?: boolean; gazeFocused?: boolean; promptingForInput?: boolean; tuiHandle?: import("@/components/daimon/XTermPanel").XTermHandle | undefined }) {
  const ok = block.code === 0;
  const failed = !block.pending && !ok;
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (!isLast) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "e" || e.key === "E")) {
        e.preventDefault();
        setExpanded((x) => !x);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isLast]);

  // Inline TUI: create xterm directly in this block's div
  const inlineTuiRef = useRef<HTMLDivElement>(null);
  // Seed from map in case altScreenEnter already fired before this component mounted
  const [tuiFullscreen, setTuiFullscreen] = useState(() => getAltScreen(sessionId));
  const tuiFitRef = useRef<(() => void) | null>(null);
  // Subscribe to alt-screen events at component level — independent of xterm mount timing
  useEffect(() => {
    if (!sessionId) return;
    // Re-check in case event arrived between useState init and effect setup
    setTuiFullscreen(getAltScreen(sessionId));
    return shell.onAltScreen((tabId, enter) => {
      if (tabId !== sessionId) return;
      setTuiFullscreen(enter);
    });
  }, [sessionId]);
  useEffect(() => {
    const el = inlineTuiRef.current;
    if (!el) return;
    if (tuiFullscreen) {
      const main = el.closest('main');
      const header = main?.querySelector('header');
      const mainLeft = main?.getBoundingClientRect().left ?? 0;
      const headerBottom = header?.getBoundingClientRect().bottom ?? 0;
      el.style.left = mainLeft + 'px';
      el.style.top = headerBottom + 'px';
    } else {
      el.style.left = '';
      el.style.top = '';
    }
    // double-rAF: first frame applies CSS, second measures after reflow
    requestAnimationFrame(() => requestAnimationFrame(() => {
      tuiFitRef.current?.();
      if (tuiFullscreen) {
        // second resize 150ms later, then Ctrl-L to force TUI app full redraw
        setTimeout(() => {
          tuiFitRef.current?.();
          sendRaw(sessionId, '\x0c');
        }, 150);
      }
    }));
  }, [tuiFullscreen]);
  useEffect(() => {
    if (!isTuiActive || !inlineTuiRef.current) return;
    const el = inlineTuiRef.current;
    const term = new Terminal({
      fontFamily: '"MesloLGS Nerd Font Mono", "MesloLGS NF", "MesloLGM Nerd Font", Monaco, Menlo, monospace, "Apple Color Emoji", "Segoe UI Emoji"',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowTransparency: true,
      theme: {
        background: "transparent",
        foreground: "#e6edf3",
        black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922",
        blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
        brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364",
        brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd", brightWhite: "#f0f6fc",
        cursor: "#58a6ff", selectionBackground: "#264f78",
      },
      allowProposedApi: true,
      scrollback: 10000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    term.open(el);
    tuiFitRef.current = () => { fit.fit(); resizePty(sessionId, term.cols, term.rows); };

    // Cell dimensions — measure once after open
    const CELL_H = 13 * 1.2; // fontSize * lineHeight
    const replay = getTuiReplayBuffer(sessionId);
    let altScreen = getAltScreen(sessionId);
    // If alt-screen already active at mount, pre-position so first fit.fit()
    // measures correct dimensions and PTY is sized correctly before TUI app draws.
    if (altScreen) {
      const main = el.closest('main');
      const header = main?.querySelector('header');
      const mainLeft = main?.getBoundingClientRect().left ?? 0;
      const headerBottom = header?.getBoundingClientRect().bottom ?? 0;
      el.style.left = mainLeft + 'px';
      el.style.top = headerBottom + 'px';
    }
    const updateHeight = () => {
      if (altScreen) {
        el.style.height = "";
        el.style.width = "";
      } else {
        el.style.height = "";
        el.style.width = "";
      }
      fit.fit();
      if (!altScreen) {
        const lines = term.buffer.active.length;
        el.style.height = Math.ceil(Math.max(lines, term.rows) * CELL_H) + "px";
      }
    };
    updateHeight();
    resizePty(sessionId, term.cols, term.rows);
    term.focus();
    term.onData((data) => sendRaw(sessionId, data));
    term.onResize(({ cols, rows }) => resizePty(sessionId, cols, rows));
    // ResizeObserver fires on every pixel change of <main> (window resize + sidebar animation).
    // Fire fit() directly each frame — DOM renderer has no glyph atlas to corrupt.
    let resizeRaf: number | null = null;
    const mainEl = el.closest('main') ?? el;
    const ro = new ResizeObserver(() => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        if (altScreen) {
          const header = mainEl.querySelector('header');
          const mainLeft = mainEl.getBoundingClientRect().left;
          const headerBottom = header?.getBoundingClientRect().bottom ?? 0;
          el.style.left = mainLeft + 'px';
          el.style.top = headerBottom + 'px';
        }
        updateHeight();
      });
    });
    ro.observe(mainEl);
    // Replay buffered bytes that arrived before this subscription was created
    for (const chunk of replay) term.write(new TextEncoder().encode(chunk));
    updateHeight();
    // Track alt-screen for updateHeight (setTuiFullscreen handled at component level)
    const offAlt = shell.onAltScreen((tabId, enter) => {
      if (tabId !== sessionId) return;
      altScreen = enter;
      updateHeight();
    });
    // Subscribe to PTY output
    const off = shell.onOutput((tabId, data) => {
      if (tabId !== sessionId) return;
      term.write(new TextEncoder().encode(data), () => updateHeight());
    });
    return () => {
      off();
      offAlt();
      ro.disconnect();
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      tuiFitRef.current = null;
      term.dispose();
    };
  // Only create once when isTuiActive first becomes true
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTuiActive]);

  const outputRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    setOverflows(el.scrollHeight > el.clientHeight + 4);
  });

  const copyOutput = () => {
    const text = block.out
      .flatMap((o) =>
        o.kind === "lines" ? o.lines :
        o.kind === "ansi" ? [o.html.replace(/<[^>]+>/g, "")] :
        o.kind === "pairs" ? o.pairs.map(([k, v]) => `${k}: ${v}`) :
        o.kind === "table" ? [o.head.join("\t"), ...o.rows.map((r) => r.join("\t"))] :
        o.kind === "gitlog" ? o.entries.map((e) => `${e.fullHash} ${e.date} ${e.subject} ${e.author}`) :
        o.kind === "gitbranches" ? o.branches.map((b) => b === o.current ? `* ${b}` : `  ${b}`) :
        o.kind === "gitdiff" ? o.raw.split("\n") :
        o.kind === "logfmt" ? o.lines.map((f) => Object.entries(f).map(([k, v]) => `${k}=${v}`).join(" ")) :
        o.kind === "pretty" ? [o.text] :
        []
      )
      .join("\n");
    const full = `$ ${block.input}\n${text}`.trimEnd();
    navigator.clipboard.writeText(full);
    toast.success(`Copied: ${full.slice(0, 80)}${full.length > 80 ? "…" : ""}`);
  };

  return (
    <article className={`rise group relative pl-9 transition-[background-color,padding,margin,border-radius] duration-150 ${failed ? "rounded-lg bg-alarm/5 py-2 pr-3 -mx-3" : ""} ${gazeFocused ? "rounded-lg ring-1 ring-signal/40 bg-signal/[0.03] px-3 -mx-3" : ""}`}>
      {/* icon center = top-[7px] + half of size = 11px, matching the timeline line at left-[11px] */}
      <div aria-hidden className="absolute left-[5px] top-[7px]">
        {block.pending
          ? <LoaderCircleIcon className="size-3 animate-spin text-signal" />
          : failed
            ? <XCircleIcon className="size-3.5 -ml-px -mt-px text-alarm" />
            : <div className="size-2 rounded-full ring-4 ring-background bg-signal" />
        }
      </div>
      <header className="flex flex-wrap items-center gap-x-3">
        <span className="font-mono text-[13px] text-muted-foreground">{displayPath(block.cwd)}</span>
        <button
          onClick={() => onRerun(block.input)}
          className={`font-mono text-[14px] font-medium underline-offset-4 hover:underline ${failed ? "text-alarm" : "text-foreground"}`}
          title="Run again"
        >
          {block.input}
        </button>
        {block.pending && (
          <button
            onClick={() => { sendRaw(sessionId, "\x03"); setTimeout(() => abandonRun(sessionId), 2000); }}
            title="Cancel (Ctrl-C)"
            className="ml-1 flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-alarm/80 hover:bg-alarm/10 hover:text-alarm transition-colors"
          >
            <XIcon className="size-3" />
            <span>cancel</span>
          </button>
        )}
        <span className="ml-auto flex items-center gap-3 font-mono text-[11px] tabular-nums text-muted-foreground/70">
          {failed && <span className="text-alarm/80">exit {block.code}</span>}
          <span>{block.ms} ms</span>
          <span>{block.at}</span>
          {block.out.length > 0 && (
            <button
              onClick={copyOutput}
              title="Copy output"
              className="transition-opacity rounded p-0.5 hover:bg-secondary"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          )}
        </span>
      </header>
      {/* Inline TUI: xterm mounted directly here for commands like hammer, fzf, etc. */}
      {isTuiActive && (
        <div
          ref={inlineTuiRef}
          className={tuiFullscreen
            ? "xterm-transparent fixed inset-0 z-50 bg-black"
            : "xterm-transparent mt-2.5 rounded"}
          style={{ minHeight: 0, willChange: 'transform' }}
        />
      )}
      {!isTuiActive && block.out.length > 0 && (
        <div className="relative mt-2.5">
          <div
            ref={outputRef}
            className={`space-y-3 overflow-hidden transition-all ${expanded ? "" : "max-h-80"}`}
          >
            {block.out.map((o, i) => (
              <OutView key={i} out={o} input={block.input} ctx={block.ctx || currentCtx} isLast={isLast && i === block.out.length - 1} />
            ))}
          </div>
          {(!expanded && overflows || expanded) && (
            <div className={`${!expanded && overflows ? "absolute bottom-0 left-0 right-0 bg-gradient-to-t from-paper to-transparent pt-8 pb-1" : "mt-1"} flex justify-center`}>
              <button
                onClick={() => setExpanded((x) => !x)}
                className="flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-0.5 font-mono text-[11px] text-muted-foreground shadow-sm hover:text-foreground transition-colors"
              >
                {expanded ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
                {expanded ? "collapse" : "expand"}
                {isLast && <span className="opacity-40 ml-0.5">⌘E</span>}
              </button>
            </div>
          )}
        </div>
      )}
      {block.pending && isLast && !isTuiActive && !STREAMING_INTERACTIVE_RE.test(block.input) && promptingForInput && (
        <StdinRow sessionId={sessionId} />
      )}
    </article>
  );
}
