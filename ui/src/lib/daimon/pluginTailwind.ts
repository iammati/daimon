/// Tailwind for plugins: the app's CSS only contains classes the app itself uses (Tailwind
/// compiles at app-build time), so plugin classes are compiled here, at runtime, against
/// the app's own theme — `bg-card`, `text-muted-foreground`, `dark:` etc. all work.
///
/// Lazy chunk: only fetched when a plugin has a `className`. Only the utilities a plugin
/// actually uses are generated (no preflight, no full stylesheet).

import { compile } from "tailwindcss";
import themeCss from "tailwindcss/theme.css?raw";
import utilitiesCss from "tailwindcss/utilities.css?raw";
import appCss from "@/styles.css?raw";

/** The app stylesheet's top-level `@theme` / `@custom-variant` / `@utility` blocks — what
 *  defines its design tokens and custom utilities — without its plain CSS rules. */
export function themeDirectives(css: string): string {
  const keep = /^@(theme|custom-variant|utility)\b/;
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 1;
      if (depth === 0) start = i + 1;
    } else if (c === '"' || c === "'") {
      while (++i < css.length && css[i] !== c) if (css[i] === "\\") i++;
    } else if (c === "{") {
      depth++;
    } else if (c === "}" || (c === ";" && depth === 0)) {
      if (c === "}") depth--;
      if (depth === 0) {
        const stmt = css.slice(start, i + 1).trim();
        if (keep.test(stmt)) out.push(stmt);
        start = i + 1;
      }
    }
  }
  return out.join("\n");
}

const stylesheets: Record<string, string> = {
  "tailwindcss/theme.css": themeCss,
  "tailwindcss/utilities.css": utilitiesCss,
};

let compiler: ReturnType<typeof compile> | null = null;

function getCompiler() {
  compiler ??= compile(
    [
      "@layer theme, base, components, utilities;",
      '@import "tailwindcss/theme.css" layer(theme);',
      '@import "tailwindcss/utilities.css" layer(utilities);',
      themeDirectives(appCss),
    ].join("\n"),
    {
      base: "/",
      loadStylesheet: async (id, base) => {
        const content = stylesheets[id];
        if (content === undefined) throw new Error(`plugin css: unknown stylesheet ${id}`);
        return { path: id, base, content };
      },
    },
  );
  return compiler;
}

/** CSS for every Tailwind class that appears in the given plugin sources. Like Tailwind's
 *  own scanner, any token may be a class; ones that aren't are ignored. */
export async function buildPluginCss(sources: string[]): Promise<string> {
  const candidates = new Set<string>();
  for (const src of sources) {
    for (const token of src.split(/[\s"'`{}]+/)) if (token) candidates.add(token);
  }
  return (await getCompiler()).build([...candidates]);
}
