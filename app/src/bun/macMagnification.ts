// macOS-only: pinch-to-zoom in the webview.
//
// WKWebView ships with allowsMagnification off and Electrobun has no switch for it, so
// it's turned on here through the Objective-C runtime — in source, for dev and
// production builds alike (this replaces injecting allow_magnification.dylib into the
// built launcher).
//
// The property is set on the main thread without needing a block: key-value coding
// through -performSelectorOnMainThread:, i.e.
//   [webView performSelectorOnMainThread:@selector(setValuesForKeysWithDictionary:)
//                             withObject:@{ @"allowsMagnification": @YES }
//                          waitUntilDone:NO];
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

type Id = Pointer | null;

function load() {
  const objc = "/usr/lib/libobjc.A.dylib";
  const { ptr: P, u64, bool } = FFIType;
  // objc_msgSend has no fixed signature; open it once per call shape.
  const send = <A extends FFIType[], R extends FFIType>(args: A, returns: R) =>
    dlopen(objc, { objc_msgSend: { args: [P, P, ...args], returns } }).symbols.objc_msgSend as unknown as (
      ...a: unknown[]
    ) => unknown;
  const rt = dlopen(objc, {
    objc_getClass: { args: [P], returns: P },
    sel_registerName: { args: [P], returns: P },
  }).symbols;
  const cstr = (s: string) => ptr(Buffer.from(s + "\0"));
  return {
    cls: (name: string) => rt.objc_getClass(cstr(name)) as Id,
    sel: (name: string) => rt.sel_registerName(cstr(name)) as Id,
    cstr,
    get: send([], P) as (self: Id, sel: Id) => Id,
    count: send([], u64) as (self: Id, sel: Id) => number | bigint,
    at: send([u64], P) as (self: Id, sel: Id, index: number) => Id,
    with1: send([P], P) as (self: Id, sel: Id, a: Id) => Id,
    with2: send([P, P], P) as (self: Id, sel: Id, a: Id, b: Id) => Id,
    withBool: send([bool], P) as (self: Id, sel: Id, a: boolean) => Id,
    isKind: send([P], bool) as (self: Id, sel: Id, cls: Id) => boolean,
    onMain: send([P, P, bool], FFIType.void) as (self: Id, sel: Id, action: Id, arg: Id, wait: boolean) => void,
  };
}

/** Enable pinch-zoom on every WKWebView currently in one of the app's windows. Returns how many. */
function enableOnOpenWebviews(o: ReturnType<typeof load>): number {
  const webViewClass = o.cls("WKWebView");
  const app = o.get(o.cls("NSApplication"), o.sel("sharedApplication"));
  if (!webViewClass || !app) return 0;

  const values = o.with2(
    o.cls("NSDictionary"),
    o.sel("dictionaryWithObject:forKey:"),
    o.withBool(o.cls("NSNumber"), o.sel("numberWithBool:"), true),
    o.with1(o.cls("NSString"), o.sel("stringWithUTF8String:"), o.cstr("allowsMagnification")),
  );
  const [selCount, selAt, selSubviews, selIsKind, selPerform, selSetValues] = [
    "count", "objectAtIndex:", "subviews", "isKindOfClass:",
    "performSelectorOnMainThread:withObject:waitUntilDone:", "setValuesForKeysWithDictionary:",
  ].map(o.sel);

  let found = 0;
  const each = (array: Id, fn: (item: Id) => void) => {
    if (!array) return;
    const n = Number(o.count(array, selCount));
    for (let i = 0; i < n; i++) fn(o.at(array, selAt, i));
  };
  const visit = (view: Id) => {
    if (!view) return;
    if (o.isKind(view, selIsKind, webViewClass)) {
      o.onMain(view, selPerform, selSetValues, values, false);
      found++;
      return;
    }
    each(o.get(view, selSubviews), visit);
  };
  each(o.get(app, o.sel("windows")), (window) => visit(o.get(window, o.sel("contentView"))));
  return found;
}

/**
 * Turn on pinch-zoom for the app's webviews. Call after creating the window; the
 * webview is attached asynchronously, so this retries briefly until it shows up.
 */
export function enablePinchZoom(attempt = 0): void {
  if (process.platform !== "darwin") return;
  try {
    if (enableOnOpenWebviews(load()) > 0) return void console.log("[main] pinch-zoom enabled");
  } catch (err) {
    return void console.warn("[main] pinch-zoom setup failed:", err);
  }
  if (attempt < 20) setTimeout(() => enablePinchZoom(attempt + 1), 250);
  else console.warn("[main] pinch-zoom: no webview found");
}
