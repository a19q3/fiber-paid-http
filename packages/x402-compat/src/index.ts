import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  SettleResponse
} from "@x402/core/types";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader
} from "@x402/core/http";
import {
  bindChallengeId,
  canonicalJson,
  decodeFiberChargeRequest,
  encodeFiberChargeRequest,
  FiberChargeRequestSchema,
  PaymentChallengeSchema,
  PaymentCredentialSchema,
  PaymentReceiptSchema,
  type FiberChargeRequest,
  type PaymentChallenge,
  type PaymentCredential,
  type PaymentReceipt,
  type ResourceDescriptor
} from "@fiber-paid-http/core";
import { z } from "zod";

export const X402_VERSION = 2 as const;
export const X402_FIBER_SCHEME = "exact" as const;
export const X402_FIBER_PROFILE = "fiber-charge-v1" as const;

export const X402FiberNetworkSchema = z.enum(["fiber:mainnet", "fiber:testnet", "fiber:dev"]);

const X402FiberDetailsSchema = z.object({
  profile: z.literal(X402_FIBER_PROFILE),
  currency: z.string().min(1),
  description: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  invoice: z.string().min(1),
  invoiceCurrency: z.string().min(1).optional(),
  invoiceExpiresAt: z.string().datetime({ offset: true }).optional(),
  invoiceUdtScript: z.string().regex(/^0x[a-f0-9]+$/i).optional(),
  paymentHash: z.string().regex(/^0x[a-f0-9]{64}$/i),
  hashAlgorithm: z.enum(["ckb_hash", "sha256"]),
  udtTypeScript: z.object({
    code_hash: z.string().regex(/^0x[a-f0-9]{64}$/i),
    hash_type: z.string().min(1),
    args: z.string().regex(/^0x[a-f0-9]*$/i)
  }).strict().optional()
}).strict();

export const X402FiberRequirementsSchema = z.object({
  scheme: z.literal(X402_FIBER_SCHEME),
  network: X402FiberNetworkSchema,
  amount: z.string().regex(/^[1-9]\d*$/),
  asset: z.string().regex(/^fiber:[a-z0-9._-]+$/),
  payTo: z.string().min(1),
  maxTimeoutSeconds: z.number().int().positive().max(86_400),
  extra: z.object({ fiber: X402FiberDetailsSchema }).strict()
}).strict();

export const X402FiberPaymentPayloadSchema = z.object({
  paymentHash: z.string().regex(/^0x[a-f0-9]{64}$/i)
}).strict();

export type X402FiberRequirements = z.infer<typeof X402FiberRequirementsSchema>;
export type X402FiberPaymentPayload = z.infer<typeof X402FiberPaymentPayloadSchema>;

export function fiberChargeToX402Requirements(
  input: FiberChargeRequest,
  maxTimeoutSeconds: number
): X402FiberRequirements {
  const charge = FiberChargeRequestSchema.parse(input);
  if (!charge.recipient) throw new Error("x402-fiber-recipient-required");
  const currency = charge.currency.toLowerCase();
  return X402FiberRequirementsSchema.parse({
    scheme: X402_FIBER_SCHEME,
    network: fiberNetworkToX402(charge.methodDetails.network),
    amount: charge.amount,
    asset: `fiber:${currency}`,
    payTo: charge.recipient,
    maxTimeoutSeconds,
    extra: {
      fiber: {
        profile: X402_FIBER_PROFILE,
        currency,
        description: charge.description,
        externalId: charge.externalId,
        invoice: charge.methodDetails.invoice,
        invoiceCurrency: charge.methodDetails.invoiceCurrency,
        invoiceExpiresAt: charge.methodDetails.invoiceExpiresAt,
        invoiceUdtScript: charge.methodDetails.invoiceUdtScript,
        paymentHash: charge.methodDetails.paymentHash,
        hashAlgorithm: charge.methodDetails.hashAlgorithm,
        udtTypeScript: charge.methodDetails.udtTypeScript
      }
    }
  });
}

export function x402RequirementsToFiberCharge(input: PaymentRequirements): FiberChargeRequest {
  const requirement = X402FiberRequirementsSchema.parse(input);
  const { fiber } = requirement.extra;
  if (requirement.asset !== `fiber:${fiber.currency.toLowerCase()}`) {
    throw new Error("x402-fiber-asset-mismatch");
  }
  return FiberChargeRequestSchema.parse({
    amount: requirement.amount,
    currency: fiber.currency,
    recipient: requirement.payTo,
    description: fiber.description,
    externalId: fiber.externalId,
    methodDetails: {
      invoice: fiber.invoice,
      invoiceCurrency: fiber.invoiceCurrency,
      invoiceExpiresAt: fiber.invoiceExpiresAt,
      invoiceUdtScript: fiber.invoiceUdtScript,
      paymentHash: fiber.paymentHash,
      network: x402NetworkToFiber(requirement.network),
      hashAlgorithm: fiber.hashAlgorithm,
      udtTypeScript: fiber.udtTypeScript
    }
  });
}

