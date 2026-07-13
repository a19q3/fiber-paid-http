import { z } from "zod";
import { canonicalJson } from "./canonical.js";

const MAX_MPP_REQUEST_PARAMETER_LENGTH = 16 * 1024;

const OpaqueSchema = z.string().min(1).refine((encoded) => {
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) return false;
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || Array.isArray(value) || typeof value !== "object") return false;
    if (Object.values(value as Record<string, unknown>).some((item) => typeof item !== "string")) return false;
    return canonicalJson(value) === bytes.toString("utf8");
  } catch {
    return false;
  }
}, "opaque must be unpadded base64url JCS for a string map");

const Sha256DigestSchema = z.string().regex(/^sha-256=:[A-Za-z0-9+/]+={0,2}:$/).refine((value) => {
  const encoded = value.slice("sha-256=:".length, -1);
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 32 && decoded.toString("base64") === encoded;
}, "digest must contain exactly 32 SHA-256 bytes");

const ChallengeFields = new Set([
  "id", "realm", "method", "intent", "request", "expires", "digest", "description", "opaque"
]);

export const AmountSchema = z.object({
  value: z.string().min(1),
  currency: z.string().min(1),
  display: z.string().optional()
});

export const ResourceDescriptorSchema = z.object({
  method: z.string().min(1),
  url: z.string().min(1),
  digest: z.string().optional(),
  contentType: z.string().optional()
});

export const FiberUdtTypeScriptSchema = z.object({
  code_hash: z.string().regex(/^0x[a-f0-9]{64}$/i),
  hash_type: z.string().min(1),
  args: z.string().regex(/^0x[a-f0-9]*$/i)
});

export const FiberNetworkSchema = z.enum(["mainnet", "testnet", "dev"]);
export const FiberHashAlgorithmSchema = z.enum(["ckb_hash", "sha256"]);

export const FiberChargeMethodDetailsSchema = z.object({
  invoice: z.string().min(1),
  paymentHash: z.string().regex(/^0x[a-f0-9]{64}$/i),
  network: FiberNetworkSchema,
  hashAlgorithm: FiberHashAlgorithmSchema,
  invoiceCurrency: z.string().min(1).optional(),
  invoiceExpiresAt: z.string().datetime({ offset: true }).optional(),
  invoiceUdtScript: z.string().regex(/^0x[a-f0-9]+$/i).optional(),
  udtTypeScript: FiberUdtTypeScriptSchema.optional()
}).passthrough();

export const FiberChargeRequestSchema = z.object({
  amount: z.string().regex(/^[1-9]\d*$/),
  currency: z.string().min(1),
  recipient: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  methodDetails: FiberChargeMethodDetailsSchema
}).passthrough();

export const PaymentChallengeSchema = z.object({
  id: z.string().min(1),
  realm: z.string().min(1),
  method: z.literal("fiber"),
  intent: z.literal("charge"),
  request: z.string().min(1).max(MAX_MPP_REQUEST_PARAMETER_LENGTH),
  expires: z.string().datetime({ offset: true }).optional(),
  digest: Sha256DigestSchema.optional(),
  description: z.string().min(1).optional(),
  opaque: OpaqueSchema.optional()
}).catchall(z.string()).superRefine((value, context) => {
  for (const key of Object.keys(value)) {
    if (!ChallengeFields.has(key) && !/^[a-z][a-z0-9_-]*$/.test(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: "custom challenge parameters must use lowercase auth-param names"
      });
    }
  }
});

export const FiberCredentialPayloadSchema = z.object({
  paymentHash: z.string().regex(/^0x[a-f0-9]{64}$/i)
}).passthrough();

export const PaymentCredentialSchema = z.object({
  challenge: PaymentChallengeSchema,
  source: z.string().min(1).optional(),
  payload: FiberCredentialPayloadSchema
}).passthrough();

export const SettlementSchema = z.object({
  status: z.enum(["settled", "failed"]),
  paymentHash: z.string().optional(),
  invoiceId: z.string().optional(),
  txHash: z.string().optional(),
  provider: z.string().optional(),
  observedAt: z.string().datetime({ offset: true })
});

export const PaymentReceiptSchema = z.object({
  status: z.literal("success"),
  method: z.literal("fiber"),
  timestamp: z.string().datetime({ offset: true }),
  reference: z.string().regex(/^0x[a-f0-9]{64}$/i),
  challengeId: z.string().min(1)
}).passthrough();

export type Amount = z.infer<typeof AmountSchema>;
export type ResourceDescriptor = z.infer<typeof ResourceDescriptorSchema>;
export type FiberUdtTypeScript = z.infer<typeof FiberUdtTypeScriptSchema>;
export type FiberNetwork = z.infer<typeof FiberNetworkSchema>;
export type FiberHashAlgorithm = z.infer<typeof FiberHashAlgorithmSchema>;
export type FiberChargeMethodDetails = z.infer<typeof FiberChargeMethodDetailsSchema>;
export type FiberChargeRequest = z.infer<typeof FiberChargeRequestSchema>;
export type PaymentChallenge = z.infer<typeof PaymentChallengeSchema>;
export type PaymentCredential = z.infer<typeof PaymentCredentialSchema>;
export type FiberCredentialPayload = z.infer<typeof FiberCredentialPayloadSchema>;
export type Settlement = z.infer<typeof SettlementSchema>;
export type PaymentReceipt = z.infer<typeof PaymentReceiptSchema>;

export type PaymentMethodName = "fiber";
