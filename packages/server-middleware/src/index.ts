import {
  FiberChargeRequestSchema,
  FiberPaidHttpError,
  PAYMENT_RECEIPT_HEADER,
  PaymentChallengeSchema,
  PaymentCredentialSchema,
  PaymentReceiptSchema,
  bindChallengeId,
  buildWwwAuthenticatePaymentHeader,
  canonicalJson,
  credentialHash,
  decodeFiberChargeRequest,
  encodeFiberChargeRequest,
  encodeJsonBase64url,
  encodeReceipt,
  parseAuthorizationPaymentHeader,
  paymentProblemBody,
  resourceDescriptorFromRequest,
  resourceHash,
  toProblemJson,
  verifyChallengeIdWithAnySecret,
  type FiberChargeRequest,
  type FiberUdtTypeScript,
  type PaymentChallenge,
  type PaymentCredential,
  type PaymentReceipt,
  type Settlement
} from "@fiber-paid-http/core";
import { FiberMethodAdapter } from "@fiber-paid-http/fiber-method";
import {
  FL402ChallengeSchema,
  FL402ProofSchema,
  buildWwwAuthenticateL402Header,
  decodeFl402Capability,
  issueFl402Challenge,
  parseAuthorizationL402Header,
  verifyFl402Proof,
  type FL402HashAlgorithm
} from "@fiber-paid-http/fl402-compat";
import {
  assertProductionStore,
  type ChallengeRecord,
  type FiberPaidHttpStore
} from "@fiber-paid-http/storage";

export type FiberChargeConfig = {
  amount: string;
  currency?: string;
  description?: string;
  externalId?: string;
  udtTypeScript?: FiberUdtTypeScript;
};

export type PaidRouteConfig = {
  charge: FiberChargeConfig;
  ttlSeconds?: number;
  handler: (request: Request) => Promise<Response> | Response;
};

export type FiberPaidHttpMiddlewareConfig = {
  secret: string;
  previousSecrets?: string[];
  realm: string;
  serverId: string;
  publicBaseUrl: string;
  allowInsecureHttp?: boolean;
  store: FiberPaidHttpStore;
  fiber?: FiberMethodAdapter;
  fl402?: Fl402MiddlewareConfig;
  challengeTtlSeconds?: number;
  clockSkewSeconds?: number;
};

export type Fl402MiddlewareConfig = {
  rootKey: string;
  hashAlgorithm?: FL402HashAlgorithm;
};

export type VerifiedRedemption = {
  challenge: PaymentChallenge;
  chargeRequest: FiberChargeRequest;
  credentialHash: string;
  paymentHash: string;
  settlement: Settlement;
};

export type FiberPaidHttpMiddleware = {
  protect: (route: PaidRouteConfig) => (request: Request) => Promise<Response>;
  protectRoute: (route: PaidRouteConfig) => (request: Request) => Promise<Response>;
  issueChallenge: (request: Request, route: PaidRouteConfig) => Promise<Response>;
  verifyCredential: (request: Request, credential: PaymentCredential) => Promise<VerifiedRedemption>;
  store: FiberPaidHttpStore;
};

export type ReverseProxyConfig = Omit<PaidRouteConfig, "handler"> & {
  upstream: string;
  fetchImpl?: typeof fetch;
  upstreamTimeoutMs?: number;
  upstreamResponseLimitBytes?: number;
};

