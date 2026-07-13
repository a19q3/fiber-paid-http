import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { bindChallengeId, encodeFiberChargeRequest, type PaymentChallenge, type PaymentReceipt } from "@fiber-paid-http/core";
import {
  SQLITE_SCHEMA_VERSION,
  SqliteStore,
  auditSqliteReceipts,
  backupSqliteStore,
  checkSqliteStore,
  exportSqliteReceipts,
  listSqliteDeliveryOutcomes,
  restoreSqliteStore
} from "@fiber-paid-http/storage";

const paymentHash = `0x${"12".repeat(32)}`;

describe("SQLite storage operations", () => {
  it("refuses an unversioned database that already contains application tables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fiber-paid-http-storage-"));
    const sourcePath = join(dir, "unknown.sqlite");
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
    };
    const database = new DatabaseSync(sourcePath);
    database.exec("CREATE TABLE unknown_data (id TEXT PRIMARY KEY)");
    database.close();

    expect(() => new SqliteStore(sourcePath)).toThrow(/unsupported database schema 0/);
  });

  it("refuses a version-one database with noncanonical columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fiber-paid-http-storage-"));
    const sourcePath = join(dir, "invalid-v1.sqlite");
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
    };
    const database = new DatabaseSync(sourcePath);
    database.exec("CREATE TABLE challenges (id TEXT PRIMARY KEY); PRAGMA user_version = 1");
    database.close();

    expect(() => new SqliteStore(sourcePath)).toThrow(/does not match the canonical columns/);
  });

  it("backs up and restores committed payment observations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fiber-paid-http-storage-"));
    const sourcePath = join(dir, "source.sqlite");
    const backupPath = join(dir, "backup.sqlite");
    const restoredPath = join(dir, "restored.sqlite");
    const store = new SqliteStore(sourcePath);
    await store.savePaymentObservation({
      paymentHash,
      challengeId: "storage-backup",
      settlement: { status: "settled", paymentHash, provider: "fiber-rpc", observedAt: "2026-01-01T00:00:00.000Z" },
      amountShannons: "100",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    await backupSqliteStore(sourcePath, backupPath);
    await restoreSqliteStore(backupPath, restoredPath, { force: true });
    await expect(new SqliteStore(restoredPath).getPaymentObservation(paymentHash)).resolves.toMatchObject({ amountShannons: "100" });
  });

  it("requires force before overwriting a restore destination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fiber-paid-http-storage-"));
    const sourcePath = join(dir, "source.sqlite");
    const backupPath = join(dir, "backup.sqlite");
    const destinationPath = join(dir, "destination.sqlite");
    new SqliteStore(sourcePath);
    new SqliteStore(destinationPath);
    await backupSqliteStore(sourcePath, backupPath);
    await expect(restoreSqliteStore(backupPath, destinationPath)).rejects.toThrow(/--force/);
  });

  it("reports schema health and persists delivery outcomes behind a challenge FK", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fiber-paid-http-storage-"));
    const sourcePath = join(dir, "source.sqlite");
    const store = new SqliteStore(sourcePath);
    expect(store.schemaVersion()).toBe(SQLITE_SCHEMA_VERSION);
    await expect(checkSqliteStore(sourcePath)).resolves.toMatchObject({
      schemaVersion: SQLITE_SCHEMA_VERSION,
      integrityCheck: "ok",
      foreignKeys: true
    });
    await saveChallenge(store, "delivery-failure");
    await store.saveDeliveryOutcome({
      challengeId: "delivery-failure",
      credentialHash: "credential-hash",
      paymentHash,
      status: "failed",
      responseStatus: 500,
      errorCode: "internal-error",
      recordedAt: "2026-01-01T00:00:00.000Z"
    });
    await expect(listSqliteDeliveryOutcomes(sourcePath)).resolves.toMatchObject([{ status: "failed", errorCode: "internal-error" }]);
  });

  it("exports and schema-audits standard receipts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fiber-paid-http-storage-"));
    const sourcePath = join(dir, "source.sqlite");
    const exportPath = join(dir, "receipts.jsonl");
    const store = new SqliteStore(sourcePath);
    await saveChallenge(store, "receipt-one");
    await saveChallenge(store, "receipt-two");
    const receipt = makeReceipt("receipt-one", paymentHash);
    const secondHash = `0x${"34".repeat(32)}`;
    await store.saveReceipt(receipt);
    await store.saveReceipt(makeReceipt("receipt-two", secondHash));
    await expect(auditSqliteReceipts(sourcePath)).resolves.toMatchObject({ receipts: 2, valid: 2, invalid: 0, invalidReceiptReferences: [] });
    await exportSqliteReceipts(sourcePath, exportPath);
    const exported = (await readFile(exportPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      receipt_reference: string;
      receipt_schema_valid: boolean;
    }>;
    expect(exported.map((line) => line.receipt_schema_valid)).toEqual([true, true]);
    expect(exported.map((line) => line.receipt_reference)).toEqual([paymentHash, secondHash]);
  });
});

async function saveChallenge(store: SqliteStore, id: string): Promise<void> {
  const chargeRequest = {
    amount: "100",
    currency: "ckb",
    methodDetails: { invoice: "fibt1fixture", paymentHash, network: "testnet" as const, hashAlgorithm: "ckb_hash" as const }
  };
  const pending = {
    id: "pending",
    realm: "storage.example.test",
    method: "fiber" as const,
    intent: "charge" as const,
    request: encodeFiberChargeRequest(chargeRequest),
    expires: "2030-01-01T00:00:00.000Z"
  };
  const challenge: PaymentChallenge = { ...pending, id: bindChallengeId(pending, "storage-secret-at-least-16") };
  await store.saveChallenge({
    challenge: { ...challenge, id },
    chargeRequest,
    resourceBinding: { method: "GET", url: `https://storage.example.test/${id}` },
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z"
  });
}

function makeReceipt(challengeId: string, reference: string): PaymentReceipt {
  return {
    status: "success",
    method: "fiber",
    timestamp: "2026-01-01T00:00:01.000Z",
    reference,
    challengeId
  };
}
