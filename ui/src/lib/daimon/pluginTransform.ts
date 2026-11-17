/// Strips TypeScript and turns JSX into plain JS for .jsx/.ts/.tsx plugins.
/// Lazy chunk: only fetched when such a plugin exists.

import { transform, type Transform } from "sucrase";

export function compilePluginSource(source: string, file: string): string {
  const ext = file.slice(file.lastIndexOf(".") + 1);
  const transforms: Transform[] = ext === "ts" ? ["typescript"] : ext === "tsx" ? ["typescript", "jsx"] : ["jsx"];
  return transform(source, {
    transforms,
    // JSX → `import { jsx } from "react/jsx-runtime"`, which the loader maps to the app's React.
    jsxRuntime: "automatic",
    production: true,
    filePath: file,
    disableESTransforms: true,
  }).code;
}