export function createFiberPaidHttpMiddleware(config: FiberPaidHttpMiddlewareConfig): FiberPaidHttpMiddleware {
  if (!config.secret || config.secret.length < 32) {
    throw new Error("Fiber Paid HTTP middleware requires a secret of at least 32 characters");
  }
  if (!config.realm.trim()) {
    throw new Error("Fiber Paid HTTP middleware requires an MPP realm");
  }
  if (!config.serverId.trim()) {
    throw new Error("Fiber Paid HTTP middleware requires a serverId");
  }
  const publicBaseUrl = validatePublicBaseUrl(config.publicBaseUrl, config.allowInsecureHttp === true);
  if (config.previousSecrets?.some((secret) => !secret || secret.length < 32)) {
    throw new Error("Fiber Paid HTTP middleware previous secrets must be at least 32 characters");
  }
  if (config.fl402 && config.fl402.rootKey.length < 32) {
    throw new Error("Fiber Paid HTTP F-L402 root key must be at least 32 characters");
  }
  if (!config.store) {
    throw new Error("Fiber Paid HTTP middleware requires a durable store");
  }
  const store = config.store;
  assertProductionStore(store);
  const fiber = config.fiber ?? FiberMethodAdapter.fromEnv();
  const verificationSecrets = [config.secret, ...(config.previousSecrets ?? [])];
  const challengeTtlSeconds = config.challengeTtlSeconds ?? 120;
  const clockSkewSeconds = config.clockSkewSeconds ?? 5;
  if (!Number.isFinite(challengeTtlSeconds) || challengeTtlSeconds <= 0) {
    throw new Error("Fiber Paid HTTP challenge TTL must be positive");
  }
  if (!Number.isFinite(clockSkewSeconds) || clockSkewSeconds < 0) {
    throw new Error("Fiber Paid HTTP clock skew must be non-negative");
  }

  async function issueChallenge(request: Request, route: PaidRouteConfig): Promise<Response> {
    validatePaidRoute(route);
    const resourceBinding = await resourceDescriptorForGateway(request, publicBaseUrl);
    const now = new Date();
    const ttlSeconds = route.ttlSeconds ?? challengeTtlSeconds;
    const expires = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const chargeRequest = await fiber.createChargeRequest(
      {
        amount: route.charge.amount,
        currency: route.charge.currency,
        description:
          route.charge.description ??
          `Fiber Paid HTTP ${request.method.toUpperCase()} ${new URL(request.url).pathname}`,
        externalId: route.charge.externalId,
        udtTypeScript: route.charge.udtTypeScript
      },
      ttlSeconds
    );
    const encodedRequest = encodeFiberChargeRequest(chargeRequest);
    const unbound = PaymentChallengeSchema.parse({
      id: "pending",
      realm: config.realm,
      method: "fiber",
      intent: "charge",
      request: encodedRequest,
      expires,
      digest: resourceBinding.digest,
      description: route.charge.description,
      opaque: encodeJsonBase64url({ serverId: config.serverId })
    });
    const challenge = PaymentChallengeSchema.parse({
      ...unbound,
      id: bindChallengeId(unbound, config.secret)
    });
    const record: ChallengeRecord = {
      challenge,
      chargeRequest,
      resourceBinding,
      createdAt: now.toISOString(),
      expiresAt: expires
    };
    await store.saveChallenge(record);

    const body = paymentProblemBody();
    const headers = new Headers({
      "content-type": "application/problem+json",
      "cache-control": "no-store"
    });
    headers.append("www-authenticate", buildWwwAuthenticatePaymentHeader(challenge));
    if (config.fl402) {
      const fl402 = issueFl402Challenge({
        rootKey: config.fl402.rootKey,
        invoice: chargeRequest.methodDetails.invoice,
        paymentHash: chargeRequest.methodDetails.paymentHash,
        amount: chargeRequest.amount,
        currency: chargeRequest.currency,
        expiresAt: expires,
        resource: resourceBinding,
        challengeId: challenge.id,
        issuer: config.serverId,
        network: chargeRequest.methodDetails.network,
        hashAlgorithm: config.fl402.hashAlgorithm ?? chargeRequest.methodDetails.hashAlgorithm
      });
      headers.append("www-authenticate", buildWwwAuthenticateL402Header(fl402));
    }

    return new Response(JSON.stringify(body, null, 2), { status: 402, headers });
  }

  async function verifyCredential(request: Request, credential: PaymentCredential): Promise<VerifiedRedemption> {
    const parsed = PaymentCredentialSchema.parse(credential);
    const record = await store.getChallenge(parsed.challenge.id);
    if (!record) {
      throw new FiberPaidHttpError("invalid-challenge", "Payment challenge is unknown", 402);
    }
    const challenge = PaymentChallengeSchema.parse(record.challenge);
    if (canonicalJson(parsed.challenge) !== canonicalJson(challenge)) {
      throw new FiberPaidHttpError("invalid-challenge", "Credential does not exactly echo the issued challenge", 402);
    }
    if (!verifyChallengeIdWithAnySecret(challenge, verificationSecrets)) {
      throw new FiberPaidHttpError("invalid-challenge", "Payment challenge binding is invalid", 402);
    }
    assertNotExpired(challenge, clockSkewSeconds);

    const currentResource = await resourceDescriptorForGateway(request, publicBaseUrl);
    if (canonicalJson(currentResource) !== canonicalJson(record.resourceBinding)) {
      throw new FiberPaidHttpError("wrong-resource", "Payment credential is not bound to this resource", 402);
    }
    if (challenge.digest && challenge.digest !== currentResource.digest) {
      throw new FiberPaidHttpError("wrong-body-digest", "Request body digest does not match the challenge", 402);
    }

    const chargeRequest = FiberChargeRequestSchema.parse(decodeFiberChargeRequest(challenge.request));
    if (canonicalJson(chargeRequest) !== canonicalJson(record.chargeRequest)) {
      throw new FiberPaidHttpError("invalid-challenge", "Fiber charge request does not match stored state", 402);
    }
    if (parsed.payload.paymentHash !== chargeRequest.methodDetails.paymentHash) {
      throw new FiberPaidHttpError("wrong-payment-hash", "Fiber payment hash does not match the challenge", 402);
    }

    const evidence = await fiber.verifyPayload(chargeRequest, parsed.payload);
    const hash = credentialHash(parsed);
    const now = new Date().toISOString();
    const settlement = evidence.settlement;
    const consumed = await store.consumeRedemption({
      challengeId: challenge.id,
      credentialHash: hash,
      paymentHash: chargeRequest.methodDetails.paymentHash,
      settlement,
      consumedAt: now
    });
    if (!consumed) {
      throw new FiberPaidHttpError("replay", "Payment challenge or credential was already redeemed", 402);
    }
    await store.savePaymentObservation({
      paymentHash: chargeRequest.methodDetails.paymentHash,
      challengeId: challenge.id,
      settlement,
      amountShannons: chargeRequest.amount,
      updatedAt: now
    });
    return {
      challenge,
      chargeRequest,
      credentialHash: hash,
      paymentHash: chargeRequest.methodDetails.paymentHash,
      settlement
    };
  }

  function protect(route: PaidRouteConfig): (request: Request) => Promise<Response> {
    validatePaidRoute(route);
    return async (request: Request) => {
      const authorization = request.headers.get("authorization");
      if (!authorization) {
        return issueChallenge(request, route);
      }
      let credential: PaymentCredential | null;
      try {
        credential =
          parseAuthorizationPaymentHeader(authorization) ??
          (await credentialFromFl402Authorization(authorization));
        if (!credential) {
          return issueChallenge(request, route);
        }
      } catch {
        return issueChallenge(request, route);
      }
      if (!credential) {
        return issueChallenge(request, route);
      }

      let redemption: VerifiedRedemption;
      try {
        redemption = await verifyCredential(request, credential);
      } catch (error) {
        if (error instanceof FiberPaidHttpError && error.status === 402) {
          return issueChallenge(request, route);
        }
        return paymentErrorResponse(error);
      }

      try {
        const upstream = await route.handler(request);
        const delivered = upstream.status >= 200 && upstream.status < 300;
        const receipt = delivered ? createReceipt(redemption) : undefined;
        await store.saveDeliveryOutcome({
          challengeId: redemption.challenge.id,
          credentialHash: redemption.credentialHash,
          paymentHash: redemption.paymentHash,
          receiptReference: receipt?.reference,
          status: delivered ? "delivered" : "failed",
          responseStatus: upstream.status,
          errorCode: delivered ? undefined : "upstream-non-success",
          recordedAt: new Date().toISOString()
        });
        const headers = new Headers(upstream.headers);
        if (receipt) {
          await store.saveReceipt(receipt);
          headers.set(PAYMENT_RECEIPT_HEADER, encodeReceipt(receipt));
          headers.set("cache-control", "private");
        } else {
          headers.delete(PAYMENT_RECEIPT_HEADER);
        }
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers
        });
      } catch (handlerError) {
        const problem = toProblemJson(handlerError);
        await store.saveDeliveryOutcome({
          challengeId: redemption.challenge.id,
          credentialHash: redemption.credentialHash,
          paymentHash: redemption.paymentHash,
          status: "failed",
          responseStatus: problem.status,
          errorCode: typeof problem.body.title === "string" ? problem.body.title : undefined,
          errorMessage: "protected handler failed",
          recordedAt: new Date().toISOString()
        });
        return new Response(JSON.stringify(problem.body, null, 2), {
          status: problem.status,
          headers: {
            "content-type": "application/problem+json",
            "cache-control": "no-store"
          }
        });
      }
    };
  }

  async function credentialFromFl402Authorization(header: string | null): Promise<PaymentCredential | null> {
    if (!config.fl402) return null;
    try {
      const parsed = parseAuthorizationL402Header(header);
      if (!parsed) return null;
      const decoded = decodeFl402Capability(parsed.capability);
      const caveats = decoded.payload.caveats;
      if (!caveats.challengeId) throw new Error("invalid-fl402-capability");
      const record = await store.getChallenge(caveats.challengeId);
      if (!record) throw new Error("invalid-challenge");
      const challenge = FL402ChallengeSchema.parse({
        challengeId: caveats.challengeId,
        capability: parsed.capability,
        invoice: caveats.invoice,
        paymentHash: caveats.paymentHash,
        amount: caveats.amount,
        currency: caveats.currency,
        expiresAt: caveats.expiresAt,
        resource: caveats.url,
        resourceHash: caveats.resourceHash,
        issuer: caveats.issuer,
        fiberNodeId: caveats.fiberNodeId,
        network: caveats.network,
        hashAlgorithm: caveats.hashAlgorithm
      });
      const proof = FL402ProofSchema.parse({
        capability: parsed.capability,
        preimage: parsed.preimage,
        invoice: caveats.invoice,
        paymentHash: caveats.paymentHash,
        amountShannons: caveats.amount,
        mode: fiber.mode,
        status: "settled",
        hashAlgorithm: caveats.hashAlgorithm
      });
      verifyFl402Proof({ challenge, proof, rootKey: config.fl402.rootKey });
      return PaymentCredentialSchema.parse({
        challenge: record.challenge,
        payload: { paymentHash: caveats.paymentHash }
      });
    } catch (error) {
      throw fl402PaymentError(error);
    }
  }

  return { protect, protectRoute: protect, issueChallenge, verifyCredential, store };
}

