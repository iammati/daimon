// macOS-only: native window drag via setMovableByWindowBackground.
//
// Uses the same performSelectorOnMainThread:withObject:waitUntilDone: + KVC pattern
// as macMagnification.ts so AppKit is always called from the main thread.
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

type Id = Pointer | null;

function load() {
  const objc = "/usr/lib/libobjc.A.dylib";
  const { ptr: P, u64, bool } = FFIType;
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
    onMain: send([P, P, bool], FFIType.void) as (self: Id, sel: Id, action: Id, arg: Id, wait: boolean) => void,
  };
}

function enableOnOpenWindows(o: ReturnType<typeof load>): number {
  const app = o.get(o.cls("NSApplication"), o.sel("sharedApplication"));
  if (!app) return 0;

  // @{ @"movableByWindowBackground": @YES }
  const values = o.with2(
    o.cls("NSDictionary"),
    o.sel("dictionaryWithObject:forKey:"),
    o.withBool(o.cls("NSNumber"), o.sel("numberWithBool:"), true),
    o.with1(o.cls("NSString"), o.sel("stringWithUTF8String:"), o.cstr("movableByWindowBackground")),
  );
  const selPerform = o.sel("performSelectorOnMainThread:withObject:waitUntilDone:");
  const selSetValues = o.sel("setValuesForKeysWithDictionary:");
  const selCount = o.sel("count");
  const selAt = o.sel("objectAtIndex:");
  const selWindows = o.sel("windows");

  const windows = o.get(app, selWindows);
  if (!windows) return 0;
  const n = Number(o.count(windows, selCount));
  let found = 0;
  for (let i = 0; i < n; i++) {
    const win = o.at(windows, selAt, i);
    if (!win) continue;
    o.onMain(win, selPerform, selSetValues, values, false);
    found++;
  }
  return found;
}

export function enableMovableByBackground(attempt = 0): void {
  if (process.platform !== "darwin") return;
  try {
    if (enableOnOpenWindows(load()) > 0) return void console.log("[main] native window drag enabled (movableByWindowBackground)");
  } catch (err) {
    return void console.warn("[main] native window drag setup failed:", err);
  }
  if (attempt < 20) setTimeout(() => enableMovableByBackground(attempt + 1), 250);
  else console.warn("[main] native window drag: no windows found");
}
