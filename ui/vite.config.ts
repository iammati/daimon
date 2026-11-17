import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { wraith } from "wraithterm/vite";
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
  // wraith(): keeps wraithterm's worker / wasm / font URLs intact through dep prebundling.
  plugins: [react(), tailwindcss(), wraith(), daimonToken()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      input: "index.html",
      output: {
        // Libraries in their own chunks: no single bundle over Vite's 500 kB warning, and the
        // app's own chunk changes without invalidating the (larger, rarely changing) vendor ones.
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "highlight", test: /node_modules[\\/]highlight\.js[\\/]/ },
            { name: "markdown", test: /node_modules[\\/](marked|dompurify)[\\/]/ },
            { name: "wraith", test: /node_modules[\\/]wraithterm[\\/]/ },
            { name: "ui-vendor", test: /node_modules[\\/](@radix-ui|@floating-ui|@tanstack|cmdk|lucide-react|sonner|vaul)[\\/]/ },
            // Plugin runtime: loaded only when a plugin needs it (see lib/daimon/plugins.ts).
            { name: "plugin-tailwind", test: /node_modules[\\/]tailwindcss[\\/]/ },
            { name: "plugin-sucrase", test: /node_modules[\\/](sucrase|lines-and-columns|ts-interface-checker)[\\/]/ },
            { name: "vendor", test: /node_modules[\\/]/ },
          ],
        },
      },
    },
  },
  server: { port: 7881 },
});
