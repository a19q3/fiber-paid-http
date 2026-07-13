import { createHash, randomBytes } from "node:crypto";
import {
  FiberChargeRequestSchema,
  PaymentChallengeSchema,
  PaymentCredentialSchema,
  base64urlDecode,
  base64urlEncode,
  bindChallengeId,
  canonicalJson,
  decodeFiberChargeRequest,
  encodeFiberChargeRequest,
  hmacHex,
  resourceHash,
  timingSafeEqualString,
  type PaymentChallenge,
  type PaymentCredential,
  type ResourceDescriptor
} from "@fiber-paid-http/core";
import { blake2b } from "@noble/hashes/blake2.js";
import { z } from "zod";

export const FL402_AUTH_SCHEME = "L402";
export const FL402_CAPABILITY_PREFIX = "fiber-l402-capability-v1";

const Hex32Schema = z.string().regex(/^(0x)?[a-f0-9]{64}$/i);

export const FL402HashAlgorithmSchema = z.enum(["ckb_hash", "sha256"]);

export const FL402CaveatsSchema = z.object({
  challengeId: z.string().min(1),
  resourceHash: z.string().min(32),
  method: z.string().min(1),
  url: z.string().min(1),
  amount: z.string().regex(/^[1-9]\d*$/),
  currency: z.string().min(1),
  paymentHash: Hex32Schema,
  invoice: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  issuer: z.string().optional(),
  fiberNodeId: z.string().optional(),
  network: z.enum(["mainnet", "testnet", "dev"]).default("dev"),
  hashAlgorithm: FL402HashAlgorithmSchema.default("ckb_hash")
});

export const FL402CapabilityPayloadSchema = z.object({
  domain: z.literal("fiber-l402-capability-v1"),
  caveats: FL402CaveatsSchema,
  nonce: z.string().min(16),
  issuedAt: z.string().datetime({ offset: true })
});

export const FL402ChallengeSchema = z.object({
  challengeId: z.string().min(1),
  capability: z.string().min(1),
  invoice: z.string().min(1),
  paymentHash: Hex32Schema,
  amount: z.string().regex(/^[1-9]\d*$/),
  currency: z.string().default("ckb"),
  expiresAt: z.string().datetime({ offset: true }),
  resource: z.string().optional(),
  resourceHash: z.string().min(32),
  issuer: z.string().optional(),
  fiberNodeId: z.string().optional(),
  network: z.enum(["mainnet", "testnet", "dev"]).default("dev"),
  hashAlgorithm: FL402HashAlgorithmSchema.default("ckb_hash")
});

export const FL402ProofSchema = z.object({
  capability: z.string().min(1),
  preimage: Hex32Schema,
  paymentHash: Hex32Schema,
  hashAlgorithm: FL402HashAlgorithmSchema.default("ckb_hash")
});

export type FL402HashAlgorithm = z.infer<typeof FL402HashAlgorithmSchema>;
export type FL402Caveats = z.infer<typeof FL402CaveatsSchema>;
export type FL402CapabilityPayload = z.infer<typeof FL402CapabilityPayloadSchema>;
export type FL402Challenge = z.infer<typeof FL402ChallengeSchema>;
export type FL402Proof = z.infer<typeof FL402ProofSchema>;

export function issueFl402Capability(input: {
  rootKey: string;
  caveats: FL402Caveats;
  nonce?: string;
  issuedAt?: string;
}): string {
  assertFl402RootKey(input.rootKey);
  const payload = FL402CapabilityPayloadSchema.parse({
    domain: FL402_CAPABILITY_PREFIX,
    caveats: input.caveats,
    nonce: input.nonce ?? randomBytes(16).toString("hex"),
    issuedAt: input.issuedAt ?? new Date().toISOString()
  });
  const encoded = base64urlEncode(canonicalJson(payload));
  const signature = hmacHex(input.rootKey, payload);
  return `${FL402_CAPABILITY_PREFIX}.${encoded}.${signature}`;
}

