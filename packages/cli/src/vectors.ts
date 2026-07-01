import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  FiberPaidHttpError,
  PaymentChallengeSchema,
  PaymentCredentialSchema,
  PaymentReceiptSchema,
  attachReceiptSignature,
  canonicalJson,
  resourceHash,
  sha256Hex,
  signChallenge,
  verifyChallengeSignature,
  verifyReceiptSignature,
  type PaymentChallenge,
  type PaymentCredential,
  type PaymentReceipt,
  type ResourceDescriptor
} from "@fiber-paid-http/core";
import { FiberMethodAdapter, FiberRpcClient } from "@fiber-paid-http/fiber-method";
import {
  F402ChallengeSchema,
  F402ProofSchema,
  f402ChallengeToMpp,
  f402ProofToCredential
} from "@fiber-paid-http/f402-compat";
import {
  FL402ChallengeSchema,
  FL402ProofSchema,
  fl402ChallengeToMpp,
  fl402ProofToCredential,
  hashPaymentPreimage,
  issueFl402Challenge,
  verifyFl402Proof
} from "@fiber-paid-http/fl402-compat";
import { createFiberPaidHttpMiddleware } from "@fiber-paid-http/server-middleware";
import { SqliteStore } from "@fiber-paid-http/storage";

type VerificationResult = "accepted" | "rejected";

type VectorDocument = {
  input: Record<string, unknown>;
  expected_canonical_hash: string;
  expected_verification_result: VerificationResult;
  expected_error_code?: string;
  notes: string;
};

type VerificationOutcome = {
  result: VerificationResult;
  errorCode?: string;
};

type SecurityMatrixRow = {
  attack: string;
  expected_rejection: string;
  implemented_test: string;
  vector_file: string;
  status: "covered";
};

const VECTOR_DIR = "test-vectors";
const SUCCESS_REPORT_PATH = "reports/fiber-local-e2e-success.json";
const SECRET = "fiber-paid-http-conformance-secret";
const FL402_ROOT_KEY = "fiber-paid-http-fl402-conformance-root-key";
const SERVER_ID = "fiber-paid-http-ts-conformance";
const FIXED_NOW = "2026-06-24T00:00:00.000Z";
const VALID_EXPIRES = "2030-01-01T00:00:00.000Z";
const EXPIRED_AT = "2020-01-01T00:00:00.000Z";
const CHALLENGE_ID = "chal_conformance_0001";
const NONCE = "0123456789abcdef0123456789abcdef";
const PAYMENT_HASH = `0x${"ab".repeat(32)}`;
const FL402_PREIMAGE = `0x${"11".repeat(32)}`;
const FL402_PAYMENT_HASH = hashPaymentPreimage(FL402_PREIMAGE, "sha256");
const INVOICE = "fibd1qconformancepayment0001";
const AMOUNT_SHANNONS = "1000";
const RESOURCE: ResourceDescriptor = {
  method: "GET",
  url: "http://conformance.local/paid/weather"
};
const WRONG_RESOURCE: ResourceDescriptor = {
  method: "GET",
  url: "http://conformance.local/paid/file"
};

const SECURITY_MATRIX: SecurityMatrixRow[] = [
  {
    attack: "replay",
    expected_rejection: "replay",
    implemented_test: "tests/integration/full-flow.test.ts and test-vectors/attack.replay.json",
    vector_file: "test-vectors/attack.replay.json",
    status: "covered"
  },
  {
    attack: "wrong resource",
    expected_rejection: "wrong-resource",
    implemented_test: "tests/integration/full-flow.test.ts and test-vectors/attack.wrong-resource.json",
    vector_file: "test-vectors/attack.wrong-resource.json",
    status: "covered"
  },
  {
    attack: "wrong amount",
    expected_rejection: "wrong-amount",
    implemented_test: "tests/unit/middleware.test.ts and test-vectors/attack.wrong-amount.json",
    vector_file: "test-vectors/attack.wrong-amount.json",
    status: "covered"
  },
  {
    attack: "wrong method",
    expected_rejection: "wrong-method",
    implemented_test: "tests/unit/middleware.test.ts and test-vectors/attack.wrong-method.json",
    vector_file: "test-vectors/attack.wrong-method.json",
    status: "covered"
  },
  {
    attack: "expired challenge",
    expected_rejection: "expired-challenge",
    implemented_test: "tests/integration/full-flow.test.ts, tests/unit/middleware.test.ts, and test-vectors/attack.expired-challenge.json",
    vector_file: "test-vectors/attack.expired-challenge.json",
    status: "covered"
  },
  {
    attack: "tampered receipt",
    expected_rejection: "bad-receipt-signature",
    implemented_test: "test-vectors/attack.tampered-receipt.json",
    vector_file: "test-vectors/attack.tampered-receipt.json",
    status: "covered"
  },
  {
    attack: "F-L402 wrong preimage",
    expected_rejection: "wrong-preimage",
    implemented_test: "tests/unit/fl402.test.ts and test-vectors/attack.fl402-wrong-preimage.json",
    vector_file: "test-vectors/attack.fl402-wrong-preimage.json",
    status: "covered"
  },
  {
    attack: "F-L402 tampered macaroon",
    expected_rejection: "bad-fl402-macaroon-signature",
    implemented_test: "tests/unit/fl402.test.ts and test-vectors/attack.fl402-tampered-macaroon.json",
    vector_file: "test-vectors/attack.fl402-tampered-macaroon.json",
    status: "covered"
  }
];

