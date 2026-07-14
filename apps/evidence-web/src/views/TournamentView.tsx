import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";
import { short, downloadJson } from "../lib/utils.js";

type TournamentFlow = {
  submission?: TournamentSubmission;
  registration?: TournamentRegistration;
  challengeId?: string;
  fiberChallenge?: { paymentHash?: string };
  receipt?: { reference?: string; challengeId?: string };
  ticket?: TournamentTicket;
  report?: TournamentReport;
};

type TournamentRegistration = {
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

type TournamentSubmission = {
  submissionId: string;
  botPackage: string;
  botScriptHash: string;
  sourceBytes?: number;
  status?: string;
};

type TournamentTicket = TournamentRegistration & {
  ticketId: string;
  receiptReference: string;
  challengeId: string;
  paymentHash?: string;
  status: string;
};

type TournamentReport = {
  match?: {
    winner?: string;
    round?: number;
    matchHash?: string;
    replayPath?: string;
    engineVersion?: string;
  };
  award?: {
    awardId?: string;
    xudtAsset?: string;
    prizeAmount?: string;
    status?: string;
    settlement?: string;
    prizePayment?: { paymentHash?: string; mode?: string; status?: string };
  } | null;
  warnings?: string[];
};

type Capability = {
  status: "ready" | "blocked" | "unconfigured";
  path?: string | null;
  home?: string;
  version?: string | null;
  source?: string;
  mode?: string;
  live?: boolean;
  blockers: string[];
};

type BattlecodeStatus = {
  scaffoldDir?: string;
  engine?: { version?: string; engineJar?: string; error?: string };
  readiness?: {
    scaffold?: Capability;
    jdk?: Capability;
    engineJar?: Capability;
    fiberPayment?: Capability;
    prizeSettlement?: Capability;
  };
};

function tournamentFromFlow(flow: unknown): TournamentFlow {
  if (!flow || typeof flow !== "object") return {};
  const tournament = (flow as { tournament?: unknown }).tournament;
  return tournament && typeof tournament === "object" ? tournament as TournamentFlow : {};
}

export function TournamentView() {
  const ev = useEvidence();
  const tournament = useMemo(() => tournamentFromFlow(ev.flow), [ev.flow]);
  const [runtime, setRuntime] = useState<BattlecodeStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [form, setForm] = useState<TournamentRegistration>(() => ({
    playerId: "local-player",
    submissionId: "",
    botPackage: "fiberchamp",
    botScriptHash: "",
    clientHash: "",
    xudtAsset: "xUDT:BCODE",
    entryAmount: "100",
    prizeAmount: "200",
    map: "DefaultSmall",
  }));
  const [botSource, setBotSource] = useState("");
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const loadRuntime = useCallback(async () => {
    try {
      const payload = await ev.api.getJson<{ tournament?: BattlecodeStatus }>("/api/tournament/battlecode/status");
      const next = payload.tournament || null;
      setRuntime(next);
      setStatusError("");
      const engineReady = next?.readiness?.jdk?.status === "ready" && next?.readiness?.engineJar?.status === "ready";
      if (engineReady) {
        const manifestPayload = await ev.api.getJson<{ fairnessManifest?: { botScriptHash?: string; clientHash?: string } }>("/api/tournament/battlecode/manifest");
        const manifest = manifestPayload.fairnessManifest;
        if (manifest?.botScriptHash && manifest.clientHash) {
          setForm((current) => ({
            ...current,
            botScriptHash: current.botScriptHash || manifest.botScriptHash!,
            clientHash: current.clientHash || manifest.clientHash!,
          }));
        }
      }
    } catch (error) {
      const text = (error as Error).message;
      setStatusError(text);
      ev.addLocalLog("ERROR", "examples", "Battlecode status unavailable", text);
    }
  }, [ev.api, ev.addLocalLog]);

  useEffect(() => { void loadRuntime(); }, [loadRuntime]);

  const refresh = async () => {
    setBusyStep("refresh");
    try {
      await Promise.all([ev.refreshAll("refresh examples"), loadRuntime()]);
      setMessage("Runtime and gateway evidence refreshed.");
    } finally {
      setBusyStep(null);
    }
  };

  const runStep = async (label: string, path: string, body: unknown = {}) => {
    setBusyStep(label);
    setMessage("");
    try {
      await ev.api.postJson(path, body);
      await Promise.all([ev.refreshAll(label), loadRuntime()]);
      setMessage(`${label} complete`);
    } catch (error) {
      const text = (error as Error).message;
      setMessage(text);
      ev.addLocalLog("ERROR", "examples", `${label} failed`, text);
    } finally {
      setBusyStep(null);
    }
  };

  const submitBot = async () => {
    setBusyStep("submit-bot");
    setMessage("");
    try {
      const payload = await ev.api.postJson<{
        submission?: TournamentSubmission;
        fairnessManifest?: { botScriptHash?: string; clientHash?: string };
        registrationDefaults?: Partial<TournamentRegistration>;
      }>("/api/tournament/battlecode/submissions", {
        playerId: form.playerId,
        botPackage: form.botPackage,
        ...(botSource.trim() ? { source: botSource } : {}),
      });
      const submission = payload.submission;
      if (!submission?.submissionId || !payload.fairnessManifest?.clientHash) throw new Error("submission did not return locked hashes");
      setForm((current) => ({
        ...current,
        ...payload.registrationDefaults,
        submissionId: submission.submissionId,
        botPackage: submission.botPackage,
        botScriptHash: submission.botScriptHash,
        clientHash: payload.fairnessManifest!.clientHash!,
      }));
      await Promise.all([ev.refreshAll("submit-bot"), loadRuntime()]);
      setMessage(`Bot locked as ${submission.submissionId}.`);
    } catch (error) {
      const text = (error as Error).message;
      setMessage(text);
      ev.addLocalLog("ERROR", "examples", "submit-bot failed", text);
    } finally {
      setBusyStep(null);
    }
  };

  const exportTournament = async () => {
    setBusyStep("export");
    try {
      const bundle = await ev.api.getJson("/api/tournament/battlecode/export");
      downloadJson("battlecode-paid-http-reference-export.json", bundle);
      setMessage("Evidence export prepared.");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusyStep(null);
    }
  };

  const readiness = runtime?.readiness;
  const engineReady = readiness?.jdk?.status === "ready" && readiness?.engineJar?.status === "ready";
  const fiberLive = readiness?.fiberPayment?.status === "ready";
  const disabled = ev.apiConnection === "error" || Boolean(busyStep);
  const canPay = fiberLive && Boolean(tournament.fiberChallenge);
  const canClaim = fiberLive && Boolean(tournament.fiberChallenge);
  const canRun = engineReady && Boolean(tournament.ticket);
  const commitmentReady = Boolean(form.submissionId && form.botScriptHash && form.clientHash);
  const runtimeBlockers = [
    ...(readiness?.scaffold?.blockers || []),
    ...(readiness?.jdk?.blockers || []),
    ...(readiness?.engineJar?.blockers || []),
    ...(readiness?.fiberPayment?.blockers || []),
    ...(readiness?.prizeSettlement?.blockers || []),
  ];
  const defaultMessage = statusError || runtimeBlockers[0] || "No Battlecode run has been recorded in this session.";
  const shownMessage = busyStep ? `${busyStep} running` : message || defaultMessage;
  const messageTone = busyStep ? "warn" : message ? (/failed|error|missing|requires|unavailable/i.test(message) ? "fail" : "pass") : runtimeBlockers.length || statusError ? "fail" : "warn";

  return (
    <>
      <div className="workspace-header examples-header">
        <div>
          <div className="workspace-title"><Icon name="Tournament" /> Battlecode paid entry</div>
          <p className="workspace-subtitle">Reference integration · real engine, one Fiber-paid ticket</p>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={exportTournament} disabled={disabled}><Icon name="Evidence" /> Export evidence</button>
          <button className="btn" onClick={refresh} disabled={disabled}><Icon name="ActionRetry" /> Refresh</button>
        </div>
      </div>

      <div className="reference-intro" data-reference-integration="battlecode">
        <span>REFERENCE INTEGRATION</span>
        <p>
          Battlecode remains an external service. It uses the gateway for paid entry, exact request binding, one-time redemption,
          protected delivery, and receipts instead of implementing a second payment verifier.
        </p>
      </div>

      <div className="panel capability-panel" data-panel-id="example-capabilities">
        <div className="panel-title"><Icon name="Activity" /> Demo readiness</div>
        <div className="panel-body capability-grid" id="battlecode-readiness">
          <CapabilityCard label="Scaffold" capability={readiness?.scaffold} readyLabel="READY" emptyLabel="BLOCKED" />
          <CapabilityCard label="JDK 21+" capability={readiness?.jdk} readyLabel="READY" emptyLabel="BLOCKED" />
          <CapabilityCard label="Engine jar" capability={readiness?.engineJar} readyLabel="READY" emptyLabel="BLOCKED" />
          <CapabilityCard label="Fiber payment" capability={readiness?.fiberPayment} readyLabel="LIVE" emptyLabel="UNCONFIGURED" />
          <CapabilityCard
            label="Prize mode"
            capability={readiness?.prizeSettlement}
            readyLabel={readiness?.prizeSettlement?.mode === "fiber-xudt" ? "FIBER LIVE" : "LOCAL LEDGER"}
            emptyLabel={readiness?.prizeSettlement?.mode === "fiber-xudt" ? "FIBER BLOCKED" : "UNCONFIGURED"}
          />
        </div>
      </div>

      <div className="tournament-grid">
        <div className="panel tournament-panel" data-panel-id="example-input">
          <div className="panel-title"><Icon name="Tournament" /> Match input</div>
          <div className="panel-body">
            <div className="form-grid compact">
              <label><span>PLAYER</span><input value={form.playerId} onChange={(e) => setForm({ ...form, playerId: e.target.value })} /></label>
              <label><span>BOT</span><input value={form.botPackage} onChange={(e) => setForm({ ...form, botPackage: e.target.value })} /></label>
              <label><span>xUDT ASSET</span><input value={form.xudtAsset} onChange={(e) => setForm({ ...form, xudtAsset: e.target.value })} /></label>
              <label><span>ENTRY</span><input value={form.entryAmount} onChange={(e) => setForm({ ...form, entryAmount: e.target.value })} /></label>
              <label><span>PRIZE</span><input value={form.prizeAmount} onChange={(e) => setForm({ ...form, prizeAmount: e.target.value })} /></label>
              <label><span>MAP</span><input value={form.map} onChange={(e) => setForm({ ...form, map: e.target.value })} /></label>
              <label className="wide-field"><span>BOT SOURCE (OPTIONAL — paste RobotPlayer.java or leave blank for bundled fiberchamp)</span><textarea value={botSource} onChange={(e) => setBotSource(e.target.value)} spellCheck={false} /></label>
            </div>
            <div className="actions btn-row tournament-actions">
              <button className="btn primary" disabled={disabled || !engineReady} title={engineReady ? "Lock the exact source and engine commitment" : readiness?.jdk?.blockers[0] || readiness?.engineJar?.blockers[0]} onClick={submitBot}>
                <Icon name="StatusPassed" /> Submit / lock bot
              </button>
              <button className="btn" disabled={disabled || !commitmentReady} onClick={() => runStep("request-entry", "/api/tournament/battlecode/register/unpaid", form)}><Icon name="ActionSend" /> Request 402</button>
              <button className="btn primary" disabled={disabled || !canPay} title={fiberLive ? "Pay the issued challenge" : readiness?.fiberPayment?.blockers[0]} onClick={() => runStep("pay-entry", "/api/tournament/battlecode/register/pay")}><Icon name="ActionPay" /> Pay ticket</button>
              <button className="btn" disabled={disabled || !canClaim} onClick={() => runStep("claim-ticket", "/api/tournament/battlecode/register/claim")}><Icon name="PaymentReceipt" /> Claim ticket</button>
              <button className="btn primary" disabled={disabled || !canRun} title={engineReady ? "Requires a paid ticket" : readiness?.engineJar?.blockers[0]} onClick={() => runStep("run-match", "/api/tournament/battlecode/match/run")}><Icon name="Tournament" /> Run match</button>
            </div>
            <div className={`action-hint ${messageTone}`} id="battlecode-action-status">
              <Icon name={messageTone === "fail" ? "StatusFailed" : messageTone === "pass" ? "StatusPassed" : "StatusUnavailable"} />
              <span>{shownMessage}</span>
            </div>
          </div>
        </div>

        <div className="panel tournament-panel" data-panel-id="example-evidence">
          <div className="panel-title"><Icon name="Evidence" /> Gateway evidence</div>
          <div className="panel-body tournament-cards">
            <EvidenceCell label="Challenge" value={tournament.challengeId} />
            <EvidenceCell label="Submission" value={tournament.ticket?.submissionId || tournament.registration?.submissionId || tournament.submission?.submissionId || form.submissionId} />
            <EvidenceCell label="Bot hash" value={tournament.ticket?.botScriptHash || tournament.registration?.botScriptHash || tournament.submission?.botScriptHash || form.botScriptHash} />
            <EvidenceCell label="Client hash" value={tournament.ticket?.clientHash || tournament.registration?.clientHash || form.clientHash} />
            <EvidenceCell label="Payment hash" value={tournament.receipt?.reference || tournament.fiberChallenge?.paymentHash} />
            <EvidenceCell label="Receipt reference" value={tournament.receipt?.reference || tournament.ticket?.receiptReference} />
            <EvidenceCell label="Receipt challenge" value={tournament.receipt?.challengeId || tournament.ticket?.challengeId} />
            <EvidenceCell label="Ticket" value={tournament.ticket?.ticketId} />
            <EvidenceCell label="Winner" value={tournament.report?.match?.winner} tone={tournament.report?.match?.winner === "fiberchamp" ? "pass" : undefined} />
            <EvidenceCell label="Award" value={tournament.report?.award?.awardId} tone={tournament.report?.award ? "pass" : undefined} />
          </div>
        </div>

        <div className="panel tournament-panel wide" data-panel-id="example-match">
          <div className="panel-title"><Icon name="Terminal" /> Match / award evidence</div>
          <div className="panel-body">
            <div className="kv">
              <div className="kv-row"><span className="kv-label">Engine</span><strong>{tournament.report?.match?.engineVersion || runtime?.engine?.version || "NOT READY"}</strong></div>
              <div className="kv-row"><span className="kv-label">Round</span><strong>{tournament.report?.match?.round ?? "NOT RUN"}</strong></div>
              <div className="kv-row"><span className="kv-label">Match hash</span><code>{tournament.report?.match?.matchHash ? short(tournament.report.match.matchHash) : "NOT RECORDED"}</code></div>
              <div className="kv-row"><span className="kv-label">Replay</span><code>{tournament.report?.match?.replayPath || "NOT RECORDED"}</code></div>
              <div className="kv-row"><span className="kv-label">Prize</span><strong>{tournament.report?.award ? `${tournament.report.award.prizeAmount} ${tournament.report.award.xudtAsset}` : "NOT AWARDED"}</strong></div>
              <div className="kv-row"><span className="kv-label">Settlement</span><strong>{tournament.report?.award?.settlement || readiness?.prizeSettlement?.mode || "UNCONFIGURED"}</strong></div>
              <div className="kv-row"><span className="kv-label">Prize payment</span><code>{tournament.report?.award?.prizePayment?.paymentHash ? short(tournament.report.award.prizePayment.paymentHash) : "NOT RECORDED"}</code></div>
              <div className="kv-row"><span className="kv-label">Prize status</span><strong>{tournament.report?.award?.prizePayment?.status || tournament.report?.award?.status || "NOT AWARDED"}</strong></div>
            </div>
            {tournament.report?.warnings?.map((warning) => <div className="action-hint warn" key={warning}><Icon name="StatusUnavailable" /><span>{warning}</span></div>)}
          </div>
        </div>
      </div>
    </>
  );
}

function CapabilityCard({ label, capability, readyLabel, emptyLabel }: { label: string; capability?: Capability; readyLabel: string; emptyLabel: string }) {
  const ready = capability?.status === "ready";
  const value = capability ? (ready ? readyLabel : emptyLabel) : "CHECKING";
  const detail = capability?.blockers[0] || capability?.path || capability?.home || capability?.mode || "Waiting for the Battlecode status API.";
  return (
    <article className={`capability-card ${ready ? "pass" : !capability || capability.status === "unconfigured" ? "warn" : "fail"}`} data-capability={label.toLowerCase().replace(/\s+/g, "-")} data-capability-state={value}>
      <span>{label}</span><strong>{value}</strong><p title={detail}>{detail}</p>
    </article>
  );
}

function EvidenceCell({ label, value, tone }: { label: string; value?: string; tone?: "pass" | "warn" }) {
  const recorded = Boolean(value);
  return (
    <div className={`metric-card ${tone || (recorded ? "pass" : "warn")}`}>
      <span>{label}</span>
      <strong>{recorded ? short(value) || value : "NOT RECORDED"}</strong>
    </div>
  );
}
