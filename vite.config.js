import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      name: "nrpc",
      entry: {
        "server/index": "./src/server/index.ts",
        "client/index": "./src/client/index.ts",
        "shared/index": "./src/shared/index.ts",
        "balancer/index": "./src/balancer/index.ts",
      },
    },
    sourcemap: true,
    emptyOutDir: true,
  },
});
