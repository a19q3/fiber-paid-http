import { describe, expect, it } from "vitest";
import {
  buildAuthorizationL402Header,
  buildWwwAuthenticateL402Header,
  fl402ChallengeToMpp,
  fl402ProofToCredential,
  hashPaymentPreimage,
  issueFl402Challenge,
  parseAuthorizationL402Header,
  verifyFl402Proof
} from "@fiber-paid-http/fl402-compat";

describe("F-L402 compatibility", () => {
  const rootKey = "fl402-unit-root-key-at-least-32-characters";
  const secret = "fl402-mpp-secret-at-least-16";
  const resource = { method: "GET", url: "https://localhost/paid/weather" };
  const preimage = `0x${"11".repeat(32)}`;
  const paymentHash = hashPaymentPreimage(preimage, "sha256");

  it("issues and verifies a Fiber L402 capability", () => {
    const challenge = makeChallenge();
    expect(challenge.capability).toMatch(/^fiber-l402-capability-v1\./);
    expect(buildWwwAuthenticateL402Header(challenge)).toContain("L402 ");
    const proof = { capability: challenge.capability, preimage, paymentHash, hashAlgorithm: "sha256" as const };
    expect(verifyFl402Proof({ challenge, proof, rootKey, now: "2026-07-01T00:00:00.000Z" }).caveats.paymentHash).toBe(paymentHash);
  });

  it("normalizes F-L402 into the standard MPP credential", () => {
    const fl402 = makeChallenge();
    const challenge = fl402ChallengeToMpp({ fl402, resource, realm: "fl402.example.test", secret });
    const proof = { capability: fl402.capability, preimage, paymentHash, hashAlgorithm: "sha256" as const };
    const credential = fl402ProofToCredential({ proof, challenge });
    expect(credential.challenge).toEqual(challenge);
    expect(credential.payload.paymentHash).toBe(paymentHash);
  });

  it("parses the L402 capability authorization shape", () => {
    const capability = "fiber-l402-capability-v1.aaa.bbb";
    const header = buildAuthorizationL402Header({ capability, preimage });
    expect(parseAuthorizationL402Header(header)).toEqual({ capability, preimage });
  });

  it("rejects challenge fields that do not match signed capability caveats", () => {
    const challenge = makeChallenge();
    const proof = { capability: challenge.capability, preimage, paymentHash, hashAlgorithm: "sha256" as const };
    expect(() => verifyFl402Proof({
      challenge: { ...challenge, amount: "1001" },
      proof,
      rootKey,
      now: "2026-07-01T00:00:00.000Z"
    })).toThrow("wrong-amount");
  });

  function makeChallenge() {
    return issueFl402Challenge({
      rootKey,
      invoice: "fibt1qfl402fixture",
      paymentHash,
      amount: "1000",
      currency: "ckb",
      expiresAt: "2030-01-01T00:00:00.000Z",
      resource,
      challengeId: "fl402-unit-challenge",
      issuer: "fl402.example.test",
      network: "testnet",
      hashAlgorithm: "sha256",
      issuedAt: "2026-07-01T00:00:00.000Z"
    });
  }
});
