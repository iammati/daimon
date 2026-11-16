// macOS-only: true native window dragging via performWindowDragWithEvent:.
//
// Loads libDaimonDrag.dylib (compiled ObjC) which dispatches to the main thread
// and installs a transparent NSView subclass over the title bar. Its mouseDown:
// calls performWindowDragWithEvent: synchronously — true OS-level drag.
import { dlopen, FFIType } from "bun:ffi";
import { join } from "node:path";

export function enableMovableByBackground(): void { /* no-op */ }

const TITLEBAR_H = 36;

export function setupNativeDrag(win: any, attempt = 0): void {
  if (process.platform !== "darwin") return;
  try {
    const winPtr = win.ptr;
    if (!winPtr) {
      if (attempt < 20) setTimeout(() => setupNativeDrag(win, attempt + 1), 250);
      return;
    }

    const { DaimonDragInstall } = dlopen(join(import.meta.dir, "libDaimonDrag.dylib"), {
      DaimonDragInstall: { args: [FFIType.ptr, FFIType.f64], returns: FFIType.void },
    }).symbols;

    DaimonDragInstall(winPtr, TITLEBAR_H);
    console.log("[main] native drag: DaimonDragInstall called");
  } catch (err) {
    console.warn("[main] native drag setup failed:", err);
  }
}
