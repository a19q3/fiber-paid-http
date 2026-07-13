import React, { useState } from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";
import { fallbackEndpoints, consolePersonas, personaActionReason } from "../constants.js";
import type { Persona, Density } from "../types.js";

export function SettingsDrawer() {
  const ev = useEvidence();
  const [apiInput, setApiInput] = useState(ev.apiBase);

  const profiles = ev.configuration?.profiles || {};
  const endpoints = ev.status?.endpoints || fallbackEndpoints;
  const selectedEp = endpoints.find((e) => e.path === ev.selected) || fallbackEndpoints[0]!;
  const runtime = ev.configuration?.runtimeBootstrap;
  const runtimeSource = (runtime?.source as string) || "unconfigured";
  const runtimeBlockers = (runtime?.blockers as string[]) || ev.status?.blockers || [];

  const applyReason = personaActionReason(ev.persona, "bootstrap");
  const clearReason = personaActionReason(ev.persona, "resetRuntime");

  const submitRuntimeBootstrap = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payerRpcAuth = (form.elements.namedItem("payerRpcAuth") as HTMLInputElement | null)?.value.trim() || undefined;
    const payeeRpcAuth = (form.elements.namedItem("payeeRpcAuth") as HTMLInputElement | null)?.value.trim() || undefined;
    await ev.applyRuntimeBootstrap({ payerRpcAuth, payeeRpcAuth });
  };

  return (
    <div className="settings-overlay" id="settings-overlay" onClick={(e) => { if (e.target === e.currentTarget) ev.setSettingsOpen(false); }}>
      <aside className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings-head">
          <div>
            <h2 id="settings-title">Console Settings</h2>
            <p>Evidence console preferences. Live execution still goes through the configured backend roles.</p>
          </div>
          <button className="icon-btn" id="close-settings" onClick={() => ev.setSettingsOpen(false)} aria-label="Close settings">
            <Icon name="StatusFailed" />
          </button>
        </div>
        <div className="settings-body">
          {/* Connection */}
          <section className="settings-section">
            <h3>Connection</h3>
            <form className="api-connection api-settings" id="api-settings" onSubmit={(e) => { e.preventDefault(); ev.setApiBase(apiInput); }}>
              <div className="field">
                <span><Icon name="FiberNetwork" /> Evidence API base URL</span>
                <input className="api-base-input" id="api-base-input" value={apiInput} onChange={(e) => setApiInput(e.target.value)} autoComplete="off" spellCheck={false} />
              </div>
              <div className="btn-row">
                <button className="btn primary" id="api-apply" type="submit" disabled={ev.busy || ev.refreshing}>
                  <Icon name="ActionRetry" /> Connect
                </button>
                <button className="btn" id="refresh-all" type="button" onClick={() => ev.refreshAll("manual refresh")} disabled={ev.busy || ev.refreshing}>
                  <Icon name="ActionRetry" /> Refresh
                </button>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)" }}>
                <input id="auto-refresh" type="checkbox" checked={ev.autoRefresh} onChange={(e) => ev.setAutoRefresh(e.target.checked)} />
                Live auto-refresh
              </label>
            </form>
          </section>

          {/* Appearance */}
          <section className="settings-section">
            <h3>Appearance</h3>
            <div className="field-grid">
              <div className="field">
                <span><Icon name="Settings" /> Console perspective</span>
                <select id="settings-persona" value={ev.persona} onChange={(e) => ev.setPersona(e.target.value as Persona)}>
                  <option value="operator">Operator / evidence auditor</option>
                  <option value="payer">Payer client</option>
                  <option value="payee">Payee / gateway operator</option>
                  <option value="auditor">Security auditor</option>
                </select>
              </div>
              <div className="field">
                <span><Icon name="Activity" /> Density</span>
                <select id="settings-density" value={ev.density} onChange={(e) => ev.setDensity(e.target.value as Density)}>
                  <option value="standard">Standard</option>
                  <option value="compact">Compact</option>
                </select>
              </div>
            </div>
            <div className="settings-note">
              <strong>{consolePersonas[ev.persona].title}</strong>
              <br />{consolePersonas[ev.persona].summary}
            </div>
          </section>

          {/* Flow Parameters */}
          <section className="settings-section">
            <h3>Flow Parameters</h3>
            <div className="field">
              <span><Icon name="RequestScenario" /> Protected resource</span>
              <select id="settings-endpoint" value={ev.selected} onChange={async (e) => {
                const ep = endpoints.find((item) => item.path === e.target.value);
                if (!ep || ev.busy) return;
                ev.setSelected(ep.path);
                ev.setAmountShannons(ep.charge.amount);
                await ev.resetEvidenceFlow("resource selected in settings");
              }}>
                {endpoints.map((ep) => <option key={ep.path} value={ep.path}>{ep.label} · {ep.charge.display}</option>)}
              </select>
            </div>
            <div className="field-grid">
              <div className="field">
                <span><Icon name="Price" /> Derived amount (CKB)</span>
                <input id="settings-amount-ckb" value={ev.parameters.amountCkb} readOnly />
              </div>
              <div className="field">
                <span><Icon name="ResourceHash" /> Charge amount (shannons)</span>
                <input id="settings-amount-shannons" value={ev.parameters.amountShannons} onChange={(e) => ev.setAmountShannons(e.target.value)} inputMode="numeric" />
              </div>
            </div>
          </section>

          {/* Profiles */}
          <section className="settings-section">
            <h3>Execution Roles &amp; Profiles</h3>
            {(["payer", "payee", "gateway"] as const).map((role) => (
              <div className="field" key={role}>
                <span><Icon name={role === "payer" ? "ActorClient" : role === "payee" ? "ActorFiber" : "ActorServer"} /> {role} profile</span>
                <select id={`settings-${role}-profile`} value={ev.profileSelection[role]} onChange={async (e) => {
                  ev.setProfileSelection(role, e.target.value);
                  await ev.resetEvidenceFlow(`${role} profile selected in settings`);
                }}>
                  {(profiles[role] || []).map((p) => (
                    <option key={p.id} value={p.id} disabled={p.status === "blocked" || p.source === "report"}>{p.label} · {p.status}</option>
                  ))}
                </select>
              </div>
            ))}
            <div className="settings-note">Browser settings never store Fiber private keys. Payer/payee can have multiple profiles; only env-backed or UI runtime-backed profiles are executable by this API process.</div>
            <div className="settings-roster" id="settings-profile-roster">
              {(["payer", "payee", "gateway"] as const).flatMap((role) =>
                (profiles[role] || []).map((p) => (
                  <div className="roster-row" key={`${role}-${p.id}`} title={`${p.id}; ${p.custody}; ${p.source}`}>
                    <span>{role}</span>
                    <strong>{p.label}</strong>
                    <em>{p.id === ev.profileSelection[role] ? "selected" : p.status}</em>
                  </div>
                ))
              )}
            </div>
            {/* Mirror selects for check scripts */}
            <div style={{ display: "none" }} aria-hidden="true">
              {(["payer", "payee", "gateway"] as const).map((role) => (
                <select key={`mirror-${role}`} id={`${role}-profile`} value={ev.profileSelection[role]} onChange={(e) => ev.setProfileSelection(role, e.target.value)}>
                  {(profiles[role] || []).map((p) => <option key={p.id} value={p.id}>{p.label} · {p.status}</option>)}
                </select>
              ))}
              <input id="amount-ckb" value={ev.parameters.amountCkb} readOnly />
              <input id="amount-shannons" value={ev.parameters.amountShannons} readOnly />
              <div className="role-capability" id="payer-capability" />
              <div className="role-capability" id="payee-capability" />
              <div className="role-capability" id="gateway-capability" />
              <div className="config-summary" id="config-summary" />
            </div>
          </section>

          {/* Bootstrap Runtime */}
          <section className="settings-section">
            <h3>Bootstrap Runtime</h3>
            <form className="runtime-bootstrap" id="runtime-bootstrap" onSubmit={submitRuntimeBootstrap}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <strong style={{ fontSize: 12 }}>UI Runtime Bootstrap</strong>
                <span id="runtime-bootstrap-state" style={{ fontSize: 10, color: "var(--muted)" }}>
                  {runtime?.configured ? `${runtimeSource} · ${runtime?.mode || "mode"} · secret ${runtime?.secret || "unknown"}` : runtimeBlockers[0] || "unconfigured"}
                </span>
              </div>
              <div className="field-grid">
                <div className="field">
                  <span><Icon name="FiberNetwork" /> Fiber mode</span>
                  <select id="bootstrap-mode" value={ev.bootstrapDraft.mode} onChange={(e) => ev.setBootstrapDraft("mode", e.target.value)}>
                    <option value="local">local</option>
                    <option value="testnet">testnet</option>
                  </select>
                </div>
                <div className="field">
                  <span><Icon name="ResourceHash" /> Fiber RPC currency code</span>
                  <input id="bootstrap-currency" value={ev.bootstrapDraft.currency} onChange={(e) => ev.setBootstrapDraft("currency", e.target.value)} autoComplete="off" spellCheck={false} />
                </div>
                <div className="field">
                  <span><Icon name="ActorClient" /> Payer FNN RPC</span>
                  <input id="bootstrap-payer-rpc" value={ev.bootstrapDraft.payerRpcUrl} onChange={(e) => ev.setBootstrapDraft("payerRpcUrl", e.target.value)} autoComplete="off" spellCheck={false} placeholder="http://127.0.0.1:21714" />
                </div>
                <div className="field">
                  <span><Icon name="ActorFiber" /> Payee FNN RPC</span>
                  <input id="bootstrap-payee-rpc" value={ev.bootstrapDraft.payeeRpcUrl} onChange={(e) => ev.setBootstrapDraft("payeeRpcUrl", e.target.value)} autoComplete="off" spellCheck={false} placeholder="http://127.0.0.1:21716" />
                </div>
                <div className="field">
                  <span><Icon name="FiberNetwork" /> Router RPC</span>
                  <input id="bootstrap-router-rpc" value={ev.bootstrapDraft.routerRpcUrl} onChange={(e) => ev.setBootstrapDraft("routerRpcUrl", e.target.value)} autoComplete="off" spellCheck={false} placeholder="optional http://127.0.0.1:21715" />
                </div>
                <div className="field">
                  <span><Icon name="Price" /> Fiber amount</span>
                  <input id="bootstrap-amount-shannons" value={ev.bootstrapDraft.amountShannons} onChange={(e) => ev.setBootstrapDraft("amountShannons", e.target.value)} inputMode="numeric" autoComplete="off" />
                </div>
                <div className="field">
                  <span><Icon name="ActorClient" /> Payer RPC auth</span>
                  <input id="bootstrap-payer-auth" name="payerRpcAuth" type="password" autoComplete="off" spellCheck={false} />
                </div>
                <div className="field">
                  <span><Icon name="ActorFiber" /> Payee RPC auth</span>
                  <input id="bootstrap-payee-auth" name="payeeRpcAuth" type="password" autoComplete="off" spellCheck={false} />
                </div>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)", marginTop: 8 }} title="Durable production deployments should set FIBER_PAID_HTTP_SECRET in the API process environment.">
                <input id="bootstrap-generate-secret" type="checkbox" checked={ev.bootstrapDraft.generateRuntimeSecret} onChange={(e) => ev.setBootstrapDraft("generateRuntimeSecret", e.target.checked)} />
                Generate a fresh session signing secret
              </label>
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button className="btn primary" id="apply-runtime-bootstrap" type="submit" disabled={ev.busy || ev.refreshing || Boolean(applyReason)} title={applyReason || "Apply"}>
                  <Icon name="StatusPassed" /> Apply bootstrap
                </button>
                <button className="btn" id="clear-runtime-bootstrap" type="button" onClick={() => ev.clearRuntimeBootstrap()} disabled={ev.busy || ev.refreshing || runtimeSource !== "runtime" || Boolean(clearReason)} title={clearReason || "Clear"}>
                  <Icon name="ClearLog" /> Clear runtime
                </button>
                <button className="btn" id="copy-env" type="button" onClick={() => ev.copyEnv()} disabled={ev.busy}>
                  <Icon name="Copy" /> Copy env
                </button>
                <button className="btn" id="export-evidence" type="button" onClick={() => ev.exportEvidence()} disabled={ev.busy || ev.status?.mode === "api-unreachable" || Boolean(personaActionReason(ev.persona, "exportEvidence"))}>
                  <Icon name="Evidence" /> Export evidence
                </button>
              </div>
              <div className="settings-note" style={{ marginTop: 8 }}>Runtime bootstrap is accepted only from a local console with explicit confirmation. RPC auth and generated signing state stay inside this API process and are never exported in reports.</div>
            </form>
          </section>
        </div>
      </aside>
    </div>
  );
}
