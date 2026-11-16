import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import type { Plugin } from "vite";

// Dev only: hands the pty-daemon's token to the page when it's opened in a plain
// browser (the app passes it in the URL instead). dev.sh exports DAIMON_TOKEN and
// DAIMON_PORT. Same-origin only — no CORS headers, and Vite rejects foreign Host
// headers — so other sites can't read it.
const daimonToken = (): Plugin => ({
  name: "daimon-token",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/__daimon", (_req, res) => {
      const token = process.env["DAIMON_TOKEN"];
      res.setHeader("Cache-Control", "no-store");
      if (!token) { res.statusCode = 404; res.end(); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ token, port: Number(process.env["DAIMON_PORT"]) || 7878 }));
    });
  },
});

export default defineConfig({
  assetsInclude: ["**/*.wasm"],
  define: {
    __HOME__: JSON.stringify(process.env.HOME ?? "/Users/" + (process.env.USER ?? "")),
    __USER__: JSON.stringify(process.env.USER ?? ""),
  },
  plugins: [react(), tailwindcss(), daimonToken()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: "index.html",
    },
  },
  server: { port: 7881 },
});
