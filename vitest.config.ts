import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Builds dist/ once when stale: the subprocess fixtures import it.
    globalSetup: ["test/dist-build.ts"],
  },
});
