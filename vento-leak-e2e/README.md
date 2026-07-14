# Vento leak tests

Automated proof that the browser sends **zero bytes** outside the SOCKS5
proxy, with the single allowed exception of the Vento backend.

## Threat model / what counts as a leak

- Any TCP or UDP packet leaving the machine that is not (a) a connection
  to the configured SOCKS proxy or (b) a connection to the backend host.
- Any native DNS query (remote DNS through the proxy is enforced).
- Includes background traffic: telemetry, safebrowsing, remote settings,
  captive-portal probes, connectivity checks, WebRTC ICE, HTTP/3 - either
  they go through the proxy or they must not happen at all.

## Test layers

1. **xpcshell** (`browser/components/tests/unit/test_vento_proxy_enforcement.js`)
   Asserts the *effective* (post-lock) pref values and drives
   `nsIProtocolProxyService.asyncResolve`: external URLs must resolve to
   SOCKS5 with the JWT credentials and no DIRECT failover; only
   localhost + backend resolve DIRECT. Catches the "locked pref reads
   default branch" class of bug that once silently disabled the proxy.

2. **E2E canary run** (`harness/run_leak_test.py`)
   Launches the real built browser against a stub environment:
   recording SOCKS5 proxy, fake backend (login/WS/health) and a canary
   web server. The trigger page fans out img / css / script / iframe /
   fetch / WebSocket across `canary-*.vento.test` hosts. Positive
   control: each one must appear in the SOCKS log (with the JWT as the
   SOCKS password) *and* succeed in-page - so "no leaks because nothing
   loaded" cannot pass.

3. **Kill-switch confinement** (`linux_netns.sh`, Linux/root)
   Runs layer 2 inside a network namespace where the default route is a
   dummy interface. nftables counts every TCP/UDP packet routed
   off-loopback (must be 0), tcpdump captures them for diagnosis, and
   `/etc/resolv.conf` points at a recording DNS stub (0 queries
   expected). IPv6 has no route in the namespace, so v6 egress is
   impossible by construction.

`harness/verdict.py` merges all evidence and is the single exit gate.

## Running

CI: `.github/workflows/vento-leak-tests.yml` (nightly + on changes to the
proxy-relevant paths + manual dispatch). The build job also runs the
xpcshell layer; the `e2e-leak` job runs layers 2-3 on the packaged build.

Full local run (Linux):

```bash
sudo ./vento-leak-e2e/linux_netns.sh \
  --firefox /path/to/firefox \
  --workdir /tmp/leak-out \
  --run-as "$USER" --idle 60
```

App-level layers only (works on macOS, no root; direct-egress/DNS layers
are skipped):

```bash
python3 vento-leak-e2e/harness/run_leak_test.py \
  --firefox obj-*/dist/Vento.app/Contents/MacOS/firefox \
  --workdir /tmp/leak-out --no-firewall \
  --backend-port 13000 --socks-port 11080 --canary-port 18080
```

Dependencies: `python3` + `aiohttp` (`apt install python3-aiohttp` or
`pip install aiohttp`); the netns wrapper additionally needs `nftables`,
`tcpdump`, `unshare` (util-linux).

## Outputs (workdir)

| File | Contents |
|------|----------|
| `results.json` | app-level check verdicts |
| `socks_connects.jsonl` | every CONNECT the proxy stub saw (host, port, auth) |
| `server_records.json` | canary hits, backend requests, WS auth counts |
| `dns_queries.jsonl` | native DNS queries (any line = leak) |
| `firewall.json` | nft counters (any counted packet = leak) |
| `leak0.pcap` | the leaked packets themselves, if any |
| `browser.log` | browser stdout/stderr |

## Known blind spots

- Processes outside the browser (crash reporter, OS-level services) are
  only covered by the netns layer, not by prefs.
- The test backend runs on 127.0.0.1; the "backend hostname is exempted"
  path is covered by the xpcshell layer instead.
- macOS/Windows packaging is not exercised here; the enforcement code is
  shared, the netns layer is Linux-only.
