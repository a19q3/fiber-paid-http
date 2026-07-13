import {
  PaymentReceiptSchema,
  type FiberChargeRequest,
  type PaymentChallenge,
  type PaymentReceipt,
  type ResourceDescriptor,
  type Settlement
} from "@fiber-paid-http/core";
import { constants } from "node:fs";
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

export type StoreKind = "sqlite" | "redis-compatible";

export type ChallengeRecord = {
  challenge: PaymentChallenge;
  chargeRequest: FiberChargeRequest;
  resourceBinding: ResourceDescriptor;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
};

export type RedemptionRecord = {
  challengeId: string;
  credentialHash: string;
  paymentHash: string;
  settlement: Settlement;
  consumedAt: string;
};

export type PaymentObservation = {
  paymentHash: string;
  challengeId?: string;
  settlement: Settlement;
  amountShannons?: string;
  updatedAt: string;
};

export type DeliveryOutcome = {
  challengeId: string;
  credentialHash: string;
  paymentHash: string;
  receiptReference?: string;
  status: "pending" | "delivered" | "failed";
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
  consumeRedemption(redemption: RedemptionRecord): Promise<boolean>;
  getRedemption(challengeId: string): Promise<RedemptionRecord | null>;
  saveReceipt(receipt: PaymentReceipt): Promise<void>;
  getReceipt(reference: string): Promise<PaymentReceipt | null>;
  listReceipts(): Promise<PaymentReceipt[]>;
  savePaymentObservation(observation: PaymentObservation): Promise<void>;
  getPaymentObservation(paymentHash: string): Promise<PaymentObservation | null>;
  saveDeliveryOutcome(outcome: DeliveryOutcome): Promise<void>;
  listDeliveryOutcomes(): Promise<DeliveryOutcome[]>;
}

export const SQLITE_SCHEMA_VERSION = 1;

export type ReceiptAuditReport = {
  source: string;
  receipts: number;
  valid: number;
  invalid: number;
  invalidReceiptReferences: string[];
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
    initializeSqliteSchema(this.db);
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
        `INSERT OR IGNORE INTO challenges
         (id, challenge, charge_request, resource_binding, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        record.challenge.id,
        JSON.stringify(record.challenge),
        JSON.stringify(record.chargeRequest),
        JSON.stringify(record.resourceBinding),
        record.createdAt,
        record.expiresAt
      );
  }

  public async getChallenge(challengeId: string): Promise<ChallengeRecord | null> {
    const row = this.db.prepare(
      `SELECT challenge, charge_request, resource_binding, created_at, expires_at, consumed_at
       FROM challenges WHERE id = ?`
    ).get(challengeId) as
      | {
          challenge: string;
          charge_request: string;
          resource_binding: string;
          created_at: string;
          expires_at: string;
          consumed_at?: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      challenge: JSON.parse(row.challenge) as PaymentChallenge,
      chargeRequest: JSON.parse(row.charge_request) as FiberChargeRequest,
      resourceBinding: JSON.parse(row.resource_binding) as ResourceDescriptor,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...(row.consumed_at ? { consumedAt: row.consumed_at } : {})
    };
  }

  public async consumeRedemption(redemption: RedemptionRecord): Promise<boolean> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
        .run(redemption.consumedAt, redemption.challengeId);
      const changes = this.db.prepare("SELECT changes() AS count").get() as { count?: number } | undefined;
      if (changes?.count !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare(
          `INSERT INTO redemptions
           (challenge_id, credential_hash, payment_hash, settlement, consumed_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          redemption.challengeId,
          redemption.credentialHash,
          redemption.paymentHash,
          JSON.stringify(redemption.settlement),
          redemption.consumedAt
        );
      const pending: DeliveryOutcome = {
        challengeId: redemption.challengeId,
        credentialHash: redemption.credentialHash,
        paymentHash: redemption.paymentHash,
        status: "pending",
        recordedAt: redemption.consumedAt
      };
      this.db
        .prepare(
          `INSERT INTO delivery_outcomes
           (challenge_id, credential_hash, payment_hash, status, recorded_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          pending.challengeId,
          pending.credentialHash,
          pending.paymentHash,
          pending.status,
          pending.recordedAt
        );
      this.db.exec("COMMIT");
      return true;
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      return false;
    }
  }

  public async getRedemption(challengeId: string): Promise<RedemptionRecord | null> {
    const row = this.db.prepare(
      `SELECT credential_hash, payment_hash, settlement, consumed_at
       FROM redemptions WHERE challenge_id = ?`
    ).get(challengeId) as
      | { credential_hash: string; payment_hash: string; settlement: string; consumed_at: string }
      | undefined;
    return row
      ? {
          challengeId,
          credentialHash: row.credential_hash,
          paymentHash: row.payment_hash,
          settlement: JSON.parse(row.settlement) as Settlement,
          consumedAt: row.consumed_at
        }
      : null;
  }

  public async saveReceipt(receipt: PaymentReceipt): Promise<void> {
    this.db
      .prepare("INSERT OR IGNORE INTO receipts (reference, challenge_id, receipt) VALUES (?, ?, ?)")
      .run(receipt.reference, receipt.challengeId, JSON.stringify(receipt));
  }

  public async getReceipt(reference: string): Promise<PaymentReceipt | null> {
    const row = this.db.prepare("SELECT receipt FROM receipts WHERE reference = ?").get(reference) as
      | { receipt: string }
      | undefined;
    return row ? (JSON.parse(row.receipt) as PaymentReceipt) : null;
  }

  public async listReceipts(): Promise<PaymentReceipt[]> {
    const rows = this.db.prepare("SELECT receipt FROM receipts ORDER BY reference").all() as Array<{ receipt: string }>;
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
        `INSERT OR REPLACE INTO delivery_outcomes
         (challenge_id, credential_hash, payment_hash, receipt_reference, status,
          response_status, error_code, error_message, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        outcome.challengeId,
        outcome.credentialHash,
        outcome.paymentHash,
        outcome.receiptReference ?? null,
        outcome.status,
        outcome.responseStatus ?? null,
        outcome.errorCode ?? null,
        outcome.errorMessage ?? null,
        outcome.recordedAt
      );
  }

  public async listDeliveryOutcomes(): Promise<DeliveryOutcome[]> {
    return readDeliveryOutcomes(this.db);
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
    initializeSqliteSchema(db);
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
    initializeSqliteSchema(db);
    return readDeliveryOutcomes(db);
  } finally {
    db.close?.();
  }
}

