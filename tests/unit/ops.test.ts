import { describe, expect, it } from "vitest";
import { redactForLog } from "../../packages/cli/src/ops.js";

describe("gateway operational log redaction", () => {
  it("redacts sensitive keys and auth-like values", () => {
    const redacted = redactForLog({
      authorization: "Bearer live-secret-token",
      nested: {
        rpc_auth: "Basic abc123",
        safe: "payment_hash=0xabc",
        message: "request failed with authorization=abc123&token=def456&capability=cap&preimage=00&invoice=inv"
      }
    });

    expect(redacted).toEqual({
      authorization: "[REDACTED]",
      nested: {
        rpc_auth: "[REDACTED]",
        safe: "payment_hash=0xabc",
        message: "request failed with authorization=[REDACTED]&token=[REDACTED]&capability=[REDACTED]&preimage=[REDACTED]&invoice=[REDACTED]"
      }
    });
  });

  it("supports deployment-specific extra redaction keys", () => {
    const redacted = redactForLog(
      {
        fiberNodeApiKey: "do-not-log",
        status: "ready"
      },
      {
        enabled: true,
        extraKeys: ["fiberNodeApiKey"]
      }
    );

    expect(redacted).toEqual({
      fiberNodeApiKey: "[REDACTED]",
      status: "ready"
    });
  });
});
