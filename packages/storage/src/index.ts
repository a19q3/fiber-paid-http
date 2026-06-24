import type {
  PaymentChallenge,
  PaymentReceipt,
  PaymentCredential,
  Settlement
} from "@fiber-mpp/core";
import { createRequire } from "node:module";

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

export interface FiberMppStore {
  readonly kind: StoreKind;
  readonly durable: boolean;
  saveChallenge(record: ChallengeRecord): Promise<void>;
  getChallenge(challengeId: string): Promise<ChallengeRecord | null>;
  markChallengeUsed(challengeId: string, usedAt: string): Promise<boolean>;
  hasCredentialUse(credentialHash: string): Promise<boolean>;
  saveCredentialUse(credentialHash: string, credential: PaymentCredential, usedAt: string): Promise<boolean>;
  saveReceipt(receipt: PaymentReceipt): Promise<void>;
  getReceipt(receiptId: string): Promise<PaymentReceipt | null>;
  savePaymentObservation(observation: PaymentObservation): Promise<void>;
  getPaymentObservation(paymentHash: string): Promise<PaymentObservation | null>;
}

export class SqliteStore implements FiberMppStore {
  public readonly kind = "sqlite" as const;
  public readonly durable = true;
  private readonly db: SqliteDatabase;

  public constructor(path: string) {
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(path) as SqliteDatabase;
    this.db.exec(`
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
    `);
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
}

export type RedisCompatibleStore = FiberMppStore & {
  readonly kind: "redis-compatible";
};

export function assertProductionStore(store: FiberMppStore): void {
  if (!store.durable) {
    throw new Error(
      "Durable FiberMPP storage is required. Use SQLite or a Redis-compatible production store."
    );
  }
}

type SqliteStatement = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
};

type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

function loadNodeSqlite(): { DatabaseSync: new (path: string) => unknown } {
  const loader = createRequire(import.meta.url);
  return loader("node:sqlite") as { DatabaseSync: new (path: string) => unknown };
}
