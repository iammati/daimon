/**
 * InteractiveView — pager mode (less, git log, man).
 * PTY bytes → hidden xterm (ANSI parser) → buffer walk → styled HTML spans.
 * Scroll is handled in the DOM. Keys j/k/arrows/PgUp/PgDn scroll; q exits.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal, type IBufferCell } from "@xterm/xterm";

const PALETTE: Record<number, string> = {
  0:  "#1e293b", 1:  "#b91c1c", 2:  "#15803d", 3:  "#92400e",
  4:  "#1d4ed8", 5:  "#7e22ce", 6:  "#0e7490", 7:  "#64748b",
  8:  "#475569", 9:  "#dc2626", 10: "#16a34a", 11: "#b45309",
  12: "#2563eb", 13: "#9333ea", 14: "#0891b2", 15: "#0f172a",
};
const FG_DEFAULT = "#1e293b";

function fgFromCell(cell: IBufferCell): string {
  if (cell.isFgDefault()) return FG_DEFAULT;
  if (cell.isFgRGB()) { const v = cell.getFgColor(); return `rgb(${(v>>16)&0xff},${(v>>8)&0xff},${v&0xff})`; }
  if (cell.isFgPalette()) return PALETTE[cell.getFgColor()] ?? FG_DEFAULT;
  return FG_DEFAULT;
}

function bgFromCell(cell: IBufferCell): string | null {
  if (cell.isBgDefault()) return null;
  if (cell.isBgRGB()) { const v = cell.getBgColor(); return `rgb(${(v>>16)&0xff},${(v>>8)&0xff},${v&0xff})`; }
  if (cell.isBgPalette()) return PALETTE[cell.getBgColor()] ?? null;
  return null;
}

function escHtml(ch: string): string {
  return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
}

export type InteractiveHandle = { feed: (bytes: Uint8Array) => void };

type Props = {
  onReady: (handle: InteractiveHandle) => void;
  onKey: (data: string) => void;
  cols: number;
  rows: number;
};

const LINE_HEIGHT_PX = 13 * 1.6; // must match CSS

export function InteractiveView({ onReady, onKey, cols, rows }: Props) {
  const termRef  = useRef<Terminal | null>(null);
  const frameRef = useRef<number | null>(null);
  const scrollEl = useRef<HTMLDivElement>(null);
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;

  const [lines, setLines] = useState<string[]>([]);

  const flush = useCallback(() => {
    frameRef.current = null;
    const term = termRef.current;
    if (!term) return;
    const buf  = term.buffer.active;
    const cell = buf.getNullCell();
    const result: string[] = [];

    // Walk the entire scrollback so the DOM div holds the full history.
    // The user scrolls in the DOM; we don't need to track viewport ourselves.
    const totalLines = buf.length;
    for (let row = 0; row < totalLines; row++) {
      const line = buf.getLine(row);
      if (!line) { result.push(""); continue; }

      let html = "";
      let spanOpen = false;
      let prevFg = "", prevBg = "", prevDeco = "";

      for (let col = 0; col < term.cols; col++) {
        line.getCell(col, cell);
        const ch = cell.getChars() || " ";
        const fg = fgFromCell(cell);
        const bg = bgFromCell(cell);
        const bold      = cell.isBold()      === 1;
        const italic    = cell.isItalic()    === 1;
        const underline = cell.isUnderline() === 1;
        const deco = `${bold?"b":""}${italic?"i":""}${underline?"u":""}`;

        if (fg !== prevFg || (bg ?? "") !== prevBg || deco !== prevDeco) {
          if (spanOpen) html += "</span>";
          const style = [
            fg !== FG_DEFAULT ? `color:${fg}` : "",
            bg  ? `background:${bg}` : "",
            bold      ? "font-weight:bold"         : "",
            italic    ? "font-style:italic"        : "",
            underline ? "text-decoration:underline": "",
          ].filter(Boolean).join(";");
          if (style) { html += `<span style="${style}">`; spanOpen = true; }
          else spanOpen = false;
          prevFg = fg; prevBg = bg ?? ""; prevDeco = deco;
        }
        html += escHtml(ch);
      }
      if (spanOpen) html += "</span>";
      result.push(html.trimEnd());
    }
    while (result.length > 0 && result[result.length - 1] === "") result.pop();
    setLines(result);

    // Auto-scroll to bottom on new content (like a real pager)
    requestAnimationFrame(() => {
      const el = scrollEl.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(flush);
  }, [flush]);

  useEffect(() => {
    const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 10000 });
    termRef.current = term;

    const hidden = document.createElement("div");
    hidden.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;overflow:hidden;visibility:hidden;";
    document.body.appendChild(hidden);
    term.open(hidden);
    term.onRender(scheduleFlush);
    term.onResize(scheduleFlush);

    onReady({ feed: (bytes) => term.write(bytes) });

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      term.dispose();
      hidden.remove();
      termRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep hidden terminal sized to match declared cols/rows
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const c = cols || term.cols;
    const r = rows || term.rows;
    if (term.cols !== c || term.rows !== r) term.resize(c, r);
  }, [cols, rows]);

  // Keyboard handling: scroll DOM for nav keys, send q to PTY for exit
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = scrollEl.current;
      if (!el) return;

      switch (e.key) {
        case "ArrowDown": case "j":
          e.preventDefault();
          el.scrollBy(0, LINE_HEIGHT_PX);
          return;
        case "ArrowUp": case "k":
          e.preventDefault();
          el.scrollBy(0, -LINE_HEIGHT_PX);
          return;
        case "PageDown": case " ":
          e.preventDefault();
          el.scrollBy(0, el.clientHeight);
          return;
        case "PageUp": case "b":
          if (e.key === "b" && (e.ctrlKey || e.metaKey)) break; // don't trap Cmd+B
          e.preventDefault();
          el.scrollBy(0, -el.clientHeight);
          return;
        case "Home": case "g":
          e.preventDefault();
          el.scrollTop = 0;
          return;
        case "End": case "G":
          e.preventDefault();
          el.scrollTop = el.scrollHeight;
          return;
        case "q": case "Q": case "Escape":
          e.preventDefault();
          onKeyRef.current("q");
          return;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  if (lines.length === 0) return null;

  return (
    <div
      ref={scrollEl}
      style={{
        fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
        fontSize: 13,
        lineHeight: "1.6",
        whiteSpace: "pre",
        overflowX: "auto",
        overflowY: "auto",
        maxHeight: "70vh",
        marginTop: 8,
        outline: "none",
      }}
    >
      {lines.map((html, i) => (
        // eslint-disable-next-line react/no-danger
        <div key={i} dangerouslySetInnerHTML={{ __html: html || " " }} />
      ))}
    </div>
  );
}
