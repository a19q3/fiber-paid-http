import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  PaymentChallengeSchema,
  type PaymentChallenge,
  type PaymentCredential,
  type ResourceDescriptor
} from "./types.js";
import { canonicalJson } from "./canonical.js";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha256Base64(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("base64");
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

export function challengeBindingInput(challenge: Omit<PaymentChallenge, "id"> | PaymentChallenge): string {
  return [
    challenge.realm,
    challenge.method,
    challenge.intent,
    challenge.request,
    challenge.expires ?? "",
    challenge.digest ?? "",
    challenge.opaque ?? ""
  ].join("|");
}

export function bindChallengeId(challenge: Omit<PaymentChallenge, "id">, secret: string): string {
  return createHmac("sha256", secret).update(challengeBindingInput(challenge)).digest("base64url");
}

export function verifyChallengeId(
  challenge: PaymentChallenge,
  secret: string
): boolean {
  const parsed = PaymentChallengeSchema.parse(challenge);
  return timingSafeEqualString(parsed.id, bindChallengeId(parsed, secret));
}

export function verifyChallengeIdWithAnySecret(challenge: PaymentChallenge, secrets: string[]): boolean {
  return secrets.some((secret) => verifyChallengeId(challenge, secret));
}

export function resourceHash(resource: ResourceDescriptor): string {
  return sha256Hex(canonicalJson(resource));
}

export function credentialHash(credential: PaymentCredential): string {
  return sha256Hex(canonicalJson(credential));
}
