/// Parsing a running command's output, in a worker so the page's main thread only receives
/// output and paints. While a command floods output, the main thread's speed is what paces
/// it (the daemon applies backpressure), so parsing there slowed the output itself down.
///
/// Falls back to parsing on the page if the worker can't be started.
import { OutputStream, isPartial, type Out } from "./parse";
import type { FromWorker, ToWorker, Wire } from "./parseWorker";

export interface OutputParser {
  push(text: string): void;
  /** The current output, its end limited to `live` lines; `cb` gets the latest when ready. */
  snapshot(live: number, cb: (out: Out[]) => void): void;
  /**
   * The output now — after everything pushed so far — without waiting for the pacing.
   * `partial`: it shows only the end of a longer output (the finished one has more).
   */
  latest(live: number): Promise<{ out: Out[]; partial: boolean }>;
  /** The finished output (capped). Ends this parser. */
  final(): Promise<Out[]>;
  /** JSON.stringify of final()'s output, made off the main thread where possible. */
  outputJson(): Promise<string>;
}

/** Least time between two live snapshots: during a flood, ~25 repaints a second is plenty. */
const SNAPSHOT_GAP_MS = 40;

let worker: Worker | null | undefined;   // undefined: not tried yet
const handlers = new Map<number, (m: FromWorker) => void>();
let nextId = 1;

/** The worker's time on the last finished command (bench mode reads it). */
export let lastWorkerStats: import("./parseWorker").WorkerStats | null = null;

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./parseWorker.ts", import.meta.url), { type: "module", name: "daimon output parser" });
    worker.onmessage = (e: MessageEvent<FromWorker>) => handlers.get(e.data.id)?.(e.data);
    worker.onerror = (e) => {
      console.error("[parse] worker failed, parsing on the page from now on:", e.message);
      worker = null;
      for (const h of handlers.values()) h({ id: 0, t: "final", wire: { out: [{ kind: "lines", lines: ["(output lost: the parser stopped)"], tone: "bad" }], joined: [null], htmlJoined: [false], partial: false } });
      handlers.clear();
    };
  } catch (err) {
    console.error("[parse] no worker, parsing on the page:", err);
    worker = null;
  }
  return worker;
}

/** Rebuild the outputs from their wire form (see Wire in parseWorker.ts). */
function revive(m: { wire: Wire }): Out[] {
  const { out, joined, htmlJoined } = m.wire;
  out.forEach((o, i) => {
    const j = joined[i];
    if (j == null) return;
    if (o.kind === "lines") o.lines = j.split("\n");
    else if (o.kind === "ansi") {
      if (htmlJoined[i]) o.html = j;
      Object.defineProperty(o, "lines", { value: j.split("\n"), enumerable: false });
    }
  });
  return out;
}

export function outputParser(input: string): OutputParser {
  const w = getWorker();
  return w ? remoteParser(w, input) : localParser(input);
}

function localParser(input: string): OutputParser {
  const stream = new OutputStream(input);
  let buf = "";
  return {
    push(text) { buf += text; stream.push(text); },
    snapshot(live, cb) { cb(stream.snapshot(buf, live)); },
    latest(live) { const out = stream.snapshot(buf, live); return Promise.resolve({ out, partial: out.some(isPartial) }); },
    final() { return Promise.resolve(stream.final(buf)); },
    outputJson() { return this.final().then((o) => JSON.stringify(o)); },
  };
}

function remoteParser(w: Worker, input: string): OutputParser {
  const id = nextId++;
  const post = (m: ToWorker) => w.postMessage(m);
  post({ t: "open", id, input });

  let inFlight = false;          // a snapshot request is out
  let again: { live: number; cb: (out: Out[]) => void } | null = null;   // asked meanwhile
  let lastAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Snapshot replies come back in the order asked: each takes the next callback.
  const snapReplies: ((out: Out[], partial: boolean) => void)[] = [];
  let onFinal: ((out: Out[]) => void) | null = null;
  let resolveJson: (json: string) => void = () => {};
  const json = new Promise<string>((r) => { resolveJson = r; });

  const request = (live: number, cb: (out: Out[]) => void) => {
    const wait = lastAt + SNAPSHOT_GAP_MS - performance.now();
    if (wait > 0) {
      again = { live, cb };
      timer ??= setTimeout(() => {
        timer = null;
        const a = again; again = null;
        if (a && !inFlight) request(a.live, a.cb);
        else if (a) again = a;   // the reply will send it
      }, wait);
      return;
    }
    inFlight = true;
    lastAt = performance.now();
    snapReplies.push((out) => { inFlight = false; cb(out); });
    post({ t: "snap", id, live });
  };

  handlers.set(id, (m) => {
    if (m.t === "json") { handlers.delete(id); resolveJson(m.json); return; }
    if (m.t === "snap") {
      snapReplies.shift()?.(revive(m), m.wire.partial);
      // Output arrived while that one was out: show it too.
      const a = again; again = null;
      if (a && !timer) request(a.live, a.cb); else if (a) again = a;
      return;
    }
    if (timer) clearTimeout(timer);
    if (m.stats) lastWorkerStats = m.stats;
    const out = revive(m);
    if (m.id === 0) resolveJson(JSON.stringify(out));   // the worker died: no JSON will come
    onFinal?.(out);
  });

  return {
    push(text) { post({ t: "push", id, data: text }); },
    snapshot(live, cb) {
      if (inFlight || timer) { again = { live, cb }; return; }
      request(live, cb);
    },
    final() {
      again = null;
      return new Promise((resolve) => { onFinal = resolve; post({ t: "final", id }); });
    },
    outputJson() { return json; },
    latest(live) {
      return new Promise((resolve) => {
        snapReplies.push((out, partial) => resolve({ out, partial }));
        post({ t: "snap", id, live });
      });
    },
  };
}
