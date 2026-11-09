import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "daimon2",
    identifier: "daimon2.terminal",
    version: "0.1.0",
  },
  build: {
    views: {},
    copy: {},
    mac:   { bundleCEF: false },
    linux: { bundleCEF: false },
    win:   { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