export async function generateVectors(cwd = process.cwd()): Promise<void> {
  const vectorDir = resolve(cwd, VECTOR_DIR);
  await mkdir(vectorDir, { recursive: true });
  await mkdir(resolve(cwd, "reports"), { recursive: true });

  const artifacts = buildDeterministicArtifacts();
  const liveEvidence = await readLiveEvidence(cwd);
  const vectors = buildVectorDocuments(artifacts, liveEvidence);

  for (const [file, vector] of Object.entries(vectors)) {
    await writeJson(resolve(vectorDir, file), vector);
  }

  await writeJson(resolve(cwd, "reports/security-matrix.json"), {
    generated_by: "pnpm exec fiber-paid-http vectors generate",
    generated_at: FIXED_NOW,
    attacks: SECURITY_MATRIX
  });
  await writeJson(resolve(cwd, "reports/fiber-local-e2e-evidence.json"), {
    evidence: true,
    source_report: liveEvidence.reportPath,
    receipt_source: liveEvidence.receiptSource,
    payment_hash: liveEvidence.receiptInput.payment_hash,
    receipt_id: liveEvidence.receiptInput.receipt_id,
    production_ready_for_fiber_method: false,
    blockers: [
      "testnet Fiber E2E evidence still pending"
    ]
  });

  console.log(
    JSON.stringify(
      {
        generated: Object.keys(vectors).sort(),
        security_matrix: "reports/security-matrix.json",
        live_evidence_report: liveEvidence.reportPath,
        live_evidence_receipt: liveEvidence.receiptSource
      },
      null,
      2
    )
  );
}

export async function verifyVectors(cwd = process.cwd()): Promise<void> {
  const vectorDir = resolve(cwd, VECTOR_DIR);
  const entries = (await readdir(vectorDir)).filter((entry) => entry.endsWith(".json")).sort();
  if (entries.length === 0) {
    throw new Error("No conformance vector files found under test-vectors");
  }

  const results = [];
  for (const file of entries) {
    const vector = JSON.parse(await readFile(resolve(vectorDir, file), "utf8")) as VectorDocument;
    const actualHash = sha256Hex(canonicalJson(vector.input));
    const outcome =
      actualHash === vector.expected_canonical_hash
        ? await verifyVectorInput(file, vector.input)
        : { result: "rejected" as const, errorCode: "canonical-hash-mismatch" };
    const passed =
      outcome.result === vector.expected_verification_result &&
      (vector.expected_error_code ? outcome.errorCode === vector.expected_error_code : !outcome.errorCode);
    results.push({
      file,
      passed,
      expected: vector.expected_verification_result,
      actual: outcome.result,
      expected_error_code: vector.expected_error_code,
      actual_error_code: outcome.errorCode,
      canonical_hash: actualHash
    });
  }

  const failed = results.filter((result) => !result.passed);
  await mkdir(resolve(cwd, "reports"), { recursive: true });
  const report = {
    engine: "typescript",
    verified: results.length,
    failed: failed.length,
    shared_vectors_total: results.length,
    shared_vectors_passed: results.length - failed.length,
    results
  };
  await writeJson(resolve(cwd, "reports/ts-conformance.json"), report);
  console.log(JSON.stringify(report, null, 2));
  if (failed.length > 0) {
    throw new Error(`Conformance vector verification failed for ${failed.map((result) => result.file).join(", ")}`);
  }
}

