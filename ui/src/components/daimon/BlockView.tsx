import React, { useEffect, useLayoutEffect, useRef, useState, useContext, createContext, useMemo, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { createPortal } from "react-dom";
import { LoaderCircleIcon, XCircleIcon, ChevronDownIcon, GitBranchIcon, ChevronRightIcon, PlusIcon, ChevronUpIcon, XIcon, CircleDotIcon, CloudIcon, CloudOffIcon, ArrowUpIcon, ArrowDownIcon, CheckIcon } from "lucide-react";
import { toast } from "sonner";
import { Keys } from "./Kbd";
import { displayPath } from "@/lib/daimon/world";
import { shell } from "@/lib/daimon/rpc";
import { sendRaw, resizePty, getTuiReplayBuffer, getAltScreen, takeRedraw, STREAMING_INTERACTIVE_RE, abandonRun, looksLikeYaml } from "@/lib/daimon/shell";
import type { Block, Out, LsEntry, GitStatusFile, GitBranchNode } from "@/lib/daimon/shell";
import { Wraith } from "wraithterm";
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
export const PagerContainerContext = createContext<HTMLElement | null>(null);

// Patterns that look like secrets: API keys, tokens, passwords, JWTs, private keys
// Secret-looking content. Three families:
//  1. Known token shapes (GitHub/Slack/OpenAI/AWS/GitLab prefixes, JWTs, PEM private keys).
//  2. ENV-style `NAME=value` / `NAME: value` where NAME contains a secret keyword at a word
//     boundary (start or after `_`) — so SECRET_VALUE, TOKEN_FILE, KEY_PREFIX match but MONKEY
//     and TURKEY do not. Over-redaction in presentation mode is safe; silly false positives aren't.
//  3. Lowercase `password:`/`token=` etc. in free text.
const SECRET_RE = new RegExp(
  "(?:ghp_|gho_|ghs_|github_pat_|xox[baprs]-|sk-[a-zA-Z0-9]{16,}|pk-live_|pk-test_|AKIA|ASIA|glpat-)[A-Za-z0-9_\\-]{8,}" +
  "|eyJ[A-Za-z0-9_\\-]{10,}\\.eyJ[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}" +
  "|-----BEGIN[A-Z ]+PRIVATE KEY-----[\\s\\S]*?-----END[A-Z ]+PRIVATE KEY-----" +
  "|(\\b(?:[A-Za-z0-9]+_)*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH|APIKEY|PRIVATE)(?:_[A-Za-z0-9]+)*\\s*[=:]\\s*)\\S+" +
  "|(\\b(?:password|passwd|secret|token|api[_-]?key|auth[_-]?key|access[_-]?key|private[_-]?key|credential)\\w*\\s*[=:]\\s*)\\S+",
  "gi");

function redact(text: string): string {
  return text.replace(SECRET_RE, (_, p1, p2) =>
    (p1 ?? p2) ? `${p1 ?? p2}[redacted by daimon]` : "[redacted by daimon]"
  );
}

// Strip ansi-to-html markup to plain text and decode the entities the converter introduced, so
// secret patterns that were split across <span> tags become matchable again.
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function redactNode(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  const re = new RegExp(SECRET_RE.source, "gi");
  while ((match = re.exec(text)) !== null) {
    const prefix = match[1] ?? match[2] ?? "";
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (prefix) parts.push(prefix);
    parts.push(
      <mark key={key++} className="bg-amber-400/25 text-amber-300 rounded-[3px] px-0.5 not-italic">[redacted by daimon]</mark>
    );
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// Central, content-based redaction: scrub secret-looking substrings from a parsed Out REGARDLESS
// of how the output was classified (lines/ansi/pairs/table/logfmt/pretty/lslong/gitlog). Applied
// once at the render boundary when presentation mode is on, so no per-renderer path can leak and
// toggling presentation mode off restores the original (this transforms a copy, never the store).
function redactOut(out: Out): Out {
  switch (out.kind) {
    case "lines":   return { ...out, lines: out.lines.map(redact) };
    case "ansi":    return { ...out, html: redact(out.html) };
    case "pairs":   return { ...out, pairs: out.pairs.map(([k, v]) => [k, redact(`${k}=${v}`) !== `${k}=${v}` ? "[redacted by daimon]" : v]) as [string, string][] };
    case "table":   return { ...out, rows: out.rows.map((r) => r.map(redact)) };
    case "logfmt":  return { ...out, lines: out.lines.map((rec) => Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, redact(`${k}=${v}`) !== `${k}=${v}` ? "[redacted by daimon]" : v]))) };
    case "pretty":  return { ...out, text: redact(out.text) };
    case "gitdiff": return { ...out, raw: redact(out.raw) };
    case "lslong":  return { ...out, entries: out.entries.map((e) => ({ ...e, name: redact(e.name) })) };
    case "gitlog":  return { ...out, entries: out.entries.map((e) => ({ ...e, subject: redact(e.subject) })) };
    // image/files/gitbranches/gitstatus carry no free-form secret-bearing text
    default:        return out;
  }
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
  // YAML: strict structural check (shared with the output parser) — prose with a "word:" prefix stays plain.
  if (!/^--\w/.test(trimmed) && looksLikeYaml(text)) return "yaml";
  return null;
}

