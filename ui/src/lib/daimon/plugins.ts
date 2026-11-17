/// Runtime plugins: files in ~/.config/daimon/plugins/ (.js .mjs .jsx .ts .tsx), read by the
/// daemon and imported here. No build step, and the daemon watches the folder, so saving a
/// file swaps the plugin in live.
///
///   // ~/.config/daimon/plugins/hello.tsx
///   import { useState } from "react";
///   import { registerHeaderButton, exec } from "daimon";
///
///   registerHeaderButton("hello", () => {
///     const [n, setN] = useState(0);
///     return <button className="rounded px-2 text-xs hover:bg-accent" onClick={() => setN(n + 1)}>hi {n}</button>;
///   });
///
/// - `react`, `react/jsx-runtime` and `daimon` are the only importable modules; they map to
///   the app's own React and `pluginApi`.
/// - TS/JSX is stripped in the browser (sucrase), Tailwind classes are compiled against the
///   app's theme (tailwindcss). Both are lazy chunks, fetched only when a plugin needs them.
/// - A plugin may also `export default function (daimon) { … }`; if it returns a function,
///   that's called before the plugin is reloaded or removed (clear intervals there).

import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import htm from "htm";
import { toast } from "sonner";
import { shell } from "./rpc";
import { Keys, Kbd } from "@/components/daimon/Kbd";

export type HeaderButton = { id: string; render: ComponentType | ReactNode };

let registry: readonly HeaderButton[] = [];
/** While plugins (re)load, registrations collect here and replace `registry` in one go,
 *  so a reload doesn't flicker the header. */
let staging: HeaderButton[] | null = null;
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function commit(next: readonly HeaderButton[]) {
  registry = next;
  listeners.forEach((fn) => fn());
}

/** Put a button/badge into the header's right-side slot. Registering an id again replaces it.
 *  Pass a component (preferred — it can use hooks) or a ready element. */
export function registerHeaderButton(id: string, render: ComponentType | ReactNode) {
  if (staging) {
    staging = [...staging.filter((b) => b.id !== id), { id, render }];
    return;
  }
  commit([...registry.filter((b) => b.id !== id), { id, render }]);
}

/** Current header buttons; re-renders when they change. */
export function useHeaderButtons(): readonly HeaderButton[] {
  return useSyncExternalStore(subscribe, () => registry, () => registry);
}

const html = htm.bind(React.createElement);

/** The `daimon` module / default-export argument. Keep this stable — it's the public API,
 *  typed for plugin authors in crates/daimon-cli/src/daimon.d.ts. */
export const pluginApi = {
  /** API version; bumped on breaking changes. */
  version: 1,
  React,
  h: React.createElement,
  html,
  registerHeaderButton,
  /** Run a program (no shell) via the daemon: `{ code, stdout, stderr }`. Rejects on spawn
   *  failure or timeout (default 10 s). */
  exec: shell.exec,
  /** Persistent key/value storage (shared prefs table — namespace your keys). */
  prefGet: shell.prefGet,
  prefSet: shell.prefSet,
  /** daimon's own components, for a consistent look. */
  components: { Keys, Kbd },
  toast,
};

export type DaimonPluginApi = typeof pluginApi;

// ── Module shims: what `import … from "react" | "daimon"` resolves to ────────────────────

const GLOBAL = "__daimonPlugin";
(globalThis as Record<string, unknown>)[GLOBAL] = { React, jsxRuntime, api: pluginApi };

function shimModule(expr: string, names: string[]): string {
  const ident = /^[A-Za-z_$][\w$]*$/;
  const exported = names.filter((n) => ident.test(n) && n !== "default");
  const src = `const m = globalThis.${GLOBAL}.${expr};\nexport default m;\n` +
    (exported.length ? `export const { ${exported.join(", ")} } = m;\n` : "");
  return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
}

let shims: Record<string, string> | null = null;
function getShims() {
  if (!shims) {
    const runtime = shimModule("jsxRuntime", Object.keys(jsxRuntime));
    shims = {
      react: shimModule("React", Object.keys(React)),
      "react/jsx-runtime": runtime,
      "react/jsx-dev-runtime": runtime,
      daimon: shimModule("api", Object.keys(pluginApi)),
    };
  }
  return shims;
}

