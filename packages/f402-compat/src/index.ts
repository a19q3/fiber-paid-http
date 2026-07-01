import { z } from "zod";
import {
  PaymentChallengeSchema,
  PaymentCredentialSchema,
  randomId,
  randomNonce,
  type PaymentChallenge,
  type PaymentCredential,
  type ResourceDescriptor,
  type SignedPaymentChallenge
} from "@fiber-paid-http/core";

export const F402ChallengeSchema = z.object({
  token: z.string().min(1).optional(),
  invoice: z.string().min(1),
  paymentHash: z.string().min(1),
  amount: z.string().regex(/^\d+$/),
  currency: z.string().default("CKB"),
  expiresAt: z.string().datetime(),
  resource: z.string().optional(),
  issuer: z.string().optional(),
  fiberNodeId: z.string().optional()
});

export const F402ProofSchema = z.object({
  token: z.string().min(1).optional(),
  invoice: z.string().optional(),
  paymentHash: z.string().min(1),
  amountShannons: z.string().regex(/^\d+$/).optional(),
  mode: z.enum(["local", "testnet"]).default("local"),
  status: z.string().default("settled"),
  observedAt: z.string().datetime().optional(),
  evidence: z.unknown().optional()
});

export type F402Challenge = z.infer<typeof F402ChallengeSchema>;
export type F402Proof = z.infer<typeof F402ProofSchema>;

export function f402ChallengeToMpp(input: {
  f402: F402Challenge;
  resource: ResourceDescriptor;
  serverId: string;
  challengeId?: string;
  issuedAt?: string;
  amountValue?: string;
  amountCurrency?: string;
}): PaymentChallenge {
  const f402 = F402ChallengeSchema.parse(input.f402);
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  return PaymentChallengeSchema.parse({
    domain: "fiber-paid-http-challenge-v1",
    challengeId: input.challengeId ?? randomId("chal"),
    resource: input.resource,
    amount: {
      value: input.amountValue ?? f402.amount,
      currency: input.amountCurrency ?? f402.currency
    },
    methods: [
      {
        method: "fiber",
        intent: "charge",
        asset: f402.currency,
        amountShannons: f402.amount,
        paymentHash: f402.paymentHash,
        invoice: f402.invoice,
        fiberNodeId: f402.fiberNodeId,
        fiberRpcLabel: "f402-compat",
        expiresAt: f402.expiresAt
      }
    ],
    nonce: randomNonce(),
    issuedAt,
    expiresAt: f402.expiresAt,
    serverId: input.serverId,
    audience: f402.issuer,
    maxUses: 1
  });
}

export function f402ProofToCredential(input: {
  proof: F402Proof;
  challengeId: string;
  resourceHash: string;
  submittedAt?: string;
}): PaymentCredential {
  const proof = F402ProofSchema.parse(input.proof);
  return PaymentCredentialSchema.parse({
    domain: "fiber-paid-http-credential-v1",
    challengeId: input.challengeId,
    method: "fiber",
    resourceHash: input.resourceHash,
    paymentProof: {
      kind: "fiber-payment-proof-v1",
      mode: proof.mode,
      paymentHash: proof.paymentHash,
      invoice: proof.invoice,
      amountShannons: proof.amountShannons,
      status: proof.status,
      observedAt: proof.observedAt ?? new Date().toISOString(),
      evidence: {
        f402Token: proof.token,
        f402Evidence: proof.evidence
      }
    },
    submittedAt: input.submittedAt ?? new Date().toISOString()
  });
}

export function signedChallengeToF402Body(signed: SignedPaymentChallenge): Record<string, unknown> {
  const fiber = signed.challenge.methods.find((method) => method.method === "fiber");
  if (!fiber || fiber.method !== "fiber") {
    throw new Error("Signed challenge does not contain a Fiber method");
  }
  return {
    token: signed.signature,
    invoice: fiber.invoice,
    paymentHash: fiber.paymentHash,
    amount: fiber.amountShannons,
    currency: fiber.asset,
    expiresAt: fiber.expiresAt,
    challengeId: signed.challenge.challengeId
  };
}
