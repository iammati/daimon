import { BrowserWindow, ApplicationMenu } from "electrobun/bun";
import { resolve } from "node:path";
import { backdropForBlur, prepareWindow, setBackdrop, type BackdropKind } from "./winBackdrop";

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
        // A refused connection can take seconds to fail on Windows — don't wait for it.
        const timer = setTimeout(() => { ws.close(); reject(); }, 500);
        ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(); };
        ws.onerror = () => { clearTimeout(timer); reject(); };
      });
      return;
    } catch {
      await Bun.sleep(150);
    }
  }
  console.warn("[main] daemon not ready after retries, proceeding anyway");
}

await waitForDaemon("ws://localhost:7878");

// Native see-through windows composite reliably on macOS and on Windows (WebView2 +
// DWM, which also gives real desktop blur — see winBackdrop.ts). On Linux/WSLg
// (WebKitGTK) a transparent window doesn't repaint (content only shows while
// resizing), so it's opt-in there via DAIMON_TRANSPARENT=1.
const isWindows = process.platform === "win32";
const nativeTransparent =
  process.env.DAIMON_TRANSPARENT === "1" ||
  ((process.platform === "darwin" || isWindows) && process.env.DAIMON_TRANSPARENT !== "0");

const baseUrl = isDev ? "http://localhost:7881" : "views://daimon2/index.html";
// ?blur=native tells the UI the compositor blurs the desktop (so the blur slider drives
// the native backdrop rather than only CSS backdrop-filter).
const query = [nativeTransparent && "transparent=1", nativeTransparent && isWindows && "blur=native"].filter(Boolean);
const frontendUrl = query.length ? `${baseUrl}?${query.join("&")}` : baseUrl;

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
const win = new BrowserWindow({
  title: "daimon",
  url: frontendUrl,
  frame: { width: 1280, height: 800, x: 100, y: 100 },
  // See-through window where supported; the UI paints its own translucent background.
  transparent: nativeTransparent,
});

// Windows: blur the desktop behind the window with DWM. The UI reports the blur
// slider through window.__electrobunSendToHost({ type: "glass", blur }).
if (isWindows && nativeTransparent) {
  const hwnd = win.ptr;
  if (prepareWindow(hwnd)) {
    let current: BackdropKind | null = null;
    const apply = (kind: BackdropKind) => {
      if (kind === current) return;
      if (setBackdrop(hwnd, kind)) { current = kind; console.log("[main] desktop backdrop →", kind); }
      else console.warn("[main] backdrop", kind, "was not applied");
    };
    const forced = process.env.DAIMON_BACKDROP as BackdropKind | undefined;
    apply(forced ?? backdropForBlur(24));
    (win.webview as unknown as { on(name: string, handler: (event: unknown) => void): void }).on(
      "host-message",
      (event) => {
        const msg = (event as { data?: { detail?: unknown } }).data?.detail as { type?: string; blur?: unknown } | undefined;
        if (!forced && msg?.type === "glass" && typeof msg.blur === "number") apply(backdropForBlur(msg.blur));
      },
    );
  } else {
    console.warn("[main] couldn't get a usable window handle — desktop blur disabled");
  }
}

console.log("[main] window opened →", frontendUrl);
