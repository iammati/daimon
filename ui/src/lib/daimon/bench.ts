/// End-to-end benchmark mode. Off unless the app was started with DAIMON_BENCH, which
/// arrives here as ?bench=<JSON>: {"cmds": ["cat big.txt", …], "reps": 3}.
///
/// Each command goes through the normal composer path (submit → run → block → React),
/// and is timed from submit to the frame after its final block was painted. A rAF loop
/// records the longest gap between frames meanwhile: how unresponsive the UI got.
/// Results land in the `bench-result` pref (daimon.db) and the console.
import { perf, shell } from "./rpc";
import { lastWorkerStats } from "./parseClient";

type Spec = { cmds: string[]; reps?: number; warmupMs?: number };
type Api = { submit: (cmd: string) => Promise<void>; busy: () => boolean };

const spec: Spec | null = (() => {
  try {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get("bench");
    if (!raw) return null;
    url.searchParams.delete("bench");
    history.replaceState(history.state, "", url);
    return JSON.parse(raw) as Spec;
  } catch {
    return null;
  }
})();

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Watch frame intervals until stopped; returns the gaps in ms. */
function watchFrames() {
  const gaps: number[] = [];
  let last = performance.now();
  let on = true;
  const tick = (t: number) => {
    gaps.push(t - last);
    last = t;
    if (on) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => {
    on = false;
    return gaps;
  };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

let started = false;

export function startBench(api: () => Api) {
  if (!spec || started) return;
  started = true;
  void (async () => {
    await sleep(spec.warmupMs ?? 3000);
    const results: Record<string, unknown>[] = [];
    for (const cmd of spec.cmds) {
      for (let rep = 0; rep < (spec.reps ?? 1); rep++) {
        while (api().busy()) await sleep(50);
        await sleep(300);
        const stop = watchFrames();
        // When output reaches the UI: splits transport (daemon → socket → main thread) from
        // the work after it.
        let firstOut = 0, lastOut = 0, outChars = 0;
        const off = shell.onOutput((_tab, data) => {
          const t = performance.now();
          if (!firstOut) firstOut = t;
          lastOut = t;
          outChars += data.length;
        });
        const p0 = { ...perf };
        const t0 = performance.now();
        await api().submit(cmd);
        const tBlock = performance.now();
        off();
        await frame();
        await frame();
        const tPainted = performance.now();
        const gaps = stop();
        results.push({
          cmd,
          rep,
          first_output_ms: firstOut ? r1(firstOut - t0) : null,
          last_output_ms: lastOut ? r1(lastOut - t0) : null,
          output_chars: outChars,
          // main-thread ms: decoding daemon messages / output listeners (parsing) / per-frame snapshots
          msgs: perf.msgs - p0.msgs,
          json_ms: r1(perf.parseMs - p0.parseMs),
          listeners_ms: r1(perf.outputMs - p0.outputMs),
          snapshot_ms: r1(perf.paintMs - p0.paintMs),
          worker: lastWorkerStats ? Object.fromEntries(Object.entries(lastWorkerStats).map(([k, v]) => [k, r1(v)])) : null,
          block_ms: r1(tBlock - t0),
          painted_ms: r1(tPainted - t0),
          frames: gaps.length,
          frame_gap_p50_ms: r1(pct(gaps, 50)),
          frame_gap_p99_ms: r1(pct(gaps, 99)),
          frame_gap_max_ms: r1(Math.max(0, ...gaps)),
          dom_nodes: document.getElementsByTagName("*").length,
        });
      }
    }
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const out = JSON.stringify({
      ua: navigator.userAgent,
      js_heap_mb: mem ? r1(mem.usedJSHeapSize / 1e6) : null,
      results,
    });
    console.log("[bench]", out);
    await shell.prefSet("bench-result", out).catch(() => {});
  })();
}
