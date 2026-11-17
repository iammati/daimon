/**
 * The UI's output pipeline outside the browser: feeds a file through OutputStream the way
 * run() does (PTY-sized chunks, one snapshot per 16 ms "frame"), then the end-of-block parse.
 * Times each stage and checks the streamed result against parseOutput (they must match).
 *
 *   bun tests/perf/ui-stream.ts <file> [<file>…]
 */
// shell.ts pulls in rpc.ts, which connects at import: give it inert browser globals.
const g = globalThis as Record<string, unknown>;
g.window = { location: { href: "http://x/" } };
g.history = { replaceState() {}, state: null };
g.sessionStorage = { getItem: () => null, setItem() {} };
g.WebSocket = class { send() {} close() {} };
g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);

const { OutputStream, parseOutput, splitHtmlLines } = await import("../../ui/src/lib/daimon/shell");
const { readFileSync } = await import("node:fs");

// Big files: what a PTY read typically carries under load, a snapshot per ~16 ms of output.
// Small ones: odd-sized pieces that cut escape sequences, a snapshot after each.
const chunking = (len: number) => (len > 1 << 20 ? { CHUNK: 4096, PER_FRAME: 64 } : { CHUNK: 37, PER_FRAME: 1 });

let failures = 0;
for (const path of process.argv.slice(2)) {
  const text = readFileSync(path, "utf8").replace(/\n/g, "\r\n"); // as the PTY delivers it
  const input = `cat ${path}`;
  const { CHUNK, PER_FRAME } = chunking(text.length);
  const s = new OutputStream(input);
  let buf = "";
  let pushMs = 0, snapMs = 0, snaps = 0, worstSnap = 0;
  for (let i = 0, n = 0; i < text.length; i += CHUNK, n++) {
    const c = text.slice(i, i + CHUNK);
    let t = performance.now();
    buf += c;
    s.push(c);
    pushMs += performance.now() - t;
    if (n % PER_FRAME === 0) {
      t = performance.now();
      s.snapshot(buf);
      const d = performance.now() - t;
      snapMs += d; snaps++; worstSnap = Math.max(worstSnap, d);
    }
  }
  let t = performance.now();
  const streamed = s.snapshot(buf);
  const finalSnapMs = performance.now() - t;
  t = performance.now();
  const parsed = parseOutput(buf, input);
  const parseMs = performance.now() - t;
  const same = JSON.stringify(streamed) === JSON.stringify(parsed);
  // The per-line html handed to the renderer must be what splitting the html gives.
  const a = streamed[0] as { kind: string; html?: string; lines?: string[] } | undefined;
  const linesOk = a?.kind !== "ansi" || !a.lines || JSON.stringify(a.lines) === JSON.stringify(splitHtmlLines(a.html!));
  if (!same || !linesOk) failures++;
  const r = (x: number) => Math.round(x);
  console.log(`${path.split("/").pop()}: push ${r(pushMs)} ms | ${snaps} snapshots ${r(snapMs)} ms (worst ${r(worstSnap)}) | final snapshot ${r(finalSnapMs)} ms | parseOutput ${r(parseMs)} ms | kind ${parsed[0]?.kind} | streamed == parsed: ${same}${a?.kind === "ansi" ? ` | lines ok: ${linesOk}` : ""}`);
}
process.exit(failures ? 1 : 0);
