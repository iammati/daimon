// Windows-only: the pieces of a custom (page-drawn) title bar that still have to be native.
//
// The window is created with titleBarStyle "hiddenInset": a normal framed window
// (resize borders, shadow, rounded corners, snap) whose caption strip Electrobun gives
// to the client area. Dragging is native too — WebView2 hit-tests CSS `app-region: drag`
// as the caption, so move, snap, double-click-to-maximize and the system menu all come
// from Windows. What's left for this file:
//
// - the style bits Electrobun leaves out (minimize/maximize boxes, system menu), so the
//   window animates, maximizes on a caption double-click and answers Win+arrows;
// - resizing from the top edge: that border went to the client area along with the
//   caption, so the page reports a press on its top strip and we start the native
//   resize from here.
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

const GWL_STYLE = -16;
const WS_SYSMENU = 0x00080000n;
const WS_MINIMIZEBOX = 0x00020000n;
const WS_MAXIMIZEBOX = 0x00010000n;
const WS_CLIPCHILDREN = 0x02000000n;
const SWP_FRAMECHANGED_NOMOVE_NOSIZE_NOZORDER_NOACTIVATE = 0x0020 | 0x0002 | 0x0001 | 0x0004 | 0x0010;
const WM_NCLBUTTONDOWN = 0x00a1;
const HTTOP = 12;

type User32 = ReturnType<typeof load>;
let user32: User32 | null = null;

function load() {
  return dlopen("user32.dll", {
    IsWindow: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
    SetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32, FFIType.i64], returns: FFIType.i64 },
    SetWindowPos: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32],
      returns: FFIType.i32,
    },
    GetCursorPos: { args: [FFIType.ptr], returns: FFIType.i32 },
    ReleaseCapture: { args: [], returns: FFIType.i32 },
    PostMessageW: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
  }).symbols;
}

/**
 * One-time setup after the window is created. False if the handle isn't usable.
 *
 * `transparent`: Electrobun creates this kind of window with WS_CLIPCHILDREN, which
 * keeps the frame window from ever painting under the webview. A see-through window
 * depends on exactly that paint (erased to zero-alpha black, see winBackdrop.ts) —
 * without it the area behind the page stays opaque. Call before prepareWindow().
 */
export function prepareCustomFrame(hwnd: Pointer | null, transparent: boolean): boolean {
  if (process.platform !== "win32" || !hwnd) return false;
  try {
    user32 ??= load();
    if (!user32.IsWindow(hwnd)) return false;
    const style = BigInt(user32.GetWindowLongPtrW(hwnd, GWL_STYLE));
    let wanted = style | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
    if (transparent) wanted &= ~WS_CLIPCHILDREN;
    if (wanted !== style) {
      user32.SetWindowLongPtrW(hwnd, GWL_STYLE, wanted);
      user32.SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_FRAMECHANGED_NOMOVE_NOSIZE_NOZORDER_NOACTIVATE);
    }
    return true;
  } catch (err) {
    console.warn("[frame] setup failed:", err);
    return false;
  }
}

/** Start a native resize from the top edge. Call while the mouse button is still down. */
export function startTopResize(hwnd: Pointer | null): void {
  if (process.platform !== "win32" || !hwnd || !user32) return;
  try {
    const point = new Int32Array(2);
    user32.GetCursorPos(ptr(point));
    const lParam = (BigInt(point[1]! & 0xffff) << 16n) | BigInt(point[0]! & 0xffff);
    user32.ReleaseCapture();
    user32.PostMessageW(hwnd, WM_NCLBUTTONDOWN, BigInt(HTTOP), lParam);
  } catch (err) {
    console.warn("[frame] resize failed:", err);
  }
}