function CodeView({ text, lang }: { text: string; lang: string }) {
  const highlighted = useMemo(() => {
    try { return hljs.highlight(text, { language: lang }).value; }
    catch { return hljs.highlightAuto(text).value; }
  }, [text, lang]);
  return (
    <pre className="font-mono text-[length:var(--terminal-font-size,13px)] leading-6 overflow-x-auto">
      <code className={`hljs language-${lang}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
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

const SEARCH_MARK = "bg-amber-400/40 text-foreground rounded-[2px] not-italic";

function searchRanges(text: string, query: string): [number, number][] {
  if (!query) return [];
  const lt = text.toLowerCase(), lq = query.toLowerCase();
  const out: [number, number][] = [];
  let i = 0;
  while ((i = lt.indexOf(lq, i)) !== -1) { out.push([i, i + lq.length]); i += lq.length; }
  return out;
}

/** Render styled runs of one line, overlaying search-match marks across run boundaries. */
function renderSearchRuns(runs: { text: string; cls?: string | undefined }[], query: string): React.ReactNode {
  const full = runs.map((r) => r.text).join("");
  const ranges = searchRanges(full, query);
  const out: React.ReactNode[] = [];
  let pos = 0, key = 0;
  for (const r of runs) {
    const start = pos, end = pos + r.text.length;
    const cuts = new Set([start, end]);
    for (const [a, b] of ranges) {
      if (a > start && a < end) cuts.add(a);
      if (b > start && b < end) cuts.add(b);
    }
    const pts = [...cuts].sort((x, y) => x - y);
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k]!, b = pts[k + 1]!;
      const t = full.slice(a, b);
      if (ranges.some(([ra, rb]) => a >= ra && b <= rb)) out.push(<mark key={key++} className={SEARCH_MARK}>{t}</mark>);
      else if (r.cls) out.push(<mark key={key++} className={r.cls}>{t}</mark>);
      else out.push(<span key={key++}>{t}</span>);
    }
    pos = end;
  }
  return out;
}

function hl(text: string, query: string): React.ReactNode {
  return query ? renderSearchRuns([{ text }], query) : text;
}

function linkify(text: string): React.ReactNode {
  return linkifyAll(text, undefined);
}

const URL_RE = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
// Absolute paths and ~/paths — must be at word boundary, at least 2 segments or ~/
const PATH_RE = /(?:^|(?<=\s))(?:~\/[^\s"'<>]+|\/(?:[^\s"'<>/]+\/)+[^\s"'<>]*[^\s"'<>./])/g;

function linkifyAll(text: string, onPathClick: ((path: string) => void) | undefined): React.ReactNode {
  // Build a combined list of all matches (URL, path) sorted by index
  type Chunk = { start: number; end: number; node: React.ReactNode };
  const chunks: Chunk[] = [];
  let m: RegExpExecArray | null;
  let key = 0;

  const urlRe = new RegExp(URL_RE.source, "g");
  while ((m = urlRe.exec(text)) !== null) {
    chunks.push({
      start: m.index,
      end: m.index + m[0].length,
      node: (
        <a
          key={key++}
          href={m[0]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-signal underline underline-offset-2 hover:text-signal/80 break-all"
        >
          {m[0]}
        </a>
      ),
    });
  }

  if (onPathClick) {
    const pathRe = new RegExp(PATH_RE.source, "g");
    while ((m = pathRe.exec(text)) !== null) {
      if (chunks.some((c) => m!.index >= c.start && m!.index < c.end)) continue;
      const p = m[0];
      chunks.push({
        start: m.index,
        end: m.index + m[0].length,
        node: (
          <button
            key={key++}
            onClick={() => onPathClick(p)}
            className="font-mono text-signal/70 hover:text-signal hover:underline underline-offset-2 cursor-pointer"
          >
            {p}
          </button>
        ),
      });
    }
  }

  if (chunks.length === 0) return text;

  chunks.sort((a, b) => a.start - b.start);

  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const c of chunks) {
    if (c.start > last) parts.push(text.slice(last, c.start));
    parts.push(c.node);
    last = c.end;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 ? parts[0] : parts;
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

function DiffTable({ raw, search = "" }: { raw: string; search?: string }) {
  const rows = parseUnifiedDiff(raw);
  const charRuns = (left: string, right: string, side: 0 | 1, cls: string) =>
    renderSearchRuns((charDiff(left, right)[side] ?? []).map(([text, hi]) => ({ text, cls: hi ? cls : undefined })), search);
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
              if (row.kind === "hunk") return <tr key={i} className="bg-secondary/30"><td colSpan={2} className="px-3 py-0.5 text-muted-foreground/60">{hl(row.text, search)}</td></tr>;
              if (row.kind === "same") return <tr key={i} className="hover:bg-secondary/20"><td className="select-none px-2 text-right tabular-nums text-muted-foreground/30">{row.ln}</td><td className="whitespace-pre-wrap break-all px-3 py-0 text-foreground/70">{row.text ? hl(row.text, search) : " "}</td></tr>;
              return (
                <tr key={i}>
                  <td className="select-none px-2 text-right tabular-nums text-muted-foreground/30 bg-signal/5">{row.rln ?? ""}</td>
                  <td className="whitespace-pre-wrap break-all px-3 py-0 bg-signal/10 text-signal">{hl(row.right ?? "", search)}</td>
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
                  <td colSpan={5} className="px-3 py-0.5 text-muted-foreground/60">{hl(row.text, search)}</td>
                </tr>
              );
            }
            if (row.kind === "same") {
              return (
                <tr key={i} className="group hover:bg-secondary/20">
                  <td className="select-none px-2 text-right tabular-nums text-muted-foreground/30">{row.ln}</td>
                  <td className="whitespace-pre-wrap break-all px-3 py-0 overflow-hidden text-foreground/70">{row.text ? hl(row.text, search) : " "}</td>
                  {divider}
                  <td className="select-none px-2 text-right tabular-nums text-muted-foreground/30">{row.ln}</td>
                  <td className="whitespace-pre-wrap break-all px-3 py-0 overflow-hidden text-foreground/70">{row.text ? hl(row.text, search) : " "}</td>
                </tr>
              );
            }
            return (
              <tr key={i}>
                <td className="select-none px-2 text-right tabular-nums text-muted-foreground/30 bg-alarm/5">{row.lln ?? ""}</td>
                <td className={`overflow-hidden whitespace-pre-wrap break-all px-3 py-0 ${row.left !== null ? "bg-alarm/10 text-alarm" : "bg-transparent"}`}>
                  {row.left !== null && row.right !== null
                    ? charRuns(row.left, row.right, 0, "bg-transparent text-alarm not-italic")
                    : hl(row.left ?? "", search)}
                </td>
                {divider}
                <td className="select-none px-2 text-right tabular-nums text-muted-foreground/30 bg-signal/5">{row.rln ?? ""}</td>
                <td className={`overflow-hidden whitespace-pre-wrap break-all px-3 py-0 ${row.right !== null ? "bg-signal/10 text-signal" : "bg-transparent"}`}>
                  {row.left !== null && row.right !== null
                    ? charRuns(row.left, row.right, 1, "bg-transparent text-signal not-italic")
                    : hl(row.right ?? "", search)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FileDiffView({ fullHash, filePath, cwd, search = "" }: { fullHash: string; filePath: string; cwd: string; search?: string }) {
  const [diff, setDiff] = useState<string | "loading">("loading");

  useEffect(() => {
    shell.getFileDiff(fullHash, filePath, cwd).then(setDiff);
  }, [fullHash, filePath, cwd]);

  if (diff === "loading") return <p className="py-1 font-mono text-[13px] text-muted-foreground">Loading diff…</p>;
  if (!diff.trim()) return <p className="py-1 font-mono text-[13px] text-muted-foreground">No diff available.</p>;

  return <DiffTable raw={diff} search={search} />;
}

function CommitDetailView({
  fullHash, cwd, search = "",
  fileCursor, openFiles, onToggleFile, fileRowRefs, onLoaded,
}: {
  fullHash: string; cwd: string; search?: string;
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
        <p className="mb-2 font-mono text-[13px] text-muted-foreground/70 whitespace-pre-wrap">{hl(detail.body, search)}</p>
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
                <span className="flex-1 truncate font-mono text-[13px] text-foreground/80">{hl(f.path, search)}</span>
              </button>
              {fileOpen && (
                <div className="pb-2 pl-4">
                  <FileDiffView fullHash={fullHash} filePath={f.path} cwd={cwd} search={search} />
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
/** Max commits "expand all" opens in git log (each one fetches its file list). */
const EXPAND_ALL_LIMIT = 50;
type OpenPager = { pane: string | null };
/** Open pagers in open order; the last one per pane owns the keyboard. */
const openPagers: OpenPager[] = [];

/** One pager shortcut hint: keycap combos separated by "/", then a label. */
function PagerHint({ keys, label, className = "" }: { keys: string[]; label: string; className?: string }) {
  return (
    <span className={`flex items-center gap-1.5 ${className}`}>
      {keys.map((k, i) => (
        <React.Fragment key={k}>
          {i > 0 && <span className="text-muted-foreground/40">/</span>}
          <Keys combo={k} size="xs" />
        </React.Fragment>
      ))}
      <span>{label}</span>
    </span>
  );
}

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
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [search, setSearch] = useState("");
  const entryRef = useRef<OpenPager | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Resolve the pane this pager lives in before paint, so the overlay is
  // always scoped to its own split pane (never the whole window).
  useLayoutEffect(() => {
    const el = (sentinelRef.current?.closest("[data-pane]") as HTMLElement | null) ?? document.body;
    if (el !== container) setContainer(el);
  });
  const paneId = container && container !== document.body ? container.getAttribute("data-pane") : null;

  useEffect(() => {
    if (!fullscreen || !container) return;
    const entry: OpenPager = { pane: paneId };
    entryRef.current = entry;
    openPagers.push(entry);
    window.dispatchEvent(new CustomEvent("pager-open", { detail: { paneId } }));
    return () => {
      const i = openPagers.indexOf(entry);
      if (i >= 0) openPagers.splice(i, 1);
      if (entryRef.current === entry) entryRef.current = null;
      window.dispatchEvent(new CustomEvent("pager-close", { detail: { paneId } }));
    };
  }, [fullscreen, container, paneId]);

  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => {
      // Only the topmost pager in the focused pane reacts to keys.
      const me = entryRef.current;
      if (!me) return;
      const top = [...openPagers].reverse().find((p) => p.pane === me.pane);
      if (top !== me) return;
      if (container && container !== document.body && container.dataset["paneFocused"] === "false") return;
      const ae = document.activeElement as HTMLElement | null;
      const inSearch = ae === searchRef.current;
      // Another text field (e.g. a modal) has focus — leave its keys alone.
      if (!inSearch && ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;

      if (e.key === "Tab") { e.preventDefault(); return; }
      // Ctrl/Cmd+Shift+A: unambiguous with select-all (Ctrl/Cmd+A), so it works from the search field too.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        onToggleAll();
        return;
      }
      // Plain Ctrl/Cmd+A: no-op in the pager (no page-wide select-all); in search it selects the query.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
        if (!inSearch) e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        e.preventDefault();
        if (inSearch) { searchRef.current?.blur(); return; }
        setFullscreen(false);
        return;
      }
      if (inSearch) { onKey(e, true); return; } // let every character (q, /, f…) be typed
      // Free scrolling, independent of the row cursor: Shift+↑/↓ in line steps, PageUp/PageDown by page.
      const scroller = overlayRef.current?.querySelector<HTMLElement>("[data-pager-scroll]");
      if (scroller && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const line = 20;
        let dy = 0;
        if (e.shiftKey && e.key === "ArrowDown") dy = line * 3;
        else if (e.shiftKey && e.key === "ArrowUp") dy = -line * 3;
        else if (e.key === "PageDown") dy = scroller.clientHeight - line * 2;
        else if (e.key === "PageUp") dy = -(scroller.clientHeight - line * 2);
        if (dy) {
          e.preventDefault();
          // Key-repeat (holding the key) scrolls instantly so it stays fluid; single presses glide.
          scroller.scrollBy({ top: dy, behavior: e.repeat ? "auto" : "smooth" });
          return;
        }
      }
      if (e.key === "q") {
        e.preventDefault();
        setFullscreen(false);
        return;
      }
      if (e.key === "/" || e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      onKey(e, false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [fullscreen, container, onToggleAll, onKey]);

  if (!fullscreen) {
    return (
      <button
        className="flex items-center gap-3 py-1 font-mono text-[13px] hover:opacity-80 transition-opacity"
        onClick={() => setFullscreen(true)}
      >
        <span ref={sentinelRef} />
        {collapsedSummary}
        <span className="text-muted-foreground/40 text-[11px]">click to expand</span>
      </button>
    );
  }

  const isScoped = !!container && container !== document.body;
  return (
    <>
      <span ref={sentinelRef} style={{ display: "none" }} />
      {container && createPortal(
    <div ref={overlayRef} className={`${isScoped ? "absolute" : "fixed"} inset-0 z-50 flex flex-col bg-background pager-overlay font-mono text-[13px]`}>
      {/* Title row: exactly the height of the window's drag strip (TitleBar) that overlays it,
          and on Windows the caption buttons sit over its right end — so keep it short. The
          search box is `no-drag`; TitleBar forwards clicks through to it. Key hints: bottom bar. */}
      <div className="flex h-9 shrink-0 items-center gap-3 whitespace-nowrap border-b border-border px-4">
        <span className="text-muted-foreground/60">{title}</span>
        {headerMeta}
        <div className="no-drag relative ml-2">
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
      </div>
      {typeof children === "function" ? (children as (search: string) => React.ReactNode)(search) : children}
      <div className="flex shrink-0 items-center border-t border-border px-4 py-2">
        <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground/60">
          <PagerHint keys={["↑↓", "jk"]} label="navigate" />
          <PagerHint keys={["⇧↑↓"]} label="scroll" />
          <PagerHint keys={["←→", "hl"]} label="expand" />
          <PagerHint keys={["Enter"]} label="toggle" />
          <PagerHint keys={["⌘⇧A"]} label={allCollapsed ? "expand all" : "collapse all"} className={allCollapsed ? "text-signal/80" : ""} />
          <PagerHint keys={["q", "⌘C"]} label="exit" />
        </span>
      </div>
    </div>,
    container
      )}
    </>
  );
}

function GitLogView({ entries: rawEntries, cwd, kind: _kind, isLast }: Extract<Out, { kind: "gitlog" }> & { isLast?: boolean }) {
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  const [commitIdx, setCommitIdx] = useState(0);
  const [fileIdx, setFileIdx] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openFiles, setOpenFiles] = useState<Record<string, Set<string>>>({});
  const [fileCounts, setFileCounts] = useState<Record<string, number>>({});
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
      isLast={isLast ?? false}
      collapsedSummary={<span className="text-muted-foreground/50">{entries.length} commit{entries.length !== 1 ? "s" : ""}</span>}
      headerMeta={<span className="text-muted-foreground/50">{entries.length} commit{entries.length !== 1 ? "s" : ""}</span>}
      allCollapsed={expanded.size === 0}
      onToggleAll={() => {
        if (expanded.size > 0) { setExpanded(new Set()); setFileIdx(null); return; }
        // Each expanded commit fetches its details — cap how many open at once.
        const visible = filteredRef.current;
        setExpanded(new Set(visible.slice(0, EXPAND_ALL_LIMIT).map((e) => e.hash)));
        if (visible.length > EXPAND_ALL_LIMIT) toast(`Expanded the first ${EXPAND_ALL_LIMIT} of ${visible.length} commits`, { duration: 2500 });
      }}
      onKey={onKey}
    >
      {(search: string) => {
        const lq = search.toLowerCase();
        // Expanded commits stay visible so matches inside their diffs can be seen;
        // loaded changed-file paths count as matches too.
        const filtered = search
          ? entries.filter((e) =>
              e.subject.toLowerCase().includes(lq) ||
              e.author.toLowerCase().includes(lq) ||
              e.hash.startsWith(search) || e.fullHash.startsWith(search) ||
              expanded.has(e.hash) ||
              (filePathsRef.current[e.hash] ?? []).some((p) => p.toLowerCase().includes(lq))
            )
          : entries;
        filteredRef.current = filtered;
        return (
          <div data-pager-scroll className="flex-1 overflow-y-auto divide-y divide-border/30">
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
                          fullHash={e.fullHash} cwd={cwd} search={search}
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

const fmtDuration = (ms: number) => {
  ms = Math.max(0, Math.round(ms));
  if (ms < 1000) return `${ms} ms`;
  const frac = String(ms % 1000).padStart(3, "0");
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}.${frac} s`;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = String(sec % 60).padStart(2, "0");
  return h ? `${h}h ${String(m).padStart(2, "0")}m ${s}.${frac}s` : `${m}m ${s}.${frac}s`;
};

/** Tooltip for a block's start time: full local date-time with zone, then the same instant in UTC. */
function stampTitle(ts: number): string {
  const d = new Date(ts);
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "local";
  return `${d.toLocaleString("sv-SE")} ${zone}\n${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * Block duration, to the millisecond. A running command repaints every animation frame off its
 * start time (writing the text node directly, so the block itself doesn't re-render per frame).
 */
function BlockDuration({ block }: { block: Block }) {
  const live = !!block.pending && !block.settled && block.ts != null;
  const ts = block.ts;
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!live || ts == null) return;
    let raf = 0;
    const paint = () => {
      if (ref.current) ref.current.textContent = fmtDuration(Date.now() - ts);
      raf = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(raf);
  }, [live, ts]);
  // The loop above writes the text node behind React's back; resync once it stops.
  useEffect(() => {
    if (!live && ref.current) ref.current.textContent = fmtDuration(block.ms);
  }, [live, block.ms]);
  return <span ref={ref}>{fmtDuration(live && ts != null ? Date.now() - ts : block.ms)}</span>;
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

function LsLongView({ entries, total, onCd, cwd }: Extract<Out, { kind: "lslong" }> & { onCd?: (path: string) => void; cwd?: string }) {
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

          const clickTarget = isDir
            ? (cwd ? `${cwd}/${e.name}` : e.name)
            : isLink && e.link
            ? e.link
            : null;

          return (
            <div
              key={e.name}
              className={`group flex items-center gap-3 rounded px-1 py-[2px] font-mono text-[13px] leading-[1.6] transition-colors hover:bg-secondary/30 ${isHidden ? "opacity-60 hover:opacity-100" : ""}`}
            >
              <PermBadge perms={e.perms} />
              <span className="w-[3.5rem] shrink-0 text-right tabular-nums text-[12px] text-foreground/40">{humanSize(e.size)}</span>
              <span className="w-[5.5rem] shrink-0 text-[12px] text-muted-foreground/45 tabular-nums">{lsDate(e.month, e.day, e.time)}</span>
              <span className={`flex-1 truncate ${nameColor}`}>
                {onCd && clickTarget ? (
                  <button
                    className="font-mono hover:text-signal hover:underline cursor-pointer"
                    onClick={() => onCd(clickTarget)}
                  >
                    {e.name}{isDir && <span className="text-foreground/30">/</span>}
                  </button>
                ) : (
                  <>{e.name}{isDir && <span className="text-foreground/30">/</span>}</>
                )}
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

type BranchTreeRow = { node: GitBranchNode; depth: number; guides: boolean[]; last: boolean };

/** Flatten the inferred parent links into display rows (DFS: trunk first, then recency of name). */
function branchTreeRows(nodes: GitBranchNode[], trunk: string | null | undefined): BranchTreeRow[] {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const kids = new Map<string | null, GitBranchNode[]>();
  for (const n of nodes) {
    const p = n.parent && byName.has(n.parent) ? n.parent : null;
    kids.set(p, [...(kids.get(p) ?? []), n]);
  }
  const order = (a: GitBranchNode, b: GitBranchNode) =>
    (a.name === trunk ? -1 : b.name === trunk ? 1 : 0) || a.name.localeCompare(b.name);
  const rows: BranchTreeRow[] = [];
  const MAX_DEPTH = 100;
  const walk = (parent: string | null, depth: number, guides: boolean[]) => {
    if (depth > MAX_DEPTH) return;
    const list = [...(kids.get(parent) ?? [])].sort(order);
    list.forEach((node, i) => {
      const last = i === list.length - 1;
      rows.push({ node, depth, guides, last });
      walk(node.name, depth + 1, depth === 0 ? [] : [...guides, !last]);
    });
  };
  walk(null, 0, []);
  return rows;
}

/** Tree connector for one indentation level: │ (continues), ├ / └ (this row's own joint). */
function TreeGuide({ kind }: { kind: "pass" | "blank" | "tee" | "elbow" }) {
  return (
    <span className="relative w-5 shrink-0 self-stretch">
      {(kind === "pass" || kind === "tee") && <span className="absolute left-2 top-0 bottom-0 border-l border-border" />}
      {kind === "elbow" && <span className="absolute left-2 top-0 h-1/2 border-l border-border" />}
      {(kind === "tee" || kind === "elbow") && <span className="absolute left-2 top-1/2 w-2.5 border-t border-border" />}
    </span>
  );
}

function BranchUpstream({ n }: { n: GitBranchNode }) {
  if (!n.upstream) {
    return <span className="flex items-center gap-1 text-muted-foreground/35" title="no upstream — local only"><CloudOffIcon className="size-3" />local</span>;
  }
  if (n.upGone) {
    return <span className="flex items-center gap-1 text-alarm/80" title={`${n.upstream} was deleted on the remote`}><CloudOffIcon className="size-3" />gone</span>;
  }
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground/55" title={`tracks ${n.upstream}`}>
      <CloudIcon className="size-3" />
      <span>{n.upstream}</span>
      {!n.upAhead && !n.upBehind && <CheckIcon className="size-3 text-emerald-400/70" />}
      {n.upAhead > 0 && <span className="text-amber-400/90">↑{n.upAhead}</span>}
      {n.upBehind > 0 && <span className="text-sky-400">↓{n.upBehind}</span>}
    </span>
  );
}

function GitBranchesView({ branches, current, trunk, nodes }: Extract<Out, { kind: "gitbranches" }>) {
  // Blocks saved before the tree existed only carry names — keep the flat list for them.
  if (!nodes?.length) {
    return (
      <div className="space-y-0.5">
        {branches.map((b) => (
          <div key={b} className="flex items-center gap-2 font-mono text-[13px] leading-6">
            <GitBranchIcon className={`size-3.5 ${b === current ? "text-signal" : "text-muted-foreground/40"}`} />
            <span className={b === current ? "text-signal" : "text-foreground"}>{b}</span>
          </div>
        ))}
      </div>
    );
  }

  const rows = branchTreeRows(nodes, trunk);
  return (
    <div className="font-mono text-[13px]">
      {rows.map(({ node: n, depth, guides, last }) => (
        <div key={n.name} className={`group flex items-stretch gap-2 rounded-sm pr-2 leading-7 ${n.current ? "bg-signal/[0.06]" : "hover:bg-foreground/[0.03]"}`}>
          {/* tree guides */}
          {depth > 0 && (
            <span className="flex shrink-0 pl-1">
              {guides.map((cont, i) => <TreeGuide key={i} kind={cont ? "pass" : "blank"} />)}
              <TreeGuide kind={last ? "elbow" : "tee"} />
            </span>
          )}

          {/* name + badges */}
          <span className={`flex min-w-0 shrink-0 items-center gap-1.5 ${depth === 0 ? "pl-1" : ""}`}>
            {n.current
              ? <CircleDotIcon className="size-3.5 shrink-0 text-signal" />
              : <GitBranchIcon className={`size-3.5 shrink-0 ${n.name === trunk ? "text-purple-400/80" : "text-muted-foreground/45"}`} />}
            <span className={n.current ? "font-medium text-signal" : n.name === trunk ? "text-purple-300" : "text-foreground/90"}>{n.name}</span>
            {n.current && <span className="rounded-sm bg-signal/15 px-1 text-[10px] leading-4 text-signal">HEAD</span>}
            {n.name === trunk && <span className="rounded-sm bg-purple-400/10 px-1 text-[10px] leading-4 text-purple-300/80">trunk</span>}
          </span>

          {/* divergence from parent */}
          {n.parent && (
            <span
              className="flex shrink-0 items-center gap-1.5 text-[11px]"
              title={`${n.ahead} commit${n.ahead === 1 ? "" : "s"} not on ${n.parent} · ${n.parent} has ${n.behind} newer`}
            >
              {n.ahead === 0 && n.behind === 0
                ? <span className="text-muted-foreground/35">= {n.parent}</span>
                : <>
                    <span className={`flex items-center ${n.ahead ? "text-emerald-400/80" : "text-muted-foreground/30"}`}><ArrowUpIcon className="size-3" />{n.ahead}</span>
                    <span className={`flex items-center ${n.behind ? "text-amber-400/80" : "text-muted-foreground/30"}`}><ArrowDownIcon className="size-3" />{n.behind}</span>
                  </>}
            </span>
          )}

          <span className="flex shrink-0 items-center text-[11px]"><BranchUpstream n={n} /></span>

          {/* tip commit */}
          <span className="ml-auto flex min-w-0 items-center gap-2 text-[11px]">
            <span className="shrink-0 text-amber-300/50">{n.hash}</span>
            <span className="truncate text-muted-foreground/55">{n.subject}</span>
            <span className="shrink-0 text-muted-foreground/30">{n.date}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

// git's own wording, so the view reads like `git status` at a glance.
const GIT_XY: Record<string, { label: string; cls: string }> = {
  M: { label: "modified", cls: "text-amber-400/90" },
  A: { label: "new file", cls: "text-signal" },
  D: { label: "deleted", cls: "text-alarm" },
  R: { label: "renamed", cls: "text-sky-400" },
  C: { label: "copied", cls: "text-sky-400" },
  T: { label: "typechange", cls: "text-purple-400" },
  U: { label: "conflict", cls: "text-alarm" },
};

function splitPath(p: string): [dir: string, base: string] {
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  const i = trimmed.lastIndexOf("/");
  const tail = p.endsWith("/") ? "/" : "";
  return i < 0 ? ["", trimmed + tail] : [trimmed.slice(0, i + 1), trimmed.slice(i + 1) + tail];
}

function GitPath({ path, dim, onCd }: { path: string; dim?: boolean; onCd?: ((path: string) => void) | undefined }) {
  const [dir, base] = splitPath(path);
  const body = (
    <>
      {dir && <span className="text-muted-foreground/45">{dir}</span>}
      <span className={dim ? "text-foreground/60" : "text-foreground/90"}>{base}</span>
    </>
  );
  return onCd ? (
    <button className="truncate text-left font-mono underline-offset-4 decoration-muted-foreground/30 hover:underline" title={`cd ${dir || "."}`} onClick={() => onCd(path)}>{body}</button>
  ) : (
    <span className="truncate">{body}</span>
  );
}

function GitStatusSection({
  title, hint, rail, items, onCd,
}: {
  title: string;
  hint: string;
  rail: string;
  items: { label: string; labelCls: string; path: string; from?: string | undefined; add?: number | undefined; del?: number | undefined; dim?: boolean }[];
  onCd?: ((path: string) => void) | undefined;
}) {
  return (
    <section className="group/sec relative pl-4">
      <span aria-hidden className={`absolute left-0 top-1 bottom-1 w-px ${rail}`} />
      <header className="mb-1.5 flex items-baseline gap-2 font-mono">
        <span className="text-[12px] font-medium text-foreground/85">{title}</span>
        <span className="rounded-full bg-secondary/60 px-1.5 text-[10px] tabular-nums text-muted-foreground">{items.length}</span>
        <span className="ml-auto text-[11px] text-muted-foreground/0 transition-colors group-hover/sec:text-muted-foreground/45">{hint}</span>
      </header>
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-baseline gap-x-3 font-mono text-[13px] leading-6">
        {items.map((it) => (
          <React.Fragment key={(it.from ?? "") + it.path}>
            <span className={`text-[11px] ${it.labelCls}`}>{it.label}</span>
            <span className="flex min-w-0 items-baseline gap-1.5">
              {it.from && (
                <>
                  <span className="truncate text-muted-foreground/45 line-through decoration-muted-foreground/25">{it.from}</span>
                  <span className="text-muted-foreground/40">→</span>
                </>
              )}
              <GitPath path={it.path} dim={it.dim ?? false} onCd={onCd} />
            </span>
            <span className="flex justify-end gap-2 text-[11px] tabular-nums">
              {!!it.add && <span className="text-signal/80">+{it.add}</span>}
              {!!it.del && <span className="text-alarm/80">−{it.del}</span>}
            </span>
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}

function GitStatusView({ branch, upstream, ahead, behind, staged, unstaged, untracked, added, removed, onCd }: Extract<Out, { kind: "gitstatus" }> & { onCd?: (path: string) => void }) {
  if (!branch) return <div className="font-mono text-[13px] text-muted-foreground/50">not a git repository</div>;
  const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;
  const conflicts = unstaged.filter((f) => f.xy.toUpperCase() === "U");
  const toItem = (isStaged: boolean) => (f: GitStatusFile) => {
    const info = GIT_XY[f.xy.toUpperCase()] ?? { label: f.xy, cls: "text-muted-foreground" };
    const labelCls = f.xy.toUpperCase() === "M"
      ? (isStaged ? "text-emerald-400" : "text-alarm")
      : info.cls;
    return { label: info.label, labelCls, path: f.path, from: f.from, add: f.add, del: f.del };
  };

  // Sync state, phrased like git but compact.
  let sync: React.ReactNode;
  if (!upstream) sync = <span className="text-muted-foreground/50">no upstream</span>;
  else if (!ahead && !behind) sync = <span className="text-muted-foreground/60">up to date</span>;
  else sync = (
    <span className="flex items-center gap-2">
      {ahead > 0 && <span className="text-amber-400/90">↑{ahead} to push</span>}
      {behind > 0 && <span className="text-sky-400">↓{behind} to pull</span>}
    </span>
  );

  return (
    <div className="space-y-5 font-mono">
      {/* Branch / upstream */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <span className="flex items-center gap-1.5">
          <GitBranchIcon className="size-3.5 text-purple-400/80" />
          <span className="font-medium text-purple-300">{branch}</span>
        </span>
        {upstream && (
          <span className="flex items-center gap-1.5 text-[12px]">
            <span className="text-muted-foreground/35">→</span>
            <span className="text-muted-foreground/70">{upstream}</span>
          </span>
        )}
        <span className="text-[12px]">{sync}</span>
        {!clean && (
          <span className="ml-auto flex items-center gap-3 text-[11px] tabular-nums text-muted-foreground/60">
            <span>
              {[
                staged.length && `${staged.length} staged`,
                unstaged.length && `${unstaged.length} changed`,
                untracked.length && `${untracked.length} untracked`,
              ].filter(Boolean).join(" · ")}
            </span>
            {(!!added || !!removed) && (
              <span className="flex gap-1.5">
                <span className="text-signal/80">+{added ?? 0}</span>
                <span className="text-alarm/80">−{removed ?? 0}</span>
              </span>
            )}
          </span>
        )}
      </div>

      {clean && (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground/70">
          <span className="text-signal">✓</span>
          nothing to commit, working tree clean
        </div>
      )}

      {conflicts.length > 0 && (
        <GitStatusSection title="Unmerged paths" hint="fix conflicts, then git add <file>" rail="bg-alarm/60" items={conflicts.map(toItem(false))} onCd={onCd} />
      )}
      {staged.length > 0 && (
        <GitStatusSection title="Staged" hint="git restore --staged <file> to unstage" rail="bg-signal/60" items={staged.map(toItem(true))} onCd={onCd} />
      )}
      {unstaged.length - conflicts.length > 0 && (
        <GitStatusSection title="Not staged" hint="git add <file> to stage" rail="bg-amber-400/50" items={unstaged.filter((f) => f.xy.toUpperCase() !== "U").map(toItem(false))} onCd={onCd} />
      )}
      {untracked.length > 0 && (
        <GitStatusSection
          title="Untracked"
          hint="git add <file> to track"
          rail="bg-muted-foreground/30"
          items={untracked.map((p) => ({ label: p.endsWith("/") ? "dir" : "", labelCls: "text-muted-foreground/40", path: p, dim: true }))}
          onCd={onCd}
        />
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
    const spec = (o['spec'] ?? {}) as Record<string, unknown>;
    const status = (o['status'] ?? {}) as Record<string, unknown>;
    const meta = (o['metadata'] ?? {}) as Record<string, unknown>;

    const conditions: NodeCondition[] = ((status['conditions'] ?? []) as Record<string, string>[]).map((c) => ({
      type: c['type'] ?? "",
      status: c['status'] ?? "",
      reason: c['reason'] ?? "",
      message: c['message'] ?? "",
      lastTransition: c['lastTransitionTime'] ?? "",
    }));

    const capacity: Record<string, string> = { ...((status['capacity'] ?? {}) as Record<string, string>) };
    const allocatable: Record<string, string> = { ...((status['allocatable'] ?? {}) as Record<string, string>) };
    const nodeInfo: Record<string, string> = { ...((status['nodeInfo'] ?? {}) as Record<string, string>) };

    const taints: { key: string; effect: string; value?: string }[] =
      ((spec['taints'] ?? []) as { key: string; effect: string; value?: string }[]).map((t) => ({
        key: t.key, effect: t.effect, ...(t.value ? { value: t.value } : {}),
      }));

    return {
      labels: { ...((meta['labels'] ?? {}) as Record<string, string>) },
      annotations: { ...((meta['annotations'] ?? {}) as Record<string, string>) },
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
        // JSON: dimmed keys, neutral string values; colour only for numbers and true/false/null.
        const parts: React.ReactNode[] = [];
        let rest = line;
        let key = 0;
        // Match key: "..."
        const keyMatch = rest.match(/^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)/);
        if (keyMatch) {
          parts.push(<span key={key++}>{keyMatch[1]}</span>);
          parts.push(<span key={key++} className="text-[color:var(--code-key)]">{keyMatch[2]}</span>);
          parts.push(<span key={key++}>{keyMatch[3]}</span>);
          rest = rest.slice(keyMatch[0].length);
        }
        // Match value
        const strMatch = rest.match(/^("(?:[^"\\]|\\.)*")(,?\s*)$/);
        if (strMatch) {
          parts.push(<span key={key++} className="text-[color:var(--code-string)]">{strMatch[1]}</span>);
          parts.push(<span key={key++}>{strMatch[2]}</span>);
          return <div key={i}>{parts}</div>;
        }
        const numMatch = rest.match(/^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(,?\s*)$/);
        if (numMatch) {
          parts.push(<span key={key++} className="text-[color:var(--code-number)]">{numMatch[1]}</span>);
          parts.push(<span key={key++}>{numMatch[2]}</span>);
          return <div key={i}>{parts}</div>;
        }
        const boolMatch = rest.match(/^(true|false|null)(,?\s*)$/);
        if (boolMatch) {
          parts.push(<span key={key++} className="text-[color:var(--code-literal)]">{boolMatch[1]}</span>);
          parts.push(<span key={key++}>{boolMatch[2]}</span>);
          return <div key={i}>{parts}</div>;
        }
        parts.push(<span key={key++}>{rest}</span>);
        return <div key={i}>{parts}</div>;
      })
    : lines.map((line, i) => {
        // YAML: same palette as JSON — dimmed keys, neutral values, colour only for numbers and literals.
        if (/^---\s*$/.test(line)) return <div key={i} className="text-muted-foreground/40">{line}</div>;
        if (/^\s*#/.test(line)) return <div key={i} className="text-muted-foreground/50">{line}</div>;
        const kvMatch = line.match(/^(\s*)([\w.-]+)(:)(.*)$/);
        if (kvMatch) {
          const [, indent, k, colon, val = ""] = kvMatch;
          const valTrimmed = val.trim();
          const numMatch = valTrimmed.match(/^-?\d+(?:\.\d+)?$/);
          const valClass = numMatch ? "text-[color:var(--code-number)]" : /^(true|false|null|~|yes|no)$/i.test(valTrimmed) ? "text-[color:var(--code-literal)]" : valTrimmed ? "text-[color:var(--code-string)]" : "";
          return (
            <div key={i}>
              <span>{indent}</span>
              <span className="text-[color:var(--code-key)]">{k}</span>
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
    return { kubeCmd: getM[1]!.replace(/\s+/, " "), resource: getM[2]!, ...(nsM?.[1] ? { namespace: nsM[1] } : {}) };
  }
  // kubectl describe <resource> <name> — whole output is one describe
  const descM = t.match(/^(u8s\s+kubectl|u8s\s+k|kubectl|k)\s+describe\s+(\S+)\s+(\S+)(?:\s+.*)?$/);
  if (descM) {
    const nsM = t.match(/(?:-n|--namespace)\s+(\S+)/);
    return { kubeCmd: descM[1]!.replace(/\s+/, " "), resource: descM[2]!, ...(nsM?.[1] ? { namespace: nsM[1] } : {}), isDescribe: true as const };
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
  const allCollapsed = openFiles.size === 0;
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const filesRef = useRef(files);
  filesRef.current = files;
  const stateRef = useRef({ cursor, openFiles });
  stateRef.current = { cursor, openFiles };

  const toggle = useCallback((path: string) =>
    setOpenFiles((prev) => { const s = new Set(prev); s.has(path) ? s.delete(path) : s.add(path); return s; }), []);
  // Any file open → collapse all; none open → expand all.
  const toggleAll = useCallback(() =>
    setOpenFiles((prev) => (prev.size > 0 ? new Set() : new Set(filesRef.current.map((f) => f.path)))), []);

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
      isLast={isLast ?? false}
      collapsedSummary={<><span className="text-signal">+{totalAdd}</span><span className="text-alarm">-{totalDel}</span><span className="text-muted-foreground/50">{files.length} file{files.length !== 1 ? "s" : ""}</span></>}
      headerMeta={<><span className="text-signal">+{totalAdd}</span><span className="text-alarm">-{totalDel}</span><span className="text-muted-foreground/50">{files.length} file{files.length !== 1 ? "s" : ""}</span></>}
      allCollapsed={allCollapsed}
      onToggleAll={toggleAll}
      onKey={onKey}
    >
      {(search: string) => (
        <div data-pager-scroll className="flex-1 overflow-y-auto divide-y divide-border/30">
          {files.map((f, i) => {
            const hits = search ? countMatches(f.raw.slice(Math.max(0, f.raw.indexOf("\n@@"))), search) : 0;
            return (
            <div key={f.path}>
              <button
                ref={(el) => { rowRefs.current[i] = el; }}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${i === cursor ? "bg-accent" : "hover:bg-accent/50"}`}
                onClick={() => { setCursor(i); toggle(f.path); }}
              >
                <ChevronRightIcon className={`size-3 shrink-0 text-muted-foreground/40 transition-transform ${openFiles.has(f.path) ? "rotate-90" : ""}`} />
                <span className="w-10 shrink-0 text-right tabular-nums text-signal">+{f.additions}</span>
                <span className="w-10 shrink-0 text-right tabular-nums text-alarm">-{f.deletions}</span>
                <span className="flex-1 truncate text-foreground/80">{hl(f.path, search)}</span>
                {hits > 0 && <span className="shrink-0 rounded bg-amber-400/15 px-1.5 text-[11px] text-amber-400">{hits} match{hits !== 1 ? "es" : ""}</span>}
              </button>
              {openFiles.has(f.path) && (
                <div className="px-4 pb-3">
                  <DiffTable raw={f.raw} search={search} />
                </div>
              )}
            </div>
            );
          })}
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

