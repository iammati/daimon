// Windows-only: give the window daimon's icon (title bar, taskbar, alt-tab).
//
// Without this the taskbar shows the icon of the executable that owns the window —
// the bundled bun.exe. The .ico is copied next to the main bundle by
// electrobun.config.ts.

import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

const IMAGE_ICON = 1;
const LR_LOADFROMFILE = 0x10;
const WM_SETICON = 0x80;
const ICON_SMALL = 0;
const ICON_BIG = 1;
const SM_CXICON = 11;
const SM_CXSMICON = 49;

const wide = (s: string) => new Uint16Array([...s].map((c) => c.charCodeAt(0)).concat(0));

/** Set the window's small and large icon from an .ico file. */
export function setWindowIcon(hwnd: Pointer | null, icoPath: string): boolean {
  if (process.platform !== "win32" || !hwnd) return false;
  try {
    const u = dlopen("user32.dll", {
      LoadImageW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      SendMessageW: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr], returns: FFIType.i64 },
      GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
    }).symbols;
    const path = wide(icoPath);
    let ok = false;
    for (const [which, metric] of [[ICON_SMALL, SM_CXSMICON], [ICON_BIG, SM_CXICON]] as const) {
      const size = u.GetSystemMetrics(metric);
      const icon = u.LoadImageW(null, ptr(path), IMAGE_ICON, size, size, LR_LOADFROMFILE);
      if (!icon) continue;
      u.SendMessageW(hwnd, WM_SETICON, which, icon);
      ok = true;
    }
    return ok;
  } catch (e) {
    console.warn("[main] setWindowIcon failed:", e);
    return false;
  }
}
