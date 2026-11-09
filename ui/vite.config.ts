import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  assetsInclude: ["**/*.wasm"],
  define: {
    __HOME__: JSON.stringify(process.env.HOME ?? "/Users/" + (process.env.USER ?? "")),
    __USER__: JSON.stringify(process.env.USER ?? ""),
  },
  plugins: [react(), tailwindcss()],
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