// Count occurrences of query in text (case-insensitive)
function countMatches(text: string, query: string): number {
  if (!query) return 0;
  const lq = query.toLowerCase();
  const lt = text.toLowerCase();
  let n = 0, pos = 0;
  while ((pos = lt.indexOf(lq, pos)) !== -1) { n++; pos += lq.length; }
  return n;
}

// Highlight all occurrences; matchOffset = global index of first match in this text
function highlightWithCurrent(text: string, query: string, matchOffset: number, currentMatch: number): React.ReactNode {
  if (!query) return text;
  const lq = query.toLowerCase();
  const lt = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let last = 0, key = 0, localIdx = 0;
  let pos = lt.indexOf(lq, 0);
  while (pos !== -1) {
    if (pos > last) parts.push(text.slice(last, pos));
    const globalIdx = matchOffset + localIdx;
    const isCurrent = globalIdx === currentMatch;
    parts.push(
      <mark key={key++} className={`not-italic rounded px-0.5 ${isCurrent ? "bg-signal/60 text-foreground" : "bg-signal/20 text-foreground"}`}>
        {text.slice(pos, pos + query.length)}
      </mark>
    );
    last = pos + lq.length;
    localIdx++;
    pos = lt.indexOf(lq, last);
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? text : parts;
}

const VIRTUAL_THRESHOLD = 500;

const IMG_URL_RE = /^https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp)(\?[^\s]*)?$/i;

