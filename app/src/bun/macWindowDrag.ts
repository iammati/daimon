// macOS-only: true native window dragging via performWindowDragWithEvent:.
//
// Creates a transparent NSView "drag overlay" covering the top 36px of the window.
// mouseDown: calls [NSWindow performWindowDragWithEvent:event] synchronously inside
// AppKit's event dispatch — gives true OS-level drag with Spaces, snap, Mission Control.
//
// All AppKit setup runs on the main thread via dispatch_async to the main queue.
// hitTest: returns nil for x < 80 (traffic lights zone).
// arm64: NSPoint HFA arrives as (d0=x, d1=y) — declared as two f64 args.
import { dlopen, FFIType, JSCallback, ptr, type Pointer } from "bun:ffi";

type Id = Pointer | null;

const TITLEBAR_H      = 36;
const TRAFFIC_LIGHT_W = 80;

export function enableMovableByBackground(): void { /* no-op */ }

// Keep JSCallback objects alive (GC must not collect them).
const _cbs: JSCallback[] = [];

export function setupNativeDrag(win: any, attempt = 0): void {
  if (process.platform !== "darwin") return;
  try {
    const winPtr = win.ptr as Id;
    if (!winPtr) {
      if (attempt < 20) setTimeout(() => setupNativeDrag(win, attempt + 1), 250);
      return;
    }
    dispatchOverlaySetup(winPtr, win);
  } catch (err) {
    console.warn("[main] native drag setup failed:", err);
  }
}