async function resourceDescriptorForGateway(request: Request, publicBaseUrl: string) {
  const descriptor = await resourceDescriptorFromRequest(request);
  const publicBase = new URL(publicBaseUrl);
  const incoming = new URL(request.url);
  return {
    ...descriptor,
    url: new URL(`${incoming.pathname}${incoming.search}`, publicBase).toString()
  };
}

function validatePublicBaseUrl(value: string, allowInsecureHttp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Fiber Paid HTTP middleware requires an absolute publicBaseUrl");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(allowInsecureHttp && parsed.protocol === "http:" && loopback)) {
    throw new Error("Fiber Paid HTTP middleware requires HTTPS; local loopback HTTP must be explicitly enabled");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Fiber Paid HTTP publicBaseUrl must be an origin without credentials, path, query, or fragment");
  }
  return parsed.toString().replace(/\/$/, "");
}

function createReceipt(redemption: VerifiedRedemption): PaymentReceipt {
  return PaymentReceiptSchema.parse({
    status: "success",
    method: "fiber",
    timestamp: redemption.settlement.observedAt,
    reference: redemption.paymentHash,
    challengeId: redemption.challenge.id
  });
}

function paymentErrorResponse(error: unknown): Response {
  const problem = toProblemJson(error);
  return new Response(JSON.stringify(problem.body, null, 2), {
    status: problem.status,
    headers: {
      "content-type": "application/problem+json",
      "cache-control": "no-store"
    }
  });
}

