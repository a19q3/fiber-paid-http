import React, { useEffect, useRef, useState } from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";
import { fallbackEndpoints, consolePersonas, personaActionReason } from "../constants.js";
import type { Persona, Density } from "../types.js";

export function SettingsDrawer() {
  const ev = useEvidence();
  const [apiInput, setApiInput] = useState(ev.apiBase);
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const restoreFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const profiles = ev.configuration?.profiles || {};
  const endpoints = ev.status?.endpoints || fallbackEndpoints;
  const selectedEp = endpoints.find((e) => e.path === ev.selected) || fallbackEndpoints[0]!;
  const runtime = ev.configuration?.runtimeBootstrap;
  const runtimeSource = (runtime?.source as string) || "unconfigured";
  const runtimeBlockers = (runtime?.blockers as string[]) || ev.status?.blockers || [];

  const applyReason = personaActionReason(ev.persona, "bootstrap");
  const clearReason = personaActionReason(ev.persona, "resetRuntime");
  const isBusy = ev.busy || ev.refreshing;

  useEffect(() => {
    const drawer = drawerRef.current;
    if (restoreFocusTimerRef.current !== null) clearTimeout(restoreFocusTimerRef.current);
    closeButtonRef.current?.focus();

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !drawer) return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    drawer?.addEventListener("keydown", trapFocus);
    return () => {
      drawer?.removeEventListener("keydown", trapFocus);
      restoreFocusTimerRef.current = setTimeout(() => previouslyFocusedRef.current?.focus(), 0);
    };
  }, []);

  const submitRuntimeBootstrap = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payerRpcAuth = (form.elements.namedItem("payerRpcAuth") as HTMLInputElement | null)?.value.trim() || undefined;
    const payeeRpcAuth = (form.elements.namedItem("payeeRpcAuth") as HTMLInputElement | null)?.value.trim() || undefined;
    await ev.applyRuntimeBootstrap({ payerRpcAuth, payeeRpcAuth });
  };

  return (
    <div className="settings-overlay" id="settings-overlay" onClick={(e) => { if (e.target === e.currentTarget) ev.setSettingsOpen(false); }}>
      <aside ref={drawerRef} className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title" aria-describedby="settings-description">
        <div className="settings-head">
          <div>
            <h2 id="settings-title">Gateway Lab Settings</h2>
            <p id="settings-description">Gateway Lab preferences. Live execution still goes through the configured backend roles.</p>
          </div>
          <button ref={closeButtonRef} className="icon-btn" id="close-settings" onClick={() => ev.setSettingsOpen(false)} aria-label="Close settings">
            <Icon name="StatusFailed" />
          </button>
        </div>
        <div className="settings-body">
          {/* Connection */}
          <section className="settings-section">
            <h3>Connection</h3>
            <form className="api-connection api-settings" id="api-settings" onSubmit={(e) => { e.preventDefault(); ev.setApiBase(apiInput); }}>
              <label className="field" htmlFor="api-base-input">
                <span><Icon name="FiberNetwork" /> Evidence API base URL</span>
                <input className="api-base-input" id="api-base-input" value={apiInput} onChange={(e) => setApiInput(e.target.value)} autoComplete="off" spellCheck={false} />
              </label>
              <div className="btn-row">
                <button className="btn primary" id="api-apply" type="submit" disabled={isBusy}>
                  <Icon name="ActionRetry" /> Connect
                </button>
                <button className="btn" id="refresh-all" type="button" onClick={() => ev.refreshAll("manual refresh")} disabled={isBusy}>
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
              <label className="field" htmlFor="settings-persona">
                <span><Icon name="Settings" /> Protocol perspective</span>
                <select id="settings-persona" value={ev.persona} onChange={(e) => ev.setPersona(e.target.value as Persona)}>
                  <option value="operator">Full payment flow</option>
                  <option value="payer">Payer perspective</option>
                  <option value="payee">Payee perspective</option>
                  <option value="auditor">Read-only audit</option>
                </select>
              </label>
              <label className="field" htmlFor="settings-density">
                <span><Icon name="Activity" /> Density</span>
                <select id="settings-density" value={ev.density} onChange={(e) => ev.setDensity(e.target.value as Density)}>
                  <option value="standard">Standard</option>
                  <option value="compact">Compact</option>
                </select>
              </label>
            </div>
            <div className="settings-note">
              <strong>{consolePersonas[ev.persona].title}</strong>
              <br />{consolePersonas[ev.persona].summary}
              <br /><span className="settings-clarification">This changes action availability and log emphasis only. It is not identity, wallet selection, authentication, or RBAC.</span>
            </div>
          </section>

          {/* Flow Parameters */}
          <section className="settings-section">
            <h3>Flow Parameters</h3>
            <label className="field" htmlFor="settings-endpoint">
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
            </label>
            <div className="field-grid">
              <label className="field" htmlFor="amount-ckb">
                <span><Icon name="Price" /> Derived amount (CKB)</span>
                <input id="amount-ckb" value={ev.parameters.amountCkb} readOnly />
              </label>
              <label className="field" htmlFor="amount-shannons">
                <span><Icon name="ResourceHash" /> Charge amount (shannons)</span>
                <input id="amount-shannons" value={ev.parameters.amountShannons} onChange={(e) => ev.setAmountShannons(e.target.value)} inputMode="numeric" />
              </label>
            </div>
          </section>

          {/* Profiles */}
          <section className="settings-section">
            <h3>Execution Roles &amp; Profiles</h3>
            {(["payer", "payee", "gateway"] as const).map((role) => (
              <label className="field" htmlFor={`settings-${role}-profile`} key={role}>
                <span><Icon name={role === "payer" ? "ActorClient" : role === "payee" ? "ActorFiber" : "ActorServer"} /> {role} profile</span>
                <select id={`settings-${role}-profile`} value={ev.profileSelection[role]} onChange={async (e) => {
                  ev.setProfileSelection(role, e.target.value);
                  await ev.resetEvidenceFlow(`${role} profile selected in settings`);
                }}>
                  {(profiles[role] || []).map((p) => (
                    <option key={p.id} value={p.id} disabled={p.status === "blocked" || p.source === "report"}>{p.label} · {p.status}</option>
                  ))}
                </select>
              </label>
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
                <label className="field" htmlFor="bootstrap-mode">
                  <span><Icon name="FiberNetwork" /> Fiber mode</span>
                  <select id="bootstrap-mode" value={ev.bootstrapDraft.mode} onChange={(e) => ev.setBootstrapDraft("mode", e.target.value)}>
                    <option value="local">local</option>
                    <option value="testnet">testnet</option>
                  </select>
                </label>
                <label className="field" htmlFor="bootstrap-currency">
                  <span><Icon name="ResourceHash" /> Fiber RPC currency code</span>
                  <input id="bootstrap-currency" value={ev.bootstrapDraft.currency} onChange={(e) => ev.setBootstrapDraft("currency", e.target.value)} autoComplete="off" spellCheck={false} />
                </label>
                <label className="field" htmlFor="bootstrap-payer-rpc">
                  <span><Icon name="ActorClient" /> Payer FNN RPC</span>
                  <input id="bootstrap-payer-rpc" value={ev.bootstrapDraft.payerRpcUrl} onChange={(e) => ev.setBootstrapDraft("payerRpcUrl", e.target.value)} autoComplete="off" spellCheck={false} placeholder="http://127.0.0.1:21714" />
                </label>
                <label className="field" htmlFor="bootstrap-payee-rpc">
                  <span><Icon name="ActorFiber" /> Payee FNN RPC</span>
                  <input id="bootstrap-payee-rpc" value={ev.bootstrapDraft.payeeRpcUrl} onChange={(e) => ev.setBootstrapDraft("payeeRpcUrl", e.target.value)} autoComplete="off" spellCheck={false} placeholder="http://127.0.0.1:21716" />
                </label>
                <label className="field" htmlFor="bootstrap-router-rpc">
                  <span><Icon name="FiberNetwork" /> Router RPC</span>
                  <input id="bootstrap-router-rpc" value={ev.bootstrapDraft.routerRpcUrl} onChange={(e) => ev.setBootstrapDraft("routerRpcUrl", e.target.value)} autoComplete="off" spellCheck={false} placeholder="optional http://127.0.0.1:21715" />
                </label>
                <label className="field" htmlFor="bootstrap-amount-shannons">
                  <span><Icon name="Price" /> Fiber amount</span>
                  <input id="bootstrap-amount-shannons" value={ev.bootstrapDraft.amountShannons} onChange={(e) => ev.setBootstrapDraft("amountShannons", e.target.value)} inputMode="numeric" autoComplete="off" />
                </label>
                <label className="field" htmlFor="bootstrap-payer-auth">
                  <span><Icon name="ActorClient" /> Payer RPC auth</span>
                  <input id="bootstrap-payer-auth" name="payerRpcAuth" type="password" autoComplete="off" spellCheck={false} />
                </label>
                <label className="field" htmlFor="bootstrap-payee-auth">
                  <span><Icon name="ActorFiber" /> Payee RPC auth</span>
                  <input id="bootstrap-payee-auth" name="payeeRpcAuth" type="password" autoComplete="off" spellCheck={false} />
                </label>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)", marginTop: 8 }} title="Durable production deployments should set FIBER_PAID_HTTP_SECRET in the API process environment.">
                <input id="bootstrap-generate-secret" type="checkbox" checked={ev.bootstrapDraft.generateRuntimeSecret} onChange={(e) => ev.setBootstrapDraft("generateRuntimeSecret", e.target.checked)} />
                Generate a fresh session signing secret
              </label>
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button className="btn primary" id="apply-runtime-bootstrap" type="submit" disabled={isBusy || Boolean(applyReason)} title={applyReason || "Apply"}>
                  <Icon name="StatusPassed" /> Apply bootstrap
                </button>
                <button className="btn" id="clear-runtime-bootstrap" type="button" onClick={() => ev.clearRuntimeBootstrap()} disabled={isBusy || runtimeSource !== "runtime" || Boolean(clearReason)} title={clearReason || "Clear"}>
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
