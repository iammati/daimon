import { BrowserWindow, ApplicationMenu } from "electrobun/bun";
import { openExternal } from "electrobun/bun/utils";
import { connectDaemon } from "./daemon";
import {
  attachVariableBlur, backdropForBlur, loadVariableBlur, prepareWindow, setBackdrop, setVariableBlur,
  type BackdropKind,
} from "./winBackdrop";
import { enablePinchZoom } from "./macMagnification";
import { setupNativeDrag } from "./macWindowDrag";
import { describeFocus, isForeground } from "./winFocus";
import { focusLog } from "./focusLog";
import { prepareCustomFrame, startTopResize } from "./winFrame";
import { setWindowIcon } from "./winIcon";
import { resolve } from "node:path";

// ── pty-daemon ────────────────────────────────────────────────────────────────
// Dev: dev.sh runs it. Prod: find the running daemon or start one (see daemon.ts).
const isDev = process.env.NODE_ENV !== "production";
const daemon = await connectDaemon(isDev);

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
  daemon && `daimon_token=${daemon.token}`,
  daemon && `daimon_port=${daemon.port}`,
  nativeTransparent && "transparent=1",
  nativeTransparent && isWindows && (variableBlur ? "blur=variable" : "blur=steps"),
  // The page draws the title bar (drag strip + minimize / maximize / close): see winFrame.ts.
  isWindows && "frame=custom",
  // Benchmark mode: the UI runs these commands and records timings (see ui/src/lib/daimon/bench.ts).
  process.env.DAIMON_BENCH && `bench=${encodeURIComponent(process.env.DAIMON_BENCH)}`,
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
  // Custom HTML titlebar: hide the native title bar. macOS keeps its traffic lights
  // inset; Windows keeps the resizable frame and the page draws the window buttons.
  ...((process.platform === "darwin" || isWindows) && { titleBarStyle: "hiddenInset" as const }),
  ...(process.platform === "darwin" && { trafficLightOffset: { x: 16, y: 14 } }),
});

if (isWindows && !setWindowIcon(win.ptr, resolve(import.meta.dir, "../icon.ico"))) {
  console.warn("[main] couldn't set the window icon");
}

enablePinchZoom(); // macOS only
setupNativeDrag(win); // macOS only — native drag via performWindowDragWithEvent

// Window re-activated (un-minimize, alt-tab / click back from another app) or (un)maximized:
// tell the page, so it can put the cursor back in the command input.
//
// How the page gets keyboard focus on Windows (traced with the focus log, see focusLog.ts):
// WebView2 tracks focus through its controller, so a raw Win32 SetFocus on its input window
// leaves document.hasFocus() false. Electrobun's activateWindow does give the page focus
// (a real `focus` event follows) — but every call blurs and refocuses the page, so it is only
// done when the page asks for it ({ type: "window", action: "focus" }), i.e. when it is
// visible, wants the command input focused and finds document.hasFocus() false.
//
// On un-minimize Windows reports activation while the window is still iconic and only then
// plays the restore animation, so wait until the window is really in front before telling
// the page.
const HOST_FOCUS_JS = `window.dispatchEvent(new Event("daimon:host-focus"))`;
let focusTimer: ReturnType<typeof setTimeout> | null = null;
function returnFocusToPage(why: string) {
  if (focusTimer) clearTimeout(focusTimer);
  focusLog("host", `return focus (${why}) ${describeFocus(win.ptr)}`);
  if (!isWindows) {
    focusTimer = setTimeout(() => { focusTimer = null; win.webview.executeJavascript(HOST_FOCUS_JS); }, 30);
    return;
  }
  const start = Date.now();
  const poll = () => {
    focusTimer = null;
    const ready = isForeground(win.ptr);
    if (!ready && Date.now() - start < 1500) { focusTimer = setTimeout(poll, 50); return; }
    focusLog("host", `  ${ready ? "in front" : "gave up waiting"} after ${Date.now() - start}ms → tell page; ${describeFocus(win.ptr)}`);
    if (ready) win.webview.executeJavascript(HOST_FOCUS_JS);
  };
  poll();
}
win.on("focus", () => returnFocusToPage("native focus"));
win.on("blur", () => focusLog("host", `native blur ${describeFocus(win.ptr)}`));

