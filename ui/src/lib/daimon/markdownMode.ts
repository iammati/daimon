// Remembered "render .md files as markdown" toggle, shared by every diff view.
import { useSyncExternalStore } from "react";

const MODE_KEY = "daimon-md-diff-rendered";
const listeners = new Set<() => void>();
let rendered = (() => { try { return localStorage.getItem(MODE_KEY) === "1"; } catch { return false; } })();

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx|mdown|mkd)$/i.test(path);
}

export function toggleMarkdownRendered() {
  rendered = !rendered;
  try { localStorage.setItem(MODE_KEY, rendered ? "1" : "0"); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}

export function useMarkdownRendered(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => rendered,
  );
}
