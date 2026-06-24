import type {
  PaymentChallenge,
  PaymentCredential,
  PaymentMethodChallenge,
  SignedPaymentChallenge
} from "./types.js";
import { decodeCredential, encodeCredential, encodeSignedChallenge } from "./encoding.js";
import { resourceHash, sha256Hex } from "./crypto.js";
import type { ResourceDescriptor } from "./types.js";

export const PAYMENT_AUTH_SCHEME = "Payment";
export const PAYMENT_RECEIPT_HEADER = "Payment-Receipt";

export function paymentProblemBody(challenge: PaymentChallenge, signature: string): Record<string, unknown> {
  return {
    type: "https://paymentauth.org/problems/payment-required",
    title: "Payment Required",
    status: 402,
    detail: "Payment is required.",
    challengeId: challenge.challengeId,
    challenge,
    challengeSignature: signature,
    methods: challenge.methods
  };
}

export function buildWwwAuthenticatePaymentHeader(signed: SignedPaymentChallenge): string {
  const methodList = signed.challenge.methods
    .map((method: PaymentMethodChallenge) => method.method)
    .join(" ");
  const primary = signed.challenge.methods[0];
  return [
    `${PAYMENT_AUTH_SCHEME} id="${signed.challenge.challengeId}"`,
    `method="${primary?.method ?? "unknown"}"`,
    `methods="${methodList}"`,
    `intent="charge"`,
    `challenge="${encodeSignedChallenge(signed)}"`
  ].join(", ");
}

export function buildAuthorizationPaymentHeader(credential: PaymentCredential): string {
  return `${PAYMENT_AUTH_SCHEME} ${encodeCredential(credential)}`;
}

export function parseAuthorizationPaymentHeader(header: string | null): PaymentCredential | null {
  if (!header) {
    return null;
  }
  const [scheme, token] = header.trim().split(/\s+/, 2);
  if (scheme !== PAYMENT_AUTH_SCHEME || !token) {
    return null;
  }
  return decodeCredential(token);
}

export async function resourceDescriptorFromRequest(request: Request): Promise<ResourceDescriptor> {
  const method = request.method.toUpperCase();
  const contentType = request.headers.get("content-type") ?? undefined;
  if (method === "GET" || method === "HEAD") {
    return { method, url: request.url, contentType };
  }
  const clone = request.clone();
  const body = Buffer.from(await clone.arrayBuffer());
  return {
    method,
    url: request.url,
    bodyHash: sha256Hex(body),
    contentType
  };
}

export async function resourceHashFromRequest(request: Request): Promise<string> {
  return resourceHash(await resourceDescriptorFromRequest(request));
}
