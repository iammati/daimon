// Rendered-markdown view for .md files inside git diff / git log "changed files".
//
// A unified diff only carries the hunks, not the whole file, so each hunk is rendered
// on its own from its new-side text (context + added lines). Top-level blocks that
// contain added lines get a signal-coloured rail, removed lines are folded into a
// red marker, and anything that likely did NOT render as intended (unclosed fences,
// broken tables, leftover `**` / `](` in the output, stripped HTML, …) is listed as
// a diagnostic and outlined on the affected block.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { marked, type Token } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import { AlertTriangleIcon, CheckIcon, ChevronRightIcon, EyeIcon, FileDiffIcon } from "lucide-react";
import { useMarkdownRendered, toggleMarkdownRendered } from "@/lib/daimon/markdownMode";
import { shell } from "@/lib/daimon/rpc";
import "./MarkdownDiffView.css";

// ── remembered toggle (shared by every .md file in every diff view) ──────────

/** Small pill shown on a changed-file row; toggles every .md file at once. */
export function MarkdownModeToggle({ className = "" }: { className?: string }) {
  const on = useMarkdownRendered();
  return (
    <span
      role="button"
      tabIndex={-1}
      title={on ? "Showing rendered markdown — click for raw diff (m)" : "Render markdown files (m)"}
      onClick={(e) => { e.stopPropagation(); toggleMarkdownRendered(); }}
      onMouseDown={(e) => e.stopPropagation()}
      className={`inline-flex shrink-0 cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] leading-none transition-colors ${
        on ? "border-signal/50 bg-signal/10 text-signal" : "border-line/50 text-muted-foreground hover:bg-secondary hover:text-foreground"
      } ${className}`}
    >
      {on ? <FileDiffIcon className="size-3" /> : <EyeIcon className="size-3" />}
      {on ? "diff" : "preview"}
    </span>
  );
}

// ── diff → hunks ─────────────────────────────────────────────────────────────

type Removed = { lines: string[] };
type Hunk = {
  header: string;
  newStart: number;           // 1-based line of the first new-side line
  newCount: number;           // new-side line count (0 → pure deletion; newStart is then the line *before*)
  lines: string[];            // new-side text (context + added)
  added: boolean[];           // parallel to lines
  removedBefore: Map<number, Removed>; // new-side index → removed lines just before it (index === lines.length → at end)
};

function parseHunks(raw: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let pending: string[] = [];
  const flushRemoved = () => {
    if (!cur || pending.length === 0) return;
    const at = cur.lines.length;
    const prev = cur.removedBefore.get(at);
    cur.removedBefore.set(at, { lines: [...(prev?.lines ?? []), ...pending] });
    pending = [];
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("@@")) {
      flushRemoved();
      const m = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      cur = { header: line, newStart: m ? parseInt(m[1]!) : 1, newCount: m?.[2] !== undefined ? parseInt(m[2]) : 1, lines: [], added: [], removedBefore: new Map() };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("-")) { pending.push(line.slice(1)); continue; }
    flushRemoved();
    if (line.startsWith("+")) { cur.lines.push(line.slice(1)); cur.added.push(true); }
    else if (line.startsWith(" ") || line === "") { cur.lines.push(line.slice(1)); cur.added.push(false); }
  }
  flushRemoved();
  // A trailing "" from the final newline of the diff is not a real context line.
  for (const h of hunks) {
    while (h.lines.length && h.lines[h.lines.length - 1] === "" && !h.added[h.lines.length - 1] && !h.removedBefore.has(h.lines.length)) {
      h.lines.pop(); h.added.pop();
    }
  }
  return hunks;
}

// ── diagnostics ──────────────────────────────────────────────────────────────

type Diag = { line: number; msg: string; severity: "warn" | "info" };

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

