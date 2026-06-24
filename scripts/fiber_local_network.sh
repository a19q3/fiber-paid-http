#!/usr/bin/env bash
set -euo pipefail

FIBER_REPO="${FIBER_REPO:-/home/arthur/a19q3/fiber}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
export PATH="${SCRIPT_DIR}/bin:${PATH}"
LOG_DIR="${FIBER_LOCAL_LOG_DIR:-$(pwd)/reports/fiber-local-network}"
PID_FILE="${LOG_DIR}/fiber-start.pid"
START_LOG="${LOG_DIR}/start.log"
WAIT_LOG="${LOG_DIR}/wait.log"
SETUP_LOG="${LOG_DIR}/setup.log"

CKB_RPC_URL="${CKB_RPC_URL:-http://127.0.0.1:8114}"
NODE1_RPC_URL="${NODE1_RPC_URL:-http://127.0.0.1:21714}"
NODE2_RPC_URL="${NODE2_RPC_URL:-http://127.0.0.1:21715}"
NODE3_RPC_URL="${NODE3_RPC_URL:-http://127.0.0.1:21716}"

NODE1_ADDR="${NODE1_ADDR:-/ip4/127.0.0.1/tcp/8344/p2p/QmbvRjJHAQDmj3cgnUBGQ5zVnGxUKwb2qJygwNs2wk41h8}"
NODE2_ADDR="${NODE2_ADDR:-/ip4/127.0.0.1/tcp/8345/p2p/QmSRcPqUn4aQrKHXyCDjGn2qBVf43tWBDS2Wj9QDUZXtZp}"
NODE2_PUBKEY="${NODE2_PUBKEY:-02bcbd0e0d811d13363af1e5998f56e74e6aab8a7aa44005e1ce7d696a4d3f10f6}"
NODE3_PUBKEY="${NODE3_PUBKEY:-03032b99943822e721a651c5a5b9621043017daa9dc3ec81d83215fd2e25121187}"

usage() {
  cat <<'USAGE'
usage: scripts/fiber_local_network.sh [up|start|setup|status|stop]

Commands:
  up      Start Fiber's router-pay dev network, open channels, and print status.
  start   Start Fiber's router-pay dev network and wait for RPC ports.
  setup   Connect peers, open node1->node2 and node2->node3 channels, and wait for graph gossip.
  status  Print node_info and channel summaries.
  stop    Stop the background network started by this script.

Environment:
  FIBER_REPO=/home/arthur/a19q3/fiber
  FIBER_LOCAL_LOG_DIR=reports/fiber-local-network
  REMOVE_OLD_STATE=y
  PATH=/home/arthur/a19q3/ckb-bin/ckb_v0.207.0_x86_64-unknown-linux-gnu-portable:$PATH
USAGE
}

main() {
  mkdir -p "$LOG_DIR"
  ensure_ckb_bins
  case "${1:-up}" in
    up)
      start_network
      setup_channels
      status_network
      ;;
    start)
      start_network
      ;;
    setup)
      setup_channels
      ;;
    status)
      status_network
      ;;
    stop)
      stop_network
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

start_network() {
  require_fiber_repo
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Fiber local network already running with launcher pid $(cat "$PID_FILE")"
  else
    echo "Starting Fiber router-pay local network from ${FIBER_REPO}"
    rm -f "$PID_FILE"
    (
      cd "$FIBER_REPO"
      setsid env REMOVE_OLD_STATE="${REMOVE_OLD_STATE:-y}" ./tests/nodes/start.sh e2e/router-pay >"$START_LOG" 2>&1 &
      echo "$!" >"$PID_FILE"
    )
  fi
  echo "Launcher log: ${START_LOG}"
  (
    cd "$FIBER_REPO"
    ./tests/nodes/wait.sh
  ) | tee "$WAIT_LOG"
  wait_rpc "$NODE1_RPC_URL" "node1"
  wait_rpc "$NODE2_RPC_URL" "node2"
  wait_rpc "$NODE3_RPC_URL" "node3"
}

