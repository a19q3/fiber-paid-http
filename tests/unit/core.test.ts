import { describe, expect, it } from "vitest";
import {
  PaymentChallengeSchema,
  PaymentReceiptSchema,
  base64urlEncode,
  bindChallengeId,
  buildAuthorizationPaymentHeader,
  canonicalJson,
  decodeFiberChargeRequest,
  encodeFiberChargeRequest,
  parseAuthorizationPaymentHeader,
  parseWwwAuthenticatePaymentHeader,
  sha256Base64,
  verifyChallengeId,
  buildWwwAuthenticatePaymentHeader
} from "@fiber-paid-http/core";

const secret = "unit-test-secret-at-least-16";
const paymentHash = `0x${"12".repeat(32)}`;

describe("core protocol primitives", () => {
  it("canonical JSON is stable across key order", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  });

  it("binds and round-trips a standard MPP challenge", () => {
    const pending = PaymentChallengeSchema.parse({
      id: "pending",
      realm: "api.example.test",
      method: "fiber",
      intent: "charge",
      request: encodeFiberChargeRequest({
        amount: "1000",
        currency: "ckb",
        methodDetails: {
          invoice: "fibt1qfixture",
          paymentHash,
          network: "testnet",
          hashAlgorithm: "ckb_hash"
        }
      }),
      expires: "2030-01-01T00:00:00.000Z",
      "vendor-param": "round-trip"
    });
    const challenge = PaymentChallengeSchema.parse({ ...pending, id: bindChallengeId(pending, secret) });
    expect(verifyChallengeId(challenge, secret)).toBe(true);
    expect(verifyChallengeId({ ...challenge, realm: "evil.example" }, secret)).toBe(false);
    const parsed = parseWwwAuthenticatePaymentHeader(buildWwwAuthenticatePaymentHeader(challenge));
    expect(parsed).toEqual(challenge);
    expect(parsed?.["vendor-param"]).toBe("round-trip");
    expect(decodeFiberChargeRequest(challenge.request).methodDetails.paymentHash).toBe(paymentHash);
  });

  it("accepts auth schemes case-insensitively and rejects ambiguous parameters", () => {
    const pending = PaymentChallengeSchema.parse({
      id: "pending",
      realm: "api.example.test",
      method: "fiber",
      intent: "charge",
      request: encodeFiberChargeRequest({
        amount: "1000",
        currency: "ckb",
        methodDetails: {
          invoice: "fibt1qfixture",
          paymentHash,
          network: "testnet",
          hashAlgorithm: "ckb_hash"
        }
      })
    });
    const challenge = PaymentChallengeSchema.parse({ ...pending, id: bindChallengeId(pending, secret) });
    const header = buildWwwAuthenticatePaymentHeader(challenge);
    expect(parseWwwAuthenticatePaymentHeader(header.replace(/^Payment /, "payment ").replace("realm=", "Realm="))).toEqual(challenge);
    expect(parseWwwAuthenticatePaymentHeader(`${header}, ID="duplicate"`)).toBeNull();
    expect(parseWwwAuthenticatePaymentHeader(header.slice(0, -1))).toBeNull();

    const authorization = buildAuthorizationPaymentHeader({ challenge, payload: { paymentHash } });
    expect(parseAuthorizationPaymentHeader(authorization.replace(/^Payment /, "pAyMeNt "))?.challenge.id).toBe(challenge.id);
  });

  it("rejects padded base64url and non-JCS Fiber charge requests", () => {
    const canonical = encodeFiberChargeRequest({
      amount: "1000",
      currency: "ckb",
      methodDetails: {
        invoice: "fibt1qfixture",
        paymentHash,
        network: "testnet",
        hashAlgorithm: "ckb_hash"
      }
    });
    expect(() => decodeFiberChargeRequest(`${canonical}=`)).toThrow(/base64url/);

    const nonCanonical = base64urlEncode(JSON.stringify({
      currency: "ckb",
      amount: "1000",
      methodDetails: {
        network: "testnet",
        invoice: "fibt1qfixture",
        paymentHash,
        hashAlgorithm: "ckb_hash"
      }
    }));
    expect(() => decodeFiberChargeRequest(nonCanonical)).toThrow(/JCS/);
  });

  it("uses RFC 9530 body digests and validates standard receipts", () => {
    expect(`sha-256=:${sha256Base64(Buffer.from("abc"))}:`).toBe("sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:");
    expect(PaymentReceiptSchema.parse({
      status: "success",
      method: "fiber",
      timestamp: "2026-07-13T00:00:00.000Z",
      reference: paymentHash,
      challengeId: "challenge"
    }).reference).toBe(paymentHash);
  });
});
