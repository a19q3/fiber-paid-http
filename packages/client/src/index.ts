import {
  FiberMppError,
  PAYMENT_RECEIPT_HEADER,
  PaymentChallengeSchema,
  SignedPaymentChallengeSchema,
  buildAuthorizationPaymentHeader,
  decodeReceipt,
  decodeSignedChallenge,
  resourceHashFromRequest,
  type FiberMethodChallenge,
  type PaymentChallenge,
  type PaymentReceipt,
  type SignedPaymentChallenge
} from "@fiber-mpp/core";
import { FiberMethodAdapter } from "@fiber-mpp/fiber-method";

export type PaidFetchOptions = {
  fetchImpl?: typeof fetch;
  fiber?: FiberMethodAdapter;
  methodPreference?: "fiber";
};

export type PaidFetchResult = {
  response: Response;
  receipt?: PaymentReceipt;
  challenge?: PaymentChallenge;
};

export async function paidFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: PaidFetchOptions = {}
): Promise<PaidFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const fiber = options.fiber ?? FiberMethodAdapter.fromEnv(process.env, "payer");
  const firstRequest = new Request(input, init);
  const retryTemplate = firstRequest.clone();
  const first = await fetchImpl(firstRequest);
  if (first.status !== 402) {
    return {
      response: first,
      receipt: parseReceiptHeader(first.headers.get(PAYMENT_RECEIPT_HEADER))
    };
  }

  const signed = await parseSignedChallenge(first);
  const challenge = signed.challenge;
  const fiberChallenge = challenge.methods.find((method) => method.method === "fiber") as
    | FiberMethodChallenge
    | undefined;
  if (!fiberChallenge) {
    throw new FiberMppError("fiber-method-unavailable", "Challenge did not include a Fiber payment method", 402);
  }

  const proof = await fiber.payChallenge(fiberChallenge);
  const credential = {
    domain: "fiber-mpp-credential-v1" as const,
    challengeId: challenge.challengeId,
    method: "fiber" as const,
    resourceHash: await resourceHashFromRequest(retryTemplate.clone()),
    paymentProof: proof,
    submittedAt: new Date().toISOString()
  };
  const headers = new Headers(retryTemplate.headers);
  headers.set("authorization", buildAuthorizationPaymentHeader(credential));
  const retry = await fetchImpl(new Request(retryTemplate, { headers }));
  return {
    response: retry,
    receipt: parseReceiptHeader(retry.headers.get(PAYMENT_RECEIPT_HEADER)),
    challenge
  };
}

export async function inspectChallenge(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: Pick<PaidFetchOptions, "fetchImpl"> = {}
): Promise<SignedPaymentChallenge | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(new Request(input, init));
  if (response.status !== 402) {
    return null;
  }
  return parseSignedChallenge(response);
}

export async function parseSignedChallenge(response: Response): Promise<SignedPaymentChallenge> {
  const body = (await response.clone().json()) as unknown;
  const candidate = body as {
    challenge?: unknown;
    challengeSignature?: unknown;
  };
  if (candidate.challenge && typeof candidate.challengeSignature === "string") {
    return SignedPaymentChallengeSchema.parse({
      challenge: PaymentChallengeSchema.parse(candidate.challenge),
      signature: candidate.challengeSignature
    });
  }

  const auth = response.headers.get("www-authenticate");
  const match = auth?.match(/challenge="([^"]+)"/);
  if (!match?.[1]) {
    throw new FiberMppError("missing-challenge", "402 response did not contain a Payment challenge", 402);
  }
  return decodeSignedChallenge(match[1]);
}

function parseReceiptHeader(header: string | null): PaymentReceipt | undefined {
  return header ? decodeReceipt(header) : undefined;
}
