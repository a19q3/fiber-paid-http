#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { createDemoApi, startDemoApi } from "@fiber-mpp/demo-api";
import {
  buildAuthorizationPaymentHeader,
  resourceHash,
  resourceHashFromRequest,
  verifyReceiptSignature,
  type PaymentReceipt
} from "@fiber-mpp/core";
import { paidFetch, inspectChallenge } from "@fiber-mpp/client";
import { FiberMethodAdapter } from "@fiber-mpp/fiber-method";
import { F402ChallengeSchema, f402ChallengeToMpp, f402ProofToCredential } from "@fiber-mpp/f402-compat";
import { createFiberMppMiddleware, createReverseProxyHandler } from "@fiber-mpp/server-middleware";
import { InMemoryStore, SqliteStore } from "@fiber-mpp/storage";
import { generateVectors, verifyVectors } from "./vectors.js";

const program = new Command();

program
  .name("fiber-mpp")
  .description("Fiber payment method tooling for Machine Payments Protocol")
  .version("0.1.0")
  .option("--engine <engine>", "execution engine", "typescript")
  .hook("preAction", (command) => {
    const engine = command.opts<{ engine: string }>().engine;
    if (engine !== "typescript") {
      throw new Error("The TypeScript CLI only supports --engine typescript. Use fiber-mpp-rs for the Rust engine.");
    }
  });

program
  .command("serve")
  .requiredOption("--upstream <url>", "upstream server URL")
  .option("--price-usd <amount>", "USD price", "0.01")
  .option("--methods <methods>", "comma-separated methods", "fiber")
  .option("--storage <uri>", "sqlite://path or memory://", "memory://")
  .option("--port <port>", "port", "8790")
  .description("Run FiberMPP as a reverse proxy in front of an upstream HTTP service")
  .action(async (opts: { upstream: string; priceUsd: string; methods: string; storage: string; port: string }) => {
    const store = opts.storage.startsWith("sqlite://")
      ? new SqliteStore(opts.storage.slice("sqlite://".length))
      : new InMemoryStore();
    const middleware = createFiberMppMiddleware({
      secret: process.env.FIBER_MPP_SECRET ?? "fiber-mpp-proxy-secret-at-least-16",
      serverId: "fiber-mpp-proxy",
      store,
      fiber: FiberMethodAdapter.fromEnv(),
      production: opts.storage !== "memory://",
      allowInMemoryStore: opts.storage === "memory://"
    });
    const handler = createReverseProxyHandler(middleware, {
      upstream: opts.upstream,
      price: { value: opts.priceUsd, currency: "USD", display: `$${opts.priceUsd}` },
      methods: opts.methods.split(",").map((method) => method.trim()) as never
    });
    createServer(async (req, res) => {
      try {
        await sendWebResponse(res, await handler(await nodeRequestToWeb(req)));
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(error instanceof Error ? error.message : String(error));
      }
    }).listen(Number(opts.port), () => {
      console.log(`FiberMPP reverse proxy listening on http://localhost:${opts.port}`);
      console.log(`Upstream: ${opts.upstream}`);
    });
  });

program
  .command("refs")
  .argument("<action>", "init")
  .description("Create or refresh local reference notes")
  .action(async (action: string) => {
    if (action !== "init") {
      throw new Error("Only `fiber-mpp refs init` is supported");
    }
    await writeReferenceStarterNotes(process.cwd());
    console.log("Reference notes initialized under docs/refs");
  });

program
  .command("server")
  .option("--config <path>", "config file")
  .option("--port <port>", "port", "8787")
  .description("Start a FiberMPP demo-compatible paid API server")
  .action(async (opts: { config?: string; port: string }) => {
    if (opts.config) {
      await readJson(opts.config);
    }
    startDemoApi(Number(opts.port));
  });

program
  .command("challenge")
  .argument("<action>", "inspect")
  .argument("<url>")
  .description("Inspect an MPP 402 challenge")
  .action(async (action: string, url: string) => {
    if (action !== "inspect") {
      throw new Error("Only `fiber-mpp challenge inspect <url>` is supported");
    }
    const signed = await inspectChallenge(url);
    console.log(JSON.stringify(signed, null, 2));
  });

program
  .command("pay")
  .argument("<url>")
  .option("--method <method>", "payment method", "fiber")
  .description("Pay an MPP endpoint and print the response")
  .action(async (url: string, opts: { method: string }) => {
    if (opts.method !== "fiber") {
      throw new Error("Only --method fiber is implemented");
    }
    const result = await paidFetch(url, {}, { fiber: FiberMethodAdapter.fromEnv(process.env, "payer") });
    console.log(
      JSON.stringify(
        {
          status: result.response.status,
          receipt: result.receipt,
          body: await result.response.text()
        },
        null,
        2
      )
    );
  });

program
  .command("f402")
  .argument("<action>", "convert")
  .argument("<file>")
  .description("Convert F402 challenge/proof JSON to FiberMPP shapes")
  .action(async (action: string, file: string) => {
    if (action !== "convert") {
      throw new Error("Only `fiber-mpp f402 convert <file>` is supported");
    }
    const f402 = F402ChallengeSchema.parse(await readJson(file));
    const resource = {
      method: "GET",
      url: typeof f402.resource === "string" ? f402.resource : "http://f402.local/compat"
    };
    const challenge = f402ChallengeToMpp({
      f402,
      resource,
      serverId: "fiber-mpp-cli"
    });
    const credential = f402ProofToCredential({
      proof: {
        paymentHash: f402.paymentHash,
        invoice: f402.invoice,
        amountShannons: f402.amount,
        status: "settled",
        token: f402.token
      },
      challengeId: challenge.challengeId,
      resourceHash: resourceHash(resource)
    });
    console.log(JSON.stringify({ challenge, credential }, null, 2));
  });

