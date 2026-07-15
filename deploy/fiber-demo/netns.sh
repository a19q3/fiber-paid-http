#!/usr/bin/env bash
set -euo pipefail

namespace="${FIBER_DEMO_NETNS:-fiber-demo-sandbox}"
host_interface="${FIBER_DEMO_HOST_INTERFACE:-fdemo-host}"
namespace_interface="${FIBER_DEMO_NAMESPACE_INTERFACE:-fdemo-app}"
host_cidr="${FIBER_DEMO_HOST_CIDR:-10.203.0.1/30}"
namespace_cidr="${FIBER_DEMO_NAMESPACE_CIDR:-10.203.0.2/30}"

namespace_exists() {
  ip netns list | awk '{print $1}' | grep -Fxq "$namespace"
}

interface_exists() {
  ip link show "$host_interface" >/dev/null 2>&1
}

up() {
  if ! namespace_exists; then
    ip netns add "$namespace"
  fi

  if ! interface_exists; then
    ip link add "$host_interface" type veth peer name "$namespace_interface"
    ip link set "$namespace_interface" netns "$namespace"
  fi

  ip address replace "$host_cidr" dev "$host_interface"
  ip link set "$host_interface" up
  ip netns exec "$namespace" ip address replace "$namespace_cidr" dev "$namespace_interface"
  ip netns exec "$namespace" ip link set lo up
  ip netns exec "$namespace" ip link set "$namespace_interface" up
}

down() {
  if interface_exists; then
    ip link delete "$host_interface"
  fi
  if namespace_exists; then
    ip netns delete "$namespace"
  fi
}

status() {
  namespace_exists
  interface_exists
  ip -brief address show "$host_interface"
  ip netns exec "$namespace" ip -brief address show "$namespace_interface"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *)
    echo "usage: $0 [up|down|status]" >&2
    exit 2
    ;;
esac
