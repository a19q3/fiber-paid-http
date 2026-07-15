import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  FiberRpcClient,
  extractInvoicePaymentHash,
  parseFiberMode,
  parseFiberUdtTypeScript,
  waitForFiberInvoicePaid,
  waitForFiberPaymentSuccess
} from "@fiber-paid-http/fiber-method";
import type { FiberUdtTypeScript } from "@fiber-paid-http/core";

export type BattlecodeRegistrationInput = {
  playerId: string;
  submissionId: string;
  botPackage: string;
  botScriptHash: string;
  clientHash: string;
  xudtAsset: string;
  entryAmount: string;
  prizeAmount: string;
  map: string;
};

export type BattlecodeFairnessManifest = {
  domain: "fiber-paid-http-battlecode-fairness-v1";
  botPackage: string;
  submissionId?: string;
  botScriptHash: string;
  opponentPackage: string;
  opponentScriptHash: string;
  clientHash: string;
  runnerHash: string;
  engineHash: string;
  engineVersion: string;
  hashAlgorithm: "sha256";
  notes: string[];
};

export type BattlecodeFairnessVerification = {
  status: "verified";
  committed: {
    botScriptHash: string;
    opponentScriptHash: string;
    clientHash: string;
  };
  observed: {
    botScriptHash: string;
    opponentScriptHash: string;
    clientHash: string;
    runnerHash: string;
    engineHash: string;
  };
  verifiedAt: string;
};

export type BattlecodeTicket = {
  ticketId: string;
  playerId: string;
  submissionId: string;
  botPackage: string;
  botScriptHash: string;
  clientHash: string;
  fairnessCommitment: BattlecodeFairnessManifest;
  xudtAsset: string;
  entryAmount: string;
  prizeAmount: string;
  map: string;
  receiptReference: string;
  challengeId: string;
  paymentHash?: string;
  issuedAt: string;
  status: "paid";
};

export type BattlecodeMatchResult = {
  matchId: string;
  map: string;
  teamA: string;
  teamB: string;
  winner: string;
  winnerSide: "A" | "B";
  round: number;
  reason: string;
  replayPath: string;
  matchHash: string;
  stdout: string;
  stderr: string;
  engineVersion: string;
  engineJar: string;
  engineHash: string;
  runnerHash: string;
  fairness: BattlecodeFairnessVerification;
  sandbox: BattlecodeSandboxEvidence;
  jdkHome: string;
  startedAt: string;
  finishedAt: string;
};

export type BattlecodeAward = {
  awardId: string;
  ticketId: string;
  matchId: string;
  playerId: string;
  botPackage: string;
  xudtAsset: string;
  prizeAmount: string;
  status: "claimable" | "paid";
  settlement: "local-xudt-award-ledger" | "fiber-xudt-payment";
  prizePayment?: BattlecodePrizePayment;
  matchHash: string;
  awardedAt: string;
  note: string;
};

export type BattlecodePrizePayment = {
  provider: "fiber-xudt";
  mode: "local" | "testnet";
  paymentHash: string;
  invoice: string;
  amountShannons: string;
  xudtAsset: string;
  udtTypeScript: FiberUdtTypeScript;
  payerRpcUrl: string;
  payeeRpcUrl: string;
  payerNode?: string;
  payeeNode?: string;
  status: "settled";
  observedAt: string;
  sendResult: unknown;
  settledPayment: unknown;
  paidInvoice: unknown;
};

export type BattlecodeLedger = {
  generatedAt: string;
  submissions: BattlecodeSubmission[];
  tickets: BattlecodeTicket[];
  matches: BattlecodeMatchResult[];
  awards: BattlecodeAward[];
};

export type BattlecodeSubmissionInput = {
  playerId: string;
  botPackage: string;
  source: string;
};

export type BattlecodeSubmission = {
  submissionId: string;
  playerId: string;
  botPackage: string;
  botScriptHash: string;
  sourcePath: string;
  sourceBytes: number;
  status: "locked";
  submittedAt: string;
  policy: {
    language: "java";
    entrypoint: "RobotPlayer.java";
    packageRequired: string;
    maxSourceBytes: number;
    disallowedPatterns: string[];
  };
};

export type BattlecodeSandboxEvidence = {
  mode: "bubblewrap-prlimit" | "prlimit-local" | "local-process";
  runDir: string;
  sourceDir: string;
  classesDir: string;
  replayDir: string;
  timeoutMs: number;
  jdkHome: string;
  engineJar: string;
  environmentKeys: string[];
  limits: {
    network: "unshared" | "not-granted";
    filesystem: "bubblewrap-ro-root-run-dir-rw" | "run-dir-only-by-convention";
    processTimeoutMs: number;
    cpuSeconds: number;
    addressSpaceBytes: number;
  };
};

export type BattlecodeTournamentReport = {
  generatedAt: string;
  registration: BattlecodeRegistrationInput;
  submission: BattlecodeSubmission;
  ticket: BattlecodeTicket;
  match: BattlecodeMatchResult;
  award: BattlecodeAward | null;
  ledgerPath: string;
  replayPath: string;
  warnings: string[];
};

export async function readBattlecodeReplay(
  repoRoot: string,
  replayPath: string
): Promise<{ filename: string; bytes: Buffer }> {
  const replayRoot = resolve(repoRoot, ".tmp/battlecode-tournament/matches");
  const candidate = resolve(replayPath);
  const pathWithinReplayRoot = relative(replayRoot, candidate);
  if (
    !pathWithinReplayRoot ||
    pathWithinReplayRoot.startsWith("..") ||
    isAbsolute(pathWithinReplayRoot) ||
    !candidate.endsWith(".bc25")
  ) {
    throw new Error("Battlecode replay path is outside the managed match directory");
  }

  const bytes = await readFile(candidate);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error("Battlecode replay is not a gzip-compressed .bc25 file");
  }
  try {
    gunzipSync(bytes);
  } catch {
    throw new Error("Battlecode replay gzip stream is invalid");
  }
  return { filename: basename(candidate), bytes };
}

