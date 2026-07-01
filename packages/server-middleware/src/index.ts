import {
  FiberMppError,
  PAYMENT_RECEIPT_HEADER,
  PaymentChallengeSchema,
  PaymentCredentialSchema,
  attachReceiptSignature,
  buildWwwAuthenticatePaymentHeader,
  credentialHash,
  parseAuthorizationPaymentHeader,
  paymentProblemBody,
  randomId,
  randomNonce,
  resourceDescriptorFromRequest,
  resourceHash,
  signChallenge,
  toProblemJson,
  verifyChallengeSignatureWithAnySecret,
  encodeReceipt,
  sha256Hex,
  canonicalJson,
  type Amount,
  type FiberMethodChallenge,
  type FiberUdtTypeScript,
  type PaymentChallenge,
  type PaymentCredential,
  type PaymentMethodName,
  type PaymentReceipt
} from "@fiber-mpp/core";
import { FiberMethodAdapter } from "@fiber-mpp/fiber-method";
import {
  FL402ChallengeSchema,
  FL402ProofSchema,
  buildWwwAuthenticateL402Header,
  decodeFl402Macaroon,
  fl402ProofToCredential,
  parseAuthorizationL402Header,
  signedChallengeToFl402Body,
  verifyFl402Proof,
  type FL402HashAlgorithm
} from "@fiber-mpp/fl402-compat";
import {
  assertProductionStore,
  type ChallengeRecord,
  type FiberMppStore
} from "@fiber-mpp/storage";

export type PaidRouteConfig = {
  price: Amount;
  methods?: PaymentMethodName[];
  fiberAmountShannons?: string;
  fiberUdtTypeScript?: FiberUdtTypeScript;
  ttlSeconds?: number;
  audience?: string;
  metadata?: unknown;
  handler: (request: Request) => Promise<Response> | Response;
};

export type FiberMppMiddlewareConfig = {
  secret: string;
  previousSecrets?: string[];
  serverId: string;
  store: FiberMppStore;
  fiber?: FiberMethodAdapter;
  fl402?: Fl402MiddlewareConfig;
  defaultFiberAmountShannons?: string;
  challengeTtlSeconds?: number;
  clockSkewSeconds?: number;
};

export type Fl402MiddlewareConfig = {
  rootKey: string;
  hashAlgorithm?: FL402HashAlgorithm;
};

export type FiberMppMiddleware = {
  protect: (route: PaidRouteConfig) => (request: Request) => Promise<Response>;
  protectRoute: (route: PaidRouteConfig) => (request: Request) => Promise<Response>;
  issueChallenge: (request: Request, route: PaidRouteConfig) => Promise<Response>;
  verifyCredential: (request: Request, credential: PaymentCredential) => Promise<PaymentReceipt>;
  store: FiberMppStore;
};

export type ReverseProxyConfig = Omit<PaidRouteConfig, "handler"> & {
  upstream: string;
  fetchImpl?: typeof fetch;
};