const URL_BARE_RE = /^https?:\/\/[^\s<>"{}|\\^`[\]]+$/;

function ContextMenu({ x, y, onCopy, onSearch, onOpenUrl, onClose }: {
  x: number; y: number;
  onCopy: () => void;
  onSearch: (() => void) | null;
  onOpenUrl: (() => void) | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", handler);
    return () => { document.removeEventListener("mousedown", handler); document.removeEventListener("keydown", handler); };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", left: x, top: y, zIndex: 9999 }}
      className="min-w-32 rounded border border-border bg-card py-1 shadow-lg"
    >
      <button className="block w-full px-3 py-1.5 text-left font-mono text-[12px] hover:bg-accent cursor-pointer" onClick={() => { onCopy(); onClose(); }}>Copy</button>
      {onSearch && <button className="block w-full px-3 py-1.5 text-left font-mono text-[12px] hover:bg-accent cursor-pointer" onClick={() => { onSearch(); onClose(); }}>Search</button>}
      {onOpenUrl && <button className="block w-full px-3 py-1.5 text-left font-mono text-[12px] hover:bg-accent cursor-pointer" onClick={() => { onOpenUrl(); onClose(); }}>Open URL</button>}
    </div>,
    document.body
  );
}

/** Character offset of a DOM position within `root`'s text. */
function textOffsetIn(root: Node, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(root);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** The DOM position `chars` characters into `root`'s text (clamped to the end). */
function positionAt(root: Node, chars: number): [Node, number] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let left = chars;
  let last: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (left <= n.length) return [n, left];
    left -= n.length;
    last = n;
  }
  return last ? [last, last.length] : [root, 0];
}

