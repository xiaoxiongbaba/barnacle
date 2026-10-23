import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

const server = process.env.BARNACLE_DEV_SERVER ?? "http://localhost:19100";

/** The built page carries Habblaud's MIT code: ship the licences with it (served as /LICENSES.txt). */
function licences(): Plugin {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").trim();
  return {
    name: "barnacle-licences",
    generateBundle() {
      const parts = [read("../LICENSE"), read("../NOTICE"), `Habblaud (web/src/vendor/habblaud)\n\n${read("src/vendor/habblaud/LICENSE")}`];
      this.emitFile({ type: "asset", fileName: "LICENSES.txt", source: `${parts.join("\n\n" + "=".repeat(79) + "\n\n")}\n` });
    },
  };
}

export default defineConfig({
  plugins: [licences()],
  server: {
    port: 5173,
    proxy: {
      "/api": server,
      "/ws": { target: server, ws: true },
    },
  },
  build: { outDir: "dist", chunkSizeWarningLimit: 2000 },
});