export function createFiberMppMiddleware(config: FiberMppMiddlewareConfig): FiberMppMiddleware {
  if (!config.secret || config.secret.length < 16) {
    throw new Error("FiberMPP middleware requires a secret of at least 16 characters");
  }
  if (config.previousSecrets?.some((secret) => !secret || secret.length < 16)) {
    throw new Error("FiberMPP middleware previous secrets must be at least 16 characters");
  }
  if (config.fl402 && config.fl402.rootKey.length < 16) {
    throw new Error("FiberMPP F-L402 root key must be at least 16 characters");
  }
  if (!config.store) {
    throw new Error("FiberMPP middleware requires a durable store");
  }
  const store = config.store;
  assertProductionStore(store);
  const fiber = config.fiber ?? FiberMethodAdapter.fromEnv();
  const verificationSecrets = [config.secret, ...(config.previousSecrets ?? [])];
  const challengeTtlSeconds = config.challengeTtlSeconds ?? 120;
  const clockSkewSeconds = config.clockSkewSeconds ?? 5;

  async function issueChallenge(request: Request, route: PaidRouteConfig): Promise<Response> {
    const descriptor = await resourceDescriptorFromRequest(request);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (route.ttlSeconds ?? challengeTtlSeconds) * 1000).toISOString();
    const challengeId = randomId("chal");
    const enabledMethods = route.methods ?? ["fiber"];
    const methods = [];

    if (enabledMethods.includes("fiber")) {
      methods.push(
        await fiber.createChallenge({
          challengeId,
          amountShannons: route.fiberAmountShannons ?? config.defaultFiberAmountShannons ?? "1000",
          expiresAt,
          udtTypeScript: route.fiberUdtTypeScript,
          description: `FiberMPP ${request.method.toUpperCase()} ${new URL(request.url).pathname}`
        })
      );
    }

    const unsupported = enabledMethods.filter((method) => method !== "fiber");
    if (unsupported.length > 0) {
      throw new FiberMppError("unsupported-method", `Unsupported payment method(s): ${unsupported.join(", ")}`, 500);
    }

    if (methods.length === 0) {
      throw new FiberMppError("no-payment-method", "No configured payment method can serve this route", 500);
    }

    const challenge = PaymentChallengeSchema.parse({
      domain: "fiber-mpp-challenge-v1",
      challengeId,
      resource: descriptor,
      amount: route.price,
      methods,
      nonce: randomNonce(),
      issuedAt: now.toISOString(),
      expiresAt,
      serverId: config.serverId,
      audience: route.audience,
      maxUses: 1,
      metadataHash: route.metadata ? sha256Hex(canonicalJson(route.metadata)) : undefined
    });
    const signature = signChallenge(challenge, config.secret);
    const record: ChallengeRecord = {
      challenge,
      signature,
      resourceHash: resourceHash(descriptor),
      createdAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt
    };
    await store.saveChallenge(record);

    const signed = { challenge, signature };
    const body = paymentProblemBody(challenge, signature);
    const headers = new Headers({
      "content-type": "application/problem+json",
      "cache-control": "no-store"
    });
    headers.append("www-authenticate", buildWwwAuthenticatePaymentHeader(signed));
    if (config.fl402) {
      const fl402 = signedChallengeToFl402Body({
        signed,
        rootKey: config.fl402.rootKey,
        hashAlgorithm: config.fl402.hashAlgorithm
      });
      body.fl402 = fl402;
      headers.append("www-authenticate", buildWwwAuthenticateL402Header(fl402));
    }

    return new Response(JSON.stringify(body, null, 2), {
      status: 402,
      headers
    });
  }

  async function verifyCredential(request: Request, credential: PaymentCredential): Promise<PaymentReceipt> {
    const parsed = PaymentCredentialSchema.parse(credential);
    const record = await store.getChallenge(parsed.challengeId);
    if (!record) {
      throw new FiberMppError("unknown-challenge", "Payment challenge is unknown or expired", 402);
    }
    const challenge = PaymentChallengeSchema.parse(record.challenge);
    if (!verifyChallengeSignatureWithAnySecret(challenge, record.signature, verificationSecrets)) {
      throw new FiberMppError("bad-challenge-signature", "Payment challenge signature is invalid", 402);
    }
    assertNotExpired(challenge, clockSkewSeconds);

    const currentResource = await resourceDescriptorFromRequest(request);
    const currentResourceHash = resourceHash(currentResource);
    if (parsed.resourceHash !== record.resourceHash || currentResourceHash !== record.resourceHash) {
      throw new FiberMppError("wrong-resource", "Payment credential is not bound to this resource", 402);
    }

    const methodChallenge = challenge.methods.find((method) => method.method === parsed.method);
    if (!methodChallenge) {
      throw new FiberMppError("wrong-method", "Payment credential method does not match the challenge", 402);
    }

    const hash = credentialHash(parsed);
    if (await store.hasCredentialUse(hash)) {
      throw new FiberMppError("replay", "Payment credential was already used", 402);
    }

    const evidence = await verifyMethodProof(methodChallenge, parsed);
    const now = new Date().toISOString();
    const marked = await store.markChallengeUsed(challenge.challengeId, now);
    if (!marked) {
      throw new FiberMppError("replay", "Payment challenge was already redeemed", 402);
    }
    const saved = await store.saveCredentialUse(hash, parsed, now);
    if (!saved) {
      throw new FiberMppError("replay", "Payment credential was already used", 402);
    }

    if (evidence.settlement.paymentHash) {
      await store.savePaymentObservation({
        paymentHash: evidence.settlement.paymentHash,
        challengeId: challenge.challengeId,
        settlement: evidence.settlement,
        amountShannons: evidence.amountShannons,
        updatedAt: now
      });
    }

    const receipt = attachReceiptSignature(
      {
        domain: "fiber-mpp-receipt-v1",
        receiptId: randomId("rcpt"),
        challengeId: challenge.challengeId,
        method: parsed.method,
        resourceHash: record.resourceHash,
        amount: {
          value: challenge.amount.value,
          currency: challenge.amount.currency
        },
        settlement: evidence.settlement,
        serverId: config.serverId,
        issuedAt: now
      },
      config.secret
    );
    await store.saveReceipt(receipt);
    return receipt;
  }

  async function verifyMethodProof(
    methodChallenge: PaymentChallenge["methods"][number],
    credential: PaymentCredential
  ): Promise<{ settlement: PaymentReceipt["settlement"]; amountShannons?: string }> {
    if (methodChallenge.method === "fiber") {
      return fiber.verifyProof(methodChallenge as FiberMethodChallenge, credential.paymentProof);
    }
    throw new FiberMppError("unsupported-method", `${methodChallenge.method} verification is not implemented`, 402);
  }

  function protect(route: PaidRouteConfig): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      try {
        const authorization = request.headers.get("authorization");
        const credential = parseAuthorizationPaymentHeader(authorization) ?? credentialFromFl402Authorization(authorization);
        if (!credential) {
          return await issueChallenge(request, route);
        }
        const receipt = await verifyCredential(request, credential);
        const credentialUseHash = credentialHash(credential);
        try {
          const upstream = await route.handler(request);
          await store.saveDeliveryOutcome({
            receiptId: receipt.receiptId,
            challengeId: receipt.challengeId,
            credentialHash: credentialUseHash,
            status: upstream.status >= 500 ? "failed" : "delivered",
            responseStatus: upstream.status,
            recordedAt: new Date().toISOString()
          });
          const headers = new Headers(upstream.headers);
          headers.set(PAYMENT_RECEIPT_HEADER, encodeReceipt(receipt));
          return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers
          });
        } catch (handlerError) {
          const problem = toProblemJson(handlerError);
          await store.saveDeliveryOutcome({
            receiptId: receipt.receiptId,
            challengeId: receipt.challengeId,
            credentialHash: credentialUseHash,
            status: "failed",
            responseStatus: problem.status,
            errorCode: typeof problem.body.title === "string" ? problem.body.title : undefined,
            errorMessage: errorMessage(handlerError),
            recordedAt: new Date().toISOString()
          });
          return new Response(JSON.stringify(problem.body, null, 2), {
            status: problem.status,
            headers: {
              "content-type": "application/problem+json",
              "cache-control": "no-store",
              [PAYMENT_RECEIPT_HEADER]: encodeReceipt(receipt)
            }
          });
        }
      } catch (error) {
        const problem = toProblemJson(error);
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

  function credentialFromFl402Authorization(header: string | null): PaymentCredential | null {
    if (!config.fl402) {
      return null;
    }
    try {
      const parsed = parseAuthorizationL402Header(header);
      if (!parsed) {
        return null;
      }
      const decoded = decodeFl402Macaroon(parsed.macaroon);
      const caveats = decoded.payload.caveats;
      if (!caveats.challengeId) {
        throw new Error("invalid-fl402-macaroon");
      }
      const challenge = FL402ChallengeSchema.parse({
        challengeId: caveats.challengeId,
        macaroon: parsed.macaroon,
        invoice: caveats.invoice,
        paymentHash: caveats.paymentHash,
        amount: caveats.amount,
        currency: caveats.currency,
        expiresAt: caveats.expiresAt,
        resource: caveats.url,
        resourceHash: caveats.resourceHash,
        issuer: caveats.issuer,
        fiberNodeId: caveats.fiberNodeId,
        hashAlgorithm: caveats.hashAlgorithm
      });
      const submittedAt = new Date().toISOString();
      const proof = FL402ProofSchema.parse({
        macaroon: parsed.macaroon,
        preimage: parsed.preimage,
        invoice: caveats.invoice,
        paymentHash: caveats.paymentHash,
        amountShannons: caveats.amount,
        mode: fiber.mode,
        status: "settled",
        observedAt: submittedAt,
        hashAlgorithm: caveats.hashAlgorithm
      });
      verifyFl402Proof({ challenge, proof, rootKey: config.fl402.rootKey });
      return fl402ProofToCredential({
        proof,
        challengeId: caveats.challengeId,
        resourceHash: caveats.resourceHash,
        submittedAt
      });
    } catch (error) {
      throw fl402PaymentError(error);
    }
  }

  return {
    protect,
    protectRoute: protect,
    issueChallenge,
    verifyCredential,
    store
  };
}

function fl402PaymentError(error: unknown): FiberMppError {
  const message = errorMessage(error);
  const code = /^[a-z0-9-]+$/.test(message) ? message : "invalid-fl402-proof";
  return new FiberMppError(code, "F-L402 proof is invalid", 402);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}

export function createReverseProxyHandler(
  middleware: FiberMppMiddleware,
  config: ReverseProxyConfig
): (request: Request) => Promise<Response> {
  const upstream = new URL(config.upstream);
  const fetchImpl = config.fetchImpl ?? fetch;
  return middleware.protect({
    ...config,
    handler: async (request) => {
      const source = new URL(request.url);
      const target = new URL(source.pathname + source.search, upstream);
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      const init: RequestInit = {
        method: request.method,
        headers
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = await request.clone().arrayBuffer();
      }
      return fetchImpl(new Request(target, init));
    }
  });
}

function assertNotExpired(challenge: PaymentChallenge, clockSkewSeconds: number): void {
  const now = Date.now();
  const expiresAt = new Date(challenge.expiresAt).getTime();
  if (Number.isNaN(expiresAt) || now - clockSkewSeconds * 1000 > expiresAt) {
    throw new FiberMppError("expired-challenge", "Payment challenge is expired", 402);
  }
}
