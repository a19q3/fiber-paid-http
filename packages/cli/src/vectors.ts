import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  PaymentChallengeSchema,
  PaymentCredentialSchema,
  PaymentReceiptSchema,
  FiberChargeRequestSchema,
  bindChallengeId,
  canonicalJson,
  decodeFiberChargeRequest,
  encodeFiberChargeRequest,
  resourceHash,
  sha256Hex,
  verifyChallengeId,
  type FiberChargeRequest,
  type PaymentChallenge,
  type PaymentCredential,
  type PaymentReceipt,
  type ResourceDescriptor
} from "@fiber-paid-http/core";
import {
  F402ChallengeSchema,
  F402ProofSchema,
  f402ChallengeToMpp,
  f402ProofToCredential
} from "@fiber-paid-http/f402-compat";
import {
  mppChallengeToX402PaymentRequired,
  paymentCredentialToX402Payload,
  paymentReceiptToX402SettleResponse,
  x402PaymentPayloadToCredential,
  x402PaymentRequiredToMpp
} from "@fiber-paid-http/x402-compat";
import {
  FL402ChallengeSchema,
  FL402ProofSchema,
  fl402ChallengeToMpp,
  fl402ProofToCredential,
  hashPaymentPreimage,
  issueFl402Challenge,
  verifyFl402Proof
} from "@fiber-paid-http/fl402-compat";

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

const VECTOR_DIR = "test-vectors";
const SECRET = "fiber-paid-http-conformance-secret";
const FL402_ROOT_KEY = "fiber-paid-http-fl402-conformance-root-key";
const REALM = "conformance.example.com";
const NOW = "2026-07-13T00:00:00.000Z";
const EXPIRES = "2030-01-01T00:00:00.000Z";
const EXPIRED = "2020-01-01T00:00:00.000Z";
const PAYMENT_HASH = `0x${"ab".repeat(32)}`;
const PREIMAGE = `0x${"11".repeat(32)}`;
const FL402_PAYMENT_HASH = hashPaymentPreimage(PREIMAGE, "sha256");
const INVOICE = "fibt1qconformancepayment0001";
const RESOURCE: ResourceDescriptor = {
  method: "GET",
  url: "https://conformance.example.com/paid/weather"
};
const WRONG_RESOURCE: ResourceDescriptor = {
  method: "GET",
  url: "https://conformance.example.com/paid/file"
};

const FILES = [
  "challenge.valid.json",
  "credential.valid.json",
  "receipt.valid.json",
  "resource.hash.valid.json",
  "f402.challenge.valid.json",
  "f402.credential.valid.json",
  "x402.required.valid.json",
  "x402.payload.valid.json",
  "x402.settlement.valid.json",
  "fl402.challenge.valid.json",
  "fl402.credential.valid.json",
  "attack.replay.json",
  "attack.wrong-resource.json",
  "attack.wrong-amount.json",
  "attack.wrong-method.json",
  "attack.expired-challenge.json",
  "attack.receipt-on-error.json",
  "attack.fl402-wrong-preimage.json",
  "attack.fl402-tampered-capability.json",
  "attack.x402-tampered-requirement.json",
  "fiber.local-e2e.receipt.json",
  "fiber.local-e2e.report.json"
] as const;

const SECURITY_MATRIX = [
  ["replay", "replay", "attack.replay.json"],
  ["wrong resource", "wrong-resource", "attack.wrong-resource.json"],
  ["wrong amount", "wrong-amount", "attack.wrong-amount.json"],
  ["wrong method", "wrong-method", "attack.wrong-method.json"],
  ["expired challenge", "expired-challenge", "attack.expired-challenge.json"],
  ["receipt on non-2xx", "receipt-on-error-response", "attack.receipt-on-error.json"],
  ["F-L402 wrong preimage", "wrong-preimage", "attack.fl402-wrong-preimage.json"],
  ["F-L402 tampered capability", "bad-fl402-capability-signature", "attack.fl402-tampered-capability.json"],
  ["x402 changed accepted requirement", "x402-fiber-requirement-mismatch", "attack.x402-tampered-requirement.json"]
].map(([attack, expected_rejection, file]) => ({
  attack,
  expected_rejection,
  implemented_test: `test-vectors/${file}`,
  vector_file: `test-vectors/${file}`,
  status: "covered"
}));

