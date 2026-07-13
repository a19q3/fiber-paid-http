import {
  FiberPaidHttpError,
  PAYMENT_RECEIPT_HEADER,
  PaymentCredentialSchema,
  buildAuthorizationPaymentHeader,
  decodeFiberChargeRequest,
  decodeReceipt,
  parseWwwAuthenticatePaymentHeader,
  type FiberChargeRequest,
  type PaymentChallenge,
  type PaymentReceipt
} from "@fiber-paid-http/core";
import { FiberMethodAdapter } from "@fiber-paid-http/fiber-method";

export type PaidFetchOptions = {
  fetchImpl?: typeof fetch;
  fiber?: FiberMethodAdapter;
  authorizePayment?: (input: {
    challenge: PaymentChallenge;
    charge: FiberChargeRequest;
    request: Request;
  }) => boolean | Promise<boolean>;
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
    return { response: first, receipt: parseReceiptForResponse(first) };
  }
  if (first.redirected) {
    throw new FiberPaidHttpError(
      "payment-after-redirect-forbidden",
      "Payment authorization requires a direct 402 response; redirects must be resolved explicitly first",
      403
    );
  }

  const challenge = parseChallengeResponse(first);
  if (challenge.method !== "fiber" || challenge.intent !== "charge") {
    throw new FiberPaidHttpError("method-unsupported", "Challenge is not a Fiber charge request", 400);
  }
  if (challenge.expires && Date.now() > new Date(challenge.expires).getTime()) {
    throw new FiberPaidHttpError("payment-expired", "Payment challenge is expired", 402);
  }
  const chargeRequest = decodeFiberChargeRequest(challenge.request);
  if (!options.authorizePayment) {
    throw new FiberPaidHttpError(
      "payment-authorization-required",
      "An explicit payment authorization policy is required before paying a challenge",
      403
    );
  }
  const authorized = await options.authorizePayment({
    challenge,
    charge: chargeRequest,
    request: retryTemplate.clone()
  });
  if (!authorized) {
    throw new FiberPaidHttpError("payment-not-authorized", "Payment was not authorized by the client policy", 403);
  }
  const payload = await fiber.payCharge(chargeRequest);
  const credential = PaymentCredentialSchema.parse({ challenge, payload });
  const headers = new Headers(retryTemplate.headers);
  headers.set("authorization", buildAuthorizationPaymentHeader(credential));
  const retry = await fetchImpl(new Request(retryTemplate, { headers }));
  const receipt = parseReceiptForResponse(retry);
  if (receipt) {
    if (receipt.reference.toLowerCase() !== payload.paymentHash.toLowerCase() || receipt.challengeId !== challenge.id) {
      throw new FiberPaidHttpError("invalid-receipt", "Payment receipt does not match the fulfilled challenge", 502);
    }
  }
  return { response: retry, receipt, challenge };
}

export async function inspectChallenge(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: Pick<PaidFetchOptions, "fetchImpl"> = {}
): Promise<PaymentChallenge | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(new Request(input, init));
  return response.status === 402 ? parseChallengeResponse(response) : null;
}

export function parseChallengeResponse(response: Response): PaymentChallenge {
  const challenge = parseWwwAuthenticatePaymentHeader(response.headers.get("www-authenticate"));
  if (!challenge) {
    throw new FiberPaidHttpError("missing-challenge", "402 response did not contain a valid Payment challenge", 402);
  }
  return challenge;
}

function parseReceiptForResponse(response: Response): PaymentReceipt | undefined {
  const header = response.headers.get(PAYMENT_RECEIPT_HEADER);
  if (!header) return undefined;
  if (response.status < 200 || response.status >= 300) {
    throw new FiberPaidHttpError("receipt-on-error-response", "Payment-Receipt is forbidden on non-2xx responses", 502);
  }
  return decodeReceipt(header);
}