function fl402PaymentError(error: unknown): FiberPaidHttpError {
  const message = errorMessage(error);
  const code = /^[a-z0-9-]+$/.test(message) ? message : "invalid-fl402-proof";
  return new FiberPaidHttpError(code, "F-L402 proof is invalid", 402);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

export function createReverseProxyHandler(
  middleware: FiberPaidHttpMiddleware,
  config: ReverseProxyConfig
): (request: Request) => Promise<Response> {
  const upstream = new URL(config.upstream);
  const fetchImpl = config.fetchImpl ?? fetch;
  const upstreamTimeoutMs = config.upstreamTimeoutMs ?? 30_000;
  const upstreamResponseLimitBytes = config.upstreamResponseLimitBytes ?? 8_388_608;
  if (!Number.isFinite(upstreamTimeoutMs) || upstreamTimeoutMs <= 0) {
    throw new Error("Fiber Paid HTTP upstream timeout must be positive");
  }
  if (!Number.isSafeInteger(upstreamResponseLimitBytes) || upstreamResponseLimitBytes < 1024) {
    throw new Error("Fiber Paid HTTP upstream response limit must be at least 1024 bytes");
  }
  if (
    !(["http:", "https:"] as string[]).includes(upstream.protocol) ||
    upstream.username ||
    upstream.password ||
    upstream.pathname !== "/" ||
    upstream.search ||
    upstream.hash
  ) {
    throw new Error("Fiber Paid HTTP upstream must be an HTTP(S) origin without credentials, path, query, or fragment");
  }
  return middleware.protect({
    ...config,
    handler: async (request) => {
      const source = new URL(request.url);
      const target = new URL(source.pathname + source.search, upstream);
      const headers = new Headers(request.headers);
      stripProxyRequestHeaders(headers);
      const init: RequestInit = {
        method: request.method,
        headers,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(upstreamTimeoutMs)])
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = await request.clone().arrayBuffer();
      }
      const response = await fetchImpl(new Request(target, init));
      const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(declaredLength) && declaredLength > upstreamResponseLimitBytes) {
        throw new FiberPaidHttpError("upstream-response-too-large", "Upstream response exceeds configured limit", 502);
      }
      const bytes = await readResponseBodyWithLimit(response, upstreamResponseLimitBytes);
      const responseHeaders = new Headers(response.headers);
      stripHopByHopHeaders(responseHeaders);
      responseHeaders.delete("content-length");
      return new Response(request.method === "HEAD" || response.status === 204 || response.status === 304 ? null : bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
    }
  });
}