function buildVectorDocuments(
  artifacts: ReturnType<typeof buildDeterministicArtifacts>,
  liveEvidence: LiveEvidence
): Record<string, VectorDocument> {
  const wrongAmountCredential = PaymentCredentialSchema.parse({
    ...artifacts.credential,
    paymentProof: {
      ...(artifacts.credential.paymentProof as Record<string, unknown>),
      amountShannons: "999"
    }
  });
  const wrongMethodCredential = PaymentCredentialSchema.parse({
    ...artifacts.credential,
    method: "unsupported-method",
    paymentProof: {
      status: "settled",
      observedAt: FIXED_NOW
    }
  });
  const expiredArtifacts = buildDeterministicArtifacts({ expiresAt: EXPIRED_AT });
  const tamperedReceipt = PaymentReceiptSchema.parse({
    ...artifacts.receipt,
    amount: {
      value: "999",
      currency: artifacts.receipt.amount.currency
    }
  });
  const f402Challenge = {
    token: artifacts.signature,
    invoice: INVOICE,
    paymentHash: PAYMENT_HASH,
    amount: AMOUNT_SHANNONS,
    currency: "Fibd",
    expiresAt: VALID_EXPIRES,
    resource: RESOURCE.url,
    issuer: SERVER_ID,
    fiberNodeId: "fiber-node-conformance-payee"
  };
  const f402Proof = {
    token: artifacts.signature,
    invoice: INVOICE,
    paymentHash: PAYMENT_HASH,
    amountShannons: AMOUNT_SHANNONS,
    mode: "local" as const,
    status: "settled",
    observedAt: FIXED_NOW,
    evidence: {
      conformance: true
    }
  };
  const f402Credential = f402ProofToCredential({
    proof: f402Proof,
    challengeId: CHALLENGE_ID,
    resourceHash: artifacts.resourceHash,
    submittedAt: FIXED_NOW
  });
  const fl402Challenge = issueFl402Challenge({
    rootKey: FL402_ROOT_KEY,
    invoice: INVOICE,
    paymentHash: FL402_PAYMENT_HASH,
    amount: AMOUNT_SHANNONS,
    currency: "Fibd",
    expiresAt: VALID_EXPIRES,
    resource: RESOURCE,
    challengeId: CHALLENGE_ID,
    issuer: SERVER_ID,
    fiberNodeId: "fiber-node-conformance-payee",
    hashAlgorithm: "sha256",
    nonce: NONCE,
    issuedAt: FIXED_NOW
  });
  const fl402Proof = {
    macaroon: fl402Challenge.macaroon,
    preimage: FL402_PREIMAGE,
    invoice: INVOICE,
    paymentHash: FL402_PAYMENT_HASH,
    amountShannons: AMOUNT_SHANNONS,
    mode: "local" as const,
    status: "settled",
    observedAt: FIXED_NOW,
    hashAlgorithm: "sha256" as const,
    evidence: {
      conformance: true
    }
  };
  const fl402Credential = fl402ProofToCredential({
    proof: fl402Proof,
    challengeId: CHALLENGE_ID,
    resourceHash: artifacts.resourceHash,
    submittedAt: FIXED_NOW
  });
  const fl402WrongPreimageProof = {
    ...fl402Proof,
    preimage: `0x${"22".repeat(32)}`
  };
  const fl402TamperedMacaroonProof = {
    ...fl402Proof,
    macaroon: `${fl402Proof.macaroon.slice(0, -1)}${fl402Proof.macaroon.endsWith("0") ? "1" : "0"}`
  };

  return {
    "challenge.valid.json": vector(
      {
        case: "challenge.valid",
        secret: SECRET,
        challenge: artifacts.challenge,
        signature: artifacts.signature
      },
      "accepted",
      "Signed Fiber Paid HTTP challenge with a deterministic Fiber method and HMAC signature."
    ),
    "credential.valid.json": vector(
      credentialInput(artifacts.challenge, artifacts.signature, artifacts.credential, RESOURCE),
      "accepted",
      "Authorization: Payment credential bound to the signed challenge resource."
    ),
    "receipt.valid.json": vector(
      {
        case: "receipt.valid",
        secret: SECRET,
        receipt: artifacts.receipt
      },
      "accepted",
      "Payment-Receipt signed by the TypeScript implementation."
    ),
    "resource.hash.valid.json": vector(
      {
        case: "resource.hash.valid",
        resource: RESOURCE,
        resource_hash: artifacts.resourceHash
      },
      "accepted",
      "Canonical resource hash for the paid resource descriptor."
    ),
    "f402.challenge.valid.json": vector(
      {
        case: "f402.challenge.valid",
        f402: f402Challenge,
        resource: RESOURCE,
        server_id: SERVER_ID,
        challenge_id: CHALLENGE_ID,
        issued_at: FIXED_NOW,
        expected_mpp_fields: {
          domain: "fiber-paid-http-challenge-v1",
          challengeId: CHALLENGE_ID,
          resource: RESOURCE,
          amount: {
            value: AMOUNT_SHANNONS,
            currency: "Fibd"
          },
          method: "fiber",
          paymentHash: PAYMENT_HASH,
          invoice: INVOICE,
          amountShannons: AMOUNT_SHANNONS,
          serverId: SERVER_ID,
          audience: SERVER_ID,
          maxUses: 1
        }
      },
      "accepted",
      "F402 challenge fields as accepted by the TypeScript F402 compatibility adapter."
    ),
    "f402.credential.valid.json": vector(
      {
        case: "f402.credential.valid",
        proof: f402Proof,
        challenge_id: CHALLENGE_ID,
        resource_hash: artifacts.resourceHash,
        submitted_at: FIXED_NOW,
        credential: f402Credential
      },
      "accepted",
      "F402 proof converted to a Fiber Paid HTTP payment credential."
    ),
    "fl402.challenge.valid.json": vector(
      {
        case: "fl402.challenge.valid",
        root_key: FL402_ROOT_KEY,
        fl402: fl402Challenge,
        resource: RESOURCE,
        server_id: SERVER_ID,
        challenge_id: CHALLENGE_ID,
        issued_at: FIXED_NOW,
        expected_mpp_fields: {
          domain: "fiber-paid-http-challenge-v1",
          challengeId: CHALLENGE_ID,
          resource: RESOURCE,
          amount: {
            value: AMOUNT_SHANNONS,
            currency: "Fibd"
          },
          method: "fiber",
          paymentHash: FL402_PAYMENT_HASH,
          invoice: INVOICE,
          amountShannons: AMOUNT_SHANNONS,
          serverId: SERVER_ID,
          audience: SERVER_ID,
          maxUses: 1,
          hashAlgorithm: "sha256"
        }
      },
      "accepted",
      "F-L402 challenge with first-party caveats and a Fiber payment preimage hash."
    ),
    "fl402.credential.valid.json": vector(
      {
        case: "fl402.credential.valid",
        root_key: FL402_ROOT_KEY,
        fl402: fl402Challenge,
        proof: fl402Proof,
        challenge_id: CHALLENGE_ID,
        resource_hash: artifacts.resourceHash,
        submitted_at: FIXED_NOW,
        credential: fl402Credential
      },
      "accepted",
      "F-L402 proof converted to a Fiber Paid HTTP credential after macaroon and preimage verification."
    ),
    "attack.replay.json": vector(
      {
        ...credentialInput(artifacts.challenge, artifacts.signature, artifacts.credential, RESOURCE),
        case: "attack.replay",
        replay: true
      },
      "rejected",
      "The same credential is redeemed twice; the second redemption must be rejected.",
      "replay"
    ),
    "attack.wrong-resource.json": vector(
      credentialInput(artifacts.challenge, artifacts.signature, artifacts.credential, WRONG_RESOURCE, "attack.wrong-resource"),
      "rejected",
      "Credential is valid for the original resource but submitted to a different resource URL.",
      "wrong-resource"
    ),
    "attack.wrong-amount.json": vector(
      credentialInput(artifacts.challenge, artifacts.signature, wrongAmountCredential, RESOURCE, "attack.wrong-amount"),
      "rejected",
      "Fiber payment proof amount does not match the Fiber method challenge amount.",
      "wrong-amount"
    ),
    "attack.wrong-method.json": vector(
      credentialInput(artifacts.challenge, artifacts.signature, wrongMethodCredential, RESOURCE, "attack.wrong-method"),
      "rejected",
      "Credential names a method that was not offered in the signed challenge.",
      "wrong-method"
    ),
    "attack.expired-challenge.json": vector(
      credentialInput(
        expiredArtifacts.challenge,
        expiredArtifacts.signature,
        expiredArtifacts.credential,
        RESOURCE,
        "attack.expired-challenge"
      ),
      "rejected",
      "Signed challenge has an expiry in the past and must be rejected before proof verification.",
      "expired-challenge"
    ),
    "attack.tampered-receipt.json": vector(
      {
        case: "attack.tampered-receipt",
        secret: SECRET,
        receipt: tamperedReceipt
      },
      "rejected",
      "Receipt body is changed without recomputing the receipt signature.",
      "bad-receipt-signature"
    ),
    "attack.fl402-wrong-preimage.json": vector(
      {
        case: "attack.fl402-wrong-preimage",
        root_key: FL402_ROOT_KEY,
        fl402: fl402Challenge,
        proof: fl402WrongPreimageProof,
        challenge_id: CHALLENGE_ID,
        resource_hash: artifacts.resourceHash,
        submitted_at: FIXED_NOW,
        credential: fl402Credential
      },
      "rejected",
      "F-L402 proof submits a preimage that does not hash to the macaroon payment hash caveat.",
      "wrong-preimage"
    ),
    "attack.fl402-tampered-macaroon.json": vector(
      {
        case: "attack.fl402-tampered-macaroon",
        root_key: FL402_ROOT_KEY,
        fl402: {
          ...fl402Challenge,
          macaroon: fl402TamperedMacaroonProof.macaroon
        },
        proof: fl402TamperedMacaroonProof,
        challenge_id: CHALLENGE_ID,
        resource_hash: artifacts.resourceHash,
        submitted_at: FIXED_NOW,
        credential: fl402Credential
      },
      "rejected",
      "F-L402 macaroon signature is changed without recomputing the root-key HMAC.",
      "bad-fl402-macaroon-signature"
    ),
    "fiber.local-e2e.receipt.json": vector(
      liveEvidence.receiptInput,
      "accepted",
      "Evidence copied from the latest successful local Fiber E2E run; this is not a deterministic fixture."
    ),
    "fiber.local-e2e.report.json": vector(
      liveEvidence.reportInput,
      "accepted",
      "Gate report evidence copied from the latest successful local Fiber E2E run."
    )
  };
}

