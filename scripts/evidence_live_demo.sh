#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-start}"
API_PORT="${EVIDENCE_API_PORT:-8787}"
WEB_PORT="${EVIDENCE_WEB_PORT:-8788}"
SESSION="${FIBER_MPP_DEMO_SESSION:-live-demo}"
POLL_MS="${FIBER_MPP_DEMO_POLL_MS:-1200}"
STEP_DELAY_MS="${FIBER_MPP_DEMO_STEP_DELAY_MS:-3500}"
COUNTDOWN_SECONDS="${FIBER_MPP_DEMO_COUNTDOWN_SECONDS:-8}"
API_BASE="http://127.0.0.1:${API_PORT}"
WEB_URL="http://127.0.0.1:${WEB_PORT}"
PID_FILE="${ROOT}/.tmp/evidence-live-demo.pid"
LOG_FILE="${ROOT}/.tmp/evidence-live-demo.server.log"
FLOW_LOG="${ROOT}/.tmp/evidence-live-demo.flow.log"
REPORT_FILE="${ROOT}/reports/evidence-live-demo-flow.json"

cd "${ROOT}"
mkdir -p "${ROOT}/.tmp" "${ROOT}/reports"

require_live_env() {
  local missing=()
  [[ "${RUN_FIBER_E2E:-}" == "1" ]] || missing+=("RUN_FIBER_E2E=1")
  [[ -n "${FIBER_MODE:-}" ]] || missing+=("FIBER_MODE=local|testnet")
  [[ -n "${FIBER_PAYER_RPC_URL:-}" ]] || missing+=("FIBER_PAYER_RPC_URL")
  [[ -n "${FIBER_PAYEE_RPC_URL:-${FIBER_RPC_URL:-}}" ]] || missing+=("FIBER_PAYEE_RPC_URL or FIBER_RPC_URL")
  [[ -n "${FIBER_CURRENCY:-}" ]] || missing+=("FIBER_CURRENCY=Fibd for local or Fibt for testnet")
  [[ -n "${FIBER_E2E_AMOUNT_SHANNONS:-}" ]] || missing+=("FIBER_E2E_AMOUNT_SHANNONS")
  [[ -n "${FIBER_MPP_SECRET:-}" ]] || missing+=("FIBER_MPP_SECRET")
  if ((${#missing[@]})); then
    echo "Live evidence demo refuses to start without real Fiber env:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    echo >&2
    echo "For the local 3-node network, use for example:" >&2
    echo "  RUN_FIBER_E2E=1 FIBER_MODE=local FIBER_PAYER_RPC_URL=http://127.0.0.1:21714 FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716 FIBER_CURRENCY=Fibd FIBER_E2E_AMOUNT_SHANNONS=100 FIBER_MPP_SECRET=\$(openssl rand -hex 32) $0 start" >&2
    exit 78
  fi
}

start_server() {
  if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    echo "Evidence server already running pid=$(cat "${PID_FILE}")"
    return
  fi
  rm -f "${PID_FILE}"
  if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
    echo "Skipping workspace build because SKIP_BUILD=1."
  else
    echo "Building workspace before starting Evidence API/Web..."
    pnpm build
  fi
  echo "Starting Evidence API/Web on ${API_BASE} and ${WEB_URL}..."
  setsid env \
    FIBER_MPP_EVIDENCE_API_BASE="${API_BASE}" \
    pnpm exec fiber-mpp evidence start --port "${API_PORT}" --web-port "${WEB_PORT}" \
    >"${LOG_FILE}" 2>&1 &
  echo "$!" > "${PID_FILE}"
  wait_url "${API_BASE}/healthz" "Evidence API"
  wait_url "${WEB_URL}/" "Evidence Web"
}

stop_server() {
  if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    local pid
    pid="$(cat "${PID_FILE}")"
    echo "Stopping Evidence server pid=${pid}"
    kill "${pid}" 2>/dev/null || true
    sleep 1
    kill -9 "${pid}" 2>/dev/null || true
  else
    echo "No Evidence server pid file with a live process."
  fi
  rm -f "${PID_FILE}"
}

run_flow() {
  wait_url "${API_BASE}/healthz" "Evidence API"
  echo "Running live flow for session=${SESSION}; watch ${WEB_URL}/?sessionId=${SESSION}&pollMs=${POLL_MS}"
  node scripts/evidence_live_flow.mjs \
    --api-base "${API_BASE}" \
    --web-url "${WEB_URL}" \
    --session "${SESSION}" \
    --delay-ms "${STEP_DELAY_MS}" \
    --report "${REPORT_FILE#${ROOT}/}" \
    2>&1 | tee "${FLOW_LOG}"
}

print_status() {
  echo
  echo "Evidence API: ${API_BASE}"
  echo "Evidence Web: ${WEB_URL}/?sessionId=${SESSION}&pollMs=${POLL_MS}"
  echo "Server log:   ${LOG_FILE}"
  echo "Flow log:     ${FLOW_LOG}"
  echo "Flow report:  ${REPORT_FILE}"
  if [[ -f "${PID_FILE}" ]]; then
    echo "PID file:     ${PID_FILE} ($(cat "${PID_FILE}" 2>/dev/null || true))"
  else
    echo "PID file:     ${PID_FILE} (not running)"
  fi
  echo
  echo "Monitor commands:"
  echo "  EVIDENCE_API_PORT=${API_PORT} EVIDENCE_WEB_PORT=${WEB_PORT} $0 status"
  echo "  EVIDENCE_API_PORT=${API_PORT} EVIDENCE_WEB_PORT=${WEB_PORT} $0 logs"
  echo
  echo "Run this after opening the web URL when live Fiber env is configured:"
  echo "  FIBER_MPP_DEMO_SESSION=${SESSION} EVIDENCE_API_PORT=${API_PORT} EVIDENCE_WEB_PORT=${WEB_PORT} $0 run"
  echo
}

print_runtime_status() {
  echo
  if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    echo "Evidence server pid=$(cat "${PID_FILE}") is running."
  else
    echo "Evidence server is not running."
  fi
  print_status
  echo "Health:"
  node -e "fetch(process.argv[1]).then(async r => { console.log(JSON.stringify({status:r.status, body: await r.json().catch(()=>({}))}, null, 2)); process.exit(r.ok ? 0 : 1); }).catch(e => { console.error(e.message); process.exit(1); })" "${API_BASE}/healthz" || true
  echo
  echo "Readiness:"
  node -e "fetch(process.argv[1]).then(async r => { console.log(JSON.stringify({status:r.status, body: await r.json().catch(()=>({}))}, null, 2)); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); })" "${API_BASE}/readyz" || true
}

tail_logs() {
  local lines="${TAIL_LINES:-120}"
  echo "== ${LOG_FILE} =="
  tail -n "${lines}" "${LOG_FILE}" 2>/dev/null || echo "No server log yet."
  echo
  echo "== ${FLOW_LOG} =="
  tail -n "${lines}" "${FLOW_LOG}" 2>/dev/null || echo "No flow log yet."
}

wait_url() {
  local url="$1"
  local label="$2"
  local deadline=$((SECONDS + 25))
  while ((SECONDS < deadline)); do
    if node -e "fetch(process.argv[1]).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" "${url}" >/dev/null 2>&1; then
      echo "${label} ready: ${url}"
      return
    fi
    sleep 1
  done
  echo "${label} did not become ready: ${url}" >&2
  echo "Last server log lines:" >&2
  tail -n 80 "${LOG_FILE}" >&2 || true
  exit 1
}

case "${ACTION}" in
  start)
    require_live_env
    start_server
    print_status
    ;;
  monitor)
    start_server
    print_runtime_status
    ;;
  run)
    run_flow
    ;;
  all)
    require_live_env
    start_server
    print_status
    echo "Open the console URL above. Flow starts in ${COUNTDOWN_SECONDS}s."
    sleep "${COUNTDOWN_SECONDS}"
    run_flow
    ;;
  stop)
    stop_server
    ;;
  restart)
    stop_server
    require_live_env
    start_server
    print_status
    ;;
  restart-monitor)
    stop_server
    start_server
    print_runtime_status
    ;;
  status)
    print_runtime_status
    ;;
  logs)
    tail_logs
    ;;
  *)
    echo "Usage: $0 {monitor|start|run|all|stop|restart|restart-monitor|status|logs}" >&2
    exit 64
    ;;
esac