export async function generateVectors(cwd = process.cwd()): Promise<void> {
  const directory = resolve(cwd, VECTOR_DIR);
  await mkdir(directory, { recursive: true });
  await mkdir(resolve(cwd, "reports"), { recursive: true });
  const vectors = await buildVectors(cwd);
  for (const entry of await readdir(directory)) {
    if (entry.endsWith(".json") && !FILES.includes(entry as (typeof FILES)[number])) {
      await unlink(resolve(directory, entry));
    }
  }
  for (const file of FILES) {
    await writeJson(resolve(directory, file), vectors[file]);
  }
  await writeJson(resolve(cwd, "reports/security-matrix.json"), {
    generated_by: "pnpm exec fiber-paid-http vectors generate",
    generated_at: new Date().toISOString(),
    attacks: SECURITY_MATRIX
  });
  console.log(JSON.stringify({ generated: FILES, security_matrix: "reports/security-matrix.json" }, null, 2));
}

export async function verifyVectors(cwd = process.cwd()): Promise<void> {
  const directory = resolve(cwd, VECTOR_DIR);
  const entries = (await readdir(directory)).filter((entry) => entry.endsWith(".json")).sort();
  if (entries.length === 0) throw new Error("No conformance vectors found");
  const results = [];
  for (const file of entries) {
    const vector = JSON.parse(await readFile(resolve(directory, file), "utf8")) as VectorDocument;
    const actualHash = sha256Hex(canonicalJson(vector.input));
    const outcome = actualHash === vector.expected_canonical_hash
      ? verifyVectorInput(file, vector.input)
      : rejected("canonical-hash-mismatch");
    const passed = outcome.result === vector.expected_verification_result
      && (vector.expected_error_code ? outcome.errorCode === vector.expected_error_code : !outcome.errorCode);
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
  const report = {
    engine: "typescript",
    verified: results.length,
    failed: failed.length,
    shared_vectors_total: results.length,
    shared_vectors_passed: results.length - failed.length,
    results
  };
  await mkdir(resolve(cwd, "reports"), { recursive: true });
  await writeJson(resolve(cwd, "reports/ts-conformance.json"), report);
  console.log(JSON.stringify(report, null, 2));
  if (failed.length > 0) throw new Error(`Conformance failed: ${failed.map((item) => item.file).join(", ")}`);
}

async function buildVectors(cwd: string): Promise<Record<(typeof FILES)[number], VectorDocument>> {
  const charge: FiberChargeRequest = {
    amount: "1000",
    currency: "ckb",
    description: "Conformance charge",
    methodDetails: {
      invoice: INVOICE,
      paymentHash: PAYMENT_HASH,
      network: "testnet",
      hashAlgorithm: "ckb_hash"
    }
  };
  const challenge = makeChallenge(charge, EXPIRES);
  const credential: PaymentCredential = {
    challenge,
    payload: { paymentHash: PAYMENT_HASH }
  };
  const receipt: PaymentReceipt = {
    status: "success",
    method: "fiber",
    timestamp: NOW,
    reference: PAYMENT_HASH,
    challengeId: challenge.id
  };
  const f402 = F402ChallengeSchema.parse({
    token: "f402-conformance-token",
    invoice: INVOICE,
    paymentHash: PAYMENT_HASH,
    amount: "1000",
    currency: "ckb",
    expiresAt: EXPIRES,
    resource: RESOURCE.url,
    issuer: REALM,
    network: "testnet",
    hashAlgorithm: "ckb_hash"
  });
  const f402Challenge = f402ChallengeToMpp({ f402, resource: RESOURCE, realm: REALM, secret: SECRET });
  const f402Proof = F402ProofSchema.parse({ token: f402.token, paymentHash: PAYMENT_HASH });
  const f402Credential = f402ProofToCredential({ proof: f402Proof, challenge: f402Challenge });
  const x402Charge = FiberChargeRequestSchema.parse({
    ...charge,
    recipient: "03fiberconformancepayee"
  });
  const x402Challenge = makeChallenge(x402Charge, EXPIRES);
  const x402Required = mppChallengeToX402PaymentRequired({
    challenge: x402Challenge,
    resource: { url: RESOURCE.url },
    maxTimeoutSeconds: 120
  });
  const x402Credential = PaymentCredentialSchema.parse({
    challenge: x402Challenge,
    source: "x402",
    payload: { paymentHash: PAYMENT_HASH }
  });
  const x402Payload = paymentCredentialToX402Payload({
    credential: x402Credential,
    maxTimeoutSeconds: 120,
    resource: { url: RESOURCE.url }
  });
  const x402Settlement = paymentReceiptToX402SettleResponse({
    receipt,
    network: "fiber:testnet",
    amount: "1000"
  });
  const fl402 = issueFl402Challenge({
    rootKey: FL402_ROOT_KEY,
    invoice: INVOICE,
    paymentHash: FL402_PAYMENT_HASH,
    amount: "1000",
    currency: "ckb",
    expiresAt: EXPIRES,
    resource: RESOURCE,
    challengeId: "fl402-conformance-challenge",
    issuer: REALM,
    network: "testnet",
    hashAlgorithm: "sha256",
    nonce: "00112233445566778899aabbccddeeff",
    issuedAt: NOW
  });
  const fl402Mpp = fl402ChallengeToMpp({ fl402, resource: RESOURCE, realm: REALM, secret: SECRET });
  const fl402Proof = FL402ProofSchema.parse({
    capability: fl402.capability,
    preimage: PREIMAGE,
    paymentHash: FL402_PAYMENT_HASH,
    hashAlgorithm: "sha256"
  });
  const fl402Credential = fl402ProofToCredential({ proof: fl402Proof, challenge: fl402Mpp });
  const expiredChallenge = makeChallenge(charge, EXPIRED);
  const wrongMethod = { ...challenge, method: "lightning" };
  const tamperedCapability = `${fl402.capability.slice(0, -1)}${fl402.capability.endsWith("0") ? "1" : "0"}`;
  const evidence = await readEvidence(cwd, challenge);

  const credentialInput = (overrides: Record<string, unknown> = {}) => ({
    case: "mpp.credential",
    secret: SECRET,
    now: NOW,
    credential,
    resource: RESOURCE,
    stored_resource: RESOURCE,
    expected_amount: "1000",
    ...overrides
  });

  return {
    "challenge.valid.json": vector({ case: "mpp.challenge", secret: SECRET, challenge }, "accepted", "Bound MPP-draft challenge."),
    "credential.valid.json": vector(credentialInput(), "accepted", "Standard Payment credential."),
    "receipt.valid.json": vector({ case: "mpp.receipt", receipt, response_status: 200 }, "accepted", "Receipt on a successful response."),
    "resource.hash.valid.json": vector({ case: "resource.hash", resource: RESOURCE, resource_hash: resourceHash(RESOURCE) }, "accepted", "JCS resource binding."),
    "f402.challenge.valid.json": vector({ case: "f402.challenge", f402, resource: RESOURCE, realm: REALM, secret: SECRET, expected_challenge: f402Challenge }, "accepted", "F402 entrance normalization."),
    "f402.credential.valid.json": vector({ case: "f402.credential", proof: f402Proof, challenge: f402Challenge, expected_credential: f402Credential }, "accepted", "F402 proof normalization."),
    "x402.required.valid.json": vector({ case: "x402.required", payment_required: x402Required, resource: RESOURCE, realm: REALM, secret: SECRET, expires_at: EXPIRES, expected_challenge: x402Challenge }, "accepted", "x402 v2 exact/Fiber requirement normalization."),
    "x402.payload.valid.json": vector({ case: "x402.payload", payment_payload: x402Payload, challenge: x402Challenge, expected_resource_url: RESOURCE.url, expected_credential: x402Credential }, "accepted", "x402 v2 Fiber payload normalization."),
    "x402.settlement.valid.json": vector({ case: "x402.settlement", receipt, network: "fiber:testnet", amount: "1000", expected_response: x402Settlement }, "accepted", "MPP success receipt to x402 v2 settlement response."),
    "fl402.challenge.valid.json": vector({ case: "fl402.challenge", root_key: FL402_ROOT_KEY, now: NOW, fl402, resource: RESOURCE, realm: REALM, secret: SECRET, expected_challenge: fl402Mpp }, "accepted", "F-L402 capability normalization."),
    "fl402.credential.valid.json": vector({ case: "fl402.credential", root_key: FL402_ROOT_KEY, now: NOW, fl402, proof: fl402Proof, challenge: fl402Mpp, expected_credential: fl402Credential }, "accepted", "F-L402 proof normalization."),
    "attack.replay.json": vector(credentialInput({ already_redeemed: true }), "rejected", "Replay is single-use.", "replay"),
    "attack.wrong-resource.json": vector(credentialInput({ resource: WRONG_RESOURCE }), "rejected", "Credential is resource-bound.", "wrong-resource"),
    "attack.wrong-amount.json": vector(credentialInput({ expected_amount: "999" }), "rejected", "Stored charge amount mismatch.", "wrong-amount"),
    "attack.wrong-method.json": vector(credentialInput({ credential: { ...credential, challenge: wrongMethod } }), "rejected", "Only Fiber method is accepted.", "wrong-method"),
    "attack.expired-challenge.json": vector(credentialInput({ credential: { challenge: expiredChallenge, payload: credential.payload } }), "rejected", "Expired challenge.", "expired-challenge"),
    "attack.receipt-on-error.json": vector({ case: "mpp.receipt", receipt, response_status: 500 }, "rejected", "Receipt is forbidden on non-2xx.", "receipt-on-error-response"),
    "attack.fl402-wrong-preimage.json": vector({ case: "fl402.credential", root_key: FL402_ROOT_KEY, now: NOW, fl402, proof: { ...fl402Proof, preimage: `0x${"22".repeat(32)}` }, challenge: fl402Mpp, expected_credential: fl402Credential }, "rejected", "Wrong F-L402 preimage.", "wrong-preimage"),
    "attack.fl402-tampered-capability.json": vector({ case: "fl402.credential", root_key: FL402_ROOT_KEY, now: NOW, fl402: { ...fl402, capability: tamperedCapability }, proof: { ...fl402Proof, capability: tamperedCapability }, challenge: fl402Mpp, expected_credential: fl402Credential }, "rejected", "Tampered F-L402 capability.", "bad-fl402-capability-signature"),
    "attack.x402-tampered-requirement.json": vector({ case: "x402.payload", payment_payload: { ...x402Payload, accepted: { ...x402Payload.accepted, amount: "1001" } }, challenge: x402Challenge, expected_resource_url: RESOURCE.url, expected_credential: x402Credential }, "rejected", "Changed x402 accepted requirement.", "x402-fiber-requirement-mismatch"),
    "fiber.local-e2e.receipt.json": evidence.receipt,
    "fiber.local-e2e.report.json": evidence.report
  };
}

function makeChallenge(charge: FiberChargeRequest, expires: string): PaymentChallenge {
  const pending = PaymentChallengeSchema.parse({
    id: "pending",
    realm: REALM,
    method: "fiber",
    intent: "charge",
    request: encodeFiberChargeRequest(charge),
    expires
  });
  return PaymentChallengeSchema.parse({ ...pending, id: bindChallengeId(pending, SECRET) });
}

function verifyVectorInput(file: string, input: Record<string, unknown>): VerificationOutcome {
  try {
    switch (input.case) {
      case "mpp.challenge": {
        const challenge = PaymentChallengeSchema.parse(input.challenge);
        if (!verifyChallengeId(challenge, String(input.secret))) return rejected("invalid-challenge-binding");
        decodeFiberChargeRequest(challenge.request);
        return accepted();
      }
      case "mpp.credential":
        return verifyCredentialInput(input);
      case "mpp.receipt": {
        PaymentReceiptSchema.parse(input.receipt);
        const status = Number(input.response_status);
        return status >= 200 && status < 300 ? accepted() : rejected("receipt-on-error-response");
      }
      case "resource.hash":
        return resourceHash(input.resource as ResourceDescriptor) === input.resource_hash
          ? accepted()
          : rejected("resource-hash-mismatch");
      case "f402.challenge": {
        const actual = f402ChallengeToMpp({
          f402: F402ChallengeSchema.parse(input.f402),
          resource: input.resource as ResourceDescriptor,
          realm: String(input.realm),
          secret: String(input.secret)
        });
        return canonicalJson(actual) === canonicalJson(input.expected_challenge) ? accepted() : rejected("f402-challenge-mismatch");
      }
      case "f402.credential": {
        const actual = f402ProofToCredential({
          proof: F402ProofSchema.parse(input.proof),
          challenge: PaymentChallengeSchema.parse(input.challenge)
        });
        return canonicalJson(actual) === canonicalJson(input.expected_credential) ? accepted() : rejected("f402-credential-mismatch");
      }
      case "x402.required": {
        const actual = x402PaymentRequiredToMpp({
          paymentRequired: input.payment_required as Parameters<typeof x402PaymentRequiredToMpp>[0]["paymentRequired"],
          resource: input.resource as ResourceDescriptor,
          realm: String(input.realm),
          secret: String(input.secret),
          expiresAt: String(input.expires_at)
        });
        return canonicalJson(actual) === canonicalJson(input.expected_challenge)
          ? accepted()
          : rejected("x402-challenge-mismatch");
      }
      case "x402.payload": {
        const actual = x402PaymentPayloadToCredential({
          paymentPayload: input.payment_payload as Parameters<typeof x402PaymentPayloadToCredential>[0]["paymentPayload"],
          challenge: PaymentChallengeSchema.parse(input.challenge),
          expectedResourceUrl: String(input.expected_resource_url)
        });
        return canonicalJson(actual) === canonicalJson(input.expected_credential)
          ? accepted()
          : rejected("x402-credential-mismatch");
      }
      case "x402.settlement": {
        const actual = paymentReceiptToX402SettleResponse({
          receipt: PaymentReceiptSchema.parse(input.receipt),
          network: String(input.network) as "fiber:mainnet" | "fiber:testnet" | "fiber:dev",
          amount: String(input.amount)
        });
        return canonicalJson(actual) === canonicalJson(input.expected_response)
          ? accepted()
          : rejected("x402-settlement-mismatch");
      }
      case "fl402.challenge": {
        const fl402 = FL402ChallengeSchema.parse(input.fl402);
        verifyFl402Proof({
          challenge: fl402,
          proof: FL402ProofSchema.parse({
            capability: fl402.capability,
            preimage: PREIMAGE,
            paymentHash: fl402.paymentHash,
            hashAlgorithm: fl402.hashAlgorithm
          }),
          rootKey: String(input.root_key),
          now: String(input.now)
        });
        const actual = fl402ChallengeToMpp({
          fl402,
          resource: input.resource as ResourceDescriptor,
          realm: String(input.realm),
          secret: String(input.secret)
        });
        return canonicalJson(actual) === canonicalJson(input.expected_challenge) ? accepted() : rejected("fl402-challenge-mismatch");
      }
      case "fl402.credential": {
        const fl402 = FL402ChallengeSchema.parse(input.fl402);
        const proof = FL402ProofSchema.parse(input.proof);
        verifyFl402Proof({ challenge: fl402, proof, rootKey: String(input.root_key), now: String(input.now) });
        const actual = fl402ProofToCredential({ proof, challenge: PaymentChallengeSchema.parse(input.challenge) });
        return canonicalJson(actual) === canonicalJson(input.expected_credential) ? accepted() : rejected("fl402-credential-mismatch");
      }
      case "fiber.evidence.report":
        return input.status === "passed" && typeof input.payment_hash === "string"
          ? accepted()
          : rejected("missing-local-fiber-e2e-evidence");
      case "fiber.evidence.receipt":
        return PaymentReceiptSchema.safeParse(input.receipt).success
          ? accepted()
          : rejected("missing-local-fiber-receipt-evidence");
      default:
        return rejected(`unknown-vector-case:${file}`);
    }
  } catch (error) {
    return rejected(errorCode(error));
  }
}

function verifyCredentialInput(input: Record<string, unknown>): VerificationOutcome {
  const raw = input.credential as { challenge?: { method?: unknown } };
  if (raw?.challenge?.method !== "fiber") return rejected("wrong-method");
  const credential = PaymentCredentialSchema.parse(input.credential);
  if (!verifyChallengeId(credential.challenge, String(input.secret))) return rejected("invalid-challenge-binding");
  const expires = credential.challenge.expires;
  if (expires && Date.parse(String(input.now)) > Date.parse(expires)) return rejected("expired-challenge");
  if (canonicalJson(input.resource) !== canonicalJson(input.stored_resource)) return rejected("wrong-resource");
  const charge = decodeFiberChargeRequest(credential.challenge.request);
  if (charge.amount !== input.expected_amount) return rejected("wrong-amount");
  if (credential.payload.paymentHash !== charge.methodDetails.paymentHash) return rejected("wrong-payment-hash");
  if (input.already_redeemed === true) return rejected("replay");
  return accepted();
}

async function readEvidence(cwd: string, fallbackChallenge: PaymentChallenge): Promise<{ receipt: VectorDocument; report: VectorDocument }> {
  let raw: Record<string, unknown> = {};
  for (const path of ["reports/fiber-paid-http-gate.json", "reports/fiber-local-e2e-success.json"]) {
    try {
      raw = JSON.parse(await readFile(resolve(cwd, path), "utf8")) as Record<string, unknown>;
      if (raw.fiber_e2e_status === "passed") break;
    } catch {
      // Missing evidence is represented by a deterministic rejected fixture.
    }
  }
  const paymentHash = typeof raw.fiber_e2e_payment_hash === "string" ? raw.fiber_e2e_payment_hash : undefined;
  const passed = raw.fiber_e2e_status === "passed" && Boolean(paymentHash);
  const reportInput = { case: "fiber.evidence.report", status: passed ? "passed" : "missing", payment_hash: paymentHash ?? null };
  const receiptValue = passed ? {
    status: "success",
    method: "fiber",
    timestamp: typeof raw.generated_at === "string" ? raw.generated_at : NOW,
    reference: paymentHash,
    challengeId: typeof raw.fiber_e2e_challenge_id === "string" ? raw.fiber_e2e_challenge_id : fallbackChallenge.id
  } : null;
  const receiptInput = { case: "fiber.evidence.receipt", receipt: receiptValue };
  return {
    report: vector(reportInput, passed ? "accepted" : "rejected", "Local Fiber E2E report evidence.", passed ? undefined : "missing-local-fiber-e2e-evidence"),
    receipt: vector(receiptInput, passed ? "accepted" : "rejected", "Local Fiber MPP-draft receipt evidence.", passed ? undefined : "missing-local-fiber-receipt-evidence")
  };
}

function vector(
  input: Record<string, unknown>,
  result: VerificationResult,
  notes: string,
  errorCode?: string
): VectorDocument {
  return {
    input,
    expected_canonical_hash: sha256Hex(canonicalJson(input)),
    expected_verification_result: result,
    ...(errorCode ? { expected_error_code: errorCode } : {}),
    notes
  };
}

function accepted(): VerificationOutcome {
  return { result: "accepted" };
}

function rejected(errorCode: string): VerificationOutcome {
  return { result: "rejected", errorCode };
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const known = [
    "bad-fl402-capability-signature",
    "wrong-preimage",
    "wrong-payment-hash",
    "expired-fl402-capability",
    "fl402-capability-mismatch",
    "x402-fiber-requirement-mismatch"
  ].find((code) => message.includes(code));
  return known ?? "invalid-vector-input";
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