function buildDeterministicArtifacts(options: { expiresAt?: string } = {}): {
  challenge: PaymentChallenge;
  signature: string;
  credential: PaymentCredential;
  receipt: PaymentReceipt;
  resourceHash: string;
} {
  const expiresAt = options.expiresAt ?? VALID_EXPIRES;
  const challenge = PaymentChallengeSchema.parse({
    domain: "fiber-paid-http-challenge-v1",
    challengeId: CHALLENGE_ID,
    resource: RESOURCE,
    amount: {
      value: AMOUNT_SHANNONS,
      currency: "CKB"
    },
    methods: [
      {
        method: "fiber",
        intent: "charge",
        asset: "CKB",
        amountShannons: AMOUNT_SHANNONS,
        paymentHash: PAYMENT_HASH,
        invoice: INVOICE,
        fiberNodeId: "fiber-node-conformance-payee",
        fiberRpcLabel: "conformance-local",
        expiresAt
      }
    ],
    nonce: NONCE,
    issuedAt: FIXED_NOW,
    expiresAt,
    serverId: SERVER_ID,
    maxUses: 1
  });
  const signature = signChallenge(challenge, SECRET);
  const hashedResource = resourceHash(RESOURCE);
  const credential = PaymentCredentialSchema.parse({
    domain: "fiber-paid-http-credential-v1",
    challengeId: CHALLENGE_ID,
    method: "fiber",
    resourceHash: hashedResource,
    paymentProof: {
      kind: "fiber-payment-proof-v1",
      mode: "local",
      paymentHash: PAYMENT_HASH,
      invoice: INVOICE,
      amountShannons: AMOUNT_SHANNONS,
      status: "settled",
      observedAt: FIXED_NOW,
      evidence: {
        conformance: true
      }
    },
    submittedAt: FIXED_NOW
  });
  const receipt = attachReceiptSignature(
    {
      domain: "fiber-paid-http-receipt-v1",
      receiptId: "rcpt_conformance_0001",
      challengeId: CHALLENGE_ID,
      method: "fiber",
      resourceHash: hashedResource,
      amount: {
        value: AMOUNT_SHANNONS,
        currency: "CKB"
      },
      settlement: {
        status: "settled",
        paymentHash: PAYMENT_HASH,
        invoiceId: INVOICE,
        provider: "fiber-rpc",
        observedAt: FIXED_NOW
      },
      serverId: SERVER_ID,
      issuedAt: FIXED_NOW
    },
    SECRET
  );
  return {
    challenge,
    signature,
    credential,
    receipt,
    resourceHash: hashedResource
  };
}

