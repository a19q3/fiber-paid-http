import type {
  PaymentChallenge,
  PaymentCredential
} from "./types.js";
import { PaymentChallengeSchema } from "./types.js";
import { decodeCredential, encodeCredential } from "./encoding.js";
import { resourceHash, sha256Base64 } from "./crypto.js";
import type { ResourceDescriptor } from "./types.js";

export const PAYMENT_AUTH_SCHEME = "Payment";
export const PAYMENT_RECEIPT_HEADER = "Payment-Receipt";
const PAYMENT_CHALLENGE_FIELDS = new Set([
  "id", "realm", "method", "intent", "request", "expires", "digest", "description", "opaque"
]);

export function paymentProblemBody(detail = "Payment is required."): Record<string, unknown> {
  return {
    type: "https://paymentauth.org/problems/payment-required",
    title: "Payment Required",
    status: 402,
    detail
  };
}

export function buildWwwAuthenticatePaymentHeader(challenge: PaymentChallenge): string {
  const parsed = PaymentChallengeSchema.parse(challenge);
  const fields: Array<[string, string | undefined]> = [
    ["id", parsed.id],
    ["realm", parsed.realm],
    ["method", parsed.method],
    ["intent", parsed.intent],
    ["request", parsed.request],
    ["expires", parsed.expires],
    ["digest", parsed.digest],
    ["description", parsed.description],
    ["opaque", parsed.opaque]
  ];
  for (const [key, value] of Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right))) {
    if (!PAYMENT_CHALLENGE_FIELDS.has(key) && typeof value === "string") {
      fields.push([key, value]);
    }
  }
  return `${PAYMENT_AUTH_SCHEME} ${fields
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}="${escapeQuoted(value)}"`)
    .join(", ")}`;
}

export function parseWwwAuthenticatePaymentHeader(header: string | null): PaymentChallenge | null {
  if (!header) {
    return null;
  }
  const schemeIndex = header.search(/(?:^|,\s*)Payment\s+/i);
  if (schemeIndex < 0) {
    return null;
  }
  const start = header.slice(schemeIndex).replace(/^,\s*/, "");
  try {
    const params = parseAuthParams(start.slice(start.indexOf(" ") + 1));
    return PaymentChallengeSchema.parse(params);
  } catch {
    return null;
  }
}

export function buildAuthorizationPaymentHeader(credential: PaymentCredential): string {
  return `${PAYMENT_AUTH_SCHEME} ${encodeCredential(credential)}`;
}

export function parseAuthorizationPaymentHeader(header: string | null): PaymentCredential | null {
  if (!header) {
    return null;
  }
  const [scheme, token] = header.trim().split(/\s+/, 2);
  if (scheme?.toLowerCase() !== PAYMENT_AUTH_SCHEME.toLowerCase() || !token) {
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
    digest: `sha-256=:${sha256Base64(body)}:`,
    contentType
  };
}

export async function resourceHashFromRequest(request: Request): Promise<string> {
  return resourceHash(await resourceDescriptorFromRequest(request));
}

function escapeQuoted(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}

function parseAuthParams(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  let index = 0;
  while (index < input.length) {
    while (index < input.length && /[\s,]/.test(input[index] ?? "")) index += 1;
    const keyStart = index;
    while (index < input.length && /[A-Za-z0-9_-]/.test(input[index] ?? "")) index += 1;
    const rawKey = input.slice(keyStart, index);
    const keyEnd = index;
    while (index < input.length && /\s/.test(input[index] ?? "")) index += 1;
    if (!rawKey || input[index] !== "=") {
      const rest = input.slice(index).trimStart();
      if (rawKey && index > keyEnd && /^[A-Za-z][A-Za-z0-9_-]*\s*=/.test(rest)) break;
      throw new Error("invalid trailing auth parameter");
    }
    const key = rawKey.toLowerCase();
    index += 1;
    while (index < input.length && /\s/.test(input[index] ?? "")) index += 1;
    let value = "";
    if (input[index] === '"') {
      index += 1;
      let closed = false;
      while (index < input.length) {
        const char = input[index];
        index += 1;
        if (char === '"') {
          closed = true;
          break;
        }
        if (char === "\\" && index < input.length) {
          value += input[index] ?? "";
          index += 1;
        } else {
          value += char ?? "";
        }
      }
      if (!closed) throw new Error("unterminated quoted auth parameter");
    } else {
      const valueStart = index;
      while (index < input.length && !/[\s,]/.test(input[index] ?? "")) index += 1;
      value = input.slice(valueStart, index);
    }
    if (Object.hasOwn(result, key)) {
      throw new Error(`duplicate auth parameter ${key}`);
    }
    result[key] = value;
  }
  return result;
}
