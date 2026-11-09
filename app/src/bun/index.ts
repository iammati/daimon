import { BrowserWindow, ApplicationMenu } from "electrobun/bun";
import { resolve } from "node:path";

// ── Spawn pty-daemon ──────────────────────────────────────────────────────────
// In dev the daemon is already running (started separately).
// In prod it's bundled next to the app binary.
const isDev = process.env.NODE_ENV !== "production";

let daemonProc: ReturnType<typeof Bun.spawn> | null = null;

if (!isDev) {
  // Prod: daemon binary is in the same dir as this script
  const daemonPath = resolve(import.meta.dir, "../pty-daemon");
  daemonProc = Bun.spawn([daemonPath], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env },
  });
  console.log("[main] pty-daemon spawned, pid:", daemonProc.pid);
}

// ── Wait for daemon to be ready ───────────────────────────────────────────────
async function waitForDaemon(url: string, retries = 20): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      // WebSocket connect attempt
      const ws = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => { ws.close(); resolve(); };
        ws.onerror = () => reject();
      });
      return;
    } catch {
      await Bun.sleep(150);
    }
  }
  console.warn("[main] daemon not ready after retries, proceeding anyway");
}

await waitForDaemon("ws://localhost:7878");

const frontendUrl = isDev ? "http://localhost:7881" : "views://daimon2/index.html";

// ── App menu ──────────────────────────────────────────────────────────────────
ApplicationMenu.setApplicationMenu([
  {
    label: "daimon",
    submenu: [
      { role: "about" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "showAll" },
      { type: "separator" },
      { role: "quit" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  },
  {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  },
]);

// ── Window ────────────────────────────────────────────────────────────────────
new BrowserWindow({
  title: "daimon",
  url: frontendUrl,
  frame: { width: 1280, height: 800, x: 100, y: 100 },
});

console.log("[main] window opened →", frontendUrl);
