/// A minimal terminal screen, for output that moves the cursor but never takes over the
/// screen (fastfetch drawing its info beside the logo, progress bars, spinners): replays the
/// bytes the way a terminal would and returns the final text, colours kept as SGR, one
/// line per row — ready for the normal output parser.
///
/// Understood: printable text, CR/LF/BS/TAB, cursor movement (CUU/CUD/CUF/CUB/CNL/CPL/CHA/
/// CUP/HVP/VPA), erase in line/display (EL/ED) and SGR. Everything else (modes, OSC, other
/// escapes) is dropped. Each code point is one column.

type Cell = { ch: string; sgr: string };

/** Rows a cursor-addressed program sees (CUP rows count from the top of this window). */
const SCREEN_ROWS = 50;

const SEQ_RE =
  // CSI | OSC (BEL or ST) | DCS/SOS/PM/APC (ST) | other 2-byte ESC
  /\x1b\[([0-?]*)([ -/]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[^[\]PX^_]?/y;

export function renderScreen(raw: string): string {
  const rows: Cell[][] = [[]];
  let r = 0, c = 0;
  let sgr = "";   // SGR sequences in effect since the last reset

  const row = (i: number) => { while (rows.length <= i) rows.push([]); return rows[i]!; };
  const top = () => Math.max(0, rows.length - SCREEN_ROWS);
  const put = (ch: string) => {
    const line = row(r);
    while (line.length < c) line.push({ ch: " ", sgr: "" });
    line[c] = { ch, sgr };
    c++;
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "\x1b") {
      SEQ_RE.lastIndex = i;
      const m = SEQ_RE.exec(raw);
      if (!m) { i++; continue; }
      i += m[0].length;
      if (m[3] === undefined || m[2]) continue;   // not a CSI we handle
      const params = m[1]!;
      if (params.startsWith("?") || params.startsWith(">") || params.startsWith("=")) continue;
      const ps = params.split(";").map((p) => parseInt(p, 10));
      const n = (k = 0, d = 1) => (Number.isFinite(ps[k]) && ps[k]! > 0 ? ps[k]! : d);
      switch (m[3]) {
        case "A": r = Math.max(top(), r - n()); break;
        case "B": r += n(); row(r); break;
        case "C": c += n(); break;
        case "D": c = Math.max(0, c - n()); break;
        case "E": r += n(); row(r); c = 0; break;
        case "F": r = Math.max(top(), r - n()); c = 0; break;
        case "G": case "`": c = n() - 1; break;
        case "d": r = top() + n() - 1; row(r); break;
        case "H": case "f": r = top() + n(0) - 1; row(r); c = n(1) - 1; break;
        case "K": {
          const line = row(r), mode = ps[0] || 0;
          if (mode === 0) line.length = Math.min(line.length, c);
          else if (mode === 1) for (let k = 0; k <= c && k < line.length; k++) line[k] = { ch: " ", sgr: "" };
          else line.length = 0;
          break;
        }
        case "J": {
          const mode = ps[0] || 0;
          if (mode === 0) { row(r).length = Math.min(row(r).length, c); rows.length = r + 1; }
          else if (mode === 1) for (let k = top(); k <= r; k++) rows[k] = k < r ? [] : row(k).map((x, j) => (j <= c ? { ch: " ", sgr: "" } : x));
          else { rows.length = 0; rows.push([]); r = 0; c = 0; }
          break;
        }
        case "m": {
          // A reset (alone or leading) starts over; anything else adds to what's in effect.
          const resets = params === "" || ps[0] === 0;
          sgr = resets ? (params === "" || params === "0" ? "" : m[0]) : sgr + m[0];
          break;
        }
      }
      continue;
    }
    i++;
    if (ch === "\r") c = 0;
    else if (ch === "\n") { r++; row(r); }
    else if (ch === "\b") c = Math.max(0, c - 1);
    else if (ch === "\t") c = (Math.floor(c / 8) + 1) * 8;
    else if (ch < " " || ch === "\x7f") { /* other controls: ignore */ }
    else {
      // Keep a surrogate pair together.
      const code = ch.charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdbff && i < raw.length) { put(ch + raw[i]); i++; }
      else put(ch);
    }
  }

  // Trailing rows with nothing visible (coloured spaces — a palette, a bar — do count).
  while (rows.length && rows[rows.length - 1]!.every((cell) => cell.ch === " " && !cell.sgr)) rows.pop();
  const lines = rows.map((line) => {
    let out = "", cur = "";
    for (const cell of line) {
      if (cell.sgr !== cur) { out += "\x1b[0m" + cell.sgr; cur = cell.sgr; }
      out += cell.ch;
    }
    return cur ? out + "\x1b[0m" : out;
  });
  return lines.join("\n");
}
