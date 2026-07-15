import React, { useEffect, useMemo, useRef, useState } from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";
import { short, downloadBlob, downloadJson } from "../lib/utils.js";

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
    teamA?: string;
    teamB?: string;
    round?: number;
    matchHash?: string;
    replayPath?: string;
    engineVersion?: string;
    fairness?: {
      observed?: { opponentScriptHash?: string };
    };
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

type LatestReplay = {
  matchId?: string;
  filename?: string;
  engineVersion?: string;
};

type TournamentOpponent = {
  opponentPackage?: string;
  opponentScriptHash?: string;
};

const MAX_BOT_SOURCE_BYTES = 128_000;
const RESERVED_BOT_PACKAGES = new Set(["baselinebot", "arena_baseline"]);

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
  const [sourceFile, setSourceFile] = useState<{ name: string; bytes: number } | null>(null);
  const [opponent, setOpponent] = useState<TournamentOpponent>({});
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [latestReplay, setLatestReplay] = useState<LatestReplay | null>(null);
  const sourceFileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.getJson("/api/tournament/battlecode/manifest")
      .then((payload) => {
        if (cancelled) return;
        const manifest = (payload as { fairnessManifest?: TournamentOpponent }).fairnessManifest;
        setOpponent(manifest ?? {});
      })
      .catch((error) => {
        if (!cancelled) {
          addLocalLog("ERROR", "tournament", "fairness manifest failed", (error as Error).message);
        }
      });
    api.getJson<{ tournament?: { latestReplay?: LatestReplay | null } }>("/api/tournament/battlecode/status")
      .then((payload) => {
        if (!cancelled) setLatestReplay(payload.tournament?.latestReplay ?? null);
      })
      .catch((error) => {
        if (!cancelled) {
          addLocalLog("ERROR", "tournament", "latest replay status failed", (error as Error).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, addLocalLog]);

  const invalidateSubmission = (next: Partial<TournamentRegistration>) => {
    setForm((current) => ({
      ...current,
      ...next,
      submissionId: "",
      botScriptHash: "",
      clientHash: ""
    }));
  };

  const chooseBotSource = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setMessage("");
    if (!file.name.endsWith(".java")) {
      setMessage("Choose a .java source file.");
      return;
    }
    if (file.size <= 0 || file.size > MAX_BOT_SOURCE_BYTES) {
      setMessage(`RobotPlayer.java must be 1..${MAX_BOT_SOURCE_BYTES} bytes.`);
      return;
    }
    const source = await file.text();
    const packageName = source.match(/\bpackage\s+([a-z][a-z0-9_]{0,31})\s*;/i)?.[1];
    if (!packageName || RESERVED_BOT_PACKAGES.has(packageName.toLowerCase())) {
      setMessage("RobotPlayer.java needs a non-reserved Java package declaration.");
      return;
    }
    setBotSource(source);
    setSourceFile({ name: file.name, bytes: file.size });
    invalidateSubmission({ botPackage: packageName });
    setMessage(`${file.name} loaded; submit to lock its source hash.`);
  };

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
      if (!botSource.trim()) {
        throw new Error("Choose or paste RobotPlayer.java before submitting.");
      }
      const payload = await ev.api.postJson<{
        submission?: TournamentSubmission;
        fairnessManifest?: { botScriptHash?: string; clientHash?: string };
        registrationDefaults?: Partial<TournamentRegistration>;
      }>("/api/tournament/battlecode/submissions", {
        playerId: form.playerId,
        botPackage: form.botPackage,
        source: botSource
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
      downloadJson("battlecode-paid-http-tournament-export.json", bundle);
      setMessage("evidence JSON downloaded; this file is not a Battlecode replay");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusyStep(null);
    }
  };

  const downloadReplay = async () => {
    setBusyStep("download-replay");
    try {
      const blob = await ev.api.getBlob("/api/tournament/battlecode/replay");
      const filename = tournament.report?.match?.replayPath?.split("/").pop() || latestReplay?.filename || "battlecode-match.bc25";
      downloadBlob(filename, blob);
      setMessage("Battlecode .bc25 replay downloaded; open it in Client 3.1.0");
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
  const canDownloadReplay = Boolean(tournament.report?.match?.replayPath || latestReplay?.filename);
  const commitmentReady = Boolean(form.submissionId && form.botScriptHash && form.clientHash);

  return (
    <>
      <div className="workspace-header">
        <div className="workspace-title"><Icon name="Tournament" /> Battlecode xUDT Tournament</div>
        <div className="btn-row">
          <button className="btn primary" onClick={downloadReplay} disabled={disabled || !canDownloadReplay}>
            <Icon name="Tournament" /> Download Replay (.bc25)
          </button>
          <button className="btn" onClick={exportTournament} disabled={disabled}>
            <Icon name="Evidence" /> Export Evidence (.json)
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
              <label><span>BOT</span><input value={form.botPackage} onChange={(e) => invalidateSubmission({ botPackage: e.target.value })} /></label>
              <label><span>SUBMISSION</span><input value={form.submissionId || "submit bot first"} readOnly /></label>
              <label><span>BOT HASH</span><input value={form.botScriptHash} readOnly /></label>
              <label><span>CLIENT HASH</span><input value={form.clientHash} readOnly /></label>
              <label><span>xUDT ASSET</span><input value={form.xudtAsset} onChange={(e) => setForm({ ...form, xudtAsset: e.target.value })} /></label>
              <label><span>ENTRY</span><input value={form.entryAmount} onChange={(e) => setForm({ ...form, entryAmount: e.target.value })} /></label>
              <label><span>PRIZE</span><input value={form.prizeAmount} onChange={(e) => setForm({ ...form, prizeAmount: e.target.value })} /></label>
              <label><span>MAP</span><input value={form.map} onChange={(e) => setForm({ ...form, map: e.target.value })} /></label>
              <div className="wide-field bot-source-field">
                <div className="bot-source-heading">
                  <span>BOT SOURCE · REQUIRED</span>
                  <button className="btn bot-source-upload" type="button" disabled={Boolean(busyStep)} onClick={() => sourceFileInput.current?.click()}>
                    <Icon name="Upload" /> Choose RobotPlayer.java
                  </button>
                  <input ref={sourceFileInput} className="source-file-input" type="file" accept=".java,text/x-java-source,text/plain" onChange={chooseBotSource} />
                </div>
                <div className={"bot-source-status " + (sourceFile ? "ready" : "empty")}>
                  {sourceFile ? `${sourceFile.name} · ${sourceFile.bytes.toLocaleString()} bytes · package ${form.botPackage}` : "No file selected. The demo will not substitute an embedded bot."}
                </div>
                <textarea
                  aria-label="Battlecode RobotPlayer.java source"
                  value={botSource}
                  onChange={(e) => {
                    setBotSource(e.target.value);
                    setSourceFile(null);
                    invalidateSubmission({});
                  }}
                  placeholder="Choose RobotPlayer.java above, or paste the complete source here."
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="actions btn-row tournament-actions">
              <button className="btn primary" disabled={disabled || !botSource.trim()} onClick={submitBot}>
                <Icon name="StatusPassed" /> Submit / Lock Uploaded Bot
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
              <span aria-live="polite">{busyStep ? `${busyStep} running` : message || "Choose RobotPlayer.java, then lock it before requesting the paid entry."}</span>
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
            <EvidenceCell label="Opponent" value={tournament.report?.match?.teamB || opponent.opponentPackage || "pending"} />
            <EvidenceCell label="Opponent Hash" value={tournament.report?.match?.fairness?.observed?.opponentScriptHash || opponent.opponentScriptHash || "pending"} />
            <EvidenceCell label="Payment Hash" value={tournament.receipt?.reference || tournament.fiberChallenge?.paymentHash || "pending"} />
            <EvidenceCell label="Receipt Reference" value={tournament.receipt?.reference || tournament.ticket?.receiptReference || "pending"} />
            <EvidenceCell label="Challenge" value={tournament.receipt?.challengeId || tournament.ticket?.challengeId || "pending"} />
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
