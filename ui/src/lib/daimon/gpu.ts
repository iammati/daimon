// GPU rendering for live xterm.js terminals (WebGL2 glyph atlas instead of DOM spans).
//
// Falls back to xterm's DOM renderer when WebGL2 isn't available — e.g. WebKitGTK with
// compositing disabled (DAIMON_TRANSPARENT=1 on Linux) or a GPU-less VM — and when the
// context is lost later (driver reset, too many contexts, GPU process crash).
// Load it after term.open(): the addon needs the terminal's element.
import type { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";

export type Renderer = "webgl" | "dom";

/** `?renderer=dom` (or localStorage daimon.renderer = "dom") forces the DOM renderer. */
function gpuDisabled(): boolean {
  try {
    if (new URLSearchParams(location.search).get("renderer") === "dom") return true;
    return localStorage.getItem("daimon.renderer") === "dom";
  } catch {
    return false;
  }
}

let warned = false;

/** Attach the WebGL renderer to an opened terminal. Returns which renderer is active. */
export function attachGpuRenderer(term: Terminal): Renderer {
  if (gpuDisabled()) return "dom";
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      // Disposing the addon hands rendering back to the DOM renderer.
      console.warn("[gpu] WebGL context lost — falling back to the DOM renderer");
      webgl.dispose();
    });
    term.loadAddon(webgl);
    return "webgl";
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn("[gpu] WebGL2 unavailable — using the DOM renderer:", err);
    }
    return "dom";
  }
}
