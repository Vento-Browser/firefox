"""Recording DNS stub.

Answers NXDOMAIN to everything and logs each query as one JSONL line.
With socks_remote_dns enforced the browser must send ZERO queries here;
any logged query is a DNS leak. Runs standalone (started as root inside
the network namespace so it can bind port 53).
"""

import argparse
import json
import socket
import sys
import time


def parse_qname(payload):
    labels = []
    i = 12
    while i < len(payload):
        length = payload[i]
        if length == 0:
            break
        if length >= 0xC0:
            break
        labels.append(payload[i + 1 : i + 1 + length].decode("utf-8", "replace"))
        i += 1 + length
    return ".".join(labels)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=53)
    parser.add_argument("--log", required=True)
    args = parser.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((args.host, args.port))
    log = open(args.log, "a", buffering=1)
    print(f"dns_stub listening on {args.host}:{args.port}", flush=True)

    while True:
        try:
            payload, addr = sock.recvfrom(4096)
        except KeyboardInterrupt:
            return
        if len(payload) < 12:
            continue
        qname = parse_qname(payload)
        log.write(
            json.dumps({"ts": time.time(), "qname": qname, "from": addr[0]}) + "\n"
        )
        # NXDOMAIN, echo the question section back
        resp = payload[:2] + b"\x81\x83" + payload[4:6] + b"\x00" * 6 + payload[12:]
        try:
            sock.sendto(resp, addr)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
