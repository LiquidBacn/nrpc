import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      name: "nrpc",
      entry: {
        "server/index": "./src/server/index.ts",
        "client/index": "./src/client/index.ts",
        "shared/index": "./src/shared/index.ts",
      },
    },
    rollupOptions: {
      // input: {
      //   server: "./src/server/index.ts",
      //   client: "./src/client/index.ts",
      // },
    },
    emptyOutDir: true,
  },
});
