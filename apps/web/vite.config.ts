import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // `@keelson/shared` exposes a `bun` export condition pointing at its TS
  // source; Bun (server/CLI/tests) uses it, but Vite's defaults don't, so it
  // would fall through to the unbuilt `dist/`. Resolve source directly in dev.
  resolve: {
    conditions: ["bun", "module", "browser", "development|production"],
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7878",
        changeOrigin: true,
        // Forward WebSocket upgrades for /api/chat/ws and /api/workflows/runs/<id>/ws
        // so the SPA can use the same origin as REST. The server's Origin
        // allow-list still validates the browser's page origin (which Vite
        // preserves), not the upstream.
        ws: true,
      },
    },
  },
});
