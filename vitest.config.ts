import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    poolOptions: {
      threads: {
        singleThread: true
      }
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json"],
      include: ["src/**/*.ts", "scripts/**/*.ts", "integrations/**/*.ts"],
      exclude: [
        "dist/**",
        "coverage/**",
        "tests/**",
        "fixtures/**",
        "**/*.test.ts",
        "**/*.config.ts"
      ],
      thresholds: {
        statements: 85,
        lines: 85,
        functions: 85,
        branches: 80
      }
    }
  }
});
