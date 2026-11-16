// The page's half of the focus log (see app/src/bun/focusLog.ts): sent to the native host,
// which writes it into the same timeline as its window events. A no-op outside the desktop app.

type HostSend = (m: unknown) => void;

/** `el` as a short tag for the log: textarea[data-composer], body, button "Maximize"… */
export function describeEl(el: Element | null): string {
  if (!el) return "null";
  const h = el as HTMLElement;
  if (h.hasAttribute("data-composer")) return `composer(${h.closest("[data-pane]")?.getAttribute("data-pane") ?? "?"})`;
  const label = h.getAttribute("aria-label") ?? h.getAttribute("title");
  return el.tagName.toLowerCase() + (label ? ` "${label}"` : "") + (h.className && typeof h.className === "string" ? `.${h.className.split(" ")[0]}` : "");
}

function hostSend(): HostSend | undefined {
  return (window as { __electrobunSendToHost?: HostSend }).__electrobunSendToHost;
}

let lastAsk = 0;
/**
 * Ask the native host to give this page keyboard focus (Windows: WebView2 doesn't take it by
 * itself after an un-minimize / maximize). The host only does so while our window is in
 * front; a `focus` event follows once it has. At most once per 500ms: every activation
 * blurs and refocuses the page.
 */
export function requestPageFocus(): boolean {
  const send = hostSend();
  if (!send || Date.now() - lastAsk < 500) return false;
  lastAsk = Date.now();
  try { send({ type: "window", action: "focus" }); return true; } catch { return false; }
}

export function focusLog(msg: string) {
  if (!import.meta.env.DEV) return;
  const full = `${msg} | active=${describeEl(document.activeElement)} hasFocus=${document.hasFocus()} vis=${document.visibilityState}`;
  try {
    const send = hostSend();
    if (send) send({ type: "focus-log", msg: full });
    else console.debug(`[focus] ${full}`);
  } catch { /* bridge unavailable */ }
}
