"""Final leak-test verdict.

Merges the three evidence layers written into the workdir:
  - results.json        app-level checks from run_leak_test.py
  - dns_queries.jsonl   every native DNS query the browser emitted (leak)
  - firewall.json       nft counters for packets routed off-loopback (leak)

Exit code 0 only if every layer is clean.
"""

import argparse
import json
import sys
from pathlib import Path


def load_firewall_counters(path):
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    counters = []
    for item in data.get("nftables", []):
        rule = item.get("rule")
        if not rule:
            continue
        packets = None
        for expr in rule.get("expr", []):
            if "counter" in expr:
                packets = expr["counter"].get("packets", 0)
        if packets is not None:
            counters.append(
                {"comment": rule.get("comment", ""), "packets": packets}
            )
    return counters


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--app-rc", type=int, default=None)
    args = parser.parse_args()
    workdir = Path(args.workdir)

    failures = []
    print("=== vento leak-test verdict ===")

    results_path = workdir / "results.json"
    if not results_path.exists():
        failures.append("results.json missing - orchestrator crashed?")
    else:
        results = json.loads(results_path.read_text())
        for name, c in results.get("checks", {}).items():
            status = "PASS" if c["pass"] else "FAIL"
            print(f"  [{status}] {name}: {c['detail']}")
            if not c["pass"]:
                failures.append(f"app check failed: {name}")
        if results.get("other_proxied_hosts"):
            print(
                "  info: additional hosts routed through the proxy "
                f"(allowed): {results['other_proxied_hosts']}"
            )

    if args.app_rc not in (None, 0) and not failures:
        failures.append(f"orchestrator exited with rc={args.app_rc}")

    dns_path = workdir / "dns_queries.jsonl"
    if dns_path.exists():
        queries = [
            json.loads(line)
            for line in dns_path.read_text().splitlines()
            if line.strip()
        ]
        if queries:
            names = sorted({q["qname"] for q in queries})
            print(f"  [FAIL] DNS leak: {len(queries)} native queries: {names}")
            failures.append(f"DNS leak: {names}")
        else:
            print("  [PASS] DNS: zero native queries (remote DNS enforced)")
    else:
        print("  [SKIP] DNS layer: no dns_queries.jsonl (run under linux_netns.sh)")

    fw_path = workdir / "firewall.json"
    if fw_path.exists():
        counters = load_firewall_counters(fw_path)
        if counters is None:
            failures.append("firewall.json unreadable")
        else:
            leaked = sum(
                c["packets"]
                for c in counters
                if c["comment"].startswith("vento-leak")
            )
            if leaked:
                print(
                    f"  [FAIL] direct egress: {leaked} packets left loopback "
                    f"(see leak0.pcap for destinations)"
                )
                failures.append(f"direct egress: {leaked} packets")
            else:
                print("  [PASS] direct egress: 0 packets off loopback")
    else:
        print("  [SKIP] firewall layer: no firewall.json (run under linux_netns.sh)")

    if failures:
        print(f"\nRESULT: LEAK TEST FAILED ({len(failures)} problem(s))")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nRESULT: no leaks detected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
