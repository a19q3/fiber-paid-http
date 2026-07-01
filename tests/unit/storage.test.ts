import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { attachReceiptSignature } from "@fiber-paid-http/core";
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

describe("SQLite storage operations", () => {
  it("backs up and restores committed Fiber Paid HTTP observations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fiber-paid-http-storage-"));
    const sourcePath = join(dir, "source.sqlite");
    const backupPath = join(dir, "backup.sqlite");
    const restoredPath = join(dir, "restored.sqlite");
    const store = new SqliteStore(sourcePath);
    await store.savePaymentObservation({
      paymentHash: `0x${"12".repeat(32)}`,
      challengeId: "chal_storage_backup",
      settlement: {
        status: "settled",
        paymentHash: `0x${"12".repeat(32)}`,
        provider: "fiber-rpc",
        observedAt: "2026-01-01T00:00:00.000Z"
      },
      amountShannons: "100",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    await backupSqliteStore(sourcePath, backupPath);
    await restoreSqliteStore(backupPath, restoredPath, { force: true });

    const restored = new SqliteStore(restoredPath);
    await expect(restored.getPaymentObservation(`0x${"12".repeat(32)}`)).resolves.toMatchObject({
      challengeId: "chal_storage_backup",
      amountShannons: "100",
      settlement: {
        status: "settled",
        provider: "fiber-rpc"
      }
    });
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

  it("reports SQLite schema health and stores delivery outcomes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fiber-paid-http-storage-"));
    const sourcePath = join(dir, "source.sqlite");
    const store = new SqliteStore(sourcePath);

    expect(store.schemaVersion()).toBe(SQLITE_SCHEMA_VERSION);
    expect(store.healthReport(sourcePath)).toMatchObject({
      schemaVersion: SQLITE_SCHEMA_VERSION,
      integrityCheck: "ok",
      foreignKeys: true
    });
    await expect(checkSqliteStore(sourcePath)).resolves.toMatchObject({
      schemaVersion: SQLITE_SCHEMA_VERSION,
      integrityCheck: "ok",
      foreignKeys: true
    });

    await store.saveDeliveryOutcome({
      receiptId: "rcpt_delivery_failure",
      challengeId: "chal_delivery_failure",
      credentialHash: "cred_hash_delivery_failure",
      status: "failed",
      responseStatus: 500,
      errorCode: "internal-error",
      errorMessage: "handler failed after payment",
      recordedAt: "2026-01-01T00:00:00.000Z"
    });

    await expect(store.listDeliveryOutcomes()).resolves.toMatchObject([
      {
        receiptId: "rcpt_delivery_failure",
        status: "failed",
        errorCode: "internal-error"
      }
    ]);
    await expect(listSqliteDeliveryOutcomes(sourcePath)).resolves.toMatchObject([
      {
        receiptId: "rcpt_delivery_failure",
        status: "failed",
        errorCode: "internal-error"
      }
    ]);
  });

  it("exports and audits stored receipts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fiber-paid-http-storage-"));
    const sourcePath = join(dir, "source.sqlite");
    const exportPath = join(dir, "receipts.jsonl");
    const secret = "storage-receipt-audit-secret-at-least-32";
    const previousSecret = "storage-previous-receipt-secret-at-least-32";
    const receiptInput = {
      domain: "fiber-paid-http-receipt-v1" as const,
      receiptId: "rcpt_storage_audit_current",
      challengeId: "chal_storage_audit",
      method: "fiber" as const,
      resourceHash: `0x${"ab".repeat(32)}`,
      amount: { value: "1", currency: "CKB" },
      settlement: {
        status: "settled" as const,
        paymentHash: `0x${"cd".repeat(32)}`,
        provider: "fiber-rpc" as const,
        observedAt: "2026-01-01T00:00:00.000Z"
      },
      serverId: "storage-test",
      issuedAt: "2026-01-01T00:00:01.000Z"
    };
    const receipt = attachReceiptSignature(receiptInput, secret);
    const previousReceipt = attachReceiptSignature(
      {
        ...receiptInput,
        receiptId: "rcpt_storage_audit_previous",
        challengeId: "chal_storage_audit_previous"
      },
      previousSecret
    );
    const store = new SqliteStore(sourcePath);
    await store.saveReceipt(receipt);
    await store.saveReceipt(previousReceipt);

    await expect(store.listReceipts()).resolves.toHaveLength(2);
    await expect(auditSqliteReceipts(sourcePath, [secret, previousSecret])).resolves.toMatchObject({
      receipts: 2,
      valid: 2,
      invalid: 0,
      invalidReceiptIds: []
    });
    await expect(auditSqliteReceipts(sourcePath, "wrong-secret-at-least-32")).resolves.toMatchObject({
      receipts: 2,
      valid: 0,
      invalid: 2,
      invalidReceiptIds: ["rcpt_storage_audit_current", "rcpt_storage_audit_previous"]
    });

    await exportSqliteReceipts(sourcePath, exportPath, { secrets: [secret, previousSecret] });
    const exported = (await readFile(exportPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Array<{
      receipt_id: string;
      receipt_signature_valid: boolean;
      receipt: { receiptId: string };
    }>;
    expect(exported).toHaveLength(2);
    expect(exported.map((line) => line.receipt_signature_valid)).toEqual([true, true]);
    expect(exported.map((line) => line.receipt_id)).toEqual([
      "rcpt_storage_audit_current",
      "rcpt_storage_audit_previous"
    ]);
  });
});
