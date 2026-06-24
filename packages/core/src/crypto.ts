import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  PaymentChallengeSchema,
  PaymentReceiptSchema,
  PaymentReceiptUnsignedSchema,
  type PaymentChallenge,
  type PaymentCredential,
  type PaymentReceipt,
  type PaymentReceiptUnsigned,
  type ResourceDescriptor
} from "./types.js";
import { canonicalJson } from "./canonical.js";

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export function randomNonce(): string {
  return randomBytes(16).toString("hex");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacHex(secret: string, value: unknown): string {
  return createHmac("sha256", secret).update(canonicalJson(value)).digest("hex");
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function signChallenge(challenge: PaymentChallenge, secret: string): string {
  PaymentChallengeSchema.parse(challenge);
  return hmacHex(secret, challenge);
}

export function verifyChallengeSignature(
  challenge: PaymentChallenge,
  signature: string,
  secret: string
): boolean {
  const expected = signChallenge(challenge, secret);
  return timingSafeEqualString(expected, signature);
}

export function unsignedReceipt(receipt: PaymentReceipt): PaymentReceiptUnsigned {
  const { signature: _signature, ...unsigned } = receipt;
  return PaymentReceiptUnsignedSchema.parse(unsigned);
}

export function signReceipt(receipt: PaymentReceiptUnsigned, secret: string): string {
  PaymentReceiptUnsignedSchema.parse(receipt);
  return hmacHex(secret, receipt);
}

export function attachReceiptSignature(
  receipt: PaymentReceiptUnsigned,
  secret: string
): PaymentReceipt {
  return PaymentReceiptSchema.parse({
    ...receipt,
    signature: signReceipt(receipt, secret)
  });
}

export function verifyReceiptSignature(receipt: PaymentReceipt, secret: string): boolean {
  const parsed = PaymentReceiptSchema.parse(receipt);
  const signature = signReceipt(unsignedReceipt(parsed), secret);
  return timingSafeEqualString(signature, parsed.signature);
}

export function resourceHash(resource: ResourceDescriptor): string {
  return sha256Hex(canonicalJson(resource));
}

export function credentialHash(credential: PaymentCredential): string {
  return sha256Hex(canonicalJson(credential));
}