/** Point the module specifiers we provide at their shims. Anything else is left alone and
 *  fails to resolve with the browser's own (clear enough) error. */
function rewriteImports(code: string): string {
  const map = getShims();
  return code.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(react(?:\/jsx-(?:dev-)?runtime)?|daimon)\2/g,
    (_, lead: string, q: string, spec: string) => `${lead}${q}${map[spec]}${q}`,
  );
}

// ── Loading ──────────────────────────────────────────────────────────────────────────────

type PluginFile = { name: string; file: string; source: string };

function reportError(name: string, err: unknown) {
  console.error(`[plugin ${name}]`, err);
  toast.error(`Plugin "${name}" failed`, {
    id: `plugin-error-${name}`,
    description: err instanceof Error ? err.message : String(err),
  });
}

/** Cleanups returned by the default exports of the currently loaded plugins. */
let cleanups: { name: string; fn: () => void }[] = [];

async function importPlugin({ name, file, source }: PluginFile): Promise<void> {
  let code = source;
  if (/\.(jsx|ts|tsx)$/.test(file)) {
    const { compilePluginSource } = await import("./pluginTransform");
    code = compilePluginSource(source, file);
  }
  code = rewriteImports(code);
  // sourceURL: errors and devtools show the plugin's file name instead of a blob id.
  const blob = new Blob([`${code}\n//# sourceURL=daimon-plugin://${file}`], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown };
    if (typeof mod.default === "function") {
      const ret = await (mod.default as (api: DaimonPluginApi) => unknown)(pluginApi);
      if (typeof ret === "function") cleanups.push({ name, fn: ret as () => void });
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function applyPluginCss(plugins: PluginFile[]) {
  const el = document.getElementById("daimon-plugin-css");
  const styled = plugins.filter((p) => /\bclass(Name)?\s*=/.test(p.source));
  if (!styled.length) { el?.remove(); return; }
  const { buildPluginCss } = await import("./pluginTailwind");
  const css = await buildPluginCss(styled.map((p) => p.source));
  const style = el ?? Object.assign(document.createElement("style"), { id: "daimon-plugin-css" });
  style.textContent = css;
  if (!el) document.head.append(style);
}

async function loadAll() {
  const plugins = await shell.pluginList();

  for (const { name, fn } of cleanups) {
    try { fn(); } catch (e) { reportError(name, e); }
  }
  cleanups = [];

  // CSS first, so a new button doesn't paint unstyled for a frame.
  try { await applyPluginCss(plugins); } catch (e) { reportError("tailwind", e); }

  staging = [];
  try {
    for (const p of plugins) {
      try {
        await importPlugin(p);
        toast.dismiss(`plugin-error-${p.name}`);
      } catch (e) {
        reportError(p.name, e);
      }
    }
  } finally {
    const next = staging;
    staging = null;
    commit(next);
  }
}

let running: Promise<void> | null = null;
let again = false;

/** (Re)load every plugin. Calls that arrive mid-load coalesce into one more pass. */
export function reloadPlugins(): Promise<void> {
  if (running) { again = true; return running; }
  running = (async () => {
    do {
      again = false;
      try { await loadAll(); } catch (e) { console.warn("[plugins] could not load plugins:", e); }
    } while (again);
    running = null;
  })();
  return running;
}

/** Startup: check the daemon can serve plugins, load them, then follow file changes. */
export async function loadPlugins() {
  try {
    const info = await shell.daemonInfo();
    if (info.plugins === undefined) {
      toast.warning("daimon's background daemon is outdated", {
        description: "Plugins and other new features need the current one. Quit daimon and start it again to replace it.",
        duration: 15000,
      });
      return;
    }
  } catch (e) {
    console.warn("[plugins] daemon unavailable:", e);
    return;
  }
  shell.onPluginsChanged(() => { void reloadPlugins(); });
  await reloadPlugins();
}

export { reportError as reportPluginError };
