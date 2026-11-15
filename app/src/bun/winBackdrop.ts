// Windows-only: real desktop blur behind the window.
//
// WebView2 can't blur what's behind the window (CSS backdrop-filter only sees page
// pixels), so the blur has to come from the compositor. The page stays transparent
// and the blurred desktop is drawn underneath it. Two ways to get it:
//
// 1. win_backdrop.dll (crates/win-backdrop) — a composition layer under the webview
//    that blurs the desktop with any radius. Used when the DLL is available.
// 2. DWM's built-in looks, as a fallback. DWM has no adjustable radius, so the slider
//    is mapped onto three steps:
//      none    → plain see-through, no blur          (slider 0,     "off")
//      blur    → gaussian blur                       (slider 1–30,  "soft")
//      acrylic → heavier frosted-glass blur + noise  (slider 31–60, "frosted")
//    Keep backdropForBlur() in sync with nativeBlurLabel() in ui/src/lib/daimon/appearance.ts.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

export type BackdropKind = "none" | "blur" | "acrylic";

/** Settings blur slider (px) → DWM backdrop kind. */
export function backdropForBlur(blurPx: number): BackdropKind {
  if (!(blurPx > 0)) return "none";
  return blurPx <= 30 ? "blur" : "acrylic";
}

const GWL_EXSTYLE = -20;
const WS_EX_LAYERED = 0x00080000n;
const SWP_FRAMECHANGED_NOMOVE_NOSIZE_NOZORDER_NOACTIVATE = 0x0020 | 0x0002 | 0x0001 | 0x0004 | 0x0010;
const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
const WCA_ACCENT_POLICY = 19;
const ACCENT_DISABLED = 0;
const ACCENT_ENABLE_BLURBEHIND = 3;
const ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;
const GCLP_HBRBACKGROUND = -10;
const BLACK_BRUSH = 4;
const RDW_INVALIDATE = 0x1;
const RDW_ERASE = 0x4;
const RDW_FRAME = 0x400;
const DWM_BB_ENABLE = 0x1;
const DWM_BB_BLURREGION = 0x2;

type Libs = ReturnType<typeof load>;
let libs: Libs | null = null;

function load() {
  const user32 = dlopen("user32.dll", {
    IsWindow: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
    SetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32, FFIType.i64], returns: FFIType.i64 },
    SetWindowPos: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32],
      returns: FFIType.i32,
    },
    SetClassLongPtrW: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    RedrawWindow: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    SetWindowCompositionAttribute: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const dwmapi = dlopen("dwmapi.dll", {
    DwmSetWindowAttribute: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    DwmEnableBlurBehindWindow: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const gdi32 = dlopen("gdi32.dll", {
    CreateRectRgn: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.ptr },
    GetStockObject: { args: [FFIType.i32], returns: FFIType.ptr },
    DeleteObject: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  return { user32: user32.symbols, dwmapi: dwmapi.symbols, gdi32: gdi32.symbols };
}

/**
 * One-time setup: turn Electrobun's "transparent" window into something DWM can put
 * a backdrop behind. Returns false if the handle isn't usable.
 */
export function prepareWindow(hwnd: Pointer | null): boolean {
  if (process.platform !== "win32" || !hwnd) return false;
  try {
    libs ??= load();
    const { user32, dwmapi, gdi32 } = libs;
    if (!user32.IsWindow(hwnd)) return false;

    // Electrobun marks transparent windows WS_EX_LAYERED (meant for CEF off-screen
    // rendering). With WebView2 nothing ever calls UpdateLayeredWindow, and layered
    // windows don't get DWM backdrops — drop the style, keep the transparent webview.
    const ex = BigInt(user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    if (ex & WS_EX_LAYERED) user32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & ~WS_EX_LAYERED);

    // The window class has no background brush, so the area under the (transparent)
    // webview is never erased. Erase it to black: GDI black has zero alpha, which is
    // what DWM treats as "show the backdrop here".
    user32.SetClassLongPtrW(hwnd, GCLP_HBRBACKGROUND, gdi32.GetStockObject(BLACK_BRUSH));
    user32.RedrawWindow(hwnd, null, null, RDW_INVALIDATE | RDW_ERASE | RDW_FRAME);

    // Per-pixel alpha for the client area: "blur behind" with an empty region makes
    // DWM honour the alpha channel without blurring anything itself.
    const rgn = gdi32.CreateRectRgn(0, 0, -1, -1);
    const bb = new Uint8Array(24); // DWM_BLURBEHIND { DWORD flags; BOOL enable; HRGN rgn; BOOL transitionOnMaximized }
    const bbView = new DataView(bb.buffer);
    bbView.setUint32(0, DWM_BB_ENABLE | DWM_BB_BLURREGION, true);
    bbView.setInt32(4, 1, true);
    bbView.setBigUint64(8, BigInt(rgn ?? 0), true);
    dwmapi.DwmEnableBlurBehindWindow(hwnd, ptr(bb));
    if (rgn) gdi32.DeleteObject(rgn);

    const dark = new Int32Array([1]);
    dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ptr(dark), 4);

    user32.SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_FRAMECHANGED_NOMOVE_NOSIZE_NOZORDER_NOACTIVATE);
    return true;
  } catch (err) {
    console.warn("[backdrop] setup failed:", err);
    return false;
  }
}

