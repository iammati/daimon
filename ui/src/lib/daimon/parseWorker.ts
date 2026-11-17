/// The output parser, off the page's main thread (see parseClient.ts). One OutputStream per
/// running command, keyed by the id the page gave it.
import { OutputStream, type Out } from "./parse";

export type ToWorker =
  | { t: "open"; id: number; input: string }
  | { t: "push"; id: number; data: string }
  | { t: "snap"; id: number; live: number }
  | { t: "final"; id: number };

/** Worker time spent per command (ms), sent with its final output — for bench mode. */
export type WorkerStats = { push: number; snap: number; prepare: number; final: number; first: number; last: number };
export type FromWorker = { id: number; t: "snap" | "final"; out: Out[]; lines: (string[] | null)[]; stats?: WorkerStats };

const runs = new Map<number, { stream: OutputStream; buf: string; stats: WorkerStats }>();

// `lines` (an "ansi" Out's per-line html) is non-enumerable, so it doesn't survive
// postMessage on its own: send it alongside.
const reply = (id: number, t: FromWorker["t"], out: Out[], stats?: WorkerStats) =>
  postMessage({ id, t, out, lines: out.map((o) => (o.kind === "ansi" ? o.lines ?? null : null)), ...(stats ? { stats } : {}) } satisfies FromWorker);

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
  if (!run) return;
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
};
