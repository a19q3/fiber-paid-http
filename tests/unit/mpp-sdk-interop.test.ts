import { describe, expect, it } from "vitest";
import { Challenge, Credential, Receipt } from "mppx";
import {
  bindChallengeId,
  buildAuthorizationPaymentHeader,
  buildWwwAuthenticatePaymentHeader,
  decodeReceipt,
  encodeFiberChargeRequest,
  encodeReceipt,
  parseAuthorizationPaymentHeader,
  type PaymentChallenge,
  type PaymentReceipt
} from "@fiber-paid-http/core";

const secret = "mpp-sdk-interop-secret-at-least-16";
const paymentHash = `0x${"42".repeat(32)}`;
const request = {
  amount: "100",
  currency: "ckb",
  methodDetails: {
    invoice: "fibt1qinteropfixture",
    paymentHash,
    network: "testnet" as const,
    hashAlgorithm: "ckb_hash" as const
  }
};

function challenge(): PaymentChallenge {
  const pending = {
    id: "pending",
    realm: "interop.example.test",
    method: "fiber" as const,
    intent: "charge" as const,
    request: encodeFiberChargeRequest(request),
    expires: "2030-01-01T00:00:00.000Z"
  };
  return { ...pending, id: bindChallengeId(pending, secret) };
}

describe("current MPP SDK interoperability", () => {
  it("round-trips this gateway's challenge through mppx credentials", () => {
    const expected = challenge();
    const sdkChallenge = Challenge.deserialize(buildWwwAuthenticatePaymentHeader(expected));
    expect(sdkChallenge).toMatchObject({
      id: expected.id,
      realm: expected.realm,
      method: "fiber",
      intent: "charge",
      request
    });

    const authorization = Credential.serialize(Credential.from({
      challenge: sdkChallenge,
      payload: { paymentHash }
    }));
    expect(parseAuthorizationPaymentHeader(authorization)).toEqual({
      challenge: expected,
      payload: { paymentHash }
    });
  });

  it("lets mppx read credentials and receipts emitted by this toolkit", () => {
    const expected = challenge();
    const sdkCredential = Credential.deserialize(buildAuthorizationPaymentHeader({
      challenge: expected,
      payload: { paymentHash }
    }));
    expect(sdkCredential.challenge.request).toEqual(request);
    expect(sdkCredential.payload).toEqual({ paymentHash });

    const receipt: PaymentReceipt = {
      status: "success",
      method: "fiber",
      timestamp: "2026-07-13T00:00:00.000Z",
      reference: paymentHash,
      challengeId: expected.id
    };
    const sdkReceipt = Receipt.deserialize(encodeReceipt(receipt));
    expect(sdkReceipt).toMatchObject(receipt);
    expect(decodeReceipt(Receipt.serialize(sdkReceipt))).toEqual(receipt);
  });
});