function sourceDiagnostics(h: Hunk): Diag[] {
  const out: Diag[] = [];
  const abs = (i: number) => h.newStart + i;
  let fence: { ch: string; len: number; at: number } | null = null;
  const refsDefined = new Set<string>();
  for (const l of h.lines) {
    const m = l.match(/^ {0,3}\[([^\]]+)\]:\s*\S/);
    if (m) refsDefined.add(m[1]!.toLowerCase());
  }

  let tableStart = -1;
  const tableRows: { i: number; cells: number }[] = [];
  const countCells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).length;
  const flushTable = () => {
    if (tableStart < 0) return;
    const rows = tableRows.slice();
    tableStart = -1; tableRows.length = 0;
    if (rows.length < 2) return;
    const delim = h.lines[rows[1]!.i]!;
    if (!/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(delim)) {
      out.push({ line: abs(rows[0]!.i), severity: "warn", msg: "Pipe rows without a `|---|` delimiter row — renders as a paragraph, not a table" });
      return;
    }
    const want = rows[0]!.cells;
    for (const r of rows.slice(1)) {
      if (r.cells !== want) {
        out.push({ line: abs(r.i), severity: "warn", msg: `Table row has ${r.cells} cells, header has ${want} — extra cells are dropped / missing ones blank` });
      }
    }
  };

  h.lines.forEach((l, i) => {
    const fm = l.match(FENCE_RE);
    if (fence) {
      if (fm && fm[1]![0] === fence.ch && fm[1]!.length >= fence.len && l.trim() === fm[1]) fence = null;
      return;
    }
    if (fm) { flushTable(); fence = { ch: fm[1]![0]!, len: fm[1]!.length, at: i }; return; }

    if (/^\s*\|.*\|\s*$/.test(l) || (tableStart >= 0 && l.includes("|") && l.trim() !== "")) {
      if (tableStart < 0) tableStart = i;
      tableRows.push({ i, cells: countCells(l) });
    } else flushTable();

    const noCode = l.replace(/`+[^`]*`+/g, "");
    if ((noCode.match(/`/g) ?? []).length % 2 === 1) {
      out.push({ line: abs(i), severity: "warn", msg: "Unmatched backtick — inline code never closes" });
    }
    for (const m of noCode.matchAll(/\]\[([^\]]+)\]/g)) {
      if (!refsDefined.has(m[1]!.toLowerCase())) {
        out.push({ line: abs(i), severity: "info", msg: `Reference link [${m[1]}] not defined in this hunk (may be elsewhere in the file)` });
      }
    }
    for (const m of noCode.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
      if (!/^(https?:|data:)/.test(m[1]!)) {
        out.push({ line: abs(i), severity: "info", msg: `Relative image "${m[1]}" can't be shown in preview` });
      }
    }
  });
  flushTable();
  if (fence) {
    const f = fence as { ch: string; len: number; at: number };
    out.push({ line: abs(f.at), severity: "warn", msg: `Code fence ${f.ch.repeat(f.len)} is never closed${h.newStart > 1 ? " in this hunk" : ""} — everything after it renders as code` });
  }
  return out;
}

// Things that survived into the rendered *text* usually mean the syntax didn't parse.
const LEFTOVER: [RegExp, string][] = [
  [/\*\*|__(?=\w)/, "Literal `**`/`__` in output — bold didn't parse (unbalanced or adjacent to punctuation/space)"],
  [/\]\((?:[^)\s]*)\)?/, "Literal `](` in output — link syntax didn't parse"],
  [/!\[/, "Literal `![` in output — image syntax didn't parse"],
  [/^#{1,6}\S/m, "Heading marker without a space after `#` — rendered as plain text"],
  [/\[\^[^\]]+\]/, "Footnote reference — footnotes aren't supported by GFM preview"],
];

// ── rendering ────────────────────────────────────────────────────────────────

type RBlock = {
  key: string;
  html: string;
  startLine: number;          // absolute new-side line
  added: boolean;
  removed: Removed | null;    // removed lines right before this block
  diags: Diag[];
};

