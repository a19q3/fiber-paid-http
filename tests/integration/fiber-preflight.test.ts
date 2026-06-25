import { describe, expect, it } from "vitest";
import { readFiberE2ePreflight, writeFiberE2eResult } from "./fiber-e2e-env.js";

describe("Fiber live E2E preflight", () => {
  it("loads the Fiber E2E harness and reports skipped blockers", () => {
    const preflight = readFiberE2ePreflight();
    const result = writeFiberE2eResult({
      fiber_preflight_test_loaded: true,
      fiber_live_test_selected: preflight.liveReady,
      fiber_live_test_loaded: false,
      fiber_e2e_mode: preflight.mode,
      fiber_e2e_status: preflight.liveReady ? undefined : "skipped",
      fiber_e2e_blockers: preflight.blockers
    });

    if (preflight.status === "skipped") {
      console.warn(
        [
          "[fiber-e2e-preflight] status=skipped",
          "[fiber-e2e-preflight] blockers:",
          ...preflight.blockers.map((blocker) => `- ${blocker}`)
        ].join("\n")
      );
    } else {
      console.info(`[fiber-e2e-preflight] status=ready mode=${preflight.mode}`);
    }

    expect(preflight.testFileLoaded).toBe(true);
    if (preflight.status === "skipped") {
      expect(preflight.blockers.length).toBeGreaterThan(0);
      expect(result.fiber_e2e_payment_hash).toBeUndefined();
      expect(result.fiber_e2e_receipt_id).toBeUndefined();
    } else {
      expect(preflight.blockers).toEqual([]);
    }
  });
});
