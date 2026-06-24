import { configDefaults, defineConfig } from "vitest/config";
import { aliases } from "./vitest.unit.config.js";
import { FIBER_LIVE_TEST_FILE, FIBER_PREFLIGHT_TEST_FILE } from "./tests/integration/fiber-e2e-env.js";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    exclude: [...configDefaults.exclude, FIBER_PREFLIGHT_TEST_FILE, FIBER_LIVE_TEST_FILE],
    environment: "node",
    testTimeout: 15000
  },
  resolve: {
    alias: aliases
  }
});