/** Switch the compositor backdrop behind the window. Safe to call repeatedly. */
export function setBackdrop(hwnd: Pointer | null, kind: BackdropKind): boolean {
  if (process.platform !== "win32" || !hwnd || !libs) return false;
  try {
    const state =
      kind === "acrylic" ? ACCENT_ENABLE_ACRYLICBLURBEHIND : kind === "blur" ? ACCENT_ENABLE_BLURBEHIND : ACCENT_DISABLED;
    // ACCENT_POLICY { int state; int flags; uint gradientColor (AABBGGRR); int animationId }
    // Acrylic needs a non-zero tint alpha or it renders nothing; keep it barely there —
    // the page paints the real tint (Settings → Background opacity).
    const accent = new Int32Array([state, 0, kind === "acrylic" ? 0x01000000 : 0, 0]);
    // WINDOWCOMPOSITIONATTRIBDATA { int attrib; void* data; size_t size }
    const data = new Uint8Array(24);
    const view = new DataView(data.buffer);
    view.setInt32(0, WCA_ACCENT_POLICY, true);
    view.setBigUint64(8, BigInt(ptr(accent)), true);
    view.setBigUint64(16, 16n, true);
    return libs.user32.SetWindowCompositionAttribute(hwnd, ptr(data)) !== 0;
  } catch (err) {
    console.warn("[backdrop] apply failed:", err);
    return false;
  }
}

// ── Variable-radius blur (win_backdrop.dll) ───────────────────────────────────

type BlurLib = {
  daimon_backdrop_attach(hwnd: Pointer): number;
  daimon_backdrop_set_blur(hwnd: Pointer, strength: number, extra: number): number;
};
let blurLib: BlurLib | null = null;

/** Where the helper DLL is: DAIMON_BACKDROP_DLL (dev), else next to the executable. */
function blurLibPath(): string | null {
  const candidates = [process.env.DAIMON_BACKDROP_DLL, join(dirname(process.execPath), "win_backdrop.dll")];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

/** Load the helper. False (with a log line) if it's missing or won't load. */
export function loadVariableBlur(): boolean {
  if (process.platform !== "win32") return false;
  if (blurLib) return true;
  const path = blurLibPath();
  if (!path) return false;
  try {
    blurLib = dlopen(path, {
      daimon_backdrop_attach: { args: [FFIType.ptr], returns: FFIType.i32 },
      daimon_backdrop_set_blur: { args: [FFIType.ptr, FFIType.f32, FFIType.f32], returns: FFIType.i32 },
    }).symbols as unknown as BlurLib;
    return true;
  } catch (err) {
    console.warn("[backdrop] couldn't load", path, err);
    return false;
  }
}

const hr = (code: number) => "0x" + (code >>> 0).toString(16).padStart(8, "0");

/** Put the blur layer under the window's webview. Call after prepareWindow(). */
export function attachVariableBlur(hwnd: Pointer | null): boolean {
  if (!hwnd || !blurLib) return false;
  const code = blurLib.daimon_backdrop_attach(hwnd);
  if (code !== 0) console.warn("[backdrop] attach failed:", hr(code));
  return code === 0;
}

/** Top of the Settings blur slider. */
const BLUR_MAX = 60;

/**
 * Blur radius from the Settings slider, in px (same scale as CSS blur()).
 * 0 = plain see-through.
 */
export function setVariableBlur(hwnd: Pointer | null, blur: number): boolean {
  if (!hwnd || !blurLib) return false;
  const v = Math.min(BLUR_MAX, Math.max(0, blur));
  const code = blurLib.daimon_backdrop_set_blur(hwnd, v > 0 ? 1 : 0, v);
  if (code !== 0) console.warn("[backdrop] set blur failed:", hr(code));
  return code === 0;
}