function tagCounts(html: string): Map<string, number> {
  const m = new Map<string, number>();
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.body.querySelectorAll("*").forEach((el) => {
    const k = `<${el.nodeName.toLowerCase()}>`;
    m.set(k, (m.get(k) ?? 0) + 1);
    for (const a of el.attributes) {
      const risky = /^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value));
      if (risky) { const ak = `${a.name}=`; m.set(ak, (m.get(ak) ?? 0) + 1); }
    }
  });
  return m;
}

function sanitize(html: string, onStripped: (what: string) => void): string {
  const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  if (clean !== html) {
    const before = tagCounts(html), after = tagCounts(clean);
    for (const [k, n] of before) if ((after.get(k) ?? 0) < n) onStripped(k);
  }
  return clean;
}

function renderHunk(h: Hunk, hi: number): { blocks: RBlock[]; trailingRemoved: Removed | null; diags: Diag[] } {
  const src = h.lines.join("\n");
  const tokens = marked.lexer(src, { gfm: true });
  const diags = sourceDiagnostics(h);
  const blocks: RBlock[] = [];
  let lineIdx = 0;
  let pendingRemoved = null as Removed | null;
  const rem = new Map(h.removedBefore); // consumed as blocks claim their removals
  const take = (i: number) => { const r = rem.get(i); rem.delete(i); return r; };
  const takeRemoved = (from: number, to: number) => {
    // collect removals anchored anywhere in [from, to)
    for (let i = from; i < to; i++) {
      const r = take(i);
      if (r) pendingRemoved = { lines: [...(pendingRemoved?.lines ?? []), ...r.lines] };
    }
  };

  tokens.forEach((tok: Token, ti) => {
    const nLines = (tok.raw.match(/\n/g) ?? []).length;
    const from = lineIdx;
    const span = Math.max(1, tok.raw.endsWith("\n") ? nLines : nLines + 1);
    const to = Math.min(h.lines.length, from + span);
    lineIdx += nLines;
    takeRemoved(from, tok.type === "space" ? to : from + 1);
    if (tok.type === "space") return;
    // removals inside a multi-line block are attributed to the block itself
    let innerRemoved: Removed | null = null;
    for (let i = from + 1; i < to; i++) {
      const r = take(i);
      if (r) innerRemoved = { lines: [...((innerRemoved as Removed | null)?.lines ?? []), ...r.lines] };
    }

    const blockDiags: Diag[] = [];
    const stripped = new Set<string>();
    const list = Object.assign([tok], { links: (tokens as unknown as { links: unknown }).links });
    let html = marked.parser(list as never, { gfm: true });
    html = sanitize(html, (w) => stripped.add(w));
    if (stripped.size) blockDiags.push({ line: h.newStart + from, severity: "warn", msg: `Removed unsafe HTML: ${[...stripped].join(", ")}` });

    if (tok.type !== "code" && tok.type !== "html") {
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("code, pre").forEach((n) => n.remove());
      const text = doc.body.textContent ?? "";
      for (const [re, msg] of LEFTOVER) if (re.test(text)) blockDiags.push({ line: h.newStart + from, severity: "warn", msg });
    }

    const lineDiags = diags.filter((d) => d.line >= h.newStart + from && d.line < h.newStart + Math.max(to, from + 1));
    const added = h.added.slice(from, to).some(Boolean);
    const removed: Removed | null = pendingRemoved || innerRemoved
      ? { lines: [...((pendingRemoved as Removed | null)?.lines ?? []), ...(innerRemoved?.lines ?? [])] }
      : null;
    pendingRemoved = null;
    blocks.push({ key: `${hi}:${ti}`, html, startLine: h.newStart + from, added, removed, diags: [...lineDiags, ...blockDiags] });
  });

  takeRemoved(lineIdx, h.lines.length + 1);
  const all = blocks.flatMap((b) => b.diags);
  // keep source diags that didn't land on a block (e.g. trailing lines)
  for (const d of diags) if (!all.includes(d)) all.push(d);
  all.sort((a, b) => a.line - b.line);
  return { blocks, trailingRemoved: pendingRemoved, diags: all };
}

