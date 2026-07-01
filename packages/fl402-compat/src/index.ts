import { hmacHex } from "@fiber-paid-http/core";
import {
  PaymentChallengeSchema,
  PaymentCredentialSchema,
  base64urlDecode,
  base64urlEncode,
  canonicalJson,
  randomId,
  randomNonce,
  resourceHash,
  sha256Hex,
  timingSafeEqualString,
  type PaymentChallenge,
  type PaymentCredential,
  type ResourceDescriptor,
  type SignedPaymentChallenge
} from "@fiber-paid-http/core";
import { blake2b } from "@noble/hashes/blake2.js";
import { z } from "zod";

export const FL402_AUTH_SCHEME = "L402";
export const FL402_MACAROON_PREFIX = "fl402-macaroon-v1";

const Hex32Schema = z.string().regex(/^(0x)?[a-f0-9]{64}$/i);

export const FL402HashAlgorithmSchema = z.enum(["ckb_hash", "sha256"]);

export const FL402CaveatsSchema = z.object({
  challengeId: z.string().min(8).optional(),
  resourceHash: z.string().min(32),
  method: z.string().min(1),
  url: z.string().min(1),
  amount: z.string().regex(/^\d+$/),
  currency: z.string().min(1),
  paymentHash: Hex32Schema,
  invoice: z.string().min(1),
  expiresAt: z.string().datetime(),
  issuer: z.string().optional(),
  fiberNodeId: z.string().optional(),
  hashAlgorithm: FL402HashAlgorithmSchema.default("ckb_hash")
});

export const FL402MacaroonPayloadSchema = z.object({
  domain: z.literal("fl402-macaroon-v1"),
  caveats: FL402CaveatsSchema,
  nonce: z.string().min(16),
  issuedAt: z.string().datetime()
});

export const FL402ChallengeSchema = z.object({
  challengeId: z.string().min(8).optional(),
  macaroon: z.string().min(1),
  invoice: z.string().min(1),
  paymentHash: Hex32Schema,
  amount: z.string().regex(/^\d+$/),
  currency: z.string().default("CKB"),
  expiresAt: z.string().datetime(),
  resource: z.string().optional(),
  resourceHash: z.string().min(32).optional(),
  issuer: z.string().optional(),
  fiberNodeId: z.string().optional(),
  hashAlgorithm: FL402HashAlgorithmSchema.default("ckb_hash")
});

export const FL402ProofSchema = z.object({
  macaroon: z.string().min(1),
  preimage: Hex32Schema,
  invoice: z.string().optional(),
  paymentHash: Hex32Schema,
  amountShannons: z.string().regex(/^\d+$/).optional(),
  mode: z.enum(["local", "testnet"]).default("local"),
  status: z.string().default("settled"),
  observedAt: z.string().datetime().optional(),
  hashAlgorithm: FL402HashAlgorithmSchema.default("ckb_hash"),
  evidence: z.unknown().optional()
});

export type FL402HashAlgorithm = z.infer<typeof FL402HashAlgorithmSchema>;
export type FL402Caveats = z.infer<typeof FL402CaveatsSchema>;
export type FL402MacaroonPayload = z.infer<typeof FL402MacaroonPayloadSchema>;
export type FL402Challenge = z.infer<typeof FL402ChallengeSchema>;
export type FL402Proof = z.infer<typeof FL402ProofSchema>;

export function issueFl402Macaroon(input: {
  rootKey: string;
  caveats: FL402Caveats;
  nonce?: string;
  issuedAt?: string;
}): string {
  const payload = FL402MacaroonPayloadSchema.parse({
    domain: "fl402-macaroon-v1",
    caveats: input.caveats,
    nonce: input.nonce ?? randomNonce(),
    issuedAt: input.issuedAt ?? new Date().toISOString()
  });
  const encoded = base64urlEncode(canonicalJson(payload));
  const signature = hmacHex(input.rootKey, payload);
  return `${FL402_MACAROON_PREFIX}.${encoded}.${signature}`;
}

export function decodeFl402Macaroon(macaroon: string): {
  payload: FL402MacaroonPayload;
  signature: string;
} {
  const [prefix, encoded, signature, extra] = macaroon.split(".");
  if (prefix !== FL402_MACAROON_PREFIX || !encoded || !signature || extra) {
    throw new Error("invalid-fl402-macaroon");
  }
  return {
    payload: FL402MacaroonPayloadSchema.parse(JSON.parse(base64urlDecode(encoded).toString("utf8"))),
    signature
  };
}

