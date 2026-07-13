import { z } from "zod";
import {
  FiberChargeRequestSchema,
  PaymentChallengeSchema,
  PaymentCredentialSchema,
  bindChallengeId,
  decodeFiberChargeRequest,
  encodeFiberChargeRequest,
  type FiberChargeRequest,
  type PaymentChallenge,
  type PaymentCredential,
  type ResourceDescriptor
} from "@fiber-paid-http/core";

export const F402ChallengeSchema = z.object({
  token: z.string().min(1).optional(),
  invoice: z.string().min(1),
  paymentHash: z.string().regex(/^0x[a-f0-9]{64}$/i),
  amount: z.string().regex(/^[1-9]\d*$/),
  currency: z.string().default("ckb"),
  expiresAt: z.string().datetime({ offset: true }),
  resource: z.string().optional(),
  issuer: z.string().optional(),
  fiberNodeId: z.string().optional(),
  network: z.enum(["mainnet", "testnet", "dev"]).default("dev"),
  hashAlgorithm: z.enum(["ckb_hash", "sha256"]).default("ckb_hash")
});

export const F402ProofSchema = z.object({
  token: z.string().min(1).optional(),
  paymentHash: z.string().regex(/^0x[a-f0-9]{64}$/i)
});

export type F402Challenge = z.infer<typeof F402ChallengeSchema>;
export type F402Proof = z.infer<typeof F402ProofSchema>;

export function f402ChallengeToFiberChargeRequest(f402Input: F402Challenge): FiberChargeRequest {
  const f402 = F402ChallengeSchema.parse(f402Input);
  return FiberChargeRequestSchema.parse({
    amount: f402.amount,
    currency: f402.currency.toLowerCase(),
    recipient: f402.fiberNodeId,
    methodDetails: {
      invoice: f402.invoice,
      paymentHash: f402.paymentHash,
      network: f402.network,
      hashAlgorithm: f402.hashAlgorithm
    }
  });
}

export function f402ChallengeToMpp(input: {
  f402: F402Challenge;
  resource: ResourceDescriptor;
  realm: string;
  secret: string;
}): PaymentChallenge {
  const f402 = F402ChallengeSchema.parse(input.f402);
  const request = encodeFiberChargeRequest(f402ChallengeToFiberChargeRequest(f402));
  const unbound = PaymentChallengeSchema.parse({
    id: "pending",
    realm: input.realm,
    method: "fiber",
    intent: "charge",
    request,
    expires: f402.expiresAt,
    digest: input.resource.digest
  });
  return PaymentChallengeSchema.parse({ ...unbound, id: bindChallengeId(unbound, input.secret) });
}

export function f402ProofToCredential(input: {
  proof: F402Proof;
  challenge: PaymentChallenge;
}): PaymentCredential {
  const proof = F402ProofSchema.parse(input.proof);
  const challenge = PaymentChallengeSchema.parse(input.challenge);
  const request = decodeFiberChargeRequest(challenge.request);
  if (proof.paymentHash !== request.methodDetails.paymentHash) {
    throw new Error("wrong-payment-hash");
  }
  return PaymentCredentialSchema.parse({
    challenge,
    payload: { paymentHash: proof.paymentHash }
  });
}

export function mppChallengeToF402Body(challengeInput: PaymentChallenge): Record<string, unknown> {
  const challenge = PaymentChallengeSchema.parse(challengeInput);
  const request = decodeFiberChargeRequest(challenge.request);
  return {
    invoice: request.methodDetails.invoice,
    paymentHash: request.methodDetails.paymentHash,
    amount: request.amount,
    currency: request.currency,
    expiresAt: challenge.expires,
    challengeId: challenge.id,
    network: request.methodDetails.network,
    hashAlgorithm: request.methodDetails.hashAlgorithm
  };
}