export function decodeFl402Capability(capability: string): {
  payload: FL402CapabilityPayload;
  signature: string;
} {
  const [prefix, encoded, signature, extra] = capability.split(".");
  if (prefix !== FL402_CAPABILITY_PREFIX || !encoded || !signature || extra) {
    throw new Error("invalid-fl402-capability");
  }
  const bytes = base64urlDecode(encoded);
  const payload = FL402CapabilityPayloadSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (base64urlEncode(canonicalJson(payload)) !== encoded) {
    throw new Error("invalid-fl402-capability");
  }
  return {
    payload,
    signature
  };
}

export function verifyFl402Capability(input: {
  capability: string;
  rootKey: string;
  now?: string;
}): FL402CapabilityPayload {
  assertFl402RootKey(input.rootKey);
  const decoded = decodeFl402Capability(input.capability);
  const expected = hmacHex(input.rootKey, decoded.payload);
  if (!timingSafeEqualString(expected, decoded.signature)) {
    throw new Error("bad-fl402-capability-signature");
  }
  const nowMs = input.now ? new Date(input.now).getTime() : Date.now();
  const issuedMs = new Date(decoded.payload.issuedAt).getTime();
  const expiresMs = new Date(decoded.payload.caveats.expiresAt).getTime();
  if (Number.isNaN(nowMs) || Number.isNaN(issuedMs) || Number.isNaN(expiresMs) || issuedMs > nowMs || nowMs > expiresMs) {
    throw new Error("expired-fl402-capability");
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
  challengeId: string;
  issuer?: string;
  fiberNodeId?: string;
  network?: "mainnet" | "testnet" | "dev";
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
    currency: input.currency ?? "ckb",
    paymentHash: input.paymentHash,
    invoice: input.invoice,
    expiresAt: input.expiresAt,
    issuer: input.issuer,
    fiberNodeId: input.fiberNodeId,
    network: input.network ?? "dev",
    hashAlgorithm: input.hashAlgorithm ?? "ckb_hash"
  });
  const capability = issueFl402Capability({
    rootKey: input.rootKey,
    caveats,
    nonce: input.nonce,
    issuedAt: input.issuedAt
  });
  return FL402ChallengeSchema.parse({
    challengeId: input.challengeId,
    capability,
    invoice: input.invoice,
    paymentHash: input.paymentHash,
    amount: input.amount,
    currency: caveats.currency,
    expiresAt: input.expiresAt,
    resource: input.resource.url,
    resourceHash: caveats.resourceHash,
    issuer: input.issuer,
    fiberNodeId: input.fiberNodeId,
    network: caveats.network,
    hashAlgorithm: caveats.hashAlgorithm
  });
}

export function verifyFl402Proof(input: {
  challenge: FL402Challenge;
  proof: FL402Proof;
  rootKey: string;
  now?: string;
}): FL402CapabilityPayload {
  const challenge = FL402ChallengeSchema.parse(input.challenge);
  const proof = FL402ProofSchema.parse(input.proof);
  if (challenge.capability !== proof.capability) throw new Error("fl402-capability-mismatch");
  const payload = verifyFl402Capability({
    capability: proof.capability,
    rootKey: input.rootKey,
    now: input.now
  });
  const caveats = payload.caveats;
  const proofHash = hashPaymentPreimage(proof.preimage, proof.hashAlgorithm);
  const expectedHash = normalizeHex(caveats.paymentHash);
  if (normalizeHex(challenge.paymentHash) !== expectedHash || normalizeHex(proof.paymentHash) !== expectedHash) {
    throw new Error("wrong-payment-hash");
  }
  if (normalizeHex(proofHash) !== expectedHash) throw new Error("wrong-preimage");
  if (challenge.resourceHash !== caveats.resourceHash) throw new Error("wrong-resource");
  if (challenge.resource !== caveats.url) throw new Error("wrong-resource");
  if (challenge.challengeId !== caveats.challengeId) throw new Error("wrong-challenge");
  if (challenge.invoice !== caveats.invoice) throw new Error("wrong-invoice");
  if (challenge.amount !== caveats.amount) throw new Error("wrong-amount");
  if (challenge.currency !== caveats.currency) throw new Error("wrong-currency");
  if (challenge.expiresAt !== caveats.expiresAt) throw new Error("wrong-expiry");
  if (challenge.issuer !== caveats.issuer) throw new Error("wrong-issuer");
  if (challenge.fiberNodeId !== caveats.fiberNodeId) throw new Error("wrong-recipient");
  if (challenge.network !== caveats.network) throw new Error("wrong-network");
  if (challenge.hashAlgorithm !== caveats.hashAlgorithm || proof.hashAlgorithm !== caveats.hashAlgorithm) {
    throw new Error("wrong-hash-algorithm");
  }
  return payload;
}