/**
 * Colored command output. While a command streams, the html is replaced on every
 * update, which would throw away a text selection made in it (even mid-drag) — so the
 * selection is carried across the swap by its character offsets.
 */
function AnsiHtml({ html }: { html: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sel = window.getSelection();
    const a = sel?.anchorNode, f = sel?.focusNode;
    const inA = !!a && el.contains(a), inF = !!f && el.contains(f);
    if (!sel || sel.isCollapsed || (!inA && !inF)) { el.innerHTML = html; return; }
    const aOff = inA ? textOffsetIn(el, a!, sel.anchorOffset) : 0;
    const fOff = inF ? textOffsetIn(el, f!, sel.focusOffset) : 0;
    // An end outside this output (selection spans blocks) is untouched by the swap.
    const outA: [Node, number] = [a!, sel.anchorOffset], outF: [Node, number] = [f!, sel.focusOffset];
    el.innerHTML = html;
    const [an, ao] = inA ? positionAt(el, aOff) : outA;
    const [fn, fo] = inF ? positionAt(el, fOff) : outF;
    try { sel.setBaseAndExtent(an, ao, fn, fo); } catch { /* position gone — nothing to restore */ }
  }, [html]);
  return <span ref={ref} />;
}

function SelectableLine({ children, onSearch }: { children: React.ReactNode; onSearch: ((q: string) => void) | null }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const selRef = useRef("");

  const getSel = () => window.getSelection()?.toString().trim() ?? "";

  const handleDoubleClick = (e: React.MouseEvent) => {
    // Browser default already selects a word; capture it or try caretRangeFromPoint
    let sel = getSel();
    if (!sel) {
      const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (range) { const sel2 = window.getSelection(); sel2?.removeAllRanges(); sel2?.addRange(range); sel = range.toString().trim(); }
    }
    selRef.current = sel;
  };

  const handleClick = (e: React.MouseEvent) => {
    if (e.detail !== 3) return;
    // Triple-click: select whole line content
    const sel = window.getSelection();
    if (!sel?.anchorNode) return;
    const range = document.createRange();
    range.selectNodeContents(sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement! : sel.anchorNode as Element);
    sel.removeAllRanges();
    sel.addRange(range);
    selRef.current = sel.toString().trim();
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    selRef.current = getSel();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const isUrl = menu ? URL_BARE_RE.test(selRef.current) : false;

  return (
    <div className="select-text cursor-text" onDoubleClick={handleDoubleClick} onClick={handleClick} onContextMenu={handleContextMenu}>
      {children}
      {menu && (
        <ContextMenu
          x={menu.x} y={menu.y}
          onCopy={() => { const t = selRef.current || getSel(); if (t) { navigator.clipboard.writeText(t); toast.success("Copied"); } }}
          onSearch={onSearch && selRef.current ? () => onSearch!(selRef.current) : null}
          onOpenUrl={isUrl ? () => window.open(selRef.current, "_blank", "noopener,noreferrer") : null}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 cursor-zoom-out"
      onClick={onClose}
    >
      <img src={src} alt="" className="max-w-[90vw] max-h-[90vh] object-contain" />
    </div>
  );
}

function VirtualLines({ visibleLines, toneClass, search, pm, currentMatch, matchOffsets, onSearch, onPathClick }: {
  visibleLines: string[];
  toneClass: string;
  search: string;
  pm: boolean;
  currentMatch?: number | undefined;
  matchOffsets?: number[] | undefined;
  onSearch?: ((q: string) => void) | null;
  onPathClick?: (path: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: visibleLines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24, // 1.5rem line-height
    overscan: 20,
  });

  // Follow the output as it grows, until the user scrolls up; scrolling back to the end resumes.
  const followRef = useRef(true);
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [visibleLines.length]);

  return (
    <div
      ref={parentRef}
      className="overflow-auto"
      style={{ maxHeight: "60vh" }}
      onScroll={(e) => {
        const el = e.currentTarget;
        followRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
      }}
    >
      <div
        className={`relative font-mono text-[13px] leading-6 whitespace-pre-wrap ${toneClass}`}
        style={{ height: rowVirtualizer.getTotalSize() }}
      >
        {rowVirtualizer.getVirtualItems().map((vrow) => {
          const line = visibleLines[vrow.index]!;
          return (
            <SelectableLine key={vrow.index} onSearch={onSearch ?? null}>
              <div style={{ position: "absolute", top: vrow.start, width: "100%" }}>
                {search
                  ? highlightWithCurrent(pm ? line.replace(SECRET_RE, "[redacted by daimon]") : line, search, matchOffsets?.[vrow.index] ?? 0, currentMatch ?? -1)
                  : (pm ? redactNode(line) : (linkifyAll(line, onPathClick) || " "))}
              </div>
            </SelectableLine>
          );
        })}
      </div>
    </div>
  );
}

function SearchableOutput({ html, lines, tone, pm, onSearch, onPathClick }: {
  html?: string;
  lines?: string[];
  tone?: string;
  pm: boolean;
  onSearch?: ((q: string) => void) | null;
  onPathClick?: (path: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
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

  // Reset current match when query changes
  useEffect(() => { setCurrentMatch(0); }, [search]);

  const toneClass = tone === "bad" ? "text-alarm" : tone === "good" ? "text-signal" : tone === "muted" ? "text-muted-foreground" : "text-foreground";

  // Compute per-line match offsets and total count (for lines mode)
  const { totalMatches, matchOffsets } = useMemo(() => {
    if (!lines || !search) return { totalMatches: 0, matchOffsets: undefined };
    let total = 0;
    const offsets = lines.map((l) => {
      const off = total;
      total += countMatches(pm ? l.replace(SECRET_RE, "[redacted by daimon]") : l, search);
      return off;
    });
    return { totalMatches: total, matchOffsets: offsets };
  }, [lines, search, pm]);

  // For html mode, count matches in raw text
  const htmlMatchCount = useMemo(() => {
    if (!html || !search) return 0;
    const raw = html.replace(/<[^>]+>/g, "");
    return countMatches(pm ? redact(raw) : raw, search);
  }, [html, search, pm]);

  const matchCount = lines ? totalMatches : htmlMatchCount;

  const clampedCurrent = matchCount > 0 ? Math.min(currentMatch, matchCount - 1) : 0;

  const useVirtual = (lines?.length ?? 0) > VIRTUAL_THRESHOLD;

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
              if (e.key === "Enter") { e.preventDefault(); setCurrentMatch((c) => matchCount > 0 ? (c + 1) % matchCount : 0); }
              e.stopPropagation();
            }}
            className="w-40 bg-transparent font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground/40"
          />
          {search && matchCount > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground/60 tabular-nums">{clampedCurrent + 1}/{matchCount}</span>
          )}
          {search && matchCount === 0 && (
            <span className="font-mono text-[11px] text-muted-foreground/40">no matches</span>
          )}
          {matchCount > 1 && (
            <>
              <button
                onClick={() => setCurrentMatch((c) => (c - 1 + matchCount) % matchCount)}
                className="text-muted-foreground/50 hover:text-muted-foreground px-0.5"
                title="Previous match"
              ><ChevronUpIcon className="size-3" /></button>
              <button
                onClick={() => setCurrentMatch((c) => (c + 1) % matchCount)}
                className="text-muted-foreground/50 hover:text-muted-foreground px-0.5"
                title="Next match"
              ><ChevronDownIcon className="size-3" /></button>
            </>
          )}
          <button onClick={() => { setSearch(""); setShowSearch(false); }} className="text-muted-foreground/50 hover:text-muted-foreground"><XIcon className="size-3" /></button>
        </div>
      )}
      {lines !== undefined ? (
        useVirtual ? (
          <VirtualLines visibleLines={lines} toneClass={toneClass} search={search} pm={pm} currentMatch={clampedCurrent} onSearch={onSearch ?? null} {...(onPathClick ? { onPathClick } : {})} {...(matchOffsets ? { matchOffsets } : {})} />
        ) : (
          <div className={`font-mono text-[13px] leading-6 whitespace-pre-wrap ${toneClass}`}>
            {lines.map((line, i) => {
              const trimmed = line.trim();
              if (!search && IMG_URL_RE.test(trimmed)) {
                return (
                  <div key={i}>
                    {linkifyAll(line, onPathClick)}
                    <img
                      src={trimmed}
                      alt=""
                      className="mt-1 max-h-20 cursor-zoom-in rounded block"
                      onClick={() => setLightboxSrc(trimmed)}
                    />
                  </div>
                );
              }
              return (
                <SelectableLine key={i} onSearch={onSearch ?? null}>
                  <div>{search
                    ? highlightWithCurrent(pm ? line.replace(SECRET_RE, "[redacted by daimon]") : line, search, matchOffsets?.[i] ?? 0, clampedCurrent)
                    : (pm ? redactNode(line) : (linkifyAll(line, onPathClick) || " "))}</div>
                </SelectableLine>
              );
            })}
          </div>
        )
      ) : html !== undefined ? (
        <pre className="whitespace-pre-wrap font-mono text-[13px] leading-6">
          {search
            ? highlightWithCurrent((pm ? redact(stripHtml(html)) : html.replace(/<[^>]+>/g, "")), search, 0, clampedCurrent)
            : pm
              // Presentation mode: strip ANSI/HTML tags to plain text FIRST, then redact. Secret
              // patterns (NAME=value) are broken up by the ansi <span> tags, so redacting the raw
              // html misses them — matching on plain text catches them. Colors are dropped here,
              // which is an acceptable trade to guarantee no secret leaks on a shared screen.
              ? <span>{redact(stripHtml(html))}</span>
              : <AnsiHtml html={html} />
          }
        </pre>
      ) : null}
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>
  );
}

