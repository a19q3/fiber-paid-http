import React, { useEffect, useMemo, useState } from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";
import { short, downloadJson } from "../lib/utils.js";

type TournamentFlow = {
  submission?: TournamentSubmission;
  registration?: TournamentRegistration;
  challengeId?: string;
  fiberChallenge?: { paymentHash?: string };
  receipt?: { receiptId?: string; settlement?: { paymentHash?: string } };
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
  receiptId: string;
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
    prizePayment?: {
      paymentHash?: string;
      mode?: string;
      status?: string;
    };
  } | null;
  warnings?: string[];
};

function tournamentFromFlow(flow: unknown): TournamentFlow {
  if (!flow || typeof flow !== "object") return {};
  const tournament = (flow as { tournament?: unknown }).tournament;
  return tournament && typeof tournament === "object" ? tournament as TournamentFlow : {};
}

export function TournamentView() {
  const ev = useEvidence();
  const { api, addLocalLog } = ev;
  const tournament = useMemo(() => tournamentFromFlow(ev.flow), [ev.flow]);
  const [form, setForm] = useState<TournamentRegistration>(() => ({
    playerId: "arthur",
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

  useEffect(() => {
    let cancelled = false;
    api.getJson("/api/tournament/battlecode/manifest")
      .then((payload) => {
        if (cancelled) return;
        const manifest = (payload as { fairnessManifest?: { botScriptHash?: string; clientHash?: string } }).fairnessManifest;
        if (manifest?.botScriptHash && manifest?.clientHash) {
          setForm((current) => ({
            ...current,
            botScriptHash: current.botScriptHash || manifest.botScriptHash!,
            clientHash: current.clientHash || manifest.clientHash!
          }));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          addLocalLog("ERROR", "tournament", "fairness manifest failed", (error as Error).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, addLocalLog]);

  const runStep = async (label: string, path: string, body: unknown = {}) => {
    setBusyStep(label);
    setMessage("");
    try {
      await ev.api.postJson(path, body);
      await ev.refreshAll(label);
      setMessage(`${label} complete`);
    } catch (error) {
      const text = (error as Error).message;
      setMessage(text);
      ev.addLocalLog("ERROR", "tournament", `${label} failed`, text);
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
        ...(botSource.trim() ? { source: botSource } : {})
      });
      const submission = payload.submission;
      if (!submission?.submissionId || !payload.fairnessManifest?.clientHash) {
        throw new Error("submission did not return locked hashes");
      }
      setForm((current) => ({
        ...current,
        ...payload.registrationDefaults,
        submissionId: submission.submissionId,
        botPackage: submission.botPackage,
        botScriptHash: submission.botScriptHash,
        clientHash: payload.fairnessManifest!.clientHash!
      }));
      await ev.refreshAll("submit-bot");
      setMessage(`bot locked ${submission.submissionId}`);
    } catch (error) {
      const text = (error as Error).message;
      setMessage(text);
      ev.addLocalLog("ERROR", "tournament", "submit-bot failed", text);
    } finally {
      setBusyStep(null);
    }
  };

  const exportTournament = async () => {
    setBusyStep("export");
    try {
      const bundle = await ev.api.getJson("/api/tournament/battlecode/export");
      downloadJson("battlecode-fmpp-tournament-export.json", bundle);
      setMessage("export ready");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusyStep(null);
    }
  };

  const disabled = ev.apiConnection === "error" || Boolean(busyStep);
  const canPay = Boolean(tournament.fiberChallenge);
  const canClaim = Boolean(tournament.fiberChallenge);
  const canRun = Boolean(tournament.ticket);
  const commitmentReady = Boolean(form.submissionId && form.botScriptHash && form.clientHash);

  return (
    <>
      <div className="workspace-header">
        <div className="workspace-title"><Icon name="Tournament" /> Battlecode xUDT Tournament</div>
        <div className="btn-row">
          <button className="btn" onClick={exportTournament} disabled={disabled}>
            <Icon name="Evidence" /> Export
          </button>
          <button className="btn" onClick={() => ev.refreshAll("refresh tournament")} disabled={disabled}>
            <Icon name="ActionRetry" /> Refresh
          </button>
        </div>
      </div>

      <div className="tournament-grid">
        <div className="panel tournament-panel">
          <div className="panel-title"><Icon name="Tournament" /> Entry Ticket</div>
          <div className="panel-body">
            <div className="form-grid compact">
              <label><span>PLAYER</span><input value={form.playerId} onChange={(e) => setForm({ ...form, playerId: e.target.value })} /></label>
              <label><span>BOT</span><input value={form.botPackage} onChange={(e) => setForm({ ...form, botPackage: e.target.value })} /></label>
              <label><span>SUBMISSION</span><input value={form.submissionId || "submit bot first"} readOnly /></label>
              <label><span>BOT HASH</span><input value={form.botScriptHash} readOnly /></label>
              <label><span>CLIENT HASH</span><input value={form.clientHash} readOnly /></label>
              <label><span>xUDT ASSET</span><input value={form.xudtAsset} onChange={(e) => setForm({ ...form, xudtAsset: e.target.value })} /></label>
              <label><span>ENTRY</span><input value={form.entryAmount} onChange={(e) => setForm({ ...form, entryAmount: e.target.value })} /></label>
              <label><span>PRIZE</span><input value={form.prizeAmount} onChange={(e) => setForm({ ...form, prizeAmount: e.target.value })} /></label>
              <label><span>MAP</span><input value={form.map} onChange={(e) => setForm({ ...form, map: e.target.value })} /></label>
              <label className="wide-field"><span>BOT SOURCE</span><textarea value={botSource} onChange={(e) => setBotSource(e.target.value)} placeholder="Paste RobotPlayer.java here, or leave empty to lock the bundled fiberchamp source." spellCheck={false} /></label>
            </div>
            <div className="actions btn-row tournament-actions">
              <button className="btn primary" disabled={disabled} onClick={submitBot}>
                <Icon name="StatusPassed" /> Submit / Lock Bot
              </button>
              <button className="btn" disabled={disabled || !commitmentReady} onClick={() => runStep("request-entry", "/api/tournament/battlecode/register/unpaid", form)}>
                <Icon name="ActionSend" /> Request 402
              </button>
              <button className="btn primary" disabled={disabled || !canPay} onClick={() => runStep("pay-entry", "/api/tournament/battlecode/register/pay")}>
                <Icon name="ActionPay" /> Pay Ticket
              </button>
              <button className="btn" disabled={disabled || !canClaim} onClick={() => runStep("claim-ticket", "/api/tournament/battlecode/register/claim")}>
                <Icon name="PaymentReceipt" /> Claim Ticket
              </button>
              <button className="btn primary" disabled={disabled || !canRun} onClick={() => runStep("run-match", "/api/tournament/battlecode/match/run")}>
                <Icon name="Tournament" /> Run Match
              </button>
            </div>
            <div className={"action-hint " + (message.includes("failed") || message.includes("Error") ? "fail" : "pass")}>
              <Icon name={message.includes("failed") || message.includes("Error") ? "StatusFailed" : "StatusPassed"} />
              <span>{busyStep ? `${busyStep} running` : message || "Ready to request a paid Battlecode entry."}</span>
            </div>
          </div>
        </div>

        <div className="panel tournament-panel">
          <div className="panel-title"><Icon name="Evidence" /> Evidence Chain</div>
          <div className="panel-body tournament-cards">
            <EvidenceCell label="Challenge" value={tournament.challengeId || "pending"} />
            <EvidenceCell label="Submission" value={tournament.ticket?.submissionId || tournament.registration?.submissionId || tournament.submission?.submissionId || form.submissionId || "pending"} />
            <EvidenceCell label="Bot Hash" value={tournament.ticket?.botScriptHash || tournament.registration?.botScriptHash || tournament.submission?.botScriptHash || form.botScriptHash || "pending"} />
            <EvidenceCell label="Client Hash" value={tournament.ticket?.clientHash || tournament.registration?.clientHash || form.clientHash || "pending"} />
            <EvidenceCell label="Payment Hash" value={tournament.receipt?.settlement?.paymentHash || tournament.fiberChallenge?.paymentHash || "pending"} />
            <EvidenceCell label="Receipt" value={tournament.receipt?.receiptId || tournament.ticket?.receiptId || "pending"} />
            <EvidenceCell label="Ticket" value={tournament.ticket?.ticketId || "pending"} />
            <EvidenceCell label="Winner" value={tournament.report?.match?.winner || "pending"} tone={tournament.report?.match?.winner === "fiberchamp" ? "pass" : undefined} />
            <EvidenceCell label="Award" value={tournament.report?.award?.awardId || "pending"} tone={tournament.report?.award ? "pass" : undefined} />
          </div>
        </div>

        <div className="panel tournament-panel wide">
          <div className="panel-title"><Icon name="Terminal" /> Match / Award</div>
          <div className="panel-body">
            <div className="kv">
              <div className="kv-row"><span className="kv-label">Engine</span><strong>{tournament.report?.match?.engineVersion || "Battlecode 2025"}</strong></div>
              <div className="kv-row"><span className="kv-label">Round</span><strong>{tournament.report?.match?.round ?? "pending"}</strong></div>
              <div className="kv-row"><span className="kv-label">Match Hash</span><code>{short(tournament.report?.match?.matchHash)}</code></div>
              <div className="kv-row"><span className="kv-label">Replay</span><code>{tournament.report?.match?.replayPath || "pending"}</code></div>
              <div className="kv-row"><span className="kv-label">Prize</span><strong>{tournament.report?.award ? `${tournament.report.award.prizeAmount} ${tournament.report.award.xudtAsset}` : "pending"}</strong></div>
              <div className="kv-row"><span className="kv-label">Settlement</span><strong>{tournament.report?.award?.settlement || "pending"}</strong></div>
              <div className="kv-row"><span className="kv-label">Prize Payment</span><code>{short(tournament.report?.award?.prizePayment?.paymentHash)}</code></div>
              <div className="kv-row"><span className="kv-label">Prize Status</span><strong>{tournament.report?.award?.prizePayment?.status || tournament.report?.award?.status || "pending"}</strong></div>
            </div>
            {tournament.report?.warnings?.map((warning) => <div className="action-hint warn" key={warning}><Icon name="StatusUnavailable" /><span>{warning}</span></div>)}
          </div>
        </div>
      </div>
    </>
  );
}

function EvidenceCell({ label, value, tone }: { label: string; value: string; tone?: "pass" | "warn" }) {
  const pending = value === "pending";
  const status = tone || (pending ? "warn" : "pass");
  return (
    <div className={"metric-card " + status}>
      <span>{label}</span>
      <strong>{short(value) || value}</strong>
    </div>
  );
}
