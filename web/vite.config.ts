import { defineConfig } from "vite";

const server = process.env.BARNACLE_DEV_SERVER ?? "http://localhost:19100";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": server,
      "/ws": { target: server, ws: true },
    },
  },
  build: { outDir: "dist", chunkSizeWarningLimit: 2000 },
});
