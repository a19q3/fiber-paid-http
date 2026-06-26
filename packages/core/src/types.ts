import { z } from "zod";

export const AmountSchema = z.object({
  value: z.string().min(1),
  currency: z.string().min(1),
  display: z.string().optional()
});

export const ResourceDescriptorSchema = z.object({
  method: z.string().min(1),
  url: z.string().min(1),
  bodyHash: z.string().optional(),
  contentType: z.string().optional()
});

export const FiberUdtTypeScriptSchema = z.object({
  code_hash: z.string().regex(/^0x[a-f0-9]{64}$/i),
  hash_type: z.string().min(1),
  args: z.string().regex(/^0x[a-f0-9]*$/i)
});

export const FiberMethodChallengeSchema = z.object({
  method: z.literal("fiber"),
  intent: z.literal("charge"),
  asset: z.string().min(1),
  amountShannons: z.string().regex(/^\d+$/).optional(),
  paymentHash: z.string().min(1),
  invoice: z.string().optional(),
  udtTypeScript: FiberUdtTypeScriptSchema.optional(),
  fiberNodeId: z.string().optional(),
  fiberRpcLabel: z.string().optional(),
  expiresAt: z.string().datetime()
});

export const PaymentMethodChallengeSchema = FiberMethodChallengeSchema;

export const PaymentChallengeSchema = z.object({
  domain: z.literal("fiber-mpp-challenge-v1"),
  challengeId: z.string().min(8),
  resource: ResourceDescriptorSchema,
  amount: AmountSchema,
  methods: z.array(PaymentMethodChallengeSchema).min(1),
  nonce: z.string().min(16),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  serverId: z.string().min(1),
  audience: z.string().optional(),
  maxUses: z.literal(1),
  metadataHash: z.string().optional()
});

export const PaymentCredentialSchema = z.object({
  domain: z.literal("fiber-mpp-credential-v1"),
  challengeId: z.string().min(8),
  method: z.string().min(1),
  resourceHash: z.string().min(32),
  paymentProof: z.unknown(),
  submittedAt: z.string().datetime()
});

export const SettlementSchema = z.object({
  status: z.enum(["settled", "failed"]),
  paymentHash: z.string().optional(),
  invoiceId: z.string().optional(),
  txHash: z.string().optional(),
  provider: z.string().optional(),
  observedAt: z.string().datetime()
});

export const PaymentReceiptUnsignedSchema = z.object({
  domain: z.literal("fiber-mpp-receipt-v1"),
  receiptId: z.string().min(8),
  challengeId: z.string().min(8),
  method: z.string().min(1),
  resourceHash: z.string().min(32),
  amount: z.object({
    value: z.string().min(1),
    currency: z.string().min(1)
  }),
  settlement: SettlementSchema,
  serverId: z.string().min(1),
  issuedAt: z.string().datetime()
});

export const PaymentReceiptSchema = PaymentReceiptUnsignedSchema.extend({
  signature: z.string().min(32)
});

export const SignedPaymentChallengeSchema = z.object({
  challenge: PaymentChallengeSchema,
  signature: z.string().min(32)
});

export type Amount = z.infer<typeof AmountSchema>;
export type ResourceDescriptor = z.infer<typeof ResourceDescriptorSchema>;
export type FiberUdtTypeScript = z.infer<typeof FiberUdtTypeScriptSchema>;
export type FiberMethodChallenge = z.infer<typeof FiberMethodChallengeSchema>;
export type PaymentMethodChallenge = z.infer<typeof PaymentMethodChallengeSchema>;
export type PaymentChallenge = z.infer<typeof PaymentChallengeSchema>;
export type SignedPaymentChallenge = z.infer<typeof SignedPaymentChallengeSchema>;
export type PaymentCredential = z.infer<typeof PaymentCredentialSchema>;
export type Settlement = z.infer<typeof SettlementSchema>;
export type PaymentReceiptUnsigned = z.infer<typeof PaymentReceiptUnsignedSchema>;
export type PaymentReceipt = z.infer<typeof PaymentReceiptSchema>;

export type PaymentMethodName = "fiber";
