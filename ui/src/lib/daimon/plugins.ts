import { useState, useEffect, type ReactNode } from "react";

type HeaderButton = { id: string; node: ReactNode };

const registry: HeaderButton[] = [];
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

/** Register a button/badge into the header's right-side slot. Call at module level. */
export function registerHeaderButton(id: string, node: ReactNode) {
  if (registry.some((b) => b.id === id)) return; // idempotent
  registry.push({ id, node });
  notify();
}

/** React hook — returns current registered buttons, re-renders on change. */
export function useHeaderButtons(): ReactNode[] {
  const [, tick] = useState(0);
  useEffect(() => {
    const rerender = () => tick((n) => n + 1);
    listeners.add(rerender);
    return () => { listeners.delete(rerender); };
  }, []);
  return registry.map((b) => b.node);
}
