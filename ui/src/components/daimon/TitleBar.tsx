// The 36px strip along the top of the window.
//
// macOS: an empty zone — the window is dragged by its background and the traffic
// lights are native. Windows (html.custom-frame): the native title bar is gone, so this
// strip is the caption. `app-region: drag` makes Windows itself treat it as one (move,
// snap, double-click to maximize, right-click for the system menu); the three window
// buttons and the top resize edge are ours and go through the host (app/src/bun/winFrame.ts).

import { useEffect, useState } from "react";

const HEIGHT = 36;

type WindowAction = "minimize" | "maximize" | "close" | "resize-top" | "state";

function sendWindow(action: WindowAction) {
  try {
    (window as { __electrobunSendToHost?: (m: unknown) => void }).__electrobunSendToHost?.({ type: "window", action });
  } catch { /* shell bridge unavailable */ }
}

const base: React.CSSProperties = {
  position: "fixed", top: 0, left: 0, right: 0, height: HEIGHT, zIndex: 9999,
  WebkitUserSelect: "none", userSelect: "none",
};

/** `left`: content for the top-left corner of the Windows caption (as wide as the sidebar). Its buttons need `no-drag`. */
export function TitleBar({ left }: { left?: React.ReactNode }) {
  const custom = document.documentElement.classList.contains("custom-frame");
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!custom) return;
    const onState = (e: Event) => setMaximized(!!(e as CustomEvent<{ maximized?: boolean }>).detail?.maximized);
    window.addEventListener("daimon:window-state", onState);
    sendWindow("state");
    return () => window.removeEventListener("daimon:window-state", onState);
  }, [custom]);

  if (!custom) return <div className="titlebar-drag electrobun-webkit-app-region-drag" style={base} />;

  return (
    <div
      className="titlebar-drag flex justify-between"
      style={base}
      // The strip overlays the top of the page. Where page content under it opts out of dragging
      // (`no-drag`), Windows hands the click to the webview — but it lands on this strip, so
      // pass it down to the control underneath.
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget || e.button !== 0) return;
        const under = document.elementsFromPoint(e.clientX, e.clientY).find((el) => !e.currentTarget.contains(el));
        const control = under?.closest<HTMLElement>("input, textarea, button, a, [role='button']");
        if (!control) return;
        e.preventDefault();
        if (control.matches("input, textarea")) control.focus(); else control.click();
      }}
    >
      {/* The top resize border went to the client area with the caption. */}
      {!maximized && (
        <div
          className="no-drag absolute inset-x-0 top-0 h-1 cursor-ns-resize"
          onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); sendWindow("resize-top"); } }}
        />
      )}
      {left ? <div className="relative flex h-full w-56 shrink-0 items-center justify-between px-5">{left}</div> : <div />}
      <div className="no-drag relative flex h-full">
        <WindowButton label="Minimize" onClick={() => sendWindow("minimize")}>
          <path d="M0.5 5.5h9" />
        </WindowButton>
        <WindowButton label={maximized ? "Restore" : "Maximize"} onClick={() => sendWindow("maximize")}>
          {maximized
            ? <path d="M2.5 2.5v-2h7v7h-2M0.5 2.5h7v7h-7z" />
            : <path d="M0.5 0.5h9v9h-9z" />}
        </WindowButton>
        <WindowButton label="Close" onClick={() => sendWindow("close")} danger>
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </WindowButton>
      </div>
    </div>
  );
}

function WindowButton({ label, onClick, danger, children }: {
  label: string; onClick: () => void; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()} // keep keyboard focus in the command input
      onClick={onClick}
      className={`flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors ${
        danger ? "hover:bg-alarm hover:text-white" : "hover:bg-secondary hover:text-foreground"
      }`}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
        {children}
      </svg>
    </button>
  );
}
