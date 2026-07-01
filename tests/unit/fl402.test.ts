import { describe, expect, it } from "vitest";
import { resourceHash } from "@fiber-paid-http/core";
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
  const rootKey = "fl402-unit-root-key-at-least-16";
  const resource = { method: "GET", url: "http://localhost/paid/weather" };
  const preimage = `0x${"11".repeat(32)}`;
  const paymentHash = hashPaymentPreimage(preimage, "sha256");
  const expiresAt = "2030-01-01T00:00:00.000Z";

  it("issues and verifies an application-level F-L402 challenge", () => {
    const challenge = issueFl402Challenge({
      rootKey,
      invoice: "fibd1qfl402fixture",
      paymentHash,
      amount: "1000",
      currency: "Fibd",
      expiresAt,
      resource,
      challengeId: "chal_fl402_unit_0001",
      issuer: "fl402-unit",
      hashAlgorithm: "sha256"
    });
    expect(challenge.challengeId).toBe("chal_fl402_unit_0001");
    expect(buildWwwAuthenticateL402Header(challenge)).toContain("L402 ");
    const proof = {
      macaroon: challenge.macaroon,
      preimage,
      invoice: challenge.invoice,
      paymentHash,
      amountShannons: "1000",
      hashAlgorithm: "sha256" as const,
      mode: "local" as const,
      status: "settled",
      observedAt: "2026-07-01T00:00:00.000Z"
    };
    expect(verifyFl402Proof({ challenge, proof, rootKey, now: "2026-07-01T00:00:00.000Z" }).caveats.paymentHash)
      .toBe(paymentHash);
  });

  it("converts F-L402 challenge and proof to MPP objects", () => {
    const challenge = issueFl402Challenge({
      rootKey,
      invoice: "fibd1qfl402fixture",
      paymentHash,
      amount: "1000",
      expiresAt,
      resource,
      hashAlgorithm: "sha256"
    });
    const mpp = fl402ChallengeToMpp({
      fl402: challenge,
      resource,
      serverId: "fl402-unit",
      challengeId: "chal_1234567890abcdef",
      issuedAt: "2026-07-01T00:00:00.000Z"
    });
    expect(mpp.methods[0]).toMatchObject({ method: "fiber", paymentHash, fiberRpcLabel: "fl402-compat" });

    const credential = fl402ProofToCredential({
      proof: {
        macaroon: challenge.macaroon,
        preimage,
        invoice: challenge.invoice,
        paymentHash,
        amountShannons: "1000",
        hashAlgorithm: "sha256",
        mode: "local",
        status: "settled"
      },
      challengeId: mpp.challengeId,
      resourceHash: resourceHash(resource),
      submittedAt: "2026-07-01T00:00:00.000Z"
    });
    expect(credential.paymentProof).toMatchObject({ paymentHash, status: "settled" });
  });

  it("parses the L402 authorization header shape", () => {
    const header = buildAuthorizationL402Header({ macaroon: "fl402-macaroon-v1.aaa.bbb", preimage });
    expect(parseAuthorizationL402Header(header)).toEqual({ macaroon: "fl402-macaroon-v1.aaa.bbb", preimage });
  });
});
