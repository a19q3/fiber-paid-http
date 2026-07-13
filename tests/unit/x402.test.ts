import { describe, expect, it } from "vitest";
import {
  PaymentChallengeSchema,
  PaymentCredentialSchema,
  PaymentReceiptSchema,
  bindChallengeId,
  encodeFiberChargeRequest
} from "@fiber-paid-http/core";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  mppChallengeToX402PaymentRequired,
  paymentCredentialToX402Payload,
  paymentReceiptToX402SettleResponse,
  x402PaymentPayloadToCredential,
  x402PaymentRequiredToMpp
} from "@fiber-paid-http/x402-compat";

const secret = "x402-conformance-secret-at-least-32";
const paymentHash = `0x${"ab".repeat(32)}`;
const resource = {
  method: "GET",
  url: "https://x402.example.test/paid/weather"
};

describe("x402 v2 Fiber adapter", () => {
  it("round-trips official x402 v2 headers without creating another settlement path", () => {
    const challenge = makeChallenge();
    const required = mppChallengeToX402PaymentRequired({
      challenge,
      resource: { url: resource.url, description: "Weather" },
      maxTimeoutSeconds: 120
    });
    const decodedRequired = decodePaymentRequiredHeader(encodePaymentRequiredHeader(required));
    expect(decodedRequired).toEqual(required);
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "fiber:testnet",
      amount: "1000",
      asset: "fiber:ckb",
      payTo: "03fiberpayee"
    });

    const credential = PaymentCredentialSchema.parse({
      challenge,
      source: "x402",
      payload: { paymentHash }
    });
    const signature = paymentCredentialToX402Payload({
      credential,
      maxTimeoutSeconds: 120,
      resource: { url: resource.url, description: "Weather" }
    });
    const decodedSignature = decodePaymentSignatureHeader(encodePaymentSignatureHeader(signature));
    expect(x402PaymentPayloadToCredential({
      paymentPayload: decodedSignature,
      challenge,
      expectedResourceUrl: resource.url
    })).toEqual(credential);

    const receipt = PaymentReceiptSchema.parse({
      status: "success",
      method: "fiber",
      timestamp: "2026-07-13T00:00:02.000Z",
      reference: paymentHash,
      challengeId: challenge.id
    });
    const settled = paymentReceiptToX402SettleResponse({
      receipt,
      network: "fiber:testnet",
      amount: "1000"
    });
    expect(decodePaymentResponseHeader(encodePaymentResponseHeader(settled))).toEqual(settled);
    expect(settled).toMatchObject({ success: true, transaction: paymentHash, amount: "1000" });
  });

  it("converts an x402 requirement to the same bound MPP charge", () => {
    const challenge = makeChallenge();
    const required = mppChallengeToX402PaymentRequired({
      challenge,
      resource: { url: resource.url, description: "Weather" },
      maxTimeoutSeconds: 120
    });
    const converted = x402PaymentRequiredToMpp({
      paymentRequired: required,
      resource,
      realm: challenge.realm,
      secret,
      expiresAt: challenge.expires!
    });
    expect(converted).toEqual(challenge);
  });

  it("rejects changed requirements, resources, and payment hashes", () => {
    const challenge = makeChallenge();
    const credential = PaymentCredentialSchema.parse({ challenge, source: "x402", payload: { paymentHash } });
    const payload = paymentCredentialToX402Payload({
      credential,
      maxTimeoutSeconds: 120,
      resource: { url: resource.url }
    });
    expect(() => x402PaymentPayloadToCredential({
      paymentPayload: { ...payload, accepted: { ...payload.accepted, amount: "1001" } },
      challenge,
      expectedResourceUrl: resource.url
    })).toThrow(/requirement-mismatch/);
    expect(() => x402PaymentPayloadToCredential({
      paymentPayload: { ...payload, resource: { url: "https://evil.test/paid/weather" } },
      challenge,
      expectedResourceUrl: resource.url
    })).toThrow(/resource-mismatch/);
    expect(() => x402PaymentPayloadToCredential({
      paymentPayload: { ...payload, payload: { paymentHash: `0x${"cd".repeat(32)}` } },
      challenge,
      expectedResourceUrl: resource.url
    })).toThrow(/wrong-payment-hash/);
  });
});

function makeChallenge() {
  const pending = PaymentChallengeSchema.parse({
    id: "pending",
    realm: "x402.example.test",
    method: "fiber",
    intent: "charge",
    request: encodeFiberChargeRequest({
      amount: "1000",
      currency: "ckb",
      recipient: "03fiberpayee",
      methodDetails: {
        invoice: "fibt1qx402conformance0001",
        paymentHash,
        network: "testnet",
        hashAlgorithm: "ckb_hash"
      }
    }),
    expires: "2030-01-01T00:00:00.000Z",
    description: "Weather"
  });
  return PaymentChallengeSchema.parse({ ...pending, id: bindChallengeId(pending, secret) });
}
