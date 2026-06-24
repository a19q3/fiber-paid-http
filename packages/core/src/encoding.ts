import { PaymentCredentialSchema, PaymentReceiptSchema, SignedPaymentChallengeSchema } from "./types.js";
import type { PaymentCredential, PaymentReceipt, SignedPaymentChallenge } from "./types.js";

export function base64urlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export function encodeJsonBase64url(value: unknown): string {
  return base64urlEncode(JSON.stringify(value));
}

export function decodeJsonBase64url<T = unknown>(input: string): T {
  return JSON.parse(base64urlDecode(input).toString("utf8")) as T;
}

export function encodeCredential(credential: PaymentCredential): string {
  return encodeJsonBase64url(PaymentCredentialSchema.parse(credential));
}

export function decodeCredential(token: string): PaymentCredential {
  return PaymentCredentialSchema.parse(decodeJsonBase64url(token));
}

export function encodeReceipt(receipt: PaymentReceipt): string {
  return encodeJsonBase64url(PaymentReceiptSchema.parse(receipt));
}

export function decodeReceipt(token: string): PaymentReceipt {
  return PaymentReceiptSchema.parse(decodeJsonBase64url(token));
}

export function encodeSignedChallenge(signed: SignedPaymentChallenge): string {
  return encodeJsonBase64url(SignedPaymentChallengeSchema.parse(signed));
}

export function decodeSignedChallenge(token: string): SignedPaymentChallenge {
  return SignedPaymentChallengeSchema.parse(decodeJsonBase64url(token));
}