// ── full document ────────────────────────────────────────────────────────────

/** Blob ids from the diff's `index <old>..<new>` line, and whether the file was deleted. */
function diffBlobs(raw: string): { oldBlob: string; newBlob: string; deleted: boolean } {
  const m = raw.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/m);
  const newBlob = m?.[2] ?? "";
  return { oldBlob: m?.[1] ?? "", newBlob, deleted: /^deleted file mode/m.test(raw) || /^0+$/.test(newBlob) };
}

/** Lay the diff's added/removed markers over the full new-side file as one big "hunk". */
function buildFullDoc(content: string, hunks: Hunk[], markChanges: boolean): { doc: Hunk; stale: boolean } {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const doc: Hunk = { header: "", newStart: 1, newCount: lines.length, lines, added: lines.map(() => false), removedBefore: new Map() };
  let stale = false;
  if (!markChanges) return { doc, stale };
  for (const h of hunks) {
    const base = h.newCount === 0 ? h.newStart : h.newStart - 1; // 0-based index of h.lines[0]
    h.lines.forEach((l, i) => {
      if (lines[base + i] !== l) stale = true;
      if (h.added[i] && base + i < lines.length) doc.added[base + i] = true;
    });
    for (const [i, r] of h.removedBefore) {
      const at = Math.min(base + i, lines.length);
      const prev = doc.removedBefore.get(at);
      doc.removedBefore.set(at, { lines: [...(prev?.lines ?? []), ...r.lines] });
    }
  }
  return { doc, stale };
}

type FullState = { status: "loading" } | { status: "ok"; content: string; deleted: boolean } | { status: "error"; error: string };

function RemovedMarker({ removed }: { removed: Removed }) {
  const [open, setOpen] = useState(false);
  const n = removed.lines.length;
  return (
    <div className="md-removed">
      <button className="md-removed-toggle" onClick={() => setOpen((o) => !o)}>
        <ChevronRightIcon className={`size-3 transition-transform ${open ? "rotate-90" : ""}`} />
        −{n} line{n !== 1 ? "s" : ""} removed
      </button>
      {open && <pre className="md-removed-body">{removed.lines.join("\n")}</pre>}
    </div>
  );
}

