import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../backend/static",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
      // multiplayer WebSocket — without this, ws://localhost:5173/ws/play is never
      // forwarded to the backend and local multiplayer can't connect. (Prod is
      // same-origin: FastAPI serves the SPA + /ws/play together, so no proxy needed.)
      "/ws": {
        target: "ws://localhost:8000",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