export async function auditSqliteReceipts(sourcePath: string): Promise<ReceiptAuditReport> {
  const source = resolve(sourcePath);
  const receipts = await listSqliteReceipts(source);
  const invalidReceiptReferences: string[] = [];
  for (const receipt of receipts) {
    if (!PaymentReceiptSchema.safeParse(receipt).success) {
      invalidReceiptReferences.push(receipt.reference);
    }
  }
  return {
    source,
    receipts: receipts.length,
    valid: receipts.length - invalidReceiptReferences.length,
    invalid: invalidReceiptReferences.length,
    invalidReceiptReferences
  };
}

export async function exportSqliteReceipts(
  sourcePath: string,
  destinationPath: string
): Promise<ReceiptExportReport> {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  await assertFileMissing(destination, "receipt export destination already exists");
  await mkdir(dirname(destination), { recursive: true });
  const receipts = await listSqliteReceipts(source);
  const invalidReceiptReferences: string[] = [];
  const lines = receipts.map((receipt) => {
    const valid = PaymentReceiptSchema.safeParse(receipt).success;
    if (!valid) {
      invalidReceiptReferences.push(receipt.reference);
    }
    return JSON.stringify({
      receipt_reference: receipt.reference,
      challenge_id: receipt.challengeId,
      method: receipt.method,
      timestamp: receipt.timestamp,
      payment_hash: receipt.reference,
      receipt_schema_valid: valid,
      receipt
    });
  });
  await writeFile(destination, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  return {
    source,
    destination,
    receipts: receipts.length,
    valid: receipts.length - invalidReceiptReferences.length,
    invalid: invalidReceiptReferences.length,
    invalidReceiptReferences
  };
}

export async function listSqliteReceipts(sourcePath: string): Promise<PaymentReceipt[]> {
  const source = resolve(sourcePath);
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(source) as SqliteDatabase;
  try {
    const rows = db.prepare("SELECT receipt FROM receipts ORDER BY reference").all() as Array<{ receipt: string }>;
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

function initializeSqliteSchema(db: SqliteDatabase): void {
  const currentVersion = sqliteUserVersion(db);
  const existingTables = db.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).get() as { count?: number } | undefined;
  if (
    (currentVersion === 0 && Number(existingTables?.count ?? 0) > 0) ||
    (currentVersion !== 0 && currentVersion !== SQLITE_SCHEMA_VERSION)
  ) {
    throw new Error(
      `unsupported database schema ${currentVersion}; create a new schema ${SQLITE_SCHEMA_VERSION} database`
    );
  }
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
      challenge TEXT NOT NULL,
      charge_request TEXT NOT NULL,
      resource_binding TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS redemptions (
      challenge_id TEXT PRIMARY KEY,
      credential_hash TEXT NOT NULL UNIQUE,
      payment_hash TEXT NOT NULL UNIQUE,
      settlement TEXT NOT NULL,
      consumed_at TEXT NOT NULL,
      FOREIGN KEY(challenge_id) REFERENCES challenges(id)
    );
    CREATE TABLE IF NOT EXISTS receipts (
      reference TEXT PRIMARY KEY,
      challenge_id TEXT NOT NULL UNIQUE,
      receipt TEXT NOT NULL,
      FOREIGN KEY(challenge_id) REFERENCES challenges(id)
    );
    CREATE TABLE IF NOT EXISTS payment_observations (
      payment_hash TEXT PRIMARY KEY,
      observation TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS delivery_outcomes (
      challenge_id TEXT PRIMARY KEY,
      credential_hash TEXT NOT NULL,
      payment_hash TEXT NOT NULL,
      receipt_reference TEXT,
      status TEXT NOT NULL,
      response_status INTEGER,
      error_code TEXT,
      error_message TEXT,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY(challenge_id) REFERENCES challenges(id)
    );
    PRAGMA user_version = ${SQLITE_SCHEMA_VERSION};
  `);
  db.prepare("INSERT OR REPLACE INTO fiber_paid_http_meta (key, value) VALUES (?, ?)").run(
    "schema_version",
    String(SQLITE_SCHEMA_VERSION)
  );
  assertCanonicalSqliteSchema(db);
}

const CANONICAL_SQLITE_SCHEMA = {
  challenges: ["id", "challenge", "charge_request", "resource_binding", "created_at", "expires_at", "consumed_at"],
  delivery_outcomes: ["challenge_id", "credential_hash", "payment_hash", "receipt_reference", "status", "response_status", "error_code", "error_message", "recorded_at"],
  fiber_paid_http_meta: ["key", "value"],
  payment_observations: ["payment_hash", "observation", "updated_at"],
  receipts: ["reference", "challenge_id", "receipt"],
  redemptions: ["challenge_id", "credential_hash", "payment_hash", "settlement", "consumed_at"]
} as const;

function assertCanonicalSqliteSchema(db: SqliteDatabase): void {
  const actualTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as Array<{ name: string }>;
  const expectedTables = Object.keys(CANONICAL_SQLITE_SCHEMA).sort();
  if (JSON.stringify(actualTables.map((row) => row.name)) !== JSON.stringify(expectedTables)) {
    throw new Error("database schema v1 does not match the canonical table set");
  }
  for (const [table, expectedColumns] of Object.entries(CANONICAL_SQLITE_SCHEMA)) {
    const actualColumns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (JSON.stringify(actualColumns.map((row) => row.name)) !== JSON.stringify(expectedColumns)) {
      throw new Error(`database schema v1 table ${table} does not match the canonical columns`);
    }
  }
}

function readDeliveryOutcomes(db: SqliteDatabase): DeliveryOutcome[] {
  const rows = db.prepare(
    `SELECT challenge_id, credential_hash, payment_hash, receipt_reference, status,
            response_status, error_code, error_message, recorded_at
     FROM delivery_outcomes ORDER BY recorded_at, challenge_id`
  ).all() as Array<{
    challenge_id: string;
    credential_hash: string;
    payment_hash: string;
    receipt_reference: string | null;
    status: DeliveryOutcome["status"];
    response_status: number | null;
    error_code: string | null;
    error_message: string | null;
    recorded_at: string;
  }>;
  return rows.map((row) => ({
    challengeId: row.challenge_id,
    credentialHash: row.credential_hash,
    paymentHash: row.payment_hash,
    status: row.status,
    recordedAt: row.recorded_at,
    ...(row.receipt_reference ? { receiptReference: row.receipt_reference } : {}),
    ...(row.response_status === null ? {} : { responseStatus: row.response_status }),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {})
  }));
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
