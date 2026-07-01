# Fiber Paid HTTP Evidence Console Performance Audit

Generated: 2026-06-25

Scope:
- `apps/demo-web/index.html`
- `apps/demo-api/src/index.ts`
- local API at `http://localhost:8787`
- local static web at `http://localhost:8788`

## Summary

The current console is small enough for local/static delivery: `index.html` is about 155 KB, with about 54 KB CSS, 71 KB inline JS, and 17 KB lucide icon sprite. The main performance risks were not bundle size; they were repeated refresh work and duplicated live Fiber bootstrap probing.

## Measurements

Static size:

```text
apps/demo-web/index.html              155488 bytes
apps/demo-web/src/components/icons.tsx  4799 bytes
apps/demo-api/src/index.ts             55374 bytes
```

HTML breakdown:

```json
{
  "htmlBytes": 155486,
  "cssBytes": 53723,
  "jsBytes": 71001,
  "iconSpriteBytes": 16886,
  "staticTagCount": 404,
  "replaceChildren": 16
}
```

API latency after the fixes, no live Fiber env configured:

```text
/api/status         mean 3.5 ms
/api/configuration  mean 3.9 ms
/api/bootstrap      mean 4.0 ms
/api/reports/*      mean 3.5 ms
```

Simulated complete refresh with true frontend report slugs:

```json
{
  "totalMs": 35.19,
  "requests": 12,
  "maxRequestMs": 32.24,
  "statuses": {
    "200": 12
  }
}
```

## Findings

### P1: Duplicate Fiber bootstrap probing

Before the fix, one frontend refresh called both `/api/configuration` and `/api/bootstrap`. Both could build production bootstrap state, and in live Fiber mode that can probe payer and payee RPCs. That meant one refresh could duplicate Fiber RPC calls.

Fix:
- Added a per-process, 2-second bootstrap cache inside `createEvidenceApi`.
- `/api/bootstrap`, `/api/configuration`, and evidence export can reuse the same in-flight bootstrap promise.
- The cache is short enough to keep operator feedback fresh while avoiding duplicate same-refresh probes.

### P1: Serial report loading

Before the fix, `loadReports()` fetched report JSON endpoints sequentially.

Fix:
- `loadReports()` now uses `Promise.all(Object.entries(reports).map(...))`.
- A full refresh still performs 12 HTTP requests, but report latency is no longer additive.

### P2: Unnecessary DOM churn on auto-refresh

The console refreshes every 15 seconds by default. Several panels rebuilt DOM even when content was unchanged.

Fix:
- Timeline already uses `timelineSignature`.
- Evidence JSON now uses `json.dataset.renderSignature`.
- Tabs, report list, parity cards, and terminal logs now skip DOM replacement when content is unchanged.

### P2: Timeline scroll jitter

Timeline used to rebuild its entire DOM each render, which could disturb scroll position and replay row animations.

Fix:
- Timeline only rebuilds when its signature changes.
- Scroll position is restored after content changes.
- CSS uses `overflow-anchor: none`, `overscroll-behavior: contain`, and `scrollbar-gutter: stable both-edges`.

## Remaining Risks

- No browser performance trace was captured because Playwright is not installed in this workspace.
- In true live Fiber mode, `/api/bootstrap` latency depends on Fiber RPC responsiveness; each node probe has a 1200 ms timeout.
- The console is still a large single-file static app. This is acceptable for the current evidence console, but a future production deployment should split static assets and enable immutable caching.
- Auto-refresh still pulls 12 endpoints. The current local cost is low, but a production operator console should consider a consolidated `/api/console-state` endpoint or ETag-based report reads.

## Verification

Commands run:

```bash
pnpm --filter @fiber-paid-http/demo-web typecheck
pnpm typecheck
pnpm test
pnpm test:integration
git diff --check
hyperfine --warmup 3 --runs 20 'curl -s -o /dev/null http://localhost:8787/api/status' 'curl -s -o /dev/null http://localhost:8787/api/configuration' 'curl -s -o /dev/null http://localhost:8787/api/bootstrap' 'curl -s -o /dev/null http://localhost:8787/api/reports/canonical'
```

Status:

```text
demo-web static checks passed
root typecheck passed
unit tests passed: 41
integration tests passed: 6
diff check clean
```
