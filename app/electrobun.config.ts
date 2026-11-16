import type { ElectrobunConfig } from "electrobun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Production payload (./build.sh): the built UI is served from views://daimon2/ and
// the release pty-daemon sits next to the main bundle. Dev builds (./dev.sh) use the
// Vite server and an already-running daemon, so anything not built yet is skipped.
const payload: Record<string, string> = {
  "../ui/dist": "views/daimon2",
  "../target/release/pty-daemon": "pty-daemon",
  // Windows app built from WSL: the distro its (Linux) daemon runs in.
  "wsl-distro": "wsl-distro",
};
const copy = Object.fromEntries(
  Object.entries(payload)
    .map(([src, dest]) => [resolve(import.meta.dirname, src), dest] as const)
    .filter(([src]) => existsSync(src)),
);

export default {
  app: {
    name: "daimon2",
    identifier: "daimon2.terminal",
    version: "0.1.0",
  },
  build: {
    // Windows: run the main process on Bun. Electrobun's default runtime (Cottontail)
    // keeps one thread spinning there — ~40% of a core and ~550 MB while idle, even
    // for an empty one-window app; on Bun it idles at 0% and ~65 MB.
    ...(process.platform === "win32" && {
      mainProcess: "bun" as const,
      bun: { entrypoint: "src/bun/index.ts" },
    }),
    views: {},
    copy,
    mac:   { bundleCEF: false },
    linux: { bundleCEF: false },
    win:   { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