function OutView({ out: rawOut, input = "", ctx = "", isLast = false, onSearch, onPathClick }: { out: Out; input?: string; ctx?: string; isLast?: boolean; onSearch?: ((q: string) => void) | null; onPathClick?: (path: string) => void }) {
  const pm = useContext(PresentationModeContext);
  // Content-based redaction at the render boundary: scrub secrets from the parsed output for
  // EVERY kind in one place when presentation mode is on. Non-destructive — the stored block is
  // untouched, so toggling presentation mode off restores the raw output.
  const out = pm ? redactOut(rawOut) : rawOut;
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const kubeDescribeInfo = parseKubeCmd(input);

  if (out.kind === "image") {
    return (
      <>
        <img
          src={out.src}
          alt="terminal image"
          className="max-w-full max-h-96 object-contain my-2 cursor-zoom-in rounded"
          onClick={() => setLightboxSrc(out.src)}
        />
        {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      </>
    );
  }

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
    const rawHtml = rawOut.kind === "ansi" ? rawOut.html : out.html;
    const raw = rawHtml.replace(/<[^>]+>/g, "");
    const lang = detectLang(input, raw);
    if (lang) return <CodeView text={pm ? redact(raw) : raw} lang={lang} />;
    // SearchableOutput redacts internally (with the amber highlight), so feed it the RAW html.
    return <SearchableOutput html={rawHtml} pm={pm} {...(onSearch != null ? { onSearch } : {})} {...(onPathClick ? { onPathClick } : {})} />;
  }

  if (out.kind === "lines") {
    const rawLines = rawOut.kind === "lines" ? rawOut.lines : out.lines;
    const text = rawLines.join("\n");
    const lang = detectLang(input, text);
    if (lang) return <CodeView text={pm ? redact(text) : text} lang={lang} />;
    // SearchableOutput redacts + highlights internally; feed RAW lines.
    return <SearchableOutput lines={rawLines} {...(out.tone ? { tone: out.tone } : {})} pm={pm} {...(onSearch != null ? { onSearch } : {})} {...(onPathClick ? { onPathClick } : {})} />;
  }

  if (out.kind === "files")
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-6 gap-y-1.5">
        {out.items.map((it) => (
          <div key={it.name} className="flex items-baseline justify-between gap-3 font-mono text-[13px]">
            {onPathClick && it.dir ? (
              <button
                className="font-mono text-signal hover:underline cursor-pointer"
                onClick={() => onPathClick(it.name)}
              >
                {it.name}/
              </button>
            ) : (
              <span className={it.dir ? "text-signal" : "text-foreground"}>
                {it.name}{it.dir && "/"}
              </span>
            )}
            <span className="text-[11px] tabular-nums text-muted-foreground/70">
              {it.dir ? "dir" : it.size != null ? `${it.size} B` : ""}
            </span>
          </div>
        ))}
      </div>
    );

  if (out.kind === "lslong")
    return <LsLongView kind="lslong" entries={out.entries} total={out.total} {...(onPathClick ? { onCd: onPathClick } : {})} />;

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
    return <GitBranchesView {...out} />;

  if (out.kind === "gitstatus")
    return <GitStatusView {...out} {...(onPathClick ? { onCd: onPathClick } : {})} />;

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

