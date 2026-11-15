import { BrowserWindow, ApplicationMenu } from "electrobun/bun";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  attachVariableBlur, backdropForBlur, loadVariableBlur, prepareWindow, setBackdrop, setVariableBlur,
  type BackdropKind,
} from "./winBackdrop";
import { enablePinchZoom } from "./macMagnification";

// ── Spawn pty-daemon ──────────────────────────────────────────────────────────
// In dev the daemon is already running (started separately).
// In prod it's bundled next to the app binary.
const isDev = process.env.NODE_ENV !== "production";

let daemonProc: ReturnType<typeof Bun.spawn> | null = null;

if (!isDev) {
  // Prod: daemon binary is in the same dir as this script
  const daemonPath = resolve(import.meta.dir, "../pty-daemon");
  let cmd = [daemonPath, "--exit-with-parent"];
  if (process.platform === "win32") {
    // The Windows app (built from WSL by build.sh) bundles the Linux daemon and runs it
    // inside WSL; Windows reaches it on :7878 through WSL's localhost forwarding.
    // "wsl-distro" names the distro it was built in (absent → the default distro).
    const distroFile = resolve(import.meta.dir, "../wsl-distro");
    const distro = existsSync(distroFile) ? readFileSync(distroFile, "utf8").trim() : "";
    const wsl = ["wsl.exe", ...(distro ? ["-d", distro] : []), "--cd", "~", "--exec"];
    const linuxPath = Bun.spawnSync([...wsl, "wslpath", "-u", daemonPath]).stdout.toString().trim();
    if (!linuxPath) console.error("[main] couldn't resolve the daemon path inside WSL", distro || "(default distro)");
    cmd = [...wsl, linuxPath, "--exit-with-parent"];
  }
  daemonProc = Bun.spawn(cmd, {
    // Held open for our lifetime: the daemon exits when it closes (--exit-with-parent).
    stdin: "pipe",
    // Not piped: nothing reads the pipes, and a full pipe would stall the daemon.
    stdout: "inherit",
    stderr: "inherit",
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
// ?blur= tells the UI the compositor blurs the desktop behind the window, and how the
// blur slider behaves: "variable" = any radius (helper DLL), "steps" = DWM's three looks.
// DAIMON_BACKDROP pins a DWM look, which also means steps.
const variableBlur = nativeTransparent && isWindows && !process.env.DAIMON_BACKDROP && loadVariableBlur();
const query = [
  nativeTransparent && "transparent=1",
  nativeTransparent && isWindows && (variableBlur ? "blur=variable" : "blur=steps"),
].filter(Boolean);
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

enablePinchZoom(); // macOS only

// Windows: blur the desktop behind the window. The UI reports the blur slider
// through window.__electrobunSendToHost({ type: "glass", blur }).
if (isWindows && nativeTransparent) {
  const hwnd = win.ptr;
  if (prepareWindow(hwnd)) {
    const DEFAULT_BLUR = 24; // until the UI reports the saved setting
    const forced = process.env.DAIMON_BACKDROP as BackdropKind | undefined;
    let apply: (blurPx: number) => void;

    if (variableBlur && attachVariableBlur(hwnd)) {
      setBackdrop(hwnd, "none"); // the helper's layer replaces DWM's own blur
      let current = -1;
      apply = (blurPx) => {
        if (blurPx !== current && setVariableBlur(hwnd, blurPx)) current = blurPx;
      };
      console.log("[main] desktop blur: variable radius");
    } else {
      let current: BackdropKind | null = null;
      apply = (blurPx) => {
        const kind = forced ?? backdropForBlur(blurPx);
        if (kind === current) return;
        if (setBackdrop(hwnd, kind)) { current = kind; console.log("[main] desktop backdrop →", kind); }
        else console.warn("[main] backdrop", kind, "was not applied");
      };
    }

    // DAIMON_BLUR=<px> pins the blur radius and ignores the slider (handy for comparing).
    const pinned = process.env.DAIMON_BLUR ? Number(process.env.DAIMON_BLUR) : NaN;
    apply(Number.isFinite(pinned) ? pinned : DEFAULT_BLUR);
    (win.webview as unknown as { on(name: string, handler: (event: unknown) => void): void }).on(
      "host-message",
      (event) => {
        const msg = (event as { data?: { detail?: unknown } }).data?.detail as { type?: string; blur?: unknown } | undefined;
        if (!Number.isFinite(pinned) && msg?.type === "glass" && typeof msg.blur === "number") apply(msg.blur);
      },
    );
  } else {
    console.warn("[main] couldn't get a usable window handle — desktop blur disabled");
  }
}

console.log("[main] window opened →", frontendUrl);
