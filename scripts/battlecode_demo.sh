#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GIT_COMMON_DIR="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [[ -n "$GIT_COMMON_DIR" && "$(basename "$GIT_COMMON_DIR")" == ".git" ]]; then
  PROJECT_ROOT="$(dirname "$GIT_COMMON_DIR")"
else
  PROJECT_ROOT="$ROOT"
fi
PROJECTS_DIR="$(cd "$PROJECT_ROOT/.." && pwd)"

FIBER_REPO="${FIBER_REPO:-$PROJECTS_DIR/fiber}"
BATTLECODE_REPO="${BATTLECODE_REPO:-$PROJECTS_DIR/battlecode25-scaffold}"
FIBER_CKB_BIN="${FIBER_CKB_BIN:-$PROJECT_ROOT/.tmp/ckb-v0.202.0/target/release/ckb}"
FIBER_CKB_CLI_BIN="${FIBER_CKB_CLI_BIN:-$(command -v ckb-cli || true)}"
API_PORT="${EVIDENCE_API_PORT:-8787}"
WEB_PORT="${EVIDENCE_WEB_PORT:-8788}"
SESSION="${FIBER_PAID_HTTP_TOURNAMENT_SESSION:-battlecode-live}"
API_BASE="http://127.0.0.1:$API_PORT"
WEB_URL="http://127.0.0.1:$WEB_PORT/?sessionId=$SESSION&pollMs=1200"
XUDT_TYPE_SCRIPT='{"code_hash":"0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95","hash_type":"data2","args":"0x32e555f3ff8e135cece1351a6a2971518392c1e30375c1e006ad0ce8eac07947"}'

network_ready() {
  curl -sS --max-time 2 http://127.0.0.1:21714 \
    -H 'content-type: application/json' \
    --data '{"id":"battlecode-demo","jsonrpc":"2.0","method":"node_info","params":[]}' \
    | grep -q '"result"'
}

start_demo() {
  BATTLECODE_REPO="$BATTLECODE_REPO" bash "$ROOT/scripts/battlecode_setup.sh"
  BATTLECODE_DIR="$BATTLECODE_REPO/java" pnpm --dir "$ROOT" battlecode:engine-smoke

  if network_ready; then
    echo "Reusing the ready Fiber network on ports 21714-21716."
  else
    env \
      FIBER_REPO="$FIBER_REPO" \
      FIBER_CKB_BIN="$FIBER_CKB_BIN" \
      FIBER_CKB_CLI_BIN="$FIBER_CKB_CLI_BIN" \
      FIBER_LOCAL_ASSET=xudt \
      bash "$ROOT/scripts/fiber_local_network.sh" up
  fi

  env \
    RUN_FIBER_E2E=1 \
    FIBER_MODE=local \
    FIBER_PAYER_RPC_URL=http://127.0.0.1:21714 \
    FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716 \
    FIBER_ROUTER_RPC_URL=http://127.0.0.1:21715 \
    FIBER_CURRENCY=Fibd \
    FIBER_ASSET=xUDT:BCODE \
    FIBER_XUDT_TYPE_SCRIPT="$XUDT_TYPE_SCRIPT" \
    FIBER_E2E_AMOUNT_SHANNONS=100 \
    FIBER_PAID_HTTP_SECRET="${FIBER_PAID_HTTP_SECRET:-$(openssl rand -hex 32)}" \
    BATTLECODE_DIR="$BATTLECODE_REPO/java" \
    BATTLECODE_LEDGER_PATH="$ROOT/.tmp/battlecode-demo.sqlite" \
    BATTLECODE_AWARD_SETTLEMENT=local-ledger \
    EVIDENCE_API_PORT="$API_PORT" \
    EVIDENCE_WEB_PORT="$WEB_PORT" \
    FIBER_PAID_HTTP_DEMO_SESSION="$SESSION" \
    bash "$ROOT/scripts/evidence_live_demo.sh" start

  echo "Recording dashboard: $WEB_URL"
  echo "Run the automated paid tournament only when you are ready to record: pnpm battlecode:demo:run"
}

run_demo() {
  EVIDENCE_API_BASE="$API_BASE" \
  FIBER_PAID_HTTP_TOURNAMENT_SESSION="$SESSION" \
  BATTLECODE_PLAYER_ID=local-player \
  BATTLECODE_BOT=fiberchamp \
  BATTLECODE_XUDT_ASSET=xUDT:BCODE \
  BATTLECODE_ENTRY_AMOUNT=100 \
  BATTLECODE_PRIZE_AMOUNT=200 \
  BATTLECODE_MAP=DefaultSmall \
  pnpm --dir "$ROOT" battlecode:tournament
}

stop_demo() {
  EVIDENCE_API_PORT="$API_PORT" EVIDENCE_WEB_PORT="$WEB_PORT" bash "$ROOT/scripts/evidence_live_demo.sh" stop
  env FIBER_REPO="$FIBER_REPO" FIBER_CKB_BIN="$FIBER_CKB_BIN" FIBER_CKB_CLI_BIN="$FIBER_CKB_CLI_BIN" bash "$ROOT/scripts/fiber_local_network.sh" stop
}

case "${1:-start}" in
  start) start_demo ;;
  run) run_demo ;;
  all) start_demo; run_demo ;;
  stop) stop_demo ;;
  *) echo "Usage: $0 {start|run|all|stop}" >&2; exit 64 ;;
esac
