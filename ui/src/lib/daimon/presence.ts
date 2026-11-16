import { useEffect, useState } from "react";

/** How long a modal/popover takes to animate out; matches the `[data-state="closed"]` rules in styles.css. */
export const EXIT_MS = 150;

/**
 * Keeps something mounted for its exit animation: true while `open`, and for EXIT_MS after it
 * turns false. Render while this is true, with `data-state={open ? "open" : "closed"}`.
 */
export function usePresence(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(t);
  }, [open]);
  return open || mounted;
}