function BlockHtml({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>("pre code").forEach((c) => {
      const lang = [...c.classList].find((k) => k.startsWith("language-"))?.slice(9);
      if (lang && hljs.getLanguage(lang)) { c.classList.add("hljs"); c.innerHTML = hljs.highlight(c.textContent ?? "", { language: lang }).value; }
    });
    el.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((i) => { i.disabled = true; });
  }, [html]);
  return <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function MarkdownDiffView({ raw, path, cwd }: { raw: string; path: string; cwd?: string }) {
  const hunks = useMemo(() => parseHunks(raw), [raw]);
  const [full, setFull] = useState<FullState>(() => (cwd ? { status: "loading" } : { status: "error", error: "no working directory" }));

  useEffect(() => {
    if (!cwd) return;
    let alive = true;
    const { oldBlob, newBlob, deleted } = diffBlobs(raw);
    setFull({ status: "loading" });
    shell.getFileContent(deleted ? oldBlob : newBlob, path, cwd)
      .then((r) => {
        if (!alive) return;
        if (typeof r?.content === "string") setFull({ status: "ok", content: r.content, deleted });
        else setFull({ status: "error", error: r?.error ?? "unknown error" });
      })
      .catch((e: unknown) => { if (alive) setFull({ status: "error", error: String(e) }); });
    return () => { alive = false; };
  }, [raw, path, cwd]);

  const view = useMemo(() => {
    if (full.status === "loading") return null;
    if (full.status === "ok") {
      const { doc, stale } = buildFullDoc(full.content, hunks, !full.deleted);
      const r = renderHunk(doc, 0);
      const notes: Diag[] = [];
      if (full.deleted) notes.push({ line: 1, severity: "info", msg: "File was deleted — showing its last version" });
      if (stale) notes.push({ line: 1, severity: "info", msg: "File changed on disk since this diff — change markers may be off" });
      return { parts: [{ ...r, sep: null as string | null }], diags: [...notes, ...r.diags], fallback: null as string | null };
    }
    // Couldn't load the whole file: render the changed sections on their own.
    const parts = hunks.map((h, i) => ({ ...renderHunk(h, i), sep: h.newStart > 1 || hunks.length > 1 ? `⋯ from line ${h.newStart}` : null }));
    return { parts, diags: parts.flatMap((p) => p.diags), fallback: full.error };
  }, [full, hunks]);

  const allDiags = view?.diags ?? [];
  const warns = allDiags.filter((d) => d.severity === "warn");
  const [showDiags, setShowDiags] = useState(true);
  const [flash, setFlash] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const jumpTo = (line: number) => {
    const els = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-md-line]") ?? [])];
    let best: HTMLElement | null = null;
    for (const el of els) if (Number(el.dataset["mdLine"]) <= line) best = el;
    best?.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlash(best ? Number(best.dataset["mdLine"]) : null);
    window.setTimeout(() => setFlash(null), 1200);
  };

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^https?:/.test(href)) window.open(href, "_blank", "noopener,noreferrer");
  };

  if (!view) return <p className="py-1 font-mono text-[13px] text-muted-foreground">Loading {path}…</p>;
  if (view.fallback !== null && hunks.length === 0) return <p className="py-1 font-mono text-[13px] text-muted-foreground">Nothing to render (binary or rename-only change).</p>;

  return (
    <div ref={rootRef} className="mt-1 rounded border border-line/30 bg-background/50">
      {view.fallback !== null && (
        <div className="md-fallback">Couldn't load the full file ({view.fallback}) — showing changed sections only.</div>
      )}
      <div className={`md-diag-bar ${warns.length ? "md-diag-warn" : "md-diag-ok"}`}>
        <button className="md-diag-head" onClick={() => setShowDiags((s) => !s)} disabled={allDiags.length === 0}>
          {warns.length > 0 ? <AlertTriangleIcon className="size-3.5 shrink-0" /> : <CheckIcon className="size-3.5 shrink-0" />}
          {warns.length > 0 ? `${warns.length} rendering issue${warns.length !== 1 ? "s" : ""}` : "renders cleanly"}
          {allDiags.length - warns.length > 0 && <span className="opacity-60">· {allDiags.length - warns.length} note{allDiags.length - warns.length !== 1 ? "s" : ""}</span>}
          {allDiags.length > 0 && <ChevronRightIcon className={`ml-auto size-3 transition-transform ${showDiags ? "rotate-90" : ""}`} />}
        </button>
        {showDiags && allDiags.length > 0 && (
          <ul className="md-diag-list">
            {allDiags.map((d, i) => (
              <li key={i} className={d.severity === "warn" ? "md-diag-item-warn" : "md-diag-item-info"}>
                <button onClick={() => jumpTo(d.line)}>L{d.line}</button>
                <span>{d.msg}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="md-render" onClick={onClick}>
        <div className="md-page">
          {view.parts.map((r, hi) => (
            <React.Fragment key={hi}>
              {r.sep && <div className="md-hunk-sep">{r.sep}</div>}
              {r.blocks.map((b) => (
                <div
                  key={b.key}
                  data-md-line={b.startLine}
                  className={`md-block ${b.added ? "md-added" : ""} ${b.diags.some((d) => d.severity === "warn") ? "md-has-issue" : ""} ${flash === b.startLine ? "md-flash" : ""}`}
                  title={b.diags.map((d) => `L${d.line}: ${d.msg}`).join("\n") || (b.added ? "changed in this diff" : undefined)}
                >
                  {b.removed && <RemovedMarker removed={b.removed} />}
                  <BlockHtml html={b.html} />
                </div>
              ))}
              {r.trailingRemoved && <div className="md-block"><RemovedMarker removed={r.trailingRemoved} /></div>}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