function dispatchOverlaySetup(winPtr: Id, win: any): void {
  const LIB = "/usr/lib/libobjc.A.dylib";
  const { ptr: P, void: V, bool: B, f64, u64 } = FFIType;
  const cstr = (s: string) => ptr(Buffer.from(s + "\0"));

  const rt = dlopen(LIB, {
    objc_getClass:          { args: [P], returns: P },
    objc_lookUpClass:       { args: [P], returns: P },
    sel_registerName:       { args: [P], returns: P },
    objc_allocateClassPair: { args: [P, P, u64], returns: P },
    objc_registerClassPair: { args: [P], returns: V },
    class_addMethod:        { args: [P, P, P, P], returns: B },
  }).symbols;

  const cls = (n: string) => rt.objc_getClass(cstr(n)) as Id;
  const sel = (n: string) => rt.sel_registerName(cstr(n)) as Id;

  const msg0   = dlopen(LIB, { objc_msgSend: { args: [P, P],                        returns: P } }).symbols.objc_msgSend as (s: Id, m: Id) => Id;
  const msg1V  = dlopen(LIB, { objc_msgSend: { args: [P, P, P],                     returns: V } }).symbols.objc_msgSend as (s: Id, m: Id, a: Id) => void;
  const msgBV  = dlopen(LIB, { objc_msgSend: { args: [P, P, B],                     returns: V } }).symbols.objc_msgSend as (s: Id, m: Id, b: boolean) => void;
  const msgRV  = dlopen(LIB, { objc_msgSend: { args: [P, P, f64, f64, f64, f64],    returns: V } }).symbols.objc_msgSend as (s: Id, m: Id, x: number, y: number, w: number, h: number) => void;

  // Selectors needed inside the main-thread callback
  const selAlloc       = sel("alloc");
  const selInit        = sel("init");
  const selSetFrame    = sel("setFrame:");
  const selContentView = sel("contentView");
  const selWantsLayer  = sel("setWantsLayer:");
  const selSetOpaque   = sel("setOpaque:");
  const selAddSubview  = sel("addSubview:");
  const selPerfDrag    = sel("performWindowDragWithEvent:");
  const selWindow      = sel("window");
  const selMouseDown   = sel("mouseDown:");
  const selHitTest     = sel("hitTest:");
  const selAccFirst    = sel("acceptsFirstMouse:");
  const selIsOpaque    = sel("isOpaque");

  // Build/reuse overlay class (safe from any thread — only mutates ObjC runtime metadata)
  const existingCls = rt.objc_lookUpClass(cstr("DaimonDragOverlay")) as Id;
  let overlayCls: Id;

  if (existingCls) {
    overlayCls = existingCls;
  } else {
    const nsView = cls("NSView");
    if (!nsView) { console.warn("[main] NSView not found"); return; }

    overlayCls = rt.objc_allocateClassPair(nsView, cstr("DaimonDragOverlay"), BigInt(0)) as Id;
    if (!overlayCls) { console.warn("[main] allocateClassPair failed"); return; }

    const cbAccept = new JSCallback(
      (_s: Pointer, _sel: Pointer, _ev: Pointer): boolean => true,
      { args: [P, P, P], returns: B },
    );
    rt.class_addMethod(overlayCls, selAccFirst, cbAccept.ptr as Id, cstr("B@:@"));
    _cbs.push(cbAccept);

    const cbOpaque = new JSCallback(
      (_s: Pointer, _sel: Pointer): boolean => false,
      { args: [P, P], returns: B },
    );
    rt.class_addMethod(overlayCls, selIsOpaque, cbOpaque.ptr as Id, cstr("B@:"));
    _cbs.push(cbOpaque);

    // hitTest:(NSPoint) — arm64 HFA: x in d0, y in d1
    const cbHit = new JSCallback(
      (self: Pointer, _sel: Pointer, x: number, _y: number): Pointer | null =>
        x < TRAFFIC_LIGHT_W ? null : (self as unknown as Pointer),
      { args: [P, P, f64, f64], returns: P },
    );
    rt.class_addMethod(overlayCls, selHitTest, cbHit.ptr as Id, cstr("@@:{CGPoint=dd}"));
    _cbs.push(cbHit);

    const cbDown = new JSCallback(
      (self: Pointer, _sel: Pointer, event: Pointer): void => {
        try {
          const w = msg0(self as unknown as Id, selWindow);
          if (w && event) msg1V(w, selPerfDrag, event as unknown as Id);
        } catch { /* ignore */ }
      },
      { args: [P, P, P], returns: V },
    );
    rt.class_addMethod(overlayCls, selMouseDown, cbDown.ptr as Id, cstr("v@:@"));
    _cbs.push(cbDown);

    rt.objc_registerClassPair(overlayCls);
  }

  // dispatch_async to main queue — all NSView/NSWindow calls happen there
  const gcd = dlopen("/usr/lib/libdispatch.dylib", {
    dispatch_get_main_queue: { args: [], returns: P },
    dispatch_async_f:        { args: [P, P, P], returns: V },
  }).symbols;

  const mainQueue = gcd.dispatch_get_main_queue() as Id;

  // The work function receives a context pointer — we pass winPtr as context
  // and capture overlayCls via closure (JSCallback captures JS closure, not C closure).
  // dispatch_async_f signature: (queue, context, work_fn).
  // work_fn: void (*)(void *context) — receives the context we passed.
  const capturedCls = overlayCls;
  const capturedWinPtr = winPtr;

  const cbWork = new JSCallback(
    (_ctx: Pointer): void => {
      try {
        const contentView = msg0(capturedWinPtr, selContentView);
        if (!contentView) return;

        const frame = (typeof win.getFrame === "function" ? win.getFrame() : null) ?? { width: 1280, height: 800 };
        const W = (frame as any).width  ?? 1280;
        const H = (frame as any).height ?? 800;

        const alloced = msg0(capturedCls, selAlloc);
        if (!alloced) return;
        const overlayView = msg0(alloced, selInit);
        if (!overlayView) return;

        // NSView bottom-left coords: title bar = top N px = y (H - N)
        msgRV(overlayView, selSetFrame, 0, H - TITLEBAR_H, W, TITLEBAR_H);
        msgBV(overlayView, selWantsLayer, true);
        msgBV(overlayView, selSetOpaque, false);
        msg1V(contentView, selAddSubview, overlayView);

        console.log("[main] native drag: overlay installed on main thread");

        // Handle resize
        win.on?.("resize", () => {
          try {
            const f2 = (typeof win.getFrame === "function" ? win.getFrame() : null) ?? { width: 1280, height: 800 };
            const W2 = (f2 as any).width  ?? 1280;
            const H2 = (f2 as any).height ?? 800;
            // resize also needs main thread
            const cbR = new JSCallback((_: Pointer): void => {
              msgRV(overlayView, selSetFrame, 0, H2 - TITLEBAR_H, W2, TITLEBAR_H);
            }, { args: [P], returns: V });
            gcd.dispatch_async_f(mainQueue, null, cbR.ptr as Id);
            // ponytail: cbR leaks here — acceptable, resize is rare
            _cbs.push(cbR);
          } catch { /* ignore */ }
        });
      } catch (err) {
        console.warn("[main] overlay setup error on main thread:", err);
      }
    },
    { args: [P], returns: V },
  );
  _cbs.push(cbWork);

  gcd.dispatch_async_f(mainQueue, null, cbWork.ptr as Id);
  console.log("[main] native drag: setup dispatched to main thread");
}
