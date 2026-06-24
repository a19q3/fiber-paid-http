import { describe, expect, it } from "vitest";
import {
  attachReceiptSignature,
  canonicalJson,
  randomId,
  randomNonce,
  resourceHash,
  signChallenge,
  verifyChallengeSignature,
  verifyReceiptSignature,
  type PaymentChallenge
} from "@fiber-mpp/core";

const secret = "unit-test-secret-at-least-16";

describe("core protocol primitives", () => {
  it("canonical challenge hash is stable across key order", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 4 }, b: 2 })
    );
  });

  it("challenge MAC verifies and detects tampering", () => {
    const challenge = makeChallenge();
    const signature = signChallenge(challenge, secret);
    expect(verifyChallengeSignature(challenge, signature, secret)).toBe(true);
    expect(
      verifyChallengeSignature(
        { ...challenge, amount: { value: "2", currency: "CKB" } },
        signature,
        secret
      )
    ).toBe(false);
  });

  it("receipt signature verifies", () => {
    const receipt = attachReceiptSignature(
      {
        domain: "fiber-mpp-receipt-v1",
        receiptId: randomId("rcpt"),
        challengeId: "chal_1234567890abcdef",
        method: "fiber",
        resourceHash: resourceHash({ method: "GET", url: "https://example.test/paid" }),
        amount: { value: "1", currency: "CKB" },
        settlement: {
          status: "settled",
          paymentHash: "0xabc",
          provider: "fiber-rpc",
          observedAt: new Date().toISOString()
        },
        serverId: "unit",
        issuedAt: new Date().toISOString()
      },
      secret
    );
    expect(verifyReceiptSignature(receipt, secret)).toBe(true);
    expect(verifyReceiptSignature({ ...receipt, method: "unsupported-method" }, secret)).toBe(false);
  });
});

function makeChallenge(): PaymentChallenge {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  return {
    domain: "fiber-mpp-challenge-v1",
    challengeId: "chal_1234567890abcdef",
    resource: { method: "GET", url: "https://example.test/paid" },
    amount: { value: "1", currency: "CKB" },
    methods: [
      {
        method: "fiber",
        intent: "charge",
        asset: "CKB",
        amountShannons: "1000",
        paymentHash: `0x${"12".repeat(32)}`,
        invoice: "fibd1qfixture1212",
        expiresAt
      }
    ],
    nonce: randomNonce(),
    issuedAt,
    expiresAt,
    serverId: "unit",
    maxUses: 1
  };
}
