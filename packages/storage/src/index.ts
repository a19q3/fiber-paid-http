import {
  verifyReceiptSignatureWithAnySecret,
  type PaymentChallenge,
  type PaymentReceipt,
  type PaymentCredential,
  type Settlement
} from "@fiber-paid-http/core";
import { constants } from "node:fs";
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

export type StoreKind = "sqlite" | "redis-compatible";

export type ChallengeRecord = {
  challenge: PaymentChallenge;
  signature: string;
  resourceHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
};

export type PaymentObservation = {
  paymentHash: string;
  challengeId?: string;
  settlement: Settlement;
  amountShannons?: string;
  updatedAt: string;
};

export type DeliveryOutcome = {
  receiptId: string;
  challengeId: string;
  credentialHash: string;
  status: "delivered" | "failed";
  responseStatus?: number;
  errorCode?: string;
  errorMessage?: string;
  recordedAt: string;
};

export interface FiberPaidHttpStore {
  readonly kind: StoreKind;
  readonly durable: boolean;
  saveChallenge(record: ChallengeRecord): Promise<void>;
  getChallenge(challengeId: string): Promise<ChallengeRecord | null>;
  markChallengeUsed(challengeId: string, usedAt: string): Promise<boolean>;
  hasCredentialUse(credentialHash: string): Promise<boolean>;
  saveCredentialUse(credentialHash: string, credential: PaymentCredential, usedAt: string): Promise<boolean>;
  saveReceipt(receipt: PaymentReceipt): Promise<void>;
  getReceipt(receiptId: string): Promise<PaymentReceipt | null>;
  listReceipts(): Promise<PaymentReceipt[]>;
  savePaymentObservation(observation: PaymentObservation): Promise<void>;
  getPaymentObservation(paymentHash: string): Promise<PaymentObservation | null>;
  saveDeliveryOutcome(outcome: DeliveryOutcome): Promise<void>;
  listDeliveryOutcomes(): Promise<DeliveryOutcome[]>;
}

/**
 * @deprecated Use `FiberPaidHttpStore`.
 */
export type FiberMppStore = FiberPaidHttpStore;

export const SQLITE_SCHEMA_VERSION = 1;

export type ReceiptAuditReport = {
  source: string;
  receipts: number;
  valid: number;
  invalid: number;
  invalidReceiptIds: string[];
};

export type ReceiptExportReport = ReceiptAuditReport & {
  destination: string;
};

export type SqliteStoreHealthReport = {
  source: string;
  schemaVersion: number;
  journalMode: string | null;
  foreignKeys: boolean;
  integrityCheck: string;
};

export class SqliteStore implements FiberPaidHttpStore {
  public readonly kind = "sqlite" as const;
  public readonly durable = true;
  private readonly db: SqliteDatabase;

  public constructor(path: string) {
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(path) as SqliteDatabase;
    applySqliteMigrations(this.db);
  }

  public schemaVersion(): number {
    return sqliteUserVersion(this.db);
  }

  public healthReport(sourcePath: string): SqliteStoreHealthReport {
    return sqliteHealthReport(this.db, resolve(sourcePath));
  }

