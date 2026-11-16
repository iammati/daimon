// Windows-only: hand keyboard focus to the WebView2 page when the window is re-activated.
//
// WebView2 doesn't take focus by itself when its top-level window is activated
// (un-minimize, alt-tab back): the host is expected to forward it. Without that the
// page never sees a `focus` event and keystrokes go nowhere until the user clicks.
// We find WebView2's render-widget child window and SetFocus it. That window lives
// on another thread (in the browser process), so input queues are briefly attached.

import { dlopen, FFIType, JSCallback, ptr, type Pointer } from "bun:ffi";

type User32 = ReturnType<typeof load>;
let user32: User32 | null = null;

function load() {
  return dlopen("user32.dll", {
    IsWindow: { args: [FFIType.ptr], returns: FFIType.i32 },
    IsIconic: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetForegroundWindow: { args: [], returns: FFIType.ptr },
    EnumChildWindows: { args: [FFIType.ptr, FFIType.function, FFIType.i64], returns: FFIType.i32 },
    GetClassNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    AttachThreadInput: { args: [FFIType.u32, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
    SetFocus: { args: [FFIType.ptr], returns: FFIType.ptr },
  }).symbols;
}

const kernel32 = () =>
  dlopen("kernel32.dll", { GetCurrentThreadId: { args: [], returns: FFIType.u32 } }).symbols;

/** WebView2's innermost input window (the one Chromium routes keystrokes through). */
const RENDER_WIDGET_CLASS = "Chrome_RenderWidgetHostHWND";

function findRenderWidget(u: User32, hwnd: Pointer): Pointer | null {
  let found: Pointer | null = null;
  const buf = new Uint16Array(64);
  const cb = new JSCallback(
    (child: Pointer) => {
      const n = u.GetClassNameW(child, ptr(buf), buf.length);
      if (String.fromCharCode(...buf.subarray(0, n)) === RENDER_WIDGET_CLASS) {
        found = child;
        return 0; // stop
      }
      return 1;
    },
    { args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
  );
  try {
    u.EnumChildWindows(hwnd, cb.ptr, 0);
  } finally {
    cb.close();
  }
  return found;
}

/** Move keyboard focus into the webview of `hwnd` if that window is the active one. */
export function focusWebview(hwnd: Pointer | null): boolean {
  if (process.platform !== "win32" || !hwnd) return false;
  try {
    user32 ??= load();
    const u = user32;
    if (!u.IsWindow(hwnd) || u.IsIconic(hwnd)) return false;
    if (u.GetForegroundWindow() !== hwnd) return false; // never steal focus from another app
    const widget = findRenderWidget(u, hwnd);
    if (!widget) return false;

    const self = kernel32().GetCurrentThreadId();
    const target = u.GetWindowThreadProcessId(widget, null);
    const attach = target !== 0 && target !== self;
    if (attach) u.AttachThreadInput(self, target, 1);
    try {
      u.SetFocus(widget);
    } finally {
      if (attach) u.AttachThreadInput(self, target, 0);
    }
    return true;
  } catch (e) {
    console.warn("[main] focusWebview failed:", e);
    return false;
  }
}