setup_channels() {
  : >"$SETUP_LOG"
  log_step "Connecting node2 -> node1"
  rpc_ok "$NODE2_RPC_URL" connect_peer "[{\"address\":\"${NODE1_ADDR}\"}]"
  sleep 1

  log_step "Connecting node3 -> node2"
  rpc_ok "$NODE3_RPC_URL" connect_peer "[{\"address\":\"${NODE2_ADDR}\"}]"
  sleep 1

  log_step "Opening node1 -> node2 CKB channel"
  rpc_ok "$NODE1_RPC_URL" open_channel "[{\"pubkey\":\"${NODE2_PUBKEY}\",\"funding_amount\":\"0x377aab54d000\",\"tlc_fee_proportional_millionths\":\"0x4B0\"}]"
  sleep 2

  log_step "Generating epochs for node1 -> node2 funding"
  rpc_ok "$CKB_RPC_URL" generate_epochs "[\"0x2\"]"
  sleep 5

  log_step "Opening node2 -> node3 CKB channel"
  rpc_ok "$NODE2_RPC_URL" open_channel "[{\"pubkey\":\"${NODE3_PUBKEY}\",\"funding_amount\":\"0x377aab54d000\",\"tlc_fee_proportional_millionths\":\"0x578\"}]"
  sleep 2

  log_step "Generating epochs for node2 -> node3 funding"
  rpc_ok "$CKB_RPC_URL" generate_epochs "[\"0x2\"]"
  sleep 5

  log_step "Waiting for node2 graph_channels to include both channels"
  wait_graph_channels
}

status_network() {
  log_step "node1 node_info"
  rpc_ok "$NODE1_RPC_URL" node_info "[]"
  log_step "node2 node_info"
  rpc_ok "$NODE2_RPC_URL" node_info "[]"
  log_step "node3 node_info"
  rpc_ok "$NODE3_RPC_URL" node_info "[]"
  log_step "node2 channels with node3"
  rpc_ok "$NODE2_RPC_URL" list_channels "[{\"pubkey\":\"${NODE3_PUBKEY}\"}]"
}

stop_network() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "No Fiber local network pid file at ${PID_FILE}"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    echo "Stopping Fiber local network process group ${pid}"
    kill -- "-${pid}" 2>/dev/null || kill "$pid" 2>/dev/null || true
  else
    echo "Fiber local network launcher pid ${pid} is not running"
  fi
  rm -f "$PID_FILE"
}

require_fiber_repo() {
  if [[ ! -x "${FIBER_REPO}/tests/nodes/start.sh" ]]; then
    echo "Fiber repo start script not found at ${FIBER_REPO}/tests/nodes/start.sh" >&2
    exit 1
  fi
}

ensure_ckb_bins() {
  if command -v ckb >/dev/null && command -v ckb-cli >/dev/null; then
    return 0
  fi
  local candidate
  for candidate in \
    "/home/arthur/a19q3/ckb-bin/ckb_v0.207.0_x86_64-unknown-linux-gnu-portable" \
    "${FIBER_REPO}/../ckb-bin/ckb_v0.207.0_x86_64-unknown-linux-gnu-portable"; do
    if [[ -x "${candidate}/ckb" && -x "${candidate}/ckb-cli" ]]; then
      export PATH="${candidate}:${PATH}"
      echo "Using CKB binaries from ${candidate}"
      return 0
    fi
  done
}

wait_rpc() {
  local url="$1"
  local label="$2"
  for attempt in $(seq 1 90); do
    if rpc_call "$url" node_info "[]" >/dev/null 2>&1; then
      echo "${label} RPC ready at ${url}"
      return 0
    fi
    echo "Waiting for ${label} RPC at ${url} (${attempt}/90)"
    sleep 2
  done
  echo "${label} RPC did not become ready at ${url}" >&2
  exit 1
}

wait_graph_channels() {
  local response
  local count
  for attempt in $(seq 1 60); do
    response="$(rpc_call "$NODE2_RPC_URL" graph_channels "[{}]")"
    count="$(RPC_RESPONSE="$response" node -e 'const res = JSON.parse(process.env.RPC_RESPONSE); console.log((res.result?.channels ?? []).length);')"
    echo "node2 graph channel count: ${count}"
    if [[ "$count" -ge 2 ]]; then
      echo "$response" | tee -a "$SETUP_LOG"
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for two graph channels" >&2
  exit 1
}

rpc_ok() {
  local response
  response="$(rpc_call "$1" "$2" "$3")"
  RPC_RESPONSE="$response" node <<'NODE' | tee -a "${SETUP_LOG}"
const res = JSON.parse(process.env.RPC_RESPONSE);
if (res.error) {
  console.error(JSON.stringify(res.error, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(res.result, null, 2));
NODE
}

rpc_call() {
  local url="$1"
  local method="$2"
  local params="$3"
  curl -sS --fail-with-body "$url" \
    -H 'content-type: application/json' \
    -d "{\"id\":\"fiber-mpp-local-network\",\"jsonrpc\":\"2.0\",\"method\":\"${method}\",\"params\":${params}}"
}

log_step() {
  echo
  echo "==> $*"
  echo "==> $*" >>"$SETUP_LOG"
}

main "$@"
