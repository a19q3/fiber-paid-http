import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  appendBattlecodeTicket,
  battlecodeBuiltInBotSource,
  createBattlecodeSubmission,
  issueBattlecodeTicket,
  normalizeBattlecodeRegistration,
  normalizeBattlecodeSubmission,
  runBattlecodeTournament,
} from "../apps/evidence-api/src/battlecode.js";

async function main(): Promise<void> {
  const runRoot = await mkdtemp(join(tmpdir(), "fiber-paid-http-battlecode-smoke-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BATTLECODE_DIR: process.env.BATTLECODE_DIR || resolve(process.cwd(), "../battlecode25-scaffold/java"),
    BATTLECODE_LEDGER_PATH: join(runRoot, "battlecode-smoke.sqlite"),
    BATTLECODE_AWARD_SETTLEMENT: "local-ledger",
  };

  try {
    const input = normalizeBattlecodeSubmission({
      playerId: "engine-smoke",
      botPackage: "fiberchamp",
      source: battlecodeBuiltInBotSource(),
    });
    const { submission, fairnessManifest } = await createBattlecodeSubmission(runRoot, input, env);
    const registration = normalizeBattlecodeRegistration({
      playerId: input.playerId,
      submissionId: submission.submissionId,
      botPackage: submission.botPackage,
      botScriptHash: fairnessManifest.botScriptHash,
      clientHash: fairnessManifest.clientHash,
      xudtAsset: "xUDT:BCODE",
      entryAmount: "100",
      prizeAmount: "200",
      map: process.env.BATTLECODE_MAP || "DefaultSmall",
    });
    const ticket = issueBattlecodeTicket({
      registration,
      submission,
      fairnessManifest,
      receiptReference: "engine-smoke-no-payment",
      challengeId: "engine-smoke-no-payment",
    });
    await appendBattlecodeTicket(runRoot, ticket, env);
    const report = await runBattlecodeTournament({ registration, ticket, submission, repoRoot: runRoot, env });
    const replayBytes = (await stat(report.match.replayPath)).size;
    console.log(JSON.stringify({
      ok: true,
      scope: "battlecode-engine-only",
      paymentExecution: "not-exercised",
      engineVersion: report.match.engineVersion,
      jdkHome: report.match.jdkHome,
      map: report.match.map,
      winner: report.match.winner,
      round: report.match.round,
      reason: report.match.reason,
      replayBytes,
      fairness: report.match.fairness.status,
    }, null, 2));
  } finally {
    if (process.env.BATTLECODE_SMOKE_KEEP !== "1") {
      await rm(runRoot, { recursive: true, force: true });
    } else {
      console.error(`Preserved smoke workspace: ${runRoot}`);
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
