import { describe, expect, it } from "vitest";
import { decodeFiberChargeRequest, verifyChallengeId } from "@fiber-paid-http/core";
import { f402ChallengeToMpp, f402ProofToCredential } from "@fiber-paid-http/f402-compat";

const secret = "f402-unit-secret-at-least-16";
const paymentHash = `0x${"ab".repeat(32)}`;
const resource = { method: "GET", url: "https://localhost/paid/weather" };

describe("F402 compatibility", () => {
  it("normalizes an F402 challenge into a bound MPP challenge", () => {
    const challenge = makeChallenge();
    expect(challenge.method).toBe("fiber");
    expect(verifyChallengeId(challenge, secret)).toBe(true);
    expect(decodeFiberChargeRequest(challenge.request).methodDetails.paymentHash).toBe(paymentHash);
  });

  it("normalizes an F402 proof into a standard Payment credential", () => {
    const challenge = makeChallenge();
    const credential = f402ProofToCredential({
      challenge,
      proof: { token: "v1.aaa.bbb", paymentHash }
    });
    expect(credential.challenge).toEqual(challenge);
    expect(credential.payload).toEqual({ paymentHash });
  });
});

function makeChallenge() {
  return f402ChallengeToMpp({
    f402: {
      token: "v1.aaa.bbb",
      invoice: "fibt1qfixture",
      paymentHash,
      amount: "1000",
      currency: "ckb",
      expiresAt: "2030-01-01T00:00:00.000Z",
      network: "testnet",
      hashAlgorithm: "ckb_hash"
    },
    resource,
    realm: "f402.example.test",
    secret
  });
}
