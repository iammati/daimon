import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { getRouter } from "./router";
import "./styles.css";
import "@daimon-plugins";
import { applyGlass, loadGlass } from "./lib/daimon/appearance";

// The native shell appends ?transparent=1 only when the window really is see-through
// (and &blur=native when the compositor also blurs the desktop behind it).
// Without it, the page keeps a solid base so nothing can ever render blank.
{
  const url = new URL(window.location.href);
  if (url.searchParams.get("transparent") === "1") {
    sessionStorage.setItem("daimon-native-transparent", "1");
    // How the compositor's blur responds to the slider: "variable" (continuous) or
    // "steps" (fixed looks). Decides what the Settings blur slider displays.
    const blur = url.searchParams.get("blur");
    if (blur === "variable" || blur === "steps") sessionStorage.setItem("daimon-native-blur", blur);
    else sessionStorage.removeItem("daimon-native-blur");
    url.searchParams.delete("transparent");
    url.searchParams.delete("blur");
    history.replaceState(history.state, "", url);
  }
  if (sessionStorage.getItem("daimon-native-transparent") === "1") {
    const root = document.documentElement;
    root.classList.add("native-transparent");
    const nativeBlur = sessionStorage.getItem("daimon-native-blur");
    if (nativeBlur) root.dataset["nativeBlur"] = nativeBlur;
    // WebKitGTK/WSLg: a partial repaint of a transparent window blanks everything
    // outside the damaged rect. Force every frame to be a full-window repaint.
    // (macOS/WKWebView and Windows/WebView2 composite correctly and don't need it.)
    if (/Linux/.test(navigator.platform)) root.classList.add("repaint-keepalive");
  }
}

// ?frame=custom: the window has no native title bar — the page draws it (TitleBar.tsx).
{
  const url = new URL(window.location.href);
  if (url.searchParams.get("frame") === "custom") {
    sessionStorage.setItem("daimon-custom-frame", "1");
    url.searchParams.delete("frame");
    history.replaceState(history.state, "", url);
  }
  const root = document.documentElement;
  if (sessionStorage.getItem("daimon-custom-frame") === "1") root.classList.add("custom-frame");
  // macOS already has overlay scrollbars that stay out of the way; everywhere else the
  // native ones are replaced with themed ones (styles.css).
  if (!/Mac/.test(navigator.platform)) root.classList.add("themed-scrollbars");
}

applyGlass(loadGlass());

const router = getRouter();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
