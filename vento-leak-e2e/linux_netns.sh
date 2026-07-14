#!/usr/bin/env bash
# Runs the Vento leak test inside an isolated network namespace.
#
# The namespace has only loopback plus a dummy interface (leak0) that owns
# the default route: every packet the browser tries to send anywhere except
# loopback is routed into leak0, counted by nftables, captured by tcpdump
# and never leaves the machine. /etc/resolv.conf is bind-mounted to point
# at a recording DNS stub, so any native DNS query is logged as a leak.
#
# Usage: sudo ./linux_netns.sh --firefox /path/to/firefox --workdir /path/out \
#          [--run-as USER] [--idle SECONDS]

set -euo pipefail

FIREFOX=""
WORKDIR=""
RUN_AS="${SUDO_USER:-runner}"
IDLE=45

while [[ $# -gt 0 ]]; do
  case "$1" in
    --firefox) FIREFOX="$2"; shift 2 ;;
    --workdir) WORKDIR="$2"; shift 2 ;;
    --run-as) RUN_AS="$2"; shift 2 ;;
    --idle) IDLE="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$FIREFOX" || -z "$WORKDIR" ]]; then
  echo "usage: sudo $0 --firefox BIN --workdir DIR [--run-as USER] [--idle SECONDS]" >&2
  exit 2
fi
if [[ $EUID -ne 0 ]]; then
  echo "must run as root (sudo)" >&2
  exit 2
fi

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)/harness"

if [[ -z "${VENTO_LEAK_INNER:-}" ]]; then
  export VENTO_LEAK_INNER=1
  exec unshare -n -m -- "$0" \
    --firefox "$FIREFOX" --workdir "$WORKDIR" --run-as "$RUN_AS" --idle "$IDLE"
fi

mkdir -p "$WORKDIR"
chown "$RUN_AS" "$WORKDIR"
USER_HOME="$(getent passwd "$RUN_AS" | cut -d: -f6)"

ip link set lo up
ip link add leak0 type dummy
ip addr add 192.0.2.1/24 dev leak0
ip link set leak0 up
ip route add default dev leak0

mount --make-rprivate /
echo "nameserver 127.0.0.1" > "$WORKDIR/resolv.conf"
mount --bind "$WORKDIR/resolv.conf" /etc/resolv.conf

nft -f - <<'EOF'
table inet ventoleak {
  chain out {
    type filter hook output priority filter; policy accept;
    oifname "leak0" meta l4proto { tcp, udp } counter comment "vento-leak-tcpudp"
    oifname "leak0" counter comment "info-leak0-total"
  }
}
EOF

python3 "$HARNESS_DIR/dns_stub.py" --port 53 --log "$WORKDIR/dns_queries.jsonl" &
DNS_PID=$!
tcpdump -i leak0 -w "$WORKDIR/leak0.pcap" -U >/dev/null 2>&1 &
TCPDUMP_PID=$!
sleep 1

set +e
runuser -u "$RUN_AS" -- env HOME="$USER_HOME" \
  python3 "$HARNESS_DIR/run_leak_test.py" \
  --firefox "$FIREFOX" --workdir "$WORKDIR" --idle "$IDLE"
APP_RC=$?
set -e

sleep 1
kill "$TCPDUMP_PID" "$DNS_PID" 2>/dev/null || true
wait "$TCPDUMP_PID" "$DNS_PID" 2>/dev/null || true

nft -j list table inet ventoleak > "$WORKDIR/firewall.json" \
  || echo '{}' > "$WORKDIR/firewall.json"
chown -R "$RUN_AS" "$WORKDIR" || true

exec python3 "$HARNESS_DIR/verdict.py" --workdir "$WORKDIR" --app-rc "$APP_RC"
