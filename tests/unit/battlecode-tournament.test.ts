import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendBattlecodeTicket,
  assertBattlecodeFairnessCommitment,
  battlecodeAwardSettlementPlan,
  battlecodeBuiltInBotScriptHash,
  battlecodeEntryPrice,
  issueBattlecodeTicket,
  normalizeBattlecodeRegistration,
  readBattlecodeLedger
} from "../../apps/evidence-api/src/battlecode.js";

const unitClientHash = `sha256:${"12".repeat(32)}`;
const unitManifest = {
  domain: "fiber-mpp-battlecode-fairness-v1" as const,
  botPackage: "fiberchamp" as const,
  botScriptHash: battlecodeBuiltInBotScriptHash(),
  clientHash: unitClientHash,
  runnerHash: `sha256:${"34".repeat(32)}`,
  engineHash: `sha256:${"56".repeat(32)}`,
  engineVersion: "unit",
  hashAlgorithm: "sha256" as const,
  notes: []
};

describe("Battlecode tournament helpers", () => {
  it("normalizes a paid xUDT Battlecode registration", () => {
    const registration = normalizeBattlecodeRegistration({
      playerId: "alice",
      bot: "fiberchamp",
      botScriptHash: unitManifest.botScriptHash,
      clientHash: unitManifest.clientHash,
      xudtAsset: "xUDT:BCODE",
      entryAmount: "100",
      prizeAmount: "200",
      map: "DefaultSmall"
    });
    expect(registration).toEqual({
      playerId: "alice",
      botPackage: "fiberchamp",
      botScriptHash: unitManifest.botScriptHash,
      clientHash: unitManifest.clientHash,
      xudtAsset: "xUDT:BCODE",
      entryAmount: "100",
      prizeAmount: "200",
      map: "DefaultSmall"
    });
    expect(battlecodeEntryPrice(registration)).toEqual({
      value: "100",
      currency: "xUDT:BCODE",
      display: "100 xUDT:BCODE"
    });
  });

  it("rejects unreviewed bot packages", () => {
    expect(() => normalizeBattlecodeRegistration({
      bot: "randomplayer",
      botScriptHash: unitManifest.botScriptHash,
      clientHash: unitManifest.clientHash
    })).toThrow(/only the built-in fiberchamp/);
  });

  it("requires committed bot and client hashes", () => {
    expect(() => normalizeBattlecodeRegistration({ bot: "fiberchamp" })).toThrow(/invalid sha256 hash commitment/);
  });

  it("rejects mismatched fairness commitments", () => {
    const registration = normalizeBattlecodeRegistration({
      playerId: "alice",
      bot: "fiberchamp",
      botScriptHash: unitManifest.botScriptHash,
      clientHash: `sha256:${"ab".repeat(32)}`
    });
    expect(() => assertBattlecodeFairnessCommitment(registration, unitManifest)).toThrow(/clientHash expected/);
  });

  it("records paid tickets in the local tournament ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "fiber-mpp-battlecode-"));
    try {
      const registration = normalizeBattlecodeRegistration({
        playerId: "bob",
        botPackage: "fiberchamp",
        botScriptHash: unitManifest.botScriptHash,
        clientHash: unitManifest.clientHash
      });
      const ticket = issueBattlecodeTicket({
        registration,
        fairnessManifest: unitManifest,
        receiptId: "rcpt_unit",
        paymentHash: `0x${"ab".repeat(32)}`
      });
      await appendBattlecodeTicket(root, ticket);
      const ledger = await readBattlecodeLedger(root);
      expect(ledger.tickets).toHaveLength(1);
      expect(ledger.tickets[0]?.ticketId).toBe(ticket.ticketId);
      expect(ledger.tickets[0]?.xudtAsset).toBe("xUDT:BCODE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not silently downgrade requested Fiber xUDT prize settlement", () => {
    const plan = battlecodeAwardSettlementPlan({
      BATTLECODE_AWARD_SETTLEMENT: "fiber-xudt"
    });
    expect(plan.mode).toBe("fiber-xudt");
    expect(plan.live).toBe(false);
    expect(plan.blockers.join("\n")).toContain("FIBER_MODE");
    expect(plan.blockers.join("\n")).toContain("BATTLECODE_PRIZE_PAYER_RPC_URL");
    expect(plan.blockers.join("\n")).toContain("BATTLECODE_PRIZE_PAYEE_RPC_URL");
  });

  it("resolves the Fiber local xUDT script for the tournament asset", () => {
    const plan = battlecodeAwardSettlementPlan({
      BATTLECODE_AWARD_SETTLEMENT: "fiber-xudt",
      FIBER_MODE: "local",
      FIBER_PAYEE_RPC_URL: "http://127.0.0.1:21716",
      FIBER_PAYER_RPC_URL: "http://127.0.0.1:21714"
    });
    expect(plan.live).toBe(true);
    expect(plan.udtTypeScript?.code_hash).toMatch(/^0x50bd8d/);
    expect(plan.udtTypeScriptSource).toBe("fiber-local-default-xudt");
  });
});
