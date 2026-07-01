#!/usr/bin/env bash
set -euo pipefail
exec "$(dirname "$0")/fiber_paid_http_ops_gate.sh" "$@"
