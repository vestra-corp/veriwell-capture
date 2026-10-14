import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Resolve the package name to the local source so the demo always runs the
// code in this repository. In your own app, just `npm install veriwell-capture`.
export default defineConfig({
  resolve: {
    alias: {
      "veriwell-capture/react": fileURLToPath(new URL("../../src/react/index.ts", import.meta.url)),
      "veriwell-capture": fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
    },
  },
  server: { host: true },
});