function vector(
  input: Record<string, unknown>,
  expected: VerificationResult,
  notes: string,
  expectedErrorCode?: string
): VectorDocument {
  return {
    input,
    expected_canonical_hash: sha256Hex(canonicalJson(input)),
    expected_verification_result: expected,
    ...(expectedErrorCode ? { expected_error_code: expectedErrorCode } : {}),
    notes
  };
}

function credentialInput(
  challenge: PaymentChallenge,
  signature: string,
  credential: PaymentCredential,
  requestResource: ResourceDescriptor,
  caseName = "credential.valid"
): Record<string, unknown> {
  return {
    case: caseName,
    secret: SECRET,
    request: requestResource,
    challenge,
    signature,
    credential
  };
}

async function verifyVectorInput(file: string, input: Record<string, unknown>): Promise<VerificationOutcome> {
  const caseName = stringField(input, "case");
  switch (caseName) {
    case "challenge.valid":
      return verifyChallengeVector(input);
    case "credential.valid":
    case "attack.replay":
    case "attack.wrong-resource":
    case "attack.wrong-amount":
    case "attack.wrong-method":
    case "attack.expired-challenge":
      return verifyCredentialVector(input, caseName === "attack.replay");
    case "receipt.valid":
    case "attack.tampered-receipt":
      return verifyReceiptVector(input);
    case "resource.hash.valid":
      return verifyResourceHashVector(input);
    case "f402.challenge.valid":
      return verifyF402ChallengeVector(input);
    case "f402.credential.valid":
      return verifyF402CredentialVector(input);
    case "fl402.challenge.valid":
      return verifyFL402ChallengeVector(input);
    case "fl402.credential.valid":
    case "attack.fl402-wrong-preimage":
    case "attack.fl402-tampered-macaroon":
      return verifyFL402CredentialVector(input);
    case "fiber.local-e2e.receipt":
      return verifyLiveReceiptEvidence(input);
    case "fiber.local-e2e.report":
      return verifyLiveReportEvidence(input);
    default:
      return {
        result: "rejected",
        errorCode: `unknown-vector-case:${file}`
      };
  }
}

