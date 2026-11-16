// Link previews: Open Graph cards for URLs in command output.
// The on/off setting lives in localStorage (like the markdown toggle); the metadata is fetched
// by the daemon (the webview can't read other origins) and memoised here per URL.
import { useSyncExternalStore } from "react";
import { shell } from "./rpc";

export type LinkPreview = {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  siteName?: string | null;
  icon?: string | null;
};

const KEY = "daimon-link-previews";
const listeners = new Set<() => void>();
let enabled = (() => { try { return localStorage.getItem(KEY) !== "0"; } catch { return true; } })();

export function setLinkPreviewsEnabled(v: boolean) {
  enabled = v;
  try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}

export function useLinkPreviewsEnabled(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => enabled,
  );
}

const cache = new Map<string, Promise<LinkPreview | null>>();

export function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  let p = cache.get(url);
  if (!p) {
    // A timeout or a dropped socket isn't a verdict on the page: forget it so a later render retries.
    p = shell.linkPreview(url).catch(() => { cache.delete(url); return null; });
    cache.set(url, p);
  }
  return p;
}

const URL_RE = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
const IMG_RE = /\.(?:png|jpe?g|gif|webp|svg)(?:\?|$)/i;
const MAX_PREVIEWS = 3;

/** Unique URLs in `text`, in order of appearance (trailing punctuation dropped, images skipped). */
export function previewUrls(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:!?)'"]+$/, "");
    if (IMG_RE.test(u) || seen.has(u)) continue;
    seen.add(u);
    if (seen.size >= MAX_PREVIEWS) break;
  }
  return [...seen];
}