  public async saveChallenge(record: ChallengeRecord): Promise<void> {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO challenges (id, record, used_at) VALUES (?, ?, COALESCE((SELECT used_at FROM challenges WHERE id = ?), NULL))"
      )
      .run(record.challenge.challengeId, JSON.stringify(record), record.challenge.challengeId);
  }

  public async getChallenge(challengeId: string): Promise<ChallengeRecord | null> {
    const row = this.db.prepare("SELECT record, used_at FROM challenges WHERE id = ?").get(challengeId) as
      | { record: string; used_at?: string | null }
      | undefined;
    if (!row) {
      return null;
    }
    const record = JSON.parse(row.record) as ChallengeRecord;
    return row.used_at ? { ...record, usedAt: row.used_at } : record;
  }

  public async markChallengeUsed(challengeId: string, usedAt: string): Promise<boolean> {
    const row = this.db.prepare("SELECT used_at FROM challenges WHERE id = ?").get(challengeId) as
      | { used_at?: string | null }
      | undefined;
    if (!row || row.used_at) {
      return false;
    }
    this.db.prepare("UPDATE challenges SET used_at = ? WHERE id = ?").run(usedAt, challengeId);
    return true;
  }

  public async hasCredentialUse(credentialHash: string): Promise<boolean> {
    const row = this.db.prepare("SELECT hash FROM credential_uses WHERE hash = ?").get(credentialHash);
    return Boolean(row);
  }

  public async saveCredentialUse(
    credentialHash: string,
    credential: PaymentCredential,
    usedAt: string
  ): Promise<boolean> {
    try {
      this.db
        .prepare("INSERT INTO credential_uses (hash, credential, used_at) VALUES (?, ?, ?)")
        .run(credentialHash, JSON.stringify(credential), usedAt);
      return true;
    } catch {
      return false;
    }
  }

  public async saveReceipt(receipt: PaymentReceipt): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO receipts (id, receipt) VALUES (?, ?)")
      .run(receipt.receiptId, JSON.stringify(receipt));
  }

  public async getReceipt(receiptId: string): Promise<PaymentReceipt | null> {
    const row = this.db.prepare("SELECT receipt FROM receipts WHERE id = ?").get(receiptId) as
      | { receipt: string }
      | undefined;
    return row ? (JSON.parse(row.receipt) as PaymentReceipt) : null;
  }

  public async listReceipts(): Promise<PaymentReceipt[]> {
    const rows = this.db.prepare("SELECT receipt FROM receipts ORDER BY id").all() as Array<{ receipt: string }>;
    return rows.map((row) => JSON.parse(row.receipt) as PaymentReceipt);
  }

  public async savePaymentObservation(observation: PaymentObservation): Promise<void> {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO payment_observations (payment_hash, observation, updated_at) VALUES (?, ?, ?)"
      )
      .run(observation.paymentHash, JSON.stringify(observation), observation.updatedAt);
  }

  public async getPaymentObservation(paymentHash: string): Promise<PaymentObservation | null> {
    const row = this.db
      .prepare("SELECT observation FROM payment_observations WHERE payment_hash = ?")
      .get(paymentHash) as { observation: string } | undefined;
    return row ? (JSON.parse(row.observation) as PaymentObservation) : null;
  }

  public async saveDeliveryOutcome(outcome: DeliveryOutcome): Promise<void> {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO delivery_outcomes (receipt_id, challenge_id, credential_hash, outcome, recorded_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        outcome.receiptId,
        outcome.challengeId,
        outcome.credentialHash,
        JSON.stringify(outcome),
        outcome.recordedAt
      );
  }

  public async listDeliveryOutcomes(): Promise<DeliveryOutcome[]> {
    const rows = this.db.prepare("SELECT outcome FROM delivery_outcomes ORDER BY recorded_at, receipt_id").all() as Array<{ outcome: string }>;
    return rows.map((row) => JSON.parse(row.outcome) as DeliveryOutcome);
  }
}

export type RedisCompatibleStore = FiberPaidHttpStore & {
  readonly kind: "redis-compatible";
};

export function assertProductionStore(store: FiberPaidHttpStore): void {
  if (!store.durable) {
    throw new Error(
      "Durable Fiber Paid HTTP storage is required. Use SQLite or a Redis-compatible production store."
    );
  }
}

export async function backupSqliteStore(sourcePath: string, destinationPath: string): Promise<{ source: string; destination: string }> {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  await assertFileMissing(destination, "backup destination already exists");
  await mkdir(dirname(destination), { recursive: true });
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(source) as SqliteDatabase;
  try {
    db.exec(`VACUUM INTO '${escapeSqlString(destination)}'`);
  } finally {
    db.close?.();
  }
  return { source, destination };
}

