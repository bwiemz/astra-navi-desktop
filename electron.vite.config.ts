import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/main/index.ts") },
        external: ["sharp", "onnxruntime-node"],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/preload/index.ts"),
          settings: resolve(import.meta.dirname, "src/preload/settings.ts"),
          missionControl: resolve(import.meta.dirname, "src/preload/missionControl.ts"),
        },
        // A sandboxed preload script has to be CommonJS.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    build: {
      target: "esnext",
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/renderer/index.html"),
          settings: resolve(import.meta.dirname, "src/renderer/settings.html"),
          missionControl: resolve(import.meta.dirname, "src/renderer/mission-control.html"),
        },
      },
    },
  },
});
