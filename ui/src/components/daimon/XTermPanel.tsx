import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

export type XTermHandle = {
  feed: (bytes: Uint8Array) => void;
  focus: () => void;
  /** Mount (or re-mount) the terminal into an arbitrary DOM element inline. */
  mountInto: (el: HTMLElement) => void;
  /** Make terminal read-only (called when TUI command exits). */
  freeze: () => void;
};

type Props = {
  visible: boolean;
  onReady: (handle: XTermHandle) => void;
  onData: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onAltScreen?: (active: boolean) => void;
};

export function XTermPanel({ visible, onReady, onData, onResize, onAltScreen }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      });
    }
  }, [visible]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      fontFamily: '"MesloLGS Nerd Font Mono", "MesloLGS NF", "MesloLGM Nerd Font", Monaco, Menlo, monospace, "Apple Color Emoji", "Segoe UI Emoji"',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        black: "#484f58",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#b1bac4",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#f0f6fc",
        cursor: "#58a6ff",
        selectionBackground: "#264f78",
      },
      allowProposedApi: true,
      scrollback: 5000,
    });

    const fit = new FitAddon();
    fitRef.current = fit;
    termRef.current = term;
    term.loadAddon(fit);
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    term.open(el);

    if (onResize) term.onResize(({ cols, rows }) => onResize(cols, rows));
    term.onData(onData);

    let altScreen = false;
    const origWrite = term.write.bind(term);
    const ENTER = "\x1b[?1049h";
    const EXIT  = "\x1b[?1049l";
    const wrappedFeed = (bytes: Uint8Array) => {
      const s = new TextDecoder().decode(bytes);
      let i = 0;
      while (i < s.length) {
        const ei = s.indexOf(ENTER, i);
        const xi = s.indexOf(EXIT, i);
        if (ei === -1 && xi === -1) break;
        if (xi === -1 || (ei !== -1 && ei < xi)) {
          if (!altScreen) { altScreen = true; onAltScreen?.(true); }
          i = ei + ENTER.length;
        } else {
          if (altScreen) { altScreen = false; onAltScreen?.(false); }
          i = xi + EXIT.length;
        }
      }
      origWrite(bytes);
    };

    const mountInto = (target: HTMLElement) => {
      // Move all xterm child nodes into the target div and refit
      while (el.firstChild) target.appendChild(el.firstChild);
      requestAnimationFrame(() => {
        fit.fit();
        term.focus();
      });
    };

    const freeze = () => {
      term.options.disableStdin = true;
      termRef.current?.blur();
    };

    requestAnimationFrame(() => {
      onReady({ feed: wrappedFeed, focus: () => term.focus(), mountInto, freeze });
    });

    const onWindowResize = () => { fit.fit(); };
    window.addEventListener("resize", onWindowResize);

    return () => {
      window.removeEventListener("resize", onWindowResize);
      fitRef.current = null;
      termRef.current = null;
      term.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 240,
        right: 0,
        bottom: 0,
        zIndex: 100,
        background: "#0d1117",
        overflow: "hidden",
        display: visible ? "flex" : "none",
        flexDirection: "column",
        padding: "8px 12px",
        boxSizing: "border-box",
      }}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        style={{ flex: 1, minHeight: 0, outline: "none" }}
      />
    </div>
  );
}