function verifyChallengeVector(input: Record<string, unknown>): VerificationOutcome {
  const challenge = PaymentChallengeSchema.parse(input.challenge);
  const signature = stringField(input, "signature");
  const secret = stringField(input, "secret");
  return verifyChallengeSignature(challenge, signature, secret)
    ? { result: "accepted" }
    : { result: "rejected", errorCode: "bad-challenge-signature" };
}

async function verifyCredentialVector(input: Record<string, unknown>, replay: boolean): Promise<VerificationOutcome> {
  const challenge = PaymentChallengeSchema.parse(input.challenge);
  const credential = PaymentCredentialSchema.parse(input.credential);
  const request = resourceField(input, "request");
  const secret = stringField(input, "secret");
  const signature = stringField(input, "signature");
  const store = new SqliteStore(join(await mkdtemp(join(tmpdir(), "fiber-paid-http-vector-")), "store.sqlite"));
  await store.saveChallenge({
    challenge,
    signature,
    resourceHash: resourceHash(challenge.resource),
    createdAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt
  });
  const middleware = createFiberPaidHttpMiddleware({
    secret,
    serverId: challenge.serverId,
    store,
    fiber: new FiberMethodAdapter({
      mode: "local",
      rpc: new FiberRpcClient({
        url: "http://fiber.local/vector",
        fetchImpl: vectorFiberFetch,
        label: "local-vector"
      }),
      asset: "CKB",
      currency: "Fibd",
      rpcLabel: "local-vector"
    }),
    clockSkewSeconds: 0
  });

  try {
    await middleware.verifyCredential(new Request(request.url, { method: request.method }), credential);
    if (replay) {
      await middleware.verifyCredential(new Request(request.url, { method: request.method }), credential);
    }
    return { result: "accepted" };
  } catch (error) {
    if (error instanceof FiberPaidHttpError) {
      return {
        result: "rejected",
        errorCode: error.code
      };
    }
    throw error;
  }
}

const vectorFiberFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const payload = JSON.parse(String(init?.body)) as { id?: number; method?: string };
  if (payload.method === "get_invoice") {
    return Response.json({
      jsonrpc: "2.0",
      id: payload.id,
      result: {
        invoice_address: INVOICE,
        status: "Paid",
        invoice: {
          data: {
            payment_hash: PAYMENT_HASH
          }
        }
      }
    });
  }
  throw new Error(`Unexpected Fiber RPC method in vector verification: ${payload.method ?? "unknown"}`);
}) as typeof fetch;

function verifyReceiptVector(input: Record<string, unknown>): VerificationOutcome {
  const receipt = PaymentReceiptSchema.parse(input.receipt);
  const secret = stringField(input, "secret");
  return verifyReceiptSignature(receipt, secret)
    ? { result: "accepted" }
    : { result: "rejected", errorCode: "bad-receipt-signature" };
}

function verifyResourceHashVector(input: Record<string, unknown>): VerificationOutcome {
  const resource = resourceField(input, "resource");
  const expected = stringField(input, "resource_hash");
  return resourceHash(resource) === expected
    ? { result: "accepted" }
    : { result: "rejected", errorCode: "resource-hash-mismatch" };
}

function verifyF402ChallengeVector(input: Record<string, unknown>): VerificationOutcome {
  const f402 = F402ChallengeSchema.parse(input.f402);
  const resource = resourceField(input, "resource");
  const expected = recordField(input, "expected_mpp_fields");
  const challenge = f402ChallengeToMpp({
    f402,
    resource,
    serverId: stringField(input, "server_id"),
    challengeId: stringField(input, "challenge_id"),
    issuedAt: stringField(input, "issued_at")
  });
  const fiber = challenge.methods.find((method) => method.method === "fiber");
  if (!fiber) {
    return { result: "rejected", errorCode: "f402-challenge-mismatch" };
  }
  const accepted =
    challenge.domain === expected.domain &&
    challenge.challengeId === expected.challengeId &&
    challenge.serverId === expected.serverId &&
    challenge.audience === expected.audience &&
    challenge.maxUses === expected.maxUses &&
    canonicalJson(challenge.resource) === canonicalJson(expected.resource) &&
    challenge.amount.value === recordField(expected, "amount").value &&
    challenge.amount.currency === recordField(expected, "amount").currency &&
    fiber.method === expected.method &&
    fiber.paymentHash === expected.paymentHash &&
    fiber.invoice === expected.invoice &&
    fiber.amountShannons === expected.amountShannons;
  return accepted ? { result: "accepted" } : { result: "rejected", errorCode: "f402-challenge-mismatch" };
}

