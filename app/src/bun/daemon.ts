// Finding (or starting) the pty-daemon.
//
// The daemon owns the shells and outlives the app, so tabs reopen with their shells —
// and any running command — intact. On launch the app looks for a running daemon
// (`pty-daemon --info`); if there is none it starts one with `--detach`, which returns
// once the daemon listens. DAIMON_PERSIST=0 instead ties the daemon to the app
// (`--exit-with-parent`): closing the app ends the sessions.
//
// Every client needs the daemon's token; the window gets it (and the port) in its URL.
//
// Windows: the app bundles the Linux daemon and runs it inside WSL (distro from the
// bundled "wsl-distro" file); Windows reaches it through WSL's localhost forwarding.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Daemon = { port: number; token: string };

type Info = {
  port: number;
  token: string;
  selfBuild: string;
  running: { pid: number; port: number; token: string; build: string } | null;
};

let tiedProc: ReturnType<typeof Bun.spawn> | null = null; // DAIMON_PERSIST=0: keeps stdin open

/** Open a WebSocket to the daemon; resolves with it open, or null. */
function open(d: Daemon, timeoutMs = 600): Promise<WebSocket | null> {
  return new Promise((done) => {
    const ws = new WebSocket(`ws://localhost:${d.port}/?token=${encodeURIComponent(d.token)}`);
    // A refused connection can take seconds to fail on Windows — don't wait for it.
    const timer = setTimeout(() => { ws.close(); done(null); }, timeoutMs);
    ws.onopen = () => { clearTimeout(timer); done(ws); };
    ws.onerror = () => { clearTimeout(timer); done(null); };
  });
}

async function reachable(d: Daemon): Promise<boolean> {
  const ws = await open(d);
  ws?.close();
  return !!ws;
}

async function waitReachable(d: Daemon, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(150)) {
    if (await reachable(d)) return true;
  }
  return false;
}

/** One request/response round trip. */
async function request<T>(d: Daemon, msg: object): Promise<T | null> {
  const ws = await open(d);
  if (!ws) return null;
  return new Promise((done) => {
    const timer = setTimeout(() => { ws.close(); done(null); }, 3000);
    ws.onmessage = (e) => {
      const ev = JSON.parse(String(e.data));
      if (ev.type === "response" && ev.req_id === "app") { clearTimeout(timer); ws.close(); done(ev.data as T); }
    };
    ws.send(JSON.stringify({ ...msg, req_id: "app" }));
  });
}

/** How to run the bundled daemon binary on this platform. */
function daemonCommand(): string[] {
  const daemonPath = resolve(import.meta.dir, "../pty-daemon");
  if (process.platform !== "win32") return [daemonPath];
  const distroFile = resolve(import.meta.dir, "../wsl-distro");
  const distro = existsSync(distroFile) ? readFileSync(distroFile, "utf8").trim() : "";
  const wsl = ["wsl.exe", ...(distro ? ["-d", distro] : []), "--cd", "~", "--exec"];
  const linuxPath = Bun.spawnSync([...wsl, "wslpath", "-u", daemonPath]).stdout.toString().trim();
  if (!linuxPath) console.error("[daemon] couldn't resolve the daemon path inside WSL", distro || "(default distro)");
  return [...wsl, linuxPath];
}

async function run(cmd: string[], args: string[]): Promise<string> {
  const p = Bun.spawn([...cmd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

/** Dev: dev.sh runs the daemon and exports its token and port. */
async function devDaemon(): Promise<Daemon | null> {
  const token = process.env.DAIMON_TOKEN;
  if (!token) {
    console.error("[daemon] DAIMON_TOKEN not set — start the app through dev.sh");
    return null;
  }
  const d = { token, port: Number(process.env.DAIMON_PORT) || 7878 };
  if (!(await waitReachable(d, 5000))) console.warn("[daemon] dev daemon not reachable on", d.port);
  return d;
}

export async function connectDaemon(isDev: boolean): Promise<Daemon | null> {
  if (isDev) return devDaemon();

  const cmd = daemonCommand();
  let info: Info;
  try {
    info = JSON.parse(await run(cmd, ["--info"]));
  } catch (err) {
    console.error("[daemon] `pty-daemon --info` failed:", err);
    return null;
  }
  const d: Daemon = { port: info.port, token: info.token };

  // A daemon is already running (the usual case after the first launch).
  if (info.running && (await reachable(d))) {
    if (info.running.build === info.selfBuild) return d;
    // It's an older build. Replacing it would end its shells, so only do that when it
    // has none; otherwise keep using it — the new one takes over next time it's idle.
    const status = await request<{ sessions: number }>(d, { type: "daemonInfo" });
    if (status && status.sessions > 0) {
      console.warn(`[daemon] running daemon is an older build with ${status.sessions} session(s) — keeping it`);
      return d;
    }
    console.log("[daemon] replacing idle daemon from an older build");
    await request(d, { type: "shutdown" });
    await Bun.sleep(300);
  }

  if (process.env.DAIMON_PERSIST === "0") {
    tiedProc = Bun.spawn([...cmd, "--exit-with-parent"], {
      stdin: "pipe", // held open for our lifetime: the daemon exits when it closes
      stdout: "inherit",
      stderr: "inherit",
    });
    console.log("[daemon] started (ends with the app), pid:", tiedProc.pid);
  } else {
    console.log("[daemon]", await run(cmd, ["--detach"]));
  }
  if (!(await waitReachable(d, 8000))) console.warn("[daemon] not reachable after start");
  return d;
}
