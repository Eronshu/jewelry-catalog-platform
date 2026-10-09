import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "app/**/*.test.{ts,tsx}",
      "tests/admin-shell-preview/**/*.test.{ts,tsx}",
      "tests/preview-configuration.test.ts",
    ],
  },
});