export function mppChallengeToX402PaymentRequired(input: {
  challenge: PaymentChallenge;
  resource: ResourceInfo;
  maxTimeoutSeconds: number;
  error?: string;
}): PaymentRequired {
  const challenge = PaymentChallengeSchema.parse(input.challenge);
  const resource = parseResourceInfo(input.resource);
  const requirement = fiberChargeToX402Requirements(
    decodeFiberChargeRequest(challenge.request),
    input.maxTimeoutSeconds
  );
  return {
    x402Version: X402_VERSION,
    error: input.error,
    resource,
    accepts: [requirement],
    extensions: {
      fiber: {
        profile: X402_FIBER_PROFILE,
        challengeId: challenge.id,
        expires: challenge.expires,
        digest: challenge.digest
      }
    }
  };
}

export function x402PaymentRequiredToMpp(input: {
  paymentRequired: PaymentRequired;
  acceptedIndex?: number;
  resource: ResourceDescriptor;
  realm: string;
  secret: string;
  expiresAt: string;
}): PaymentChallenge {
  const required = parsePaymentRequiredV2(input.paymentRequired);
  const index = input.acceptedIndex ?? 0;
  const accepted = required.accepts[index];
  if (!accepted) throw new Error("x402-fiber-requirement-missing");
  if (required.resource.url !== input.resource.url) throw new Error("x402-fiber-resource-mismatch");
  const charge = x402RequirementsToFiberCharge(accepted);
  const pending = PaymentChallengeSchema.parse({
    id: "pending",
    realm: input.realm,
    method: "fiber",
    intent: "charge",
    request: encodeFiberChargeRequest(charge),
    expires: input.expiresAt,
    digest: input.resource.digest,
    description: required.resource.description
  });
  return PaymentChallengeSchema.parse({ ...pending, id: bindChallengeId(pending, input.secret) });
}

export function paymentCredentialToX402Payload(input: {
  credential: PaymentCredential;
  maxTimeoutSeconds: number;
  resource?: ResourceInfo;
}): PaymentPayload {
  const credential = PaymentCredentialSchema.parse(input.credential);
  return {
    x402Version: X402_VERSION,
    resource: input.resource ? parseResourceInfo(input.resource) : undefined,
    accepted: fiberChargeToX402Requirements(
      decodeFiberChargeRequest(credential.challenge.request),
      input.maxTimeoutSeconds
    ),
    payload: X402FiberPaymentPayloadSchema.parse(credential.payload)
  };
}

export function x402PaymentPayloadToCredential(input: {
  paymentPayload: PaymentPayload;
  challenge: PaymentChallenge;
  expectedResourceUrl?: string;
}): PaymentCredential {
  const paymentPayload = parsePaymentPayloadV2(input.paymentPayload);
  const challenge = PaymentChallengeSchema.parse(input.challenge);
  if (input.expectedResourceUrl && paymentPayload.resource?.url !== input.expectedResourceUrl) {
    throw new Error("x402-fiber-resource-mismatch");
  }
  const expected = fiberChargeToX402Requirements(
    decodeFiberChargeRequest(challenge.request),
    paymentPayload.accepted.maxTimeoutSeconds
  );
  if (canonicalJson(expected) !== canonicalJson(paymentPayload.accepted)) {
    throw new Error("x402-fiber-requirement-mismatch");
  }
  const payload = X402FiberPaymentPayloadSchema.parse(paymentPayload.payload);
  if (payload.paymentHash !== expected.extra.fiber.paymentHash) {
    throw new Error("wrong-payment-hash");
  }
  return PaymentCredentialSchema.parse({ challenge, source: "x402", payload });
}

export function paymentReceiptToX402SettleResponse(input: {
  receipt: PaymentReceipt;
  network: z.infer<typeof X402FiberNetworkSchema>;
  amount: string;
}): SettleResponse {
  const receipt = PaymentReceiptSchema.parse(input.receipt);
  const network = X402FiberNetworkSchema.parse(input.network);
  if (!/^[1-9]\d*$/.test(input.amount)) throw new Error("x402-fiber-invalid-amount");
  return {
    success: true,
    transaction: receipt.reference,
    network,
    amount: input.amount,
    extensions: {
      fiber: {
        profile: X402_FIBER_PROFILE,
        challengeId: receipt.challengeId,
        receiptTimestamp: receipt.timestamp
      }
    }
  };
}

export {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader
};

function parsePaymentRequiredV2(input: PaymentRequired): PaymentRequired {
  if (input.x402Version !== X402_VERSION || !input.resource || !Array.isArray(input.accepts)) {
    throw new Error("x402-v2-required");
  }
  return input;
}

function parsePaymentPayloadV2(input: PaymentPayload): PaymentPayload {
  if (input.x402Version !== X402_VERSION || !("accepted" in input)) throw new Error("x402-v2-required");
  X402FiberRequirementsSchema.parse(input.accepted);
  return input;
}

function parseResourceInfo(input: ResourceInfo): ResourceInfo {
  if (!input.url || typeof input.url !== "string") throw new Error("x402-resource-url-required");
  return { ...input };
}

function fiberNetworkToX402(network: FiberChargeRequest["methodDetails"]["network"]): z.infer<typeof X402FiberNetworkSchema> {
  return X402FiberNetworkSchema.parse(`fiber:${network}`);
}

function x402NetworkToFiber(network: z.infer<typeof X402FiberNetworkSchema>): FiberChargeRequest["methodDetails"]["network"] {
  return network.slice("fiber:".length) as FiberChargeRequest["methodDetails"]["network"];
}
