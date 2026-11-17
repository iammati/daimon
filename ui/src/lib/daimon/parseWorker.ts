/// The output parser, off the page's main thread (see parseClient.ts). One OutputStream per
/// running command, keyed by the id the page gave it.
import { OutputStream, htmlIsLines, isPartial, type Out } from "./parse";

export type ToWorker =
  | { t: "open"; id: number; input: string }
  | { t: "push"; id: number; data: string }
  | { t: "snap"; id: number; live: number }
  | { t: "final"; id: number };

/** Worker time spent per command (ms), sent with its final output — for bench mode. */
export type WorkerStats = { push: number; snap: number; prepare: number; final: number; first: number; last: number };

/**
 * Outputs on the wire. Posting an array of 50k strings costs ~10x posting the same text as
 * one string, so line lists travel joined with "\n" (no line holds one) in `joined`:
 * - "lines": `lines` is sent empty and rebuilt from joined[i];
 * - "ansi": joined[i] is its per-line html (non-enumerable `lines`, lost in postMessage
 *   otherwise); when the html is exactly that join (`htmlIsLines`), html is sent empty.
 */
/** `partial`: a live view showing only the end of the output. */
export type Wire = { out: Out[]; joined: (string | null)[]; htmlJoined: boolean[]; partial: boolean };
export type FromWorker =
  | { id: number; t: "snap" | "final"; wire: Wire; stats?: WorkerStats }
  /** After "final": that output as JSON, for saving the block (so the page needn't encode it). */
  | { id: number; t: "json"; json: string };

const hasNewline = (ls: string[]) => ls.some((l) => l.includes("\n"));

function encode(out: Out[]): Wire {
  const joined: (string | null)[] = [];
  const htmlJoined: boolean[] = [];
  const sent = out.map((o, i) => {
    joined[i] = null; htmlJoined[i] = false;
    if (o.kind === "lines" && o.lines.length && !hasNewline(o.lines)) {
      joined[i] = o.lines.join("\n");
      return { ...o, lines: [] };
    }
    if (o.kind === "ansi" && o.lines?.length) {
      if (htmlIsLines(o)) { joined[i] = o.html; htmlJoined[i] = true; return { kind: "ansi" as const, html: "" }; }
      joined[i] = o.lines.join("\n");
      return { kind: "ansi" as const, html: o.html };
    }
    return o;
  });
  return { out: sent, joined, htmlJoined, partial: out.some(isPartial) };
}

const runs = new Map<number, { stream: OutputStream; buf: string; stats: WorkerStats }>();

const reply = (id: number, t: "snap" | "final", out: Out[], stats?: WorkerStats) =>
  postMessage({ id, t, wire: encode(out), ...(stats ? { stats } : {}) } satisfies FromWorker);

// Between messages, convert lines the finished block will need (OutputStream.prepare), in
// small batches so arriving output is never held up: less is left to do when it ends.
let prepareQueued = false;
const PREPARE_BATCH = 2000;
function schedulePrepare() {
  if (prepareQueued) return;
  prepareQueued = true;
  setTimeout(() => {
    prepareQueued = false;
    let more = false;
    for (const run of runs.values()) {
      const t = performance.now();
      if (run.stream.prepare(PREPARE_BATCH)) more = true;
      run.stats.prepare += performance.now() - t;
    }
    if (more) schedulePrepare();
  }, 0);
}

onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.t === "open") {
    runs.set(m.id, { stream: new OutputStream(m.input), buf: "", stats: { push: 0, snap: 0, prepare: 0, final: 0, first: 0, last: 0 } });
    return;
  }
  const run = runs.get(m.id);
  if (!run) {
    // Already finished: still answer, the page waits for a reply to every request.
    if (m.t === "snap" || m.t === "final") reply(m.id, m.t, []);
    return;
  }
  const t = performance.now();
  if (m.t === "push") {
    run.buf += m.data; run.stream.push(m.data); schedulePrepare();
    run.stats.first ||= t; run.stats.last = t;
    run.stats.push += performance.now() - t;
    return;
  }
  if (m.t === "snap") { reply(m.id, "snap", run.stream.snapshot(run.buf, m.live)); run.stats.snap += performance.now() - t; return; }
  runs.delete(m.id);
  const out = run.stream.final(run.buf);
  run.stats.final = performance.now() - t;
  // first/last: when the first and last output reached the worker, relative to the final request
  run.stats.first -= t; run.stats.last -= t;
  reply(m.id, "final", out, run.stats);
  postMessage({ id: m.id, t: "json", json: JSON.stringify(out) } satisfies FromWorker);
};
