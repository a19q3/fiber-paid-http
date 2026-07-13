import {
  FiberChargeRequestSchema,
  PaymentCredentialSchema,
  PaymentReceiptSchema
} from "./types.js";
import type { FiberChargeRequest, PaymentCredential, PaymentReceipt } from "./types.js";
import { canonicalJson } from "./canonical.js";

const MAX_MPP_TOKEN_LENGTH = 16 * 1024;

export function base64urlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function base64urlDecode(input: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new Error("invalid unpadded base64url");
  }
  const decoded = Buffer.from(input, "base64url");
  if (decoded.toString("base64url") !== input) {
    throw new Error("non-canonical base64url");
  }
  return decoded;
}

export function encodeJsonBase64url(value: unknown): string {
  return base64urlEncode(canonicalJson(value));
}

export function decodeJsonBase64url<T = unknown>(input: string): T {
  const bytes = base64urlDecode(input);
  return JSON.parse(bytes.toString("utf8")) as T;
}

export function encodeCredential(credential: PaymentCredential): string {
  return encodeJsonBase64url(PaymentCredentialSchema.parse(credential));
}

export function decodeCredential(token: string): PaymentCredential {
  if (token.length > MAX_MPP_TOKEN_LENGTH) throw new Error("credential exceeds MPP token limit");
  return PaymentCredentialSchema.parse(decodeJsonBase64url(token));
}

export function encodeReceipt(receipt: PaymentReceipt): string {
  return encodeJsonBase64url(PaymentReceiptSchema.parse(receipt));
}

export function decodeReceipt(token: string): PaymentReceipt {
  if (token.length > MAX_MPP_TOKEN_LENGTH) throw new Error("receipt exceeds MPP token limit");
  return PaymentReceiptSchema.parse(decodeJsonBase64url(token));
}

export function encodeFiberChargeRequest(request: FiberChargeRequest): string {
  return encodeJsonBase64url(FiberChargeRequestSchema.parse(request));
}

export function decodeFiberChargeRequest(token: string): FiberChargeRequest {
  const bytes = base64urlDecode(token);
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (canonicalJson(value) !== bytes.toString("utf8")) {
    throw new Error("Fiber charge request must use JCS before base64url encoding");
  }
  return FiberChargeRequestSchema.parse(value);
}
