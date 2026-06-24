import { defineConfig } from "vitest/config";
import { aliases } from "./vitest.unit.config.js";
import {
  FIBER_LIVE_TEST_FILE,
  FIBER_PREFLIGHT_TEST_FILE,
  readFiberE2ePreflight
} from "./tests/integration/fiber-e2e-env.js";

const preflight = readFiberE2ePreflight();

export default defineConfig({
  test: {
    include: preflight.liveReady ? [FIBER_PREFLIGHT_TEST_FILE, FIBER_LIVE_TEST_FILE] : [FIBER_PREFLIGHT_TEST_FILE],
    environment: "node",
    testTimeout: 30000
  },
  resolve: {
    alias: aliases
  }
});