export function fl402ChallengeToMpp(input: {
  fl402: FL402Challenge;
  resource: ResourceDescriptor;
  realm: string;
  secret: string;
}): PaymentChallenge {
  const fl402 = FL402ChallengeSchema.parse(input.fl402);
  const request = FiberChargeRequestSchema.parse({
    amount: fl402.amount,
    currency: fl402.currency,
    recipient: fl402.fiberNodeId,
    methodDetails: {
      invoice: fl402.invoice,
      paymentHash: fl402.paymentHash,
      network: fl402.network,
      hashAlgorithm: fl402.hashAlgorithm
    }
  });
  const unbound = PaymentChallengeSchema.parse({
    id: "pending",
    realm: input.realm,
    method: "fiber",
    intent: "charge",
    request: encodeFiberChargeRequest(request),
    expires: fl402.expiresAt,
    digest: input.resource.digest
  });
  return PaymentChallengeSchema.parse({ ...unbound, id: bindChallengeId(unbound, input.secret) });
}

export function fl402ProofToCredential(input: {
  proof: FL402Proof;
  challenge: PaymentChallenge;
}): PaymentCredential {
  const proof = FL402ProofSchema.parse(input.proof);
  const challenge = PaymentChallengeSchema.parse(input.challenge);
  const request = decodeFiberChargeRequest(challenge.request);
  if (normalizeHex(proof.paymentHash) !== normalizeHex(request.methodDetails.paymentHash)) {
    throw new Error("wrong-payment-hash");
  }
  return PaymentCredentialSchema.parse({ challenge, payload: { paymentHash: proof.paymentHash } });
}

export function buildWwwAuthenticateL402Header(challenge: FL402Challenge): string {
  const fl402 = FL402ChallengeSchema.parse(challenge);
  return [
    `${FL402_AUTH_SCHEME} capability="${fl402.capability}"`,
    `invoice="${fl402.invoice}"`,
    `payment_hash="${fl402.paymentHash}"`,
    `amount="${fl402.amount}"`,
    `currency="${fl402.currency}"`
  ].join(", ");
}

export function buildAuthorizationL402Header(proof: Pick<FL402Proof, "capability" | "preimage">): string {
  return `${FL402_AUTH_SCHEME} ${proof.capability}:${normalizeHex(proof.preimage)}`;
}

export function parseAuthorizationL402Header(
  header: string | null
): Pick<FL402Proof, "capability" | "preimage"> | null {
  if (!header) return null;
  const [scheme, credentials] = header.trim().split(/\s+/, 2);
  if (scheme?.toLowerCase() !== FL402_AUTH_SCHEME.toLowerCase() || !credentials) return null;
  const separator = credentials.lastIndexOf(":");
  if (separator <= 0) throw new Error("invalid-fl402-authorization");
  return {
    capability: credentials.slice(0, separator),
    preimage: Hex32Schema.parse(credentials.slice(separator + 1))
  };
}

export function hashPaymentPreimage(preimage: string, algorithm: FL402HashAlgorithm): `0x${string}` {
  const bytes = Buffer.from(normalizeHex(preimage).slice(2), "hex");
  const digest = algorithm === "sha256"
    ? createHash("sha256").update(bytes).digest()
    : Buffer.from(blake2b(bytes, { dkLen: 32, personalization: Buffer.from("ckb-default-hash") }));
  return `0x${digest.toString("hex")}`;
}

function normalizeHex(value: string): `0x${string}` {
  return `0x${value.replace(/^0x/i, "").toLowerCase()}`;
}

function assertFl402RootKey(rootKey: string): void {
  if (Buffer.byteLength(rootKey, "utf8") < 32) {
    throw new Error("fl402-root-key-too-short");
  }
}
