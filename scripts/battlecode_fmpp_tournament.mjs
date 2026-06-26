#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const apiBase = (process.env.EVIDENCE_API_BASE || `http://127.0.0.1:${process.env.EVIDENCE_API_PORT || "8877"}`).replace(/\/+$/, "");
const sessionId = process.env.FIBER_MPP_TOURNAMENT_SESSION || "battlecode-live";
const reportPath = resolve(repoRoot, process.env.BATTLECODE_TOURNAMENT_REPORT || "reports/battlecode-fmpp-tournament.json");
const registrationBase = {
  playerId: process.env.BATTLECODE_PLAYER_ID || "arthur",
  botPackage: process.env.BATTLECODE_BOT || "fiberchamp",
  xudtAsset: process.env.BATTLECODE_XUDT_ASSET || "xUDT:BCODE",
  entryAmount: process.env.BATTLECODE_ENTRY_AMOUNT || process.env.FIBER_E2E_AMOUNT_SHANNONS || "100",
  prizeAmount: process.env.BATTLECODE_PRIZE_AMOUNT || "200",
  map: process.env.BATTLECODE_MAP || "DefaultSmall"
};

async function main() {
  const manifest = await get("/api/tournament/battlecode/manifest");
  const fairnessManifest = manifest.fairnessManifest;
  if (!fairnessManifest?.botScriptHash || !fairnessManifest?.clientHash) {
    throw new Error("Battlecode fairness manifest did not include botScriptHash and clientHash");
  }
  const registration = {
    ...registrationBase,
    botScriptHash: process.env.BATTLECODE_BOT_SCRIPT_HASH || fairnessManifest.botScriptHash,
    clientHash: process.env.BATTLECODE_CLIENT_HASH || fairnessManifest.clientHash
  };
  const steps = [];
  steps.push(await post("/api/tournament/battlecode/register/unpaid", registration));
  steps.push(await post("/api/tournament/battlecode/register/pay", {}));
  steps.push(await post("/api/tournament/battlecode/register/claim", {}));
  steps.push(await post("/api/tournament/battlecode/match/run", {}));
  const status = await get("/api/tournament/battlecode/status");
  const exportPayload = await get("/api/tournament/battlecode/export");
  const report = {
    generatedAt: new Date().toISOString(),
    apiBase,
    sessionId,
    fairnessManifest,
    registration,
    steps: steps.map((step) => summarizeStep(step)),
    final: steps.at(-1),
    status,
    export: exportPayload
  };
  await mkdir(resolve(reportPath, ".."), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    reportPath,
    ticketId: steps[2]?.ticket?.ticketId,
    receiptId: steps[2]?.receipt?.receiptId,
    paymentHash: steps[2]?.receipt?.settlement?.paymentHash,
    botScriptHash: registration.botScriptHash,
    clientHash: registration.clientHash,
    winner: steps[3]?.report?.match?.winner,
    awardId: steps[3]?.report?.award?.awardId,
    awardSettlement: steps[3]?.report?.award?.settlement,
    prizePaymentHash: steps[3]?.report?.award?.prizePayment?.paymentHash,
    xudtAsset: steps[3]?.report?.award?.xudtAsset,
    prizeAmount: steps[3]?.report?.award?.prizeAmount
  }, null, 2));
}

async function get(path) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { "x-fiber-mpp-session": sessionId },
    cache: "no-store"
  });
  return parseResponse(response);
}

async function post(path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fiber-mpp-session": sessionId
    },
    body: JSON.stringify(body),
    cache: "no-store"
  });
  const payload = await parseResponse(response);
  if (!response.ok || payload.error) {
    const message = payload.message || payload.error || `${response.status} ${response.statusText}`;
    throw new Error(`${path} failed: ${message}`);
  }
  return payload;
}

async function parseResponse(response) {
  const payload = await response.json().catch(async () => ({ text: await response.text().catch(() => "") }));
  if (!response.ok) {
    payload.httpStatus = response.status;
  }
  return payload;
}

function summarizeStep(step) {
  return {
    status: step.status ?? (step.ok ? 200 : undefined),
    challengeId: step.body?.challengeId ?? step.flow?.tournament?.challengeId,
    paymentHash: step.fiberChallenge?.paymentHash ?? step.receipt?.settlement?.paymentHash,
    receiptId: step.receipt?.receiptId,
    ticketId: step.ticket?.ticketId,
    botScriptHash: step.ticket?.botScriptHash ?? step.flow?.tournament?.registration?.botScriptHash,
    clientHash: step.ticket?.clientHash ?? step.flow?.tournament?.registration?.clientHash,
    winner: step.report?.match?.winner,
    awardId: step.report?.award?.awardId,
    awardSettlement: step.report?.award?.settlement,
    prizePaymentHash: step.report?.award?.prizePayment?.paymentHash
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