export function verifyFl402Macaroon(input: {
  macaroon: string;
  rootKey: string;
  now?: string;
}): FL402MacaroonPayload {
  const decoded = decodeFl402Macaroon(input.macaroon);
  const expected = hmacHex(input.rootKey, decoded.payload);
  if (!timingSafeEqualString(expected, decoded.signature)) {
    throw new Error("bad-fl402-macaroon-signature");
  }
  const nowMs = input.now ? new Date(input.now).getTime() : Date.now();
  const expiresMs = new Date(decoded.payload.caveats.expiresAt).getTime();
  if (Number.isNaN(expiresMs) || nowMs > expiresMs) {
    throw new Error("expired-fl402-macaroon");
  }
  return decoded.payload;
}

export function issueFl402Challenge(input: {
  rootKey: string;
  invoice: string;
  paymentHash: string;
  amount: string;
  currency?: string;
  expiresAt: string;
  resource: ResourceDescriptor;
  challengeId?: string;
  issuer?: string;
  fiberNodeId?: string;
  hashAlgorithm?: FL402HashAlgorithm;
  nonce?: string;
  issuedAt?: string;
}): FL402Challenge {
  const caveats = FL402CaveatsSchema.parse({
    challengeId: input.challengeId,
    resourceHash: resourceHash(input.resource),
    method: input.resource.method,
    url: input.resource.url,
    amount: input.amount,
    currency: input.currency ?? "CKB",
    paymentHash: input.paymentHash,
    invoice: input.invoice,
    expiresAt: input.expiresAt,
    issuer: input.issuer,
    fiberNodeId: input.fiberNodeId,
    hashAlgorithm: input.hashAlgorithm ?? "ckb_hash"
  });
  const macaroon = issueFl402Macaroon({
    rootKey: input.rootKey,
    caveats,
    nonce: input.nonce,
    issuedAt: input.issuedAt
  });
  return FL402ChallengeSchema.parse({
    challengeId: input.challengeId,
    macaroon,
    invoice: input.invoice,
    paymentHash: input.paymentHash,
    amount: input.amount,
    currency: caveats.currency,
    expiresAt: input.expiresAt,
    resource: input.resource.url,
    resourceHash: caveats.resourceHash,
    issuer: input.issuer,
    fiberNodeId: input.fiberNodeId,
    hashAlgorithm: caveats.hashAlgorithm
  });
}

export function verifyFl402Proof(input: {
  challenge: FL402Challenge;
  proof: FL402Proof;
  rootKey: string;
  now?: string;
}): FL402MacaroonPayload {
  const challenge = FL402ChallengeSchema.parse(input.challenge);
  const proof = FL402ProofSchema.parse(input.proof);
  if (challenge.macaroon !== proof.macaroon) {
    throw new Error("fl402-macaroon-mismatch");
  }
  const payload = verifyFl402Macaroon({ macaroon: proof.macaroon, rootKey: input.rootKey, now: input.now });
  const caveats = payload.caveats;
  const proofHash = hashPaymentPreimage(proof.preimage, proof.hashAlgorithm);
  const expectedHash = normalizeHex(caveats.paymentHash);
  if (normalizeHex(challenge.paymentHash) !== expectedHash || normalizeHex(proof.paymentHash) !== expectedHash) {
    throw new Error("wrong-payment-hash");
  }
  if (normalizeHex(proofHash) !== expectedHash) {
    throw new Error("wrong-preimage");
  }
  if (challenge.invoice !== caveats.invoice || proof.invoice && proof.invoice !== caveats.invoice) {
    throw new Error("wrong-invoice");
  }
  if (challenge.amount !== caveats.amount || proof.amountShannons && proof.amountShannons !== caveats.amount) {
    throw new Error("wrong-amount");
  }
  if (challenge.resourceHash && challenge.resourceHash !== caveats.resourceHash) {
    throw new Error("wrong-resource");
  }
  if (challenge.challengeId && caveats.challengeId && challenge.challengeId !== caveats.challengeId) {
    throw new Error("wrong-challenge");
  }
  if (challenge.hashAlgorithm !== caveats.hashAlgorithm || proof.hashAlgorithm !== caveats.hashAlgorithm) {
    throw new Error("wrong-hash-algorithm");
  }
  if (proof.status !== "settled") {
    throw new Error("fiber-payment-not-settled");
  }
  return payload;
}