/** Collapsed output clamp; output taller than this is "long" and becomes collapsible. */
const COLLAPSED_MAX_PX = 320;

/** Terminal background. The WebGPU surface is opaque, so this is a solid color. */
const TUI_BG = "#0d1117";

export function BlockView({ block, onRerun, isLast, currentCtx = "", sessionId = "", isTuiActive = false, gazeFocused = false, promptingForInput = false, onSearch, onPathClick }: { block: Block; onRerun: (cmd: string) => void; isLast?: boolean; currentCtx?: string; sessionId?: string; isTuiActive?: boolean; gazeFocused?: boolean; promptingForInput?: boolean; onSearch?: ((q: string) => void) | null; onPathClick?: (path: string) => void }) {
  const ok = block.code === 0;
  const failed = !block.pending && !ok;
  const [expanded, setExpandedRaw] = useState(true);
  // Once the user toggles a block by hand, stop auto-collapsing it.
  const userToggledRef = useRef(false);
  const setExpanded = useCallback((v: boolean | ((x: boolean) => boolean)) => {
    userToggledRef.current = true;
    setExpandedRaw(v);
  }, []);

  // Super-shift (⌘⇧ hover + E) toggles collapse on this block.
  useEffect(() => {
    const onToggle = (e: Event) => {
      if ((e as CustomEvent).detail?.blockId === block.id) setExpanded((x) => !x);
    };
    window.addEventListener("block-toggle-collapse", onToggle);
    return () => window.removeEventListener("block-toggle-collapse", onToggle);
  }, [block.id, setExpanded]);

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
  }, [isLast, setExpanded]);

  // Inline TUI: the terminal is mounted directly in this block's div
  const inlineTuiRef = useRef<HTMLDivElement>(null);
  // Seed from map in case altScreenEnter already fired before this component mounted
  const [tuiFullscreen, setTuiFullscreen] = useState(() => getAltScreen(sessionId));
  const tuiFitRef = useRef<(() => void) | null>(null);
  // Subscribe to alt-screen events at component level — independent of terminal mount timing
  useEffect(() => {
    if (!sessionId) return;
    // Re-check in case event arrived between useState init and effect setup
    setTuiFullscreen(getAltScreen(sessionId));
    const unsub = shell.onAltScreen((tabId, enter) => {
      if (tabId !== sessionId) return;
      setTuiFullscreen(enter);
    });
    return () => { unsub(); };
  }, [sessionId]);
  useEffect(() => {
    const el = inlineTuiRef.current;
    if (!el) return;
    // Fullscreen is pure CSS (.tui-fullscreen covers the pane) — drop any inline
    // geometry left over from inline mode so `inset: 0` decides the size.
    el.style.left = '';
    el.style.top = '';
    el.style.width = '';
    el.style.height = '';
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
    // Wraith: libghostty-vt + a WebGPU renderer in a worker. It fits itself to the
    // host (its own ResizeObserver), speaks the kitty keyboard and graphics protocols,
    // and keeps scrollback inside its viewport. There is no other renderer: if WebGPU
    // is missing the block shows the error.
    let disposed = false;
    let term: Wraith | null = null;
    // Bytes that arrive while the engine is still mounting: the replay buffer first,
    // then whatever the PTY sends in the meantime, in order.
    const pending: string[] = [...getTuiReplayBuffer(sessionId)];
    const feed = (data: string) => {
      if (term) void term.write(data).catch((err) => console.error("[tui] write failed:", err));
      else pending.push(data);
    };
    const off = shell.onOutput((tabId, data) => {
      if (tabId === sessionId) feed(data);
    });
    const subs: { dispose(): void }[] = [];

    Wraith.mount(el, {
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10000,
      commandBlocks: false, // daimon draws its own blocks
      theme: {
        foreground: "#e6edf3",
        background: TUI_BG,
        cursor: "#58a6ff",
        palette: [
          "#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
          "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc",
        ],
      },
    }).then((t) => {
      if (disposed) { void t.dispose(); return; }
      term = t;
      subs.push(
        t.onData((data) => sendRaw(sessionId, data)),
        t.onResize(({ cols, rows }) => resizePty(sessionId, cols, rows)),
        t.onError((err) => console.error("[tui]", err)),
      );
      tuiFitRef.current = () => { t.fit(); resizePty(sessionId, t.cols, t.rows); };
      resizePty(sessionId, t.cols, t.rows);
      for (const chunk of pending.splice(0)) feed(chunk);
      t.focus();
      // Resumed full-screen program (the UI restarted while it ran): now that this
      // terminal listens, have it repaint.
      if (takeRedraw(sessionId)) shell.redraw(sessionId);
    }).catch((err: unknown) => {
      console.error("[tui] terminal failed to start:", err);
      if (!disposed) el.textContent = `Terminal failed to start: ${err instanceof Error ? err.message : String(err)}`;
    });
    return () => {
      disposed = true;
      off();
      subs.forEach((d) => d.dispose());
      tuiFitRef.current = null;
      void term?.dispose();
      term = null;
    };
  // Only create once when isTuiActive first becomes true
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTuiActive]);

  const outputRef = useRef<HTMLDivElement>(null);
  // "Long" = natural output height exceeds the collapsed clamp. Only long blocks are collapsible.
  const [isLong, setIsLong] = useState(false);
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    const long = el.scrollHeight > COLLAPSED_MAX_PX + 4;
    if (long !== isLong) setIsLong(long);
  });
  // Smart default: when a newer block arrives, auto-collapse this one if it's long.
  useEffect(() => {
    if (!isLast && isLong && !block.pending && !userToggledRef.current) setExpandedRaw(false);
  }, [isLast, isLong, block.pending]);

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
          <BlockDuration block={block} />
          <span title={block.ts ? stampTitle(block.ts) : undefined}>{block.at}</span>
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
      {/* Inline TUI: terminal mounted directly here for alt-screen apps (vim, htop, fzf).
          Inline it is a fixed-height viewport with its own scrollback. */}
      {isTuiActive && (
        <div
          ref={inlineTuiRef}
          className={tuiFullscreen
            ? "tui-fullscreen absolute inset-0 z-50"
            : "mt-2.5 h-[min(24rem,60vh)] overflow-hidden rounded"}
          style={{ minHeight: 0, background: TUI_BG }}
        />
      )}
      {!isTuiActive && block.out.length > 0 && (
        <div className="relative mt-2.5">
          <div
            ref={outputRef}
            data-collapsible={isLong ? (expanded ? "expanded" : "collapsed") : undefined}
            className="space-y-3 overflow-hidden transition-all"
            style={expanded || !isLong ? undefined : { maxHeight: COLLAPSED_MAX_PX }}
          >
            {block.out.map((o, i) => (
              <OutView key={i} out={o} input={block.input} ctx={block.ctx || currentCtx} isLast={!!isLast && i === block.out.length - 1} onSearch={onSearch ?? null} {...(onPathClick ? { onPathClick } : {})} />
            ))}
          </div>
          {!expanded && isLong && (
            <div className="absolute bottom-0 left-0 right-0 flex justify-center bg-gradient-to-t from-paper to-transparent pt-8 pb-1">
              <button
                onClick={() => setExpanded(true)}
                title="Expand (hold ⌘⇧ + E while hovering)"
                className="flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-0.5 font-mono text-[11px] text-muted-foreground shadow-sm hover:text-foreground transition-colors"
              >
                <ChevronDownIcon className="size-3" />
                expand
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