program
  .command("receipt")
  .argument("<action>", "verify")
  .argument("<file>")
  .option("--secret <secret>", "receipt HMAC secret")
  .description("Verify a Payment-Receipt JSON file")
  .action(async (action: string, file: string, opts: { secret?: string }) => {
    if (action !== "verify") {
      throw new Error("Only `fiber-mpp receipt verify <receipt.json>` is supported");
    }
    const receipt = (await readJson(file)) as PaymentReceipt;
    const secret = opts.secret ?? process.env.FIBER_MPP_SECRET;
    if (!secret) {
      throw new Error("Provide --secret or FIBER_MPP_SECRET");
    }
    console.log(JSON.stringify({ valid: verifyReceiptSignature(receipt, secret) }, null, 2));
  });

program
  .command("vectors")
  .argument("<action>", "generate|verify")
  .description("Generate or verify canonical FiberMPP conformance vectors")
  .action(async (action: string) => {
    if (action === "generate") {
      await generateVectors();
      return;
    }
    if (action === "verify") {
      await verifyVectors();
      return;
    }
    throw new Error("Use `fiber-mpp vectors generate` or `fiber-mpp vectors verify`");
  });

program
  .command("doctor")
  .argument("<url>")
  .description("Inspect and attempt a FiberMPP paid request")
  .action(async (url: string) => {
    const challenge = await inspectChallenge(url);
    const result = await paidFetch(url, {}, { fiber: FiberMethodAdapter.fromEnv(process.env, "payer") });
    console.log(
      JSON.stringify(
        {
          challenge,
          responseStatus: result.response.status,
          receiptPresent: Boolean(result.receipt)
        },
        null,
        2
      )
    );
  });

program
  .command("demo")
  .argument("<action>", "start|smoke")
  .option("--port <port>", "port", "8787")
  .description("Start or smoke-test the FiberMPP demo")
  .action(async (action: string, opts: { port: string }) => {
    if (action === "start") {
      startDemoApi(Number(opts.port));
      return;
    }
    if (action === "smoke") {
      const report = await runDemoSmoke();
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    throw new Error("Use `fiber-mpp demo start` or `fiber-mpp demo smoke`");
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function runDemoSmoke(): Promise<Record<string, unknown>> {
  const app = createDemoApi({
    secret: "fiber-mpp-demo-secret-at-least-16"
  });
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    return Promise.resolve(app.request(request));
  };
  const url = "http://localhost/paid/weather";
  const first = await fetchImpl(url);
  const firstBody = (await first.clone().json()) as {
    challengeId: string;
    challenge: {
      challengeId: string;
      methods: Array<{ method: string; paymentHash?: string; invoice?: string; amountShannons?: string }>;
    };
  };
  const fiber = firstBody.challenge.methods.find((method) => method.method === "fiber");
  if (!fiber?.paymentHash) {
    throw new Error("Demo challenge did not include Fiber");
  }
  const credential = {
    domain: "fiber-mpp-credential-v1" as const,
    challengeId: firstBody.challengeId,
    method: "fiber" as const,
    resourceHash: await resourceHashFromRequest(new Request(url)),
    paymentProof: {
      kind: "fiber-payment-proof-v1",
      mode: "mock",
      paymentHash: fiber.paymentHash,
      invoice: fiber.invoice,
      amountShannons: fiber.amountShannons,
      status: "settled",
      observedAt: new Date().toISOString(),
      evidence: { smoke: true }
    },
    submittedAt: new Date().toISOString()
  };
  const auth = buildAuthorizationPaymentHeader(credential);
  const paid = await fetchImpl(url, { headers: { authorization: auth } });
  const receiptHeader = paid.headers.get("payment-receipt");
  const replay = await fetchImpl(url, { headers: { authorization: auth } });
  const wrong = await fetchImpl("http://localhost/paid/file", { headers: { authorization: auth } });

  return {
    unpaid_402: first.status === 402,
    www_authenticate_payment: first.headers.get("www-authenticate")?.startsWith("Payment ") ?? false,
    paid_status: paid.status,
    receipt_present: Boolean(receiptHeader),
    replay_rejected: replay.status === 402,
    wrong_resource_rejected: wrong.status === 402
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as Record<string, unknown>;
}

async function writeReferenceStarterNotes(cwd: string): Promise<void> {
  const files = new Map<string, string>([
    ["docs/refs/README.md", "# FiberMPP Reference Index\n\nReference notes for FiberMPP protocol, Fiber RPC, F402/L402 compatibility, and security boundaries.\n"],
    ["docs/refs/fiber.md", "# Fiber References\n\nTrack Fiber JSON-RPC invoice creation, payment sending, invoice status, payment status, and settlement semantics used by FiberMPP.\n"],
    ["docs/refs/mpp.md", "# MPP References\n\nTrack the HTTP 402 challenge, credential, receipt, replay, and resource-binding lifecycle used by FiberMPP.\n"],
    ["docs/refs/infern.md", "# Infern / F402 References\n\nTrack F402 compatibility boundaries and integration assumptions for Fiber-backed paid access flows.\n"],
    ["docs/refs/l402.md", "# L402 References\n\nTrack macaroon, preimage, and paid-access precedent relevant to Authorization-bound receipts.\n"],
    ["docs/refs/security.md", "# Security References\n\nTrack replay, wrong-resource, wrong-method, wrong-amount, expired-challenge, paid-but-denied, and unpaid-service attack coverage.\n"]
  ]);
  for (const [file, contents] of files) {
    const path = resolve(cwd, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

async function nodeRequestToWeb(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    } else if (value) {
      headers.set(key, value);
    }
  }
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Request(url, {
    method,
    headers,
    body: Buffer.concat(chunks)
  });
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}