export function fl402ChallengeToMpp(input: {
  fl402: FL402Challenge;
  resource: ResourceDescriptor;
  serverId: string;
  challengeId?: string;
  issuedAt?: string;
  amountValue?: string;
  amountCurrency?: string;
}): PaymentChallenge {
  const fl402 = FL402ChallengeSchema.parse(input.fl402);
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  return PaymentChallengeSchema.parse({
    domain: "fiber-paid-http-challenge-v1",
    challengeId: input.challengeId ?? randomId("chal"),
    resource: input.resource,
    amount: {
      value: input.amountValue ?? fl402.amount,
      currency: input.amountCurrency ?? fl402.currency
    },
    methods: [
      {
        method: "fiber",
        intent: "charge",
        asset: fl402.currency,
        amountShannons: fl402.amount,
        paymentHash: fl402.paymentHash,
        invoice: fl402.invoice,
        fiberNodeId: fl402.fiberNodeId,
        fiberRpcLabel: "fl402-compat",
        expiresAt: fl402.expiresAt
      }
    ],
    nonce: randomNonce(),
    issuedAt,
    expiresAt: fl402.expiresAt,
    serverId: input.serverId,
    audience: fl402.issuer,
    maxUses: 1
  });
}

export function fl402ProofToCredential(input: {
  proof: FL402Proof;
  challengeId: string;
  resourceHash: string;
  submittedAt?: string;
}): PaymentCredential {
  const proof = FL402ProofSchema.parse(input.proof);
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
        fl402Macaroon: proof.macaroon,
        fl402PreimageHash: hashPaymentPreimage(proof.preimage, proof.hashAlgorithm),
        fl402HashAlgorithm: proof.hashAlgorithm,
        fl402Evidence: proof.evidence
      }
    },
    submittedAt: input.submittedAt ?? new Date().toISOString()
  });
}

export function signedChallengeToFl402Body(input: {
  signed: SignedPaymentChallenge;
  rootKey: string;
  hashAlgorithm?: FL402HashAlgorithm;
}): FL402Challenge {
  const fiber = input.signed.challenge.methods.find((method) => method.method === "fiber");
  if (!fiber || fiber.method !== "fiber" || !fiber.invoice || !fiber.amountShannons) {
    throw new Error("Signed challenge does not contain a complete Fiber method");
  }
  return issueFl402Challenge({
    rootKey: input.rootKey,
    invoice: fiber.invoice,
    paymentHash: fiber.paymentHash,
    amount: fiber.amountShannons,
    currency: fiber.asset,
    expiresAt: fiber.expiresAt,
    resource: input.signed.challenge.resource,
    challengeId: input.signed.challenge.challengeId,
    issuer: input.signed.challenge.serverId,
    fiberNodeId: fiber.fiberNodeId,
    hashAlgorithm: input.hashAlgorithm
  });
}

export function buildWwwAuthenticateL402Header(challenge: FL402Challenge): string {
  const fl402 = FL402ChallengeSchema.parse(challenge);
  return [
    `${FL402_AUTH_SCHEME} macaroon="${fl402.macaroon}"`,
    `invoice="${fl402.invoice}"`,
    `payment_hash="${fl402.paymentHash}"`,
    `amount="${fl402.amount}"`,
    `currency="${fl402.currency}"`
  ].join(", ");
}

export function buildAuthorizationL402Header(proof: Pick<FL402Proof, "macaroon" | "preimage">): string {
  return `${FL402_AUTH_SCHEME} ${proof.macaroon}:${proof.preimage}`;
}

export function parseAuthorizationL402Header(header: string | null): Pick<FL402Proof, "macaroon" | "preimage"> | null {
  if (!header) {
    return null;
  }
  const [scheme, credentials] = header.trim().split(/\s+/, 2);
  if (scheme !== FL402_AUTH_SCHEME || !credentials) {
    return null;
  }
  const [macaroon, preimage, extra] = credentials.split(":");
  if (!macaroon || !preimage || extra) {
    return null;
  }
  Hex32Schema.parse(preimage);
  return { macaroon, preimage };
}

export function hashPaymentPreimage(preimage: string, algorithm: FL402HashAlgorithm): `0x${string}` {
  const bytes = hexToBytes(preimage);
  if (algorithm === "sha256") {
    return `0x${sha256Hex(Buffer.from(bytes))}`;
  }
  const digest = blake2b(bytes, {
    dkLen: 32,
    personalization: new TextEncoder().encode("ckb-default-hash")
  });
  return `0x${bytesToHex(digest)}`;
}

function normalizeHex(value: string): string {
  return value.toLowerCase().replace(/^0x/, "");
}

function hexToBytes(value: string): Uint8Array {
  const normalized = normalizeHex(value);
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("expected-32-byte-hex");
  }
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