type RunOptions = {
  registration: BattlecodeRegistrationInput;
  ticket: BattlecodeTicket;
  submission: BattlecodeSubmission;
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_BATTLECODE_DIR = "/home/arthur/a19q3/battlecode25-scaffold/java";
const DEFAULT_JDK_HOME = "/home/arthur/a19q3/.toolchains/jdk-21.0.11+10";
const DEFAULT_ENGINE_VERSION = "1.0.0";
const HASH_PREFIX = "sha256:";
const BATTLECODE_MAX_SOURCE_BYTES = 128_000;
const BATTLECODE_LEDGER_SCHEMA_VERSION = 2;
const BATTLECODE_OPPONENT_PACKAGE = "arena_baseline";
const FIBER_CHAMP_SOURCE = readFileSync(
  fileURLToPath(new URL("../../../examples/battlecode/fiberchamp/RobotPlayer.java", import.meta.url)),
  "utf8"
);
const ARENA_BASELINE_SOURCE = readFileSync(
  fileURLToPath(new URL("../../../examples/battlecode/arena_baseline/RobotPlayer.java", import.meta.url)),
  "utf8"
);
const DISALLOWED_BOT_PATTERNS = [
  "java.net.",
  "java.nio.file.",
  "java.io.File",
  "ProcessBuilder",
  "Runtime.getRuntime",
  "System.exit",
  "System.load",
  "System.getenv"
];
const DEFAULT_LOCAL_XUDT_TYPE_SCRIPT: FiberUdtTypeScript = {
  code_hash: "0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95",
  hash_type: "data2",
  args: "0x32e555f3ff8e135cece1351a6a2971518392c1e30375c1e006ad0ce8eac07947"
};

export function normalizeBattlecodeRegistration(input: unknown): BattlecodeRegistrationInput {
  const record = isRecord(input) ? input : {};
  const playerId = cleanId(record.playerId, "arthur");
  const botPackage = cleanPackage(record.botPackage ?? record.bot, "fiberchamp");
  return {
    playerId,
    submissionId: cleanId(record.submissionId, ""),
    botPackage,
    botScriptHash: cleanHash(record.botScriptHash),
    clientHash: cleanHash(record.clientHash),
    xudtAsset: cleanAsset(record.xudtAsset ?? record.asset, "xUDT:BCODE"),
    entryAmount: cleanAmount(record.entryAmount ?? record.amount, "100"),
    prizeAmount: cleanAmount(record.prizeAmount ?? record.prize, "200"),
    map: cleanId(record.map, "DefaultSmall")
  };
}

export async function buildBattlecodeFairnessManifest(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  input?: { botPackage?: string; botScriptHash?: string; submissionId?: string }
): Promise<BattlecodeFairnessManifest> {
  const engine = await resolveBattlecodeEngine(repoRoot, env);
  const runnerHash = await hashFile(fileURLToPath(import.meta.url));
  const engineHash = await hashFile(engine.engineJar);
  const botPackage = input?.botPackage ?? "fiberchamp";
  const botScriptHash = input?.botScriptHash ?? battlecodeBuiltInBotScriptHash();
  const opponentScriptHash = battlecodeBuiltInOpponentScriptHash();
  const clientHash = hashJson({
    domain: "fiber-paid-http-battlecode-client-v1",
    botPackage,
    submissionId: input?.submissionId,
    botScriptHash,
    opponentPackage: BATTLECODE_OPPONENT_PACKAGE,
    opponentScriptHash,
    runnerHash,
    engineHash,
    engineVersion: engine.version
  });
  return {
    domain: "fiber-paid-http-battlecode-fairness-v1",
    botPackage,
    submissionId: input?.submissionId,
    botScriptHash,
    opponentPackage: BATTLECODE_OPPONENT_PACKAGE,
    opponentScriptHash,
    clientHash,
    runnerHash,
    engineHash,
    engineVersion: engine.version,
    hashAlgorithm: "sha256",
    notes: [
      "botScriptHash commits to the exact submitted Battlecode RobotPlayer.java source used for this lane.",
      "opponentScriptHash commits to the exact arena opponent source used for this match.",
      "clientHash commits to both bots, the tournament runner module, and the Battlecode engine jar hash."
    ]
  };
}

export function battlecodeBuiltInBotScriptHash(): string {
  return hashBytes(Buffer.from(FIBER_CHAMP_SOURCE, "utf8"));
}

export function battlecodeBuiltInBotSource(): string {
  return FIBER_CHAMP_SOURCE;
}

export function battlecodeBuiltInOpponentScriptHash(): string {
  return hashBytes(Buffer.from(ARENA_BASELINE_SOURCE, "utf8"));
}

export function battlecodeBuiltInOpponentSource(): string {
  return ARENA_BASELINE_SOURCE;
}

export function normalizeBattlecodeSubmission(input: unknown): BattlecodeSubmissionInput {
  const record = isRecord(input) ? input : {};
  const playerId = cleanId(record.playerId, "arthur");
  const botPackage = cleanPackage(record.botPackage ?? record.bot, "fiberchamp");
  const source = String(record.source ?? record.botSource ?? "");
  validateBattlecodeBotSource(source, botPackage);
  return { playerId, botPackage, source };
}

export async function createBattlecodeSubmission(
  repoRoot: string,
  input: BattlecodeSubmissionInput,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ submission: BattlecodeSubmission; fairnessManifest: BattlecodeFairnessManifest; ledger: BattlecodeLedger }> {
  validateBattlecodeBotSource(input.source, input.botPackage);
  const botScriptHash = hashBytes(Buffer.from(input.source, "utf8"));
  const submissionId = `bc_sub_${randomBytes(8).toString("hex")}`;
  const sourceDir = resolve(repoRoot, ".tmp/battlecode-tournament/submissions", submissionId, input.botPackage);
  const sourcePath = resolve(sourceDir, "RobotPlayer.java");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(sourcePath, input.source);
  const submission: BattlecodeSubmission = {
    submissionId,
    playerId: input.playerId,
    botPackage: input.botPackage,
    botScriptHash,
    sourcePath,
    sourceBytes: Buffer.byteLength(input.source, "utf8"),
    status: "locked",
    submittedAt: new Date().toISOString(),
    policy: {
      language: "java",
      entrypoint: "RobotPlayer.java",
      packageRequired: input.botPackage,
      maxSourceBytes: BATTLECODE_MAX_SOURCE_BYTES,
      disallowedPatterns: DISALLOWED_BOT_PATTERNS
    }
  };
  const fairnessManifest = await buildBattlecodeFairnessManifest(repoRoot, env, submission);
  const ledger = await appendBattlecodeSubmission(repoRoot, submission, env);
  return { submission, fairnessManifest, ledger };
}

export function assertBattlecodeFairnessCommitment(
  registration: BattlecodeRegistrationInput,
  manifest: BattlecodeFairnessManifest,
  submission?: BattlecodeSubmission
): void {
  const mismatches = [];
  if (submission && registration.submissionId !== submission.submissionId) {
    mismatches.push(`submissionId expected ${submission.submissionId} got ${registration.submissionId}`);
  }
  if (submission && registration.botScriptHash !== submission.botScriptHash) {
    mismatches.push(`botScriptHash expected locked submission ${submission.botScriptHash} got ${registration.botScriptHash}`);
  }
  if (registration.botPackage !== manifest.botPackage) {
    mismatches.push(`botPackage expected ${manifest.botPackage} got ${registration.botPackage}`);
  }
  if (registration.botScriptHash !== manifest.botScriptHash) {
    mismatches.push(`botScriptHash expected ${manifest.botScriptHash} got ${registration.botScriptHash}`);
  }
  if (registration.clientHash !== manifest.clientHash) {
    mismatches.push(`clientHash expected ${manifest.clientHash} got ${registration.clientHash}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`fairness commitment mismatch: ${mismatches.join("; ")}`);
  }
}

export function battlecodeEntryPrice(input: BattlecodeRegistrationInput): { value: string; currency: string; display: string } {
  return {
    value: input.entryAmount,
    currency: input.xudtAsset,
    display: `${input.entryAmount} ${input.xudtAsset}`
  };
}

export async function readBattlecodeLedger(repoRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<BattlecodeLedger> {
  return withBattlecodeLedgerDb(repoRoot, env, async (db) => readBattlecodeLedgerFromDb(db));
}

export async function battlecodeLedgerHealth(repoRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<{
  path: string;
  schemaVersion: number;
  journalMode: string | null;
  foreignKeys: boolean;
  integrityCheck: string;
  counts: {
    submissions: number;
    tickets: number;
    matches: number;
    awards: number;
  };
}> {
  return withBattlecodeLedgerDb(repoRoot, env, async (db, path) => {
    const ledger = readBattlecodeLedgerFromDb(db);
    const journalRow = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    const foreignKeysRow = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
    const integrityRow = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    return {
      path,
      schemaVersion: battlecodeLedgerUserVersion(db),
      journalMode: journalRow?.journal_mode ?? null,
      foreignKeys: foreignKeysRow?.foreign_keys === 1,
      integrityCheck: integrityRow?.integrity_check ?? "unknown",
      counts: {
        submissions: ledger.submissions.length,
        tickets: ledger.tickets.length,
        matches: ledger.matches.length,
        awards: ledger.awards.length
      }
    };
  });
}

export async function writeBattlecodeLedger(repoRoot: string, ledger: BattlecodeLedger, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await withBattlecodeLedgerDb(repoRoot, env, async (db) => {
    writeBattlecodeLedgerToDb(db, ledger);
  });
}

export function battlecodeLedgerPath(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(repoRoot, env.BATTLECODE_LEDGER_PATH ?? env.BATTLECODE_TOURNAMENT_LEDGER_PATH ?? ".tmp/battlecode-tournament-ledger.sqlite");
}

async function withBattlecodeLedgerDb<T>(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  fn: (db: SqliteDatabase, path: string) => T | Promise<T>
): Promise<T> {
  const path = battlecodeLedgerPath(repoRoot, env);
  await mkdir(dirname(path), { recursive: true });
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(path) as SqliteDatabase;
  try {
    initializeBattlecodeLedgerSchema(db);
    return await fn(db, path);
  } finally {
    db.close?.();
  }
}

function initializeBattlecodeLedgerSchema(db: SqliteDatabase): void {
  const currentVersion = battlecodeLedgerUserVersion(db);
  if (currentVersion !== 0 && currentVersion !== BATTLECODE_LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `unsupported Battlecode ledger schema ${currentVersion}; create a new schema ${BATTLECODE_LEDGER_SCHEMA_VERSION} database`
    );
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS battlecode_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS battlecode_submissions (
      submission_id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      bot_package TEXT NOT NULL,
      bot_script_hash TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_bytes INTEGER NOT NULL,
      submitted_at TEXT NOT NULL,
      submission_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS battlecode_tickets (
      ticket_id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      receipt_reference TEXT NOT NULL,
      challenge_id TEXT NOT NULL,
      payment_hash TEXT,
      issued_at TEXT NOT NULL,
      ticket_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS battlecode_matches (
      match_id TEXT PRIMARY KEY,
      winner TEXT NOT NULL,
      match_hash TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      match_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS battlecode_awards (
      award_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      match_id TEXT NOT NULL,
      settlement TEXT NOT NULL,
      status TEXT NOT NULL,
      awarded_at TEXT NOT NULL,
      award_json TEXT NOT NULL
    );
    PRAGMA user_version = ${BATTLECODE_LEDGER_SCHEMA_VERSION};
  `);
  db.prepare("INSERT OR REPLACE INTO battlecode_meta (key, value) VALUES (?, ?)").run(
    "schema_version",
    String(BATTLECODE_LEDGER_SCHEMA_VERSION)
  );
}

function readBattlecodeLedgerFromDb(db: SqliteDatabase): BattlecodeLedger {
  const generatedAtRow = db.prepare("SELECT value FROM battlecode_meta WHERE key = ?").get("generated_at") as
    | { value?: string }
    | undefined;
  const submissions = db
    .prepare("SELECT submission_json FROM battlecode_submissions ORDER BY submitted_at, submission_id")
    .all() as Array<{ submission_json: string }>;
  const tickets = db
    .prepare("SELECT ticket_json FROM battlecode_tickets ORDER BY issued_at, ticket_id")
    .all() as Array<{ ticket_json: string }>;
  const matches = db
    .prepare("SELECT match_json FROM battlecode_matches ORDER BY finished_at, match_id")
    .all() as Array<{ match_json: string }>;
  const awards = db
    .prepare("SELECT award_json FROM battlecode_awards ORDER BY awarded_at, award_id")
    .all() as Array<{ award_json: string }>;
  return normalizeLedger({
    generatedAt: generatedAtRow?.value ?? new Date().toISOString(),
    submissions: submissions.map((row) => JSON.parse(row.submission_json)),
    tickets: tickets.map((row) => JSON.parse(row.ticket_json)),
    matches: matches.map((row) => JSON.parse(row.match_json)),
    awards: awards.map((row) => JSON.parse(row.award_json))
  });
}

function writeBattlecodeLedgerToDb(db: SqliteDatabase, ledger: BattlecodeLedger): void {
  const normalized = normalizeLedger(ledger);
  const generatedAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DELETE FROM battlecode_awards;
      DELETE FROM battlecode_matches;
      DELETE FROM battlecode_tickets;
      DELETE FROM battlecode_submissions;
    `);
    const insertSubmission = db.prepare(`
      INSERT OR REPLACE INTO battlecode_submissions
        (submission_id, player_id, bot_package, bot_script_hash, source_path, source_bytes, submitted_at, submission_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTicket = db.prepare(`
      INSERT OR REPLACE INTO battlecode_tickets
        (ticket_id, submission_id, player_id, receipt_reference, challenge_id, payment_hash, issued_at, ticket_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMatch = db.prepare(`
      INSERT OR REPLACE INTO battlecode_matches
        (match_id, winner, match_hash, finished_at, match_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertAward = db.prepare(`
      INSERT OR REPLACE INTO battlecode_awards
        (award_id, ticket_id, match_id, settlement, status, awarded_at, award_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const submission of normalized.submissions) {
      insertSubmission.run(
        submission.submissionId,
        submission.playerId,
        submission.botPackage,
        submission.botScriptHash,
        submission.sourcePath,
        submission.sourceBytes,
        submission.submittedAt,
        JSON.stringify(submission)
      );
    }
    for (const ticket of normalized.tickets) {
      insertTicket.run(
        ticket.ticketId,
        ticket.submissionId,
        ticket.playerId,
        ticket.receiptReference,
        ticket.challengeId,
        ticket.paymentHash ?? null,
        ticket.issuedAt,
        JSON.stringify(ticket)
      );
    }
    for (const match of normalized.matches) {
      insertMatch.run(
        match.matchId,
        match.winner,
        match.matchHash,
        match.finishedAt,
        JSON.stringify(match)
      );
    }
    for (const award of normalized.awards) {
      insertAward.run(
        award.awardId,
        award.ticketId,
        award.matchId,
        award.settlement,
        award.status,
        award.awardedAt,
        JSON.stringify(award)
      );
    }
    db.prepare("INSERT OR REPLACE INTO battlecode_meta (key, value) VALUES (?, ?)").run("generated_at", generatedAt);
    db.prepare("INSERT OR REPLACE INTO battlecode_meta (key, value) VALUES (?, ?)").run(
      "schema_version",
      String(BATTLECODE_LEDGER_SCHEMA_VERSION)
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function battlecodeLedgerUserVersion(db: SqliteDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function battlecodeLedgerIsEmpty(ledger: BattlecodeLedger): boolean {
  return ledger.submissions.length === 0 &&
    ledger.tickets.length === 0 &&
    ledger.matches.length === 0 &&
    ledger.awards.length === 0;
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

function loadNodeSqlite(): { DatabaseSync: new (path: string) => unknown } {
  const loader = createRequire(import.meta.url);
  return loader("node:sqlite") as { DatabaseSync: new (path: string) => unknown };
}

export async function appendBattlecodeSubmission(
  repoRoot: string,
  submission: BattlecodeSubmission,
  env: NodeJS.ProcessEnv = process.env
): Promise<BattlecodeLedger> {
  const ledger = await readBattlecodeLedger(repoRoot, env);
  ledger.submissions = [...ledger.submissions.filter((item) => item.submissionId !== submission.submissionId), submission];
  await writeBattlecodeLedger(repoRoot, ledger, env);
  return ledger;
}

export async function findBattlecodeSubmission(
  repoRoot: string,
  submissionId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<BattlecodeSubmission> {
  const ledger = await readBattlecodeLedger(repoRoot, env);
  const submission = ledger.submissions.find((item) => item.submissionId === submissionId);
  if (!submission) {
    throw new Error(`Battlecode submission not found: ${submissionId || "missing"}`);
  }
  return submission;
}

export function issueBattlecodeTicket(input: {
  registration: BattlecodeRegistrationInput;
  submission: BattlecodeSubmission;
  fairnessManifest: BattlecodeFairnessManifest;
  receiptReference: string;
  challengeId: string;
  paymentHash?: string;
}): BattlecodeTicket {
  assertBattlecodeFairnessCommitment(input.registration, input.fairnessManifest, input.submission);
  return {
    ticketId: `bc_ticket_${randomBytes(8).toString("hex")}`,
    playerId: input.registration.playerId,
    submissionId: input.submission.submissionId,
    botPackage: input.registration.botPackage,
    botScriptHash: input.registration.botScriptHash,
    clientHash: input.registration.clientHash,
    fairnessCommitment: input.fairnessManifest,
    xudtAsset: input.registration.xudtAsset,
    entryAmount: input.registration.entryAmount,
    prizeAmount: input.registration.prizeAmount,
    map: input.registration.map,
    receiptReference: input.receiptReference,
    challengeId: input.challengeId,
    paymentHash: input.paymentHash,
    issuedAt: new Date().toISOString(),
    status: "paid"
  };
}

export async function appendBattlecodeTicket(
  repoRoot: string,
  ticket: BattlecodeTicket,
  env: NodeJS.ProcessEnv = process.env
): Promise<BattlecodeLedger> {
  const ledger = await readBattlecodeLedger(repoRoot, env);
  ledger.tickets = [...ledger.tickets.filter((item) => item.ticketId !== ticket.ticketId), ticket];
  await writeBattlecodeLedger(repoRoot, ledger, env);
  return ledger;
}

export async function runBattlecodeTournament(options: RunOptions): Promise<BattlecodeTournamentReport> {
  const startedAt = new Date().toISOString();
  const env = options.env ?? process.env;
  const engine = await resolveBattlecodeEngine(options.repoRoot, env);
  const fairnessManifest = await buildBattlecodeFairnessManifest(options.repoRoot, env, options.submission);
  assertBattlecodeFairnessCommitment(options.registration, fairnessManifest, options.submission);
  await assertSubmissionLocked(options.submission, options.ticket);
  assertTicketFairnessCommitment(options.ticket, fairnessManifest, options.submission);
  const runStamp = `${options.ticket.ticketId}-${Date.now()}`;
  const workDir = resolve(options.repoRoot, ".tmp/battlecode-tournament/runs", runStamp);
  const classesDir = resolve(workDir, "classes");
  const srcDir = resolve(workDir, "src");
  const replayDir = resolve(options.repoRoot, ".tmp/battlecode-tournament/matches");
  const replayPath = resolve(replayDir, `${runStamp}.bc25`);
  await mkdir(srcDir, { recursive: true });
  await mkdir(classesDir, { recursive: true });
  await mkdir(replayDir, { recursive: true });
  await writeBotSources(srcDir, options.submission);
  const observedBotScriptHash = await hashFile(resolve(srcDir, `${options.submission.botPackage}/RobotPlayer.java`));
  const observedOpponentScriptHash = await hashFile(resolve(srcDir, `${BATTLECODE_OPPONENT_PACKAGE}/RobotPlayer.java`));
  if (observedBotScriptHash !== options.ticket.botScriptHash) {
    throw new Error(`materialized bot script hash mismatch: expected ${options.ticket.botScriptHash} got ${observedBotScriptHash}`);
  }
  if (observedOpponentScriptHash !== options.ticket.fairnessCommitment.opponentScriptHash) {
    throw new Error(`materialized opponent script hash mismatch: expected ${options.ticket.fairnessCommitment.opponentScriptHash} got ${observedOpponentScriptHash}`);
  }

  const timeoutMs = positiveInt(env.BATTLECODE_MATCH_TIMEOUT_MS, 120_000);
  const sandboxMode = resolveSandboxMode(env);
  const sandboxMemoryBytes = positiveInt(env.BATTLECODE_SANDBOX_MEMORY_BYTES, 8_589_934_592);
  const sandboxCpuSeconds = positiveInt(env.BATTLECODE_SANDBOX_CPU_SECONDS, Math.ceil(timeoutMs / 1000) + 5);
  const javaFiles = await listFiles(srcDir, ".java");
  await runProcess(resolve(engine.jdkHome, "bin/javac"), [
    "-J-Xmx512m",
    "-J-XX:MaxMetaspaceSize=256m",
    "-J-XX:CompressedClassSpaceSize=128m",
    "-cp",
    engine.engineJar,
    "-d",
    classesDir,
    ...javaFiles
  ], {
    cwd: workDir,
    timeoutMs: 30_000,
    sandboxHome: resolve(workDir, "home"),
    jdkHome: engine.jdkHome,
    sandboxMode,
    cpuSeconds: Math.min(sandboxCpuSeconds, 35),
    addressSpaceBytes: sandboxMemoryBytes
  });

  const matchId = `bc_match_${randomBytes(8).toString("hex")}`;
  const javaArgs = [
    "-Xmx512m",
    "-XX:MaxMetaspaceSize=256m",
    "-XX:CompressedClassSpaceSize=128m",
    "--add-opens=java.base/jdk.internal.misc=ALL-UNNAMED",
    "--add-opens=java.base/jdk.internal.math=ALL-UNNAMED",
    "--add-opens=java.base/jdk.internal.util=ALL-UNNAMED",
    "--add-opens=java.base/jdk.internal.access=ALL-UNNAMED",
    "--add-opens=java.base/sun.security.action=ALL-UNNAMED",
    "-Dbc.server.wait-for-client=false",
    "-Dbc.server.mode=headless",
    "-Dbc.server.map-path=maps",
    "-Dbc.server.robot-player-to-system-out=false",
    "-Dbc.server.debug=false",
    "-Dbc.engine.debug-methods=false",
    "-Dbc.engine.enable-profiler=false",
    "-Dbc.engine.show-indicators=false",
    `-Dbc.game.team-a=${options.submission.botPackage}`,
    `-Dbc.game.team-b=${BATTLECODE_OPPONENT_PACKAGE}`,
    `-Dbc.game.team-a.url=${classesDir}`,
    `-Dbc.game.team-b.url=${classesDir}`,
    `-Dbc.game.team-a.package=${options.submission.botPackage}`,
    `-Dbc.game.team-b.package=${BATTLECODE_OPPONENT_PACKAGE}`,
    `-Dbc.game.maps=${options.registration.map}`,
    "-Dbc.server.validate-maps=true",
    "-Dbc.server.alternate-order=false",
    `-Dbc.server.save-file=${replayPath}`,
    "-cp",
    `${engine.engineJar}:${classesDir}`,
    "battlecode.server.Main",
    "-c=-"
  ];
  const sandbox: BattlecodeSandboxEvidence = {
    mode: sandboxMode,
    runDir: workDir,
    sourceDir: srcDir,
    classesDir,
    replayDir,
    timeoutMs,
    jdkHome: engine.jdkHome,
    engineJar: engine.engineJar,
    environmentKeys: ["HOME", "JAVA_HOME", "LANG", "PATH", "TMPDIR"],
    limits: {
      network: sandboxMode === "bubblewrap-prlimit" ? "unshared" : "not-granted",
      filesystem: sandboxMode === "bubblewrap-prlimit" ? "bubblewrap-ro-root-run-dir-rw" : "run-dir-only-by-convention",
      processTimeoutMs: timeoutMs,
      cpuSeconds: sandboxCpuSeconds,
      addressSpaceBytes: sandboxMemoryBytes
    }
  };
  const run = await runProcess(resolve(engine.jdkHome, "bin/java"), javaArgs, {
    cwd: workDir,
    timeoutMs,
    sandboxHome: resolve(workDir, "home"),
    jdkHome: engine.jdkHome,
    sandboxMode,
    cpuSeconds: sandboxCpuSeconds,
    addressSpaceBytes: sandboxMemoryBytes
  });
  const parsed = parseMatchOutput(run.stdout);
  const replayHashInput = existsSync(replayPath) ? await readFile(replayPath) : Buffer.alloc(0);
  const fairness: BattlecodeFairnessVerification = {
    status: "verified",
    committed: {
      botScriptHash: options.ticket.botScriptHash,
      opponentScriptHash: options.ticket.fairnessCommitment.opponentScriptHash,
      clientHash: options.ticket.clientHash
    },
    observed: {
      botScriptHash: observedBotScriptHash,
      opponentScriptHash: observedOpponentScriptHash,
      clientHash: fairnessManifest.clientHash,
      runnerHash: fairnessManifest.runnerHash,
      engineHash: fairnessManifest.engineHash
    },
    verifiedAt: new Date().toISOString()
  };
  const matchHash = createHash("sha256")
    .update(stableJson(fairness))
    .update(run.stdout)
    .update(run.stderr)
    .update(replayHashInput)
    .digest("hex");
  const match: BattlecodeMatchResult = {
    matchId,
    map: options.registration.map,
    teamA: options.submission.botPackage,
    teamB: BATTLECODE_OPPONENT_PACKAGE,
    winner: parsed.winner,
    winnerSide: parsed.side,
    round: parsed.round,
    reason: parsed.reason,
    replayPath,
    matchHash,
    stdout: run.stdout,
    stderr: run.stderr,
    engineVersion: engine.version,
    engineJar: engine.engineJar,
    engineHash: fairnessManifest.engineHash,
    runnerHash: fairnessManifest.runnerHash,
    fairness,
    sandbox,
    jdkHome: engine.jdkHome,
    startedAt,
    finishedAt: new Date().toISOString()
  };
  const award = match.winner === options.ticket.botPackage
    ? await createBattlecodeAward(options.ticket, match, env)
    : null;
  const ledger = await readBattlecodeLedger(options.repoRoot, env);
  ledger.matches = [...ledger.matches.filter((item) => item.matchId !== match.matchId), match];
  if (award) {
    ledger.awards = [...ledger.awards.filter((item) => item.awardId !== award.awardId), award];
  }
  await writeBattlecodeLedger(options.repoRoot, ledger, env);
  return {
    generatedAt: new Date().toISOString(),
    registration: options.registration,
    submission: options.submission,
    ticket: options.ticket,
    match,
    award,
    ledgerPath: battlecodeLedgerPath(options.repoRoot, env),
    replayPath,
    warnings: [
      "Battlecode runs as an external AGPL-3.0 scaffold/engine dependency; Fiber Paid HTTP stores only tournament evidence and local bot sources.",
      award?.settlement === "fiber-xudt-payment"
        ? "The prize was settled by a live Fiber xUDT payment and recorded with payment hash evidence."
        : "The xUDT award is recorded as a local claimable prize ledger entry; set BATTLECODE_AWARD_SETTLEMENT=fiber-xudt for live Fiber xUDT prize payout."
    ]
  };
}

export async function battlecodeStatus(repoRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const ledger = await readBattlecodeLedger(repoRoot, env);
  const latestMatch = ledger.matches.at(-1);
  const ledgerHealth = await battlecodeLedgerHealth(repoRoot, env).catch((error: unknown) => ({ error: errorMessage(error) }));
  const engine = await resolveBattlecodeEngine(repoRoot, env).catch((error: unknown) => ({ error: errorMessage(error) }));
  const fairnessManifest = await buildBattlecodeFairnessManifest(repoRoot, env).catch((error: unknown) => ({ error: errorMessage(error) }));
  return {
    enabled: true,
    scaffoldDir: env.BATTLECODE_DIR ?? DEFAULT_BATTLECODE_DIR,
    ledgerPath: battlecodeLedgerPath(repoRoot, env),
    ledgerStorage: "sqlite",
    ledgerHealth,
    engine,
    fairnessManifest,
    awardSettlement: battlecodeAwardSettlementPlan(env),
    tickets: ledger.tickets.length,
    submissions: ledger.submissions.length,
    matches: ledger.matches.length,
    awards: ledger.awards.length,
    latestReplay: latestMatch ? {
      matchId: latestMatch.matchId,
      filename: basename(latestMatch.replayPath),
      engineVersion: latestMatch.engineVersion
    } : null,
    latestAward: ledger.awards.at(-1) ?? null
  };
}

export function battlecodeAwardSettlementPlan(env: NodeJS.ProcessEnv = process.env): {
  mode: "local-ledger" | "fiber-xudt";
  live: boolean;
  blockers: string[];
  udtTypeScript?: FiberUdtTypeScript;
  udtTypeScriptSource?: string;
} {
  const mode = env.BATTLECODE_AWARD_SETTLEMENT === "fiber-xudt" ? "fiber-xudt" : "local-ledger";
  if (mode === "local-ledger") {
    return { mode, live: false, blockers: [] };
  }
  const blockers: string[] = [];
  try {
    parseFiberMode(env.FIBER_MODE);
  } catch {
    blockers.push("FIBER_MODE must be local or testnet for Battlecode Fiber xUDT prize payout");
  }
  const payerRpcUrl = prizePayerRpcUrl(env);
  const payeeRpcUrl = prizePayeeRpcUrl(env);
  if (!payerRpcUrl) {
    blockers.push("BATTLECODE_PRIZE_PAYER_RPC_URL or FIBER_PAYEE_RPC_URL is required for prize payout");
  }
  if (!payeeRpcUrl) {
    blockers.push("BATTLECODE_PRIZE_PAYEE_RPC_URL or FIBER_PAYER_RPC_URL is required for prize payout");
  }
  let udtTypeScript: FiberUdtTypeScript | undefined;
  let udtTypeScriptSource: string | undefined;
  try {
    const resolved = resolveBattlecodeUdtTypeScript(env);
    udtTypeScript = resolved.udtTypeScript;
    udtTypeScriptSource = resolved.source;
  } catch (error) {
    blockers.push(errorMessage(error));
  }
  return {
    mode,
    live: blockers.length === 0,
    blockers,
    udtTypeScript,
    udtTypeScriptSource
  };
}

export function battlecodeXudtTypeScript(env: NodeJS.ProcessEnv = process.env): FiberUdtTypeScript {
  return resolveBattlecodeUdtTypeScript(env).udtTypeScript;
}

async function createBattlecodeAward(ticket: BattlecodeTicket, match: BattlecodeMatchResult, env: NodeJS.ProcessEnv): Promise<BattlecodeAward> {
  const plan = battlecodeAwardSettlementPlan(env);
  if (plan.mode === "fiber-xudt") {
    if (plan.blockers.length > 0) {
      throw new Error(`Battlecode Fiber xUDT prize payout is not ready: ${plan.blockers.join("; ")}`);
    }
    const prizePayment = await settleBattlecodeFiberXudtPrize(ticket, match, env, plan.udtTypeScript!);
    return {
      awardId: `bc_award_${randomBytes(8).toString("hex")}`,
      ticketId: ticket.ticketId,
      matchId: match.matchId,
      playerId: ticket.playerId,
      botPackage: ticket.botPackage,
      xudtAsset: ticket.xudtAsset,
      prizeAmount: ticket.prizeAmount,
      status: "paid",
      settlement: "fiber-xudt-payment",
      prizePayment,
      matchHash: match.matchHash,
      awardedAt: new Date().toISOString(),
      note: "Prize settled by a live Fiber xUDT payment after a paid Fiber Paid HTTP entry and deterministic local Battlecode match."
    };
  }
  return {
    awardId: `bc_award_${randomBytes(8).toString("hex")}`,
    ticketId: ticket.ticketId,
    matchId: match.matchId,
    playerId: ticket.playerId,
    botPackage: ticket.botPackage,
    xudtAsset: ticket.xudtAsset,
    prizeAmount: ticket.prizeAmount,
    status: "claimable",
    settlement: "local-xudt-award-ledger",
    matchHash: match.matchHash,
    awardedAt: new Date().toISOString(),
    note: "Prize claim recorded after a paid Fiber Paid HTTP entry and deterministic local Battlecode match. On-chain xUDT payout signer is a separate integration step."
  };
}

async function settleBattlecodeFiberXudtPrize(
  ticket: BattlecodeTicket,
  match: BattlecodeMatchResult,
  env: NodeJS.ProcessEnv,
  udtTypeScript: FiberUdtTypeScript
): Promise<BattlecodePrizePayment> {
  const mode = parseFiberMode(env.FIBER_MODE);
  const payerRpcUrl = prizePayerRpcUrl(env)!;
  const payeeRpcUrl = prizePayeeRpcUrl(env)!;
  const timeoutSeconds = positiveInt(env.BATTLECODE_PRIZE_TIMEOUT_SECONDS, 30);
  const timeoutMs = positiveInt(env.BATTLECODE_PRIZE_TIMEOUT_MS ?? env.FIBER_SETTLEMENT_TIMEOUT_MS, timeoutSeconds * 1000);
  const pollMs = positiveInt(env.FIBER_SETTLEMENT_POLL_MS, 250);
  const payerRpc = new FiberRpcClient({
    url: payerRpcUrl,
    auth: env.BATTLECODE_PRIZE_PAYER_RPC_AUTH ?? env.FIBER_PRIZE_PAYER_RPC_AUTH ?? env.FIBER_PAYEE_RPC_AUTH ?? env.FIBER_RPC_AUTH,
    label: "battlecode-prize-payer"
  });
  const payeeRpc = new FiberRpcClient({
    url: payeeRpcUrl,
    auth: env.BATTLECODE_PRIZE_PAYEE_RPC_AUTH ?? env.FIBER_PRIZE_PAYEE_RPC_AUTH ?? env.FIBER_PAYER_RPC_AUTH ?? env.FIBER_RPC_AUTH,
    label: "battlecode-prize-payee"
  });
  const [payerInfo, payeeInfo] = await Promise.all([
    payerRpc.nodeInfo().catch(() => null),
    payeeRpc.nodeInfo().catch(() => null)
  ]);
  const invoice = await payeeRpc.newInvoice({
    amount: ticket.prizeAmount,
    currency: env.FIBER_CURRENCY ?? (mode === "testnet" ? "Fibt" : "Fibd"),
    description: `Fiber Paid HTTP Battlecode prize ${ticket.ticketId} ${match.matchId}`,
    expirySeconds: timeoutSeconds,
    udtTypeScript
  });
  const paymentHash = extractInvoicePaymentHash(invoice);
  const invoiceAddress = invoice.invoice_address;
  if (!invoiceAddress) {
    throw new Error("Fiber prize invoice did not return invoice_address");
  }
  const sendResult = await payerRpc.sendPayment({
    invoice: invoiceAddress,
    timeoutSeconds
  });
  const settledPayment = await waitForFiberPaymentSuccess(payerRpc, sendResult.payment_hash ?? paymentHash, {
    timeoutMs,
    pollMs
  });
  const paidInvoice = await waitForFiberInvoicePaid(payeeRpc, paymentHash, {
    timeoutMs,
    pollMs
  });
  return {
    provider: "fiber-xudt",
    mode,
    paymentHash,
    invoice: invoiceAddress,
    amountShannons: ticket.prizeAmount,
    xudtAsset: ticket.xudtAsset,
    udtTypeScript,
    payerRpcUrl,
    payeeRpcUrl,
    payerNode: extractFiberPubkey(payerInfo),
    payeeNode: extractFiberPubkey(payeeInfo),
    status: "settled",
    observedAt: new Date().toISOString(),
    sendResult,
    settledPayment,
    paidInvoice
  };
}

function resolveBattlecodeUdtTypeScript(env: NodeJS.ProcessEnv): { udtTypeScript: FiberUdtTypeScript; source: string } {
  const explicit = parseFiberUdtTypeScript(
    env.BATTLECODE_XUDT_TYPE_SCRIPT ?? env.FIBER_XUDT_TYPE_SCRIPT ?? env.FIBER_UDT_TYPE_SCRIPT,
    {
      codeHash: env.BATTLECODE_XUDT_CODE_HASH ?? env.FIBER_XUDT_CODE_HASH ?? env.FIBER_UDT_CODE_HASH,
      hashType: env.BATTLECODE_XUDT_HASH_TYPE ?? env.FIBER_XUDT_HASH_TYPE ?? env.FIBER_UDT_HASH_TYPE,
      args: env.BATTLECODE_XUDT_ARGS ?? env.FIBER_XUDT_ARGS ?? env.FIBER_UDT_ARGS
    }
  );
  if (explicit) {
    return { udtTypeScript: explicit, source: "env" };
  }
  if (env.FIBER_MODE === "local") {
    return { udtTypeScript: DEFAULT_LOCAL_XUDT_TYPE_SCRIPT, source: "fiber-local-default-xudt" };
  }
  throw new Error("BATTLECODE_XUDT_TYPE_SCRIPT or FIBER_XUDT_TYPE_SCRIPT is required for non-local xUDT payout");
}

function prizePayerRpcUrl(env: NodeJS.ProcessEnv): string | undefined {
  return env.BATTLECODE_PRIZE_PAYER_RPC_URL ?? env.FIBER_PRIZE_PAYER_RPC_URL ?? env.FIBER_PAYEE_RPC_URL ?? env.FIBER_RPC_URL;
}

function prizePayeeRpcUrl(env: NodeJS.ProcessEnv): string | undefined {
  return env.BATTLECODE_PRIZE_PAYEE_RPC_URL ?? env.FIBER_PRIZE_PAYEE_RPC_URL ?? env.FIBER_PAYER_RPC_URL;
}

function extractFiberPubkey(input: unknown): string | undefined {
  return isRecord(input) && typeof input.pubkey === "string" ? input.pubkey : undefined;
}

async function assertSubmissionLocked(submission: BattlecodeSubmission, ticket: BattlecodeTicket): Promise<void> {
  if (submission.status !== "locked") {
    throw new Error(`Battlecode submission is not locked: ${submission.submissionId}`);
  }
  if (ticket.submissionId !== submission.submissionId) {
    throw new Error(`ticket submissionId expected ${submission.submissionId} got ${ticket.submissionId}`);
  }
  const sourceHash = await hashFile(submission.sourcePath);
  if (sourceHash !== submission.botScriptHash || sourceHash !== ticket.botScriptHash) {
    throw new Error(`locked submission source hash mismatch: source=${sourceHash} submission=${submission.botScriptHash} ticket=${ticket.botScriptHash}`);
  }
}

function assertTicketFairnessCommitment(ticket: BattlecodeTicket, manifest: BattlecodeFairnessManifest, submission: BattlecodeSubmission): void {
  const mismatches = [];
  if (ticket.submissionId !== submission.submissionId) {
    mismatches.push(`ticket submissionId expected ${submission.submissionId} got ${ticket.submissionId}`);
  }
  if (ticket.botScriptHash !== manifest.botScriptHash) {
    mismatches.push(`ticket botScriptHash expected ${manifest.botScriptHash} got ${ticket.botScriptHash}`);
  }
  if (ticket.clientHash !== manifest.clientHash) {
    mismatches.push(`ticket clientHash expected ${manifest.clientHash} got ${ticket.clientHash}`);
  }
  if (ticket.fairnessCommitment.botScriptHash !== manifest.botScriptHash) {
    mismatches.push("ticket fairnessCommitment botScriptHash changed after payment");
  }
  if (ticket.fairnessCommitment.opponentPackage !== manifest.opponentPackage) {
    mismatches.push("ticket fairnessCommitment opponentPackage changed after payment");
  }
  if (ticket.fairnessCommitment.opponentScriptHash !== manifest.opponentScriptHash) {
    mismatches.push("ticket fairnessCommitment opponentScriptHash changed after payment");
  }
  if (ticket.fairnessCommitment.clientHash !== manifest.clientHash) {
    mismatches.push("ticket fairnessCommitment clientHash changed after payment");
  }
  if (mismatches.length > 0) {
    throw new Error(`ticket fairness commitment mismatch: ${mismatches.join("; ")}`);
  }
}

async function resolveBattlecodeEngine(repoRoot: string, env: NodeJS.ProcessEnv): Promise<{
  jdkHome: string;
  engineJar: string;
  version: string;
}> {
  const jdkHome = env.BATTLECODE_JDK_HOME ?? DEFAULT_JDK_HOME;
  const javaBin = resolve(jdkHome, "bin/java");
  const javacBin = resolve(jdkHome, "bin/javac");
  if (!existsSync(javaBin) || !existsSync(javacBin)) {
    throw new Error(`Battlecode JDK 21 is missing; set BATTLECODE_JDK_HOME or install ${DEFAULT_JDK_HOME}`);
  }
  const explicitJar = env.BATTLECODE_ENGINE_JAR;
  if (explicitJar && existsSync(explicitJar)) {
    return { jdkHome, engineJar: explicitJar, version: env.BATTLECODE_ENGINE_VERSION ?? "custom" };
  }
  const toolchainJar = resolve(repoRoot, "../.toolchains/battlecode25/battlecode25-java-3.1.0.jar");
  if (existsSync(toolchainJar)) {
    return { jdkHome, engineJar: toolchainJar, version: "3.1.0" };
  }
  const cached = await findCachedBattlecodeJar(DEFAULT_ENGINE_VERSION);
  if (cached) {
    return { jdkHome, engineJar: cached, version: DEFAULT_ENGINE_VERSION };
  }
  throw new Error("Battlecode engine jar is missing; set BATTLECODE_ENGINE_JAR or download battlecode25-java-3.1.0.jar");
}

async function findCachedBattlecodeJar(version: string): Promise<string | null> {
  const root = `${process.env.HOME ?? "/home/arthur"}/.gradle/caches/modules-2/files-2.1/org.battlecode/battlecode25-java/${version}`;
  try {
    const files = await listFiles(root, ".jar");
    return files[0] ?? null;
  } catch {
    return null;
  }
}

async function writeBotSources(srcDir: string, submission: BattlecodeSubmission): Promise<void> {
  const bots = [
    { name: submission.botPackage, source: await readFile(submission.sourcePath, "utf8") },
    { name: BATTLECODE_OPPONENT_PACKAGE, source: ARENA_BASELINE_SOURCE }
  ];
  for (const bot of bots) {
    const dir = resolve(srcDir, bot.name);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, "RobotPlayer.java"), bot.source);
  }
}

async function listFiles(root: string, suffix: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir)) {
      const full = resolve(dir, entry);
      const info = await stat(full);
      if (info.isDirectory()) {
        await walk(full);
      } else if (entry.endsWith(suffix)) {
        result.push(full);
      }
    }
  }
  await walk(root);
  return result.sort();
}

async function runProcess(command: string, args: string[], options: {
  cwd: string;
  timeoutMs: number;
  sandboxHome?: string;
  jdkHome?: string;
  sandboxMode?: BattlecodeSandboxEvidence["mode"];
  cpuSeconds?: number;
  addressSpaceBytes?: number;
}): Promise<{ stdout: string; stderr: string }> {
  const sandboxHome = options.sandboxHome ?? resolve(options.cwd, "home");
  await mkdir(sandboxHome, { recursive: true });
  const env = {
    HOME: sandboxHome,
    JAVA_HOME: options.jdkHome ?? dirname(dirname(command)),
    LANG: "C.UTF-8",
    PATH: `${dirname(command)}:/usr/bin:/bin`,
    TMPDIR: options.cwd
  };
  const sandboxed = buildSandboxCommand(command, args, {
    ...options,
    sandboxHome,
    env
  });
  return new Promise((resolveProcess, reject) => {
    const child = spawn(sandboxed.command, sandboxed.args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveProcess({ stdout, stderr });
      } else {
        reject(new Error(`${sandboxed.command} exited with ${code}\n${stdout}\n${stderr}`));
      }
    });
  });
}

function resolveSandboxMode(env: NodeJS.ProcessEnv): BattlecodeSandboxEvidence["mode"] {
  if (env.BATTLECODE_SANDBOX_MODE === "bubblewrap-prlimit") {
    return existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/prlimit") ? "bubblewrap-prlimit" : "local-process";
  }
  if (env.BATTLECODE_SANDBOX_MODE === "local-process") {
    return "local-process";
  }
  if (existsSync("/usr/bin/prlimit")) {
    return "prlimit-local";
  }
  return "local-process";
}

function buildSandboxCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    sandboxHome: string;
    sandboxMode?: BattlecodeSandboxEvidence["mode"];
    cpuSeconds?: number;
    addressSpaceBytes?: number;
    env: Record<string, string>;
  }
): { command: string; args: string[] } {
  if (options.sandboxMode !== "bubblewrap-prlimit") {
    if (options.sandboxMode === "prlimit-local") {
      return {
        command: "/usr/bin/prlimit",
        args: [
          `--cpu=${options.cpuSeconds ?? 125}`,
          `--as=${options.addressSpaceBytes ?? 8_589_934_592}`,
          "--",
          command,
          ...args
        ]
      };
    }
    return { command, args };
  }
  const home = options.env.HOME ?? options.sandboxHome;
  const javaHome = options.env.JAVA_HOME ?? dirname(dirname(command));
  const lang = options.env.LANG ?? "C.UTF-8";
  const path = options.env.PATH ?? `${dirname(command)}:/usr/bin:/bin`;
  const tmpDir = options.env.TMPDIR ?? options.cwd;
  const prlimitArgs = [
    `--cpu=${options.cpuSeconds ?? 125}`,
    `--as=${options.addressSpaceBytes ?? 8_589_934_592}`,
    "--",
    command,
    ...args
  ];
  return {
    command: "/usr/bin/bwrap",
    args: [
      "--unshare-net",
      "--ro-bind", "/", "/",
      "--bind", options.cwd, options.cwd,
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      "--chdir", options.cwd,
      "--setenv", "HOME", home,
      "--setenv", "JAVA_HOME", javaHome,
      "--setenv", "LANG", lang,
      "--setenv", "PATH", path,
      "--setenv", "TMPDIR", tmpDir,
      "/usr/bin/prlimit",
      ...prlimitArgs
    ]
  };
}

function parseMatchOutput(stdout: string): { winner: string; side: "A" | "B"; round: number; reason: string } {
  const winnerLine = stdout.match(/\[server\]\s+([^\n(]+?)\s+\((A|B)\)\s+wins\s+\(round\s+(\d+)\)/);
  if (!winnerLine) {
    throw new Error(`Battlecode match did not report a winner:\n${stdout.slice(-2000)}`);
  }
  const reasonLine = stdout.match(/\[server\]\s+Reason:\s+([^\n]+)/);
  return {
    winner: winnerLine[1]!.trim(),
    side: winnerLine[2] as "A" | "B",
    round: Number(winnerLine[3]),
    reason: reasonLine?.[1]?.trim() ?? "not reported"
  };
}

function normalizeLedger(input: unknown): BattlecodeLedger {
  const record = isRecord(input) ? input : {};
  return {
    generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : new Date().toISOString(),
    submissions: Array.isArray(record.submissions) ? record.submissions.filter(isRecord) as BattlecodeSubmission[] : [],
    tickets: Array.isArray(record.tickets) ? record.tickets.filter(isRecord) as BattlecodeTicket[] : [],
    matches: Array.isArray(record.matches) ? record.matches.filter(isRecord) as BattlecodeMatchResult[] : [],
    awards: Array.isArray(record.awards) ? record.awards.filter(isRecord) as BattlecodeAward[] : []
  };
}

function emptyLedger(): BattlecodeLedger {
  return {
    generatedAt: new Date().toISOString(),
    submissions: [],
    tickets: [],
    matches: [],
    awards: []
  };
}

function cleanId(value: unknown, fallback: string): string {
  const text = String(value ?? fallback).trim();
  if (/^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(text)) {
    return text;
  }
  throw new Error(`invalid id: ${text}`);
}

function cleanPackage(value: unknown, fallback: string): string {
  const text = String(value ?? fallback).trim();
  if (
    /^[a-z][a-z0-9_]{0,31}$/i.test(text) &&
    !["baselinebot", BATTLECODE_OPPONENT_PACKAGE].includes(text.toLowerCase())
  ) {
    return text;
  }
  throw new Error(`invalid Battlecode Java package: ${text}`);
}

function validateBattlecodeBotSource(source: string, botPackage: string): void {
  const byteLength = Buffer.byteLength(source, "utf8");
  if (byteLength <= 0 || byteLength > BATTLECODE_MAX_SOURCE_BYTES) {
    throw new Error(`Battlecode bot source must be 1..${BATTLECODE_MAX_SOURCE_BYTES} bytes`);
  }
  if (source.includes("\0")) {
    throw new Error("Battlecode bot source must not contain NUL bytes");
  }
  const packagePattern = new RegExp(`\\bpackage\\s+${escapeRegExp(botPackage)}\\s*;`);
  if (!packagePattern.test(source)) {
    throw new Error(`Battlecode bot source must declare package ${botPackage};`);
  }
  if (!/\bclass\s+RobotPlayer\b/.test(source)) {
    throw new Error("Battlecode bot source must define class RobotPlayer");
  }
  const blocked = DISALLOWED_BOT_PATTERNS.find((pattern) => source.includes(pattern));
  if (blocked) {
    throw new Error(`Battlecode bot source uses disallowed API pattern: ${blocked}`);
  }
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanAsset(value: unknown, fallback: string): string {
  const text = String(value ?? fallback).trim();
  if (/^(xUDT:[A-Z0-9._:-]{2,64}|0x[a-f0-9]{64})$/i.test(text)) {
    return text;
  }
  throw new Error(`invalid xUDT asset identifier: ${text}`);
}

function cleanAmount(value: unknown, fallback: string): string {
  const text = String(value ?? fallback).trim();
  if (/^[1-9][0-9]{0,17}$/.test(text)) {
    return text;
  }
  throw new Error(`invalid positive integer amount: ${text}`);
}

function cleanHash(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (/^sha256:[a-f0-9]{64}$/.test(text)) {
    return text;
  }
  throw new Error(`invalid sha256 hash commitment: ${text || "missing"}`);
}

async function hashFile(path: string): Promise<string> {
  return hashBytes(await readFile(path));
}

function hashBytes(bytes: Buffer): string {
  return `${HASH_PREFIX}${createHash("sha256").update(bytes).digest("hex")}`;
}

function hashJson(input: unknown): string {
  return hashBytes(Buffer.from(stableJson(input), "utf8"));
}

function stableJson(input: unknown): string {
  if (input === null || typeof input !== "object") {
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = input as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function positiveInt(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