export async function restoreSqliteStore(
  backupPath: string,
  destinationPath: string,
  options: { force?: boolean } = {}
): Promise<{ source: string; destination: string }> {
  const source = resolve(backupPath);
  const destination = resolve(destinationPath);
  await access(source, constants.R_OK);
  if (!options.force) {
    await assertFileMissing(destination, "restore destination already exists; pass --force to overwrite it");
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  return { source, destination };
}

export async function checkSqliteStore(sourcePath: string): Promise<SqliteStoreHealthReport> {
  const source = resolve(sourcePath);
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(source) as SqliteDatabase;
  try {
    applySqliteMigrations(db);
    return sqliteHealthReport(db, source);
  } finally {
    db.close?.();
  }
}

export async function listSqliteDeliveryOutcomes(sourcePath: string): Promise<DeliveryOutcome[]> {
  const source = resolve(sourcePath);
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(source) as SqliteDatabase;
  try {
    applySqliteMigrations(db);
    const rows = db.prepare("SELECT outcome FROM delivery_outcomes ORDER BY recorded_at, receipt_id").all() as Array<{ outcome: string }>;
    return rows.map((row) => JSON.parse(row.outcome) as DeliveryOutcome);
  } finally {
    db.close?.();
  }
}

export async function auditSqliteReceipts(sourcePath: string, secrets: string | string[]): Promise<ReceiptAuditReport> {
  const source = resolve(sourcePath);
  const receipts = await listSqliteReceipts(source);
  const verificationSecrets = normalizeSecrets(secrets);
  const invalidReceiptIds: string[] = [];
  for (const receipt of receipts) {
    if (!verifyReceiptSignatureWithAnySecret(receipt, verificationSecrets)) {
      invalidReceiptIds.push(receipt.receiptId);
    }
  }
  return {
    source,
    receipts: receipts.length,
    valid: receipts.length - invalidReceiptIds.length,
    invalid: invalidReceiptIds.length,
    invalidReceiptIds
  };
}

export async function exportSqliteReceipts(
  sourcePath: string,
  destinationPath: string,
  options: { secret?: string; secrets?: string[] } = {}
): Promise<ReceiptExportReport> {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  await assertFileMissing(destination, "receipt export destination already exists");
  await mkdir(dirname(destination), { recursive: true });
  const receipts = await listSqliteReceipts(source);
  const invalidReceiptIds: string[] = [];
  const verificationSecrets = normalizeOptionalSecrets(options);
  const lines = receipts.map((receipt) => {
    const signatureValid = verificationSecrets.length > 0
      ? verifyReceiptSignatureWithAnySecret(receipt, verificationSecrets)
      : undefined;
    if (signatureValid === false) {
      invalidReceiptIds.push(receipt.receiptId);
    }
    return JSON.stringify({
      receipt_id: receipt.receiptId,
      challenge_id: receipt.challengeId,
      method: receipt.method,
      issued_at: receipt.issuedAt,
      server_id: receipt.serverId,
      payment_hash: receipt.settlement.paymentHash,
      receipt_signature_valid: signatureValid,
      receipt
    });
  });
  await writeFile(destination, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  return {
    source,
    destination,
    receipts: receipts.length,
    valid: verificationSecrets.length > 0 ? receipts.length - invalidReceiptIds.length : 0,
    invalid: verificationSecrets.length > 0 ? invalidReceiptIds.length : 0,
    invalidReceiptIds
  };
}

export async function listSqliteReceipts(sourcePath: string): Promise<PaymentReceipt[]> {
  const source = resolve(sourcePath);
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(source) as SqliteDatabase;
  try {
    const rows = db.prepare("SELECT receipt FROM receipts ORDER BY id").all() as Array<{ receipt: string }>;
    return rows.map((row) => JSON.parse(row.receipt) as PaymentReceipt);
  } finally {
    db.close?.();
  }
}

type SqliteStatement = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
};

type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close?: () => void;
};

function applySqliteMigrations(db: SqliteDatabase): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS fiber_paid_http_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS challenges (
      id TEXT PRIMARY KEY,
      record TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS credential_uses (
      hash TEXT PRIMARY KEY,
      credential TEXT NOT NULL,
      used_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      receipt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_observations (
      payment_hash TEXT PRIMARY KEY,
      observation TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS delivery_outcomes (
      receipt_id TEXT PRIMARY KEY,
      challenge_id TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      outcome TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    PRAGMA user_version = ${SQLITE_SCHEMA_VERSION};
  `);
  db.prepare("INSERT OR REPLACE INTO fiber_paid_http_meta (key, value) VALUES (?, ?)").run(
    "schema_version",
    String(SQLITE_SCHEMA_VERSION)
  );
}

function sqliteUserVersion(db: SqliteDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function sqliteHealthReport(db: SqliteDatabase, source: string): SqliteStoreHealthReport {
  const journalRow = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
  const foreignKeysRow = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
  const integrityRow = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
  return {
    source,
    schemaVersion: sqliteUserVersion(db),
    journalMode: journalRow?.journal_mode ?? null,
    foreignKeys: foreignKeysRow?.foreign_keys === 1,
    integrityCheck: integrityRow?.integrity_check ?? "unknown"
  };
}

function loadNodeSqlite(): { DatabaseSync: new (path: string) => unknown } {
  const loader = createRequire(import.meta.url);
  return loader("node:sqlite") as { DatabaseSync: new (path: string) => unknown };
}

async function assertFileMissing(path: string, message: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
  } catch {
    return;
  }
  throw new Error(message);
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeSecrets(secrets: string | string[]): string[] {
  const normalized = (Array.isArray(secrets) ? secrets : [secrets]).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error("At least one receipt audit secret is required");
  }
  return normalized;
}

function normalizeOptionalSecrets(options: { secret?: string; secrets?: string[] }): string[] {
  return [...(options.secret ? [options.secret] : []), ...(options.secrets ?? [])].filter(Boolean);
}
