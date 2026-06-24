import { describe, expect, it } from "vitest";
import { resourceHash } from "@fiber-mpp/core";
import { f402ChallengeToMpp, f402ProofToCredential } from "@fiber-mpp/f402-compat";

describe("F402 compatibility", () => {
  it("converts an F402 challenge to an MPP challenge", () => {
    const resource = { method: "GET", url: "http://localhost/paid/weather" };
    const challenge = f402ChallengeToMpp({
      f402: {
        token: "v1.aaa.bbb",
        invoice: "fibd1qmock",
        paymentHash: `0x${"ab".repeat(32)}`,
        amount: "1000",
        currency: "CKB",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      },
      resource,
      serverId: "f402-unit"
    });
    expect(challenge.methods[0]?.method).toBe("fiber");
    expect(challenge.methods[0]).toMatchObject({ paymentHash: `0x${"ab".repeat(32)}` });
  });

  it("converts an F402 proof to PaymentCredential", () => {
    const resource = { method: "GET", url: "http://localhost/paid/weather" };
    const credential = f402ProofToCredential({
      challengeId: "chal_1234567890abcdef",
      resourceHash: resourceHash(resource),
      proof: {
        token: "v1.aaa.bbb",
        invoice: "fibd1qmock",
        paymentHash: `0x${"cd".repeat(32)}`,
        amountShannons: "1000",
        status: "settled"
      }
    });
    expect(credential.method).toBe("fiber");
    expect(credential.paymentProof).toMatchObject({ paymentHash: `0x${"cd".repeat(32)}` });
  });
});