function stripProxyRequestHeaders(headers: Headers): void {
  headers.delete("authorization");
  headers.delete("host");
  headers.delete("content-length");
  headers.delete(PAYMENT_RECEIPT_HEADER);
  stripHopByHopHeaders(headers);
}

function stripHopByHopHeaders(headers: Headers): void {
  const connectionTokens = (headers.get("connection") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  for (const name of connectionTokens) {
    headers.delete(name);
  }
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ]) {
    headers.delete(name);
  }
}

function validatePaidRoute(route: PaidRouteConfig): void {
  if (!/^[1-9]\d*$/.test(route.charge.amount)) {
    throw new Error("Fiber Paid HTTP route amount must be a positive decimal integer");
  }
  if (route.charge.currency !== undefined && !route.charge.currency.trim()) {
    throw new Error("Fiber Paid HTTP route currency must not be empty");
  }
  if (route.ttlSeconds !== undefined && (!Number.isSafeInteger(route.ttlSeconds) || route.ttlSeconds <= 0)) {
    throw new Error("Fiber Paid HTTP route TTL must be a positive integer");
  }
  if (typeof route.handler !== "function") {
    throw new Error("Fiber Paid HTTP route handler is required");
  }
}

async function readResponseBodyWithLimit(response: Response, limit: number): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("upstream response exceeds configured limit");
        throw new FiberPaidHttpError("upstream-response-too-large", "Upstream response exceeds configured limit", 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

function assertNotExpired(challenge: PaymentChallenge, clockSkewSeconds: number): void {
  if (!challenge.expires) return;
  const expiresAt = new Date(challenge.expires).getTime();
  if (Number.isNaN(expiresAt) || Date.now() - clockSkewSeconds * 1000 > expiresAt) {
    throw new FiberPaidHttpError("payment-expired", "Payment challenge is expired", 402);
  }
}