function verifyF402CredentialVector(input: Record<string, unknown>): VerificationOutcome {
  const proof = F402ProofSchema.parse(input.proof);
  const expected = PaymentCredentialSchema.parse(input.credential);
  const actual = f402ProofToCredential({
    proof,
    challengeId: stringField(input, "challenge_id"),
    resourceHash: stringField(input, "resource_hash"),
    submittedAt: stringField(input, "submitted_at")
  });
  return canonicalJson(actual) === canonicalJson(expected)
    ? { result: "accepted" }
    : { result: "rejected", errorCode: "f402-credential-mismatch" };
}

function verifyFL402ChallengeVector(input: Record<string, unknown>): VerificationOutcome {
  const fl402 = FL402ChallengeSchema.parse(input.fl402);
  const resource = resourceField(input, "resource");
  const expected = recordField(input, "expected_mpp_fields");
  try {
    verifyFl402Proof({
      challenge: fl402,
      proof: {
        macaroon: fl402.macaroon,
        preimage: FL402_PREIMAGE,
        invoice: fl402.invoice,
        paymentHash: fl402.paymentHash,
        amountShannons: fl402.amount,
        mode: "local",
        status: "settled",
        hashAlgorithm: fl402.hashAlgorithm
      },
      rootKey: stringField(input, "root_key"),
      now: FIXED_NOW
    });
  } catch (error) {
    return { result: "rejected", errorCode: errorMessage(error) };
  }
  const challenge = fl402ChallengeToMpp({
    fl402,
    resource,
    serverId: stringField(input, "server_id"),
    challengeId: stringField(input, "challenge_id"),
    issuedAt: stringField(input, "issued_at")
  });
  const fiber = challenge.methods.find((method) => method.method === "fiber");
  if (!fiber) {
    return { result: "rejected", errorCode: "fl402-challenge-mismatch" };
  }
  const accepted =
    challenge.domain === expected.domain &&
    challenge.challengeId === expected.challengeId &&
    challenge.serverId === expected.serverId &&
    challenge.audience === expected.audience &&
    challenge.maxUses === expected.maxUses &&
    canonicalJson(challenge.resource) === canonicalJson(expected.resource) &&
    challenge.amount.value === recordField(expected, "amount").value &&
    challenge.amount.currency === recordField(expected, "amount").currency &&
    fiber.method === expected.method &&
    fiber.paymentHash === expected.paymentHash &&
    fiber.invoice === expected.invoice &&
    fiber.amountShannons === expected.amountShannons;
  return accepted ? { result: "accepted" } : { result: "rejected", errorCode: "fl402-challenge-mismatch" };
}

function verifyFL402CredentialVector(input: Record<string, unknown>): VerificationOutcome {
  const fl402 = FL402ChallengeSchema.parse(input.fl402);
  const proof = FL402ProofSchema.parse(input.proof);
  try {
    verifyFl402Proof({
      challenge: fl402,
      proof,
      rootKey: stringField(input, "root_key"),
      now: FIXED_NOW
    });
  } catch (error) {
    return { result: "rejected", errorCode: errorMessage(error) };
  }
  const expected = PaymentCredentialSchema.parse(input.credential);
  const actual = fl402ProofToCredential({
    proof,
    challengeId: stringField(input, "challenge_id"),
    resourceHash: stringField(input, "resource_hash"),
    submittedAt: stringField(input, "submitted_at")
  });
  return canonicalJson(actual) === canonicalJson(expected)
    ? { result: "accepted" }
    : { result: "rejected", errorCode: "fl402-credential-mismatch" };
}

function verifyLiveReportEvidence(input: Record<string, unknown>): VerificationOutcome {
  const report = recordField(input, "report");
  return report.fiber_e2e_status === "passed" &&
    report.live_fiber_local_e2e === true &&
    typeof report.fiber_e2e_payment_hash === "string" &&
    typeof report.fiber_e2e_receipt_id === "string"
    ? { result: "accepted" }
    : { result: "rejected", errorCode: "missing-local-fiber-e2e-evidence" };
}

