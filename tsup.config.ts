import { defineConfig } from "tsup";

export default defineConfig((options) => [
  {
    ...options,
    entry: {
      cli: "src/cli/main.ts",
      controller: "src/controller/main.ts",
      "opencode-integration": "integrations/opencode/generated-entry.ts"
    },
    outDir: "dist",
    format: ["esm"],
    splitting: false,
    sourcemap: true,
    clean: true,
    dts: false
  }
]);
