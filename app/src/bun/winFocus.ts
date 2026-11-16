// Windows-only window queries for focus handling: whether our window is in front, and a
// one-line description of the focus state for the focus log (focusLog.ts).
//
// Giving the page keyboard focus is done with Electrobun's activateWindow, not here: a raw
// SetFocus on WebView2's input window moves Win32 focus but leaves the page unfocused
// (document.hasFocus() stays false), because WebView2 tracks focus through its controller.

import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

type User32 = ReturnType<typeof load>;
let user32: User32 | null = null;

function load() {
  return dlopen("user32.dll", {
    IsIconic: { args: [FFIType.ptr], returns: FFIType.i32 },
    IsZoomed: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetForegroundWindow: { args: [], returns: FFIType.ptr },
    GetClassNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    GetGUIThreadInfo: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
}

/** True when `hwnd` is the active (foreground) window and not minimized. */
export function isForeground(hwnd: Pointer | null): boolean {
  if (process.platform !== "win32" || !hwnd) return false;
  try {
    user32 ??= load();
    return user32.GetForegroundWindow() === hwnd && !user32.IsIconic(hwnd);
  } catch { return false; }
}

function className(u: User32, h: Pointer | null): string {
  if (!h) return "-";
  const buf = new Uint16Array(64);
  const n = u.GetClassNameW(h, ptr(buf), buf.length);
  return String.fromCharCode(...buf.subarray(0, n));
}

/** For the focus log: window state and which window holds keyboard focus right now. */
export function describeFocus(hwnd: Pointer | null): string {
  if (process.platform !== "win32" || !hwnd) return "";
  try {
    user32 ??= load();
    const u = user32;
    const fg = u.GetForegroundWindow();
    // GUITHREADINFO: cbSize, flags, then hwndActive, hwndFocus, … (8-byte handles on x64).
    const gti = new BigUint64Array(9);
    new Uint32Array(gti.buffer)[0] = 72;
    let focus = "-";
    if (fg && u.GetGUIThreadInfo(u.GetWindowThreadProcessId(fg, null), ptr(gti))) {
      const h = Number(gti[2]);
      focus = h ? className(u, h as unknown as Pointer) : "-";
    }
    return `fg=${fg === hwnd ? "self" : className(u, fg)} focus=${focus} iconic=${u.IsIconic(hwnd)} zoomed=${u.IsZoomed(hwnd)}`;
  } catch (e) {
    return `describeFocus failed: ${e}`;
  }
}