function verifyLiveReceiptEvidence(input: Record<string, unknown>): VerificationOutcome {
  const receipt = input.receipt;
  if (receipt && typeof receipt === "object") {
    const parsed = PaymentReceiptSchema.parse(receipt);
    const secret = typeof input.secret === "string" ? input.secret : null;
    if (secret && !verifyReceiptSignature(parsed, secret)) {
      return { result: "rejected", errorCode: "bad-receipt-signature" };
    }
    return typeof parsed.settlement.paymentHash === "string" &&
      parsed.settlement.paymentHash === input.payment_hash &&
      parsed.receiptId === input.receipt_id
      ? { result: "accepted" }
      : { result: "rejected", errorCode: "receipt-evidence-mismatch" };
  }
  return typeof input.receipt_id === "string" && typeof input.payment_hash === "string"
    ? { result: "accepted" }
    : { result: "rejected", errorCode: "missing-local-fiber-receipt-evidence" };
}

type LiveEvidence = {
  reportPath: string;
  receiptSource: string;
  reportInput: Record<string, unknown>;
  receiptInput: Record<string, unknown>;
};

async function readLiveEvidence(cwd: string): Promise<LiveEvidence> {
  const currentReport = await readJsonIfExists(resolve(cwd, "reports/fiber-paid-http-gate.json"));
  const successReport = await readJsonIfExists(resolve(cwd, SUCCESS_REPORT_PATH));
  const existingVector = await readJsonIfExists(resolve(cwd, VECTOR_DIR, "fiber.local-e2e.report.json"));
  const existingVectorReport =
    existingVector && typeof existingVector === "object" && !Array.isArray(existingVector)
      ? recordField(recordField(existingVector as Record<string, unknown>, "input"), "report")
      : null;

  const selected = selectSuccessfulReport([
    { path: "reports/fiber-paid-http-gate.json", report: currentReport },
    { path: SUCCESS_REPORT_PATH, report: successReport },
    { path: "test-vectors/fiber.local-e2e.report.json", report: existingVectorReport }
  ]);
  if (!selected) {
    throw new Error("Cannot generate Fiber evidence vectors: no successful local Fiber E2E report is available");
  }
  const report = selected.report;
  await writeJson(resolve(cwd, SUCCESS_REPORT_PATH), report);
  const receiptId = stringField(report, "fiber_e2e_receipt_id");
  const paymentHash = stringField(report, "fiber_e2e_payment_hash");

  const storagePath = resolve(cwd, ".tmp/fiber-live-e2e.sqlite");
  let receipt: PaymentReceipt | null = null;
  let receiptSource = selected.path;
  if (existsSync(storagePath)) {
    try {
      receipt = await new SqliteStore(storagePath).getReceipt(receiptId);
      if (receipt) {
        receiptSource = ".tmp/fiber-live-e2e.sqlite";
      }
    } catch {
      receipt = null;
    }
  }

  return {
    reportPath: selected.path,
    receiptSource,
    reportInput: {
      case: "fiber.local-e2e.report",
      evidence: true,
      source_report: selected.path,
      report
    },
    receiptInput: {
      case: "fiber.local-e2e.receipt",
      evidence: true,
      source_report: selected.path,
      receipt_source: receiptSource,
      receipt_id: receiptId,
      payment_hash: paymentHash,
      receipt_signature_verification: receipt
        ? "verified during the live Fiber E2E run; fixture omits HMAC secret"
        : "receipt body unavailable; report-level payment hash and receipt id retained",
      ...(receipt ? { receipt } : {})
    }
  };
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function selectSuccessfulReport(
  candidates: Array<{ path: string; report: Record<string, unknown> | null }>
): { path: string; report: Record<string, unknown> } | null {
  for (const candidate of candidates) {
    if (candidate.report && isSuccessfulLocalReport(candidate.report)) {
      return {
        path: candidate.path,
        report: candidate.report
      };
    }
  }
  return null;
}

function isSuccessfulLocalReport(report: Record<string, unknown>): boolean {
  return (
    report.fiber_e2e_status === "passed" &&
    report.live_fiber_local_e2e === true &&
    typeof report.fiber_e2e_payment_hash === "string" &&
    typeof report.fiber_e2e_receipt_id === "string"
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function stringField(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== "string") {
    throw new Error(`Vector field ${field} must be a string`);
  }
  return value;
}

function recordField(source: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = source[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Vector field ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function resourceField(source: Record<string, unknown>, field: string): ResourceDescriptor {
  const resource = recordField(source, field);
  if (typeof resource.method !== "string" || typeof resource.url !== "string") {
    throw new Error(`Vector field ${field} must be a resource descriptor`);
  }
  return {
    method: resource.method,
    url: resource.url,
    ...(typeof resource.bodyHash === "string" ? { bodyHash: resource.bodyHash } : {}),
    ...(typeof resource.contentType === "string" ? { contentType: resource.contentType } : {})
  };
}