// Messages from the page: window.__electrobunSendToHost({ type, ... }).
type HostMessage = { type?: string; blur?: unknown; action?: unknown; msg?: unknown };
const hostMessageHandlers: ((msg: HostMessage) => void)[] = [];
(win.webview as unknown as { on(name: string, handler: (event: unknown) => void): void }).on(
  "host-message",
  (event) => {
    const msg = (event as { data?: { detail?: unknown } }).data?.detail as HostMessage | undefined;
    if (msg) for (const handle of hostMessageHandlers) handle(msg);
  },
);
// The page's half of the focus log.
hostMessageHandlers.push((msg) => {
  if (msg.type === "focus-log" && typeof msg.msg === "string") focusLog("page", msg.msg);
});

// Windows: the page's title bar. Its buttons arrive as { type: "window", action }, and
// it is told when the window is (un)maximized so it can swap the maximize/restore icon.
if (isWindows) {
  if (!prepareCustomFrame(win.ptr, nativeTransparent)) console.warn("[main] couldn't set up the custom window frame");
  let maximized: boolean | null = null;
  const reportState = (force = false) => {
    const now = win.isMaximized();
    if (!force && now === maximized) return;
    // (Un)maximizing from the caption (double-click, snap) leaves keyboard focus on the frame
    // window without a new `focus` event: hand it back to the page. Not on the first report.
    focusLog("host", `window state: maximized ${maximized} → ${now}${force ? " (asked)" : ""}`);
    if (maximized !== null && now !== maximized) returnFocusToPage("maximized changed");
    maximized = now;
    win.webview.executeJavascript(
      `window.dispatchEvent(new CustomEvent("daimon:window-state", { detail: { maximized: ${now} } }))`,
    );
  };
  win.on("resize", () => { focusLog("host", `native resize ${describeFocus(win.ptr)}`); reportState(); });
  hostMessageHandlers.push((msg) => {
    if (msg.type !== "window") return;
    if (msg.action !== "state") focusLog("host", `title bar: ${String(msg.action)}`);
    switch (msg.action) {
      case "minimize": win.minimize(); break;
      case "maximize": if (win.isMaximized()) win.unmaximize(); else win.maximize(); break;
      case "focus": {
        // The page wants keyboard focus (see returnFocusToPage). Never steal it from another app.
        const front = isForeground(win.ptr);
        focusLog("host", `page asks for focus → ${front ? "activate" : "not in front, ignored"}`);
        if (front) win.activate();
        break;
      }
      case "close": win.close(); break;
      case "resize-top": startTopResize(win.ptr); break;
      case "state": reportState(true); break;
    }
  });
}

// Windows: blur the desktop behind the window. The UI reports the blur slider
// as { type: "glass", blur }.
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
    hostMessageHandlers.push((msg) => {
      if (!Number.isFinite(pinned) && msg.type === "glass" && typeof msg.blur === "number") apply(msg.blur);
    });
  } else {
    console.warn("[main] couldn't get a usable window handle — desktop blur disabled");
  }
}

console.log("[main] window opened →", frontendUrl.replace(/daimon_token=[^&]+/, "daimon_token=…"));

// Open a URL in the system default browser via Electrobun's native API.
hostMessageHandlers.push((msg) => {
  if (msg.type !== "openUrl" || typeof (msg as { url?: unknown }).url !== "string") return;
  const url = (msg as { url: string }).url;
  try {
    if (url === "tailscale://") {
      Bun.spawn(["open", "-a", "Tailscale"]);
    } else if (url.startsWith("https://") || url.startsWith("http://")) {
      openExternal(url);
    }
  } catch (e) {
    console.error("[main] openUrl error:", e);
  }
});
