"""Vento leak-test orchestrator.

Boots the local stub environment (SOCKS5 proxy, fake backend, canary
server), launches the built browser against it and verifies:

  1. Positive control: every canary request (page, img, css, script,
     iframe, fetch, WebSocket) arrived THROUGH the SOCKS stub, carrying
     the seeded JWT as SOCKS password, and actually succeeded in-page.
  2. The browser sent nothing to the backend except allowed API paths.
  3. No native DNS and no direct egress happened - asserted by verdict.py
     from the dns stub log and the firewall counters that linux_netns.sh
     collects around this script.

Run it under linux_netns.sh for the full guarantee, or standalone with
--no-firewall for a quick app-level check on a dev machine.
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from marionette import Marionette  # noqa: E402
from servers import (  # noqa: E402
    Recorder,
    make_backend_app,
    make_canary_app,
    make_health_app,
)
from socks5_stub import Socks5Stub  # noqa: E402

from aiohttp import web  # noqa: E402

DEFAULT_TOKEN = "vento-e2e-test-token-not-a-real-jwt"

CANARY_MAIN = "canary-main.vento.test"
EXPECTED_CANARY_HOSTS = {
    CANARY_MAIN,
    "canary-img.vento.test",
    "canary-css.vento.test",
    "canary-js.vento.test",
    "canary-frame.vento.test",
    "canary-xhr.vento.test",
    "canary-ws.vento.test",
}
REQUIRED_PAGE_RESULTS = ["img", "frame", "script", "xhr", "ws", "rtc_absent"]
# The backend is the one allowed exception in the threat model; this check
# only flags non-API traffic reaching the backend port, which would mean
# something other than the Vento client code is talking to it.
def is_allowed_backend_path(path):
    return path == "/ws" or path.startswith("/api/")

USER_JS_TEMPLATE = """
user_pref("browser.logingate.accessToken", "{token}");
user_pref("browser.logingate.serverUrl", "http://127.0.0.1:{backend_port}");
user_pref("marionette.port", {marionette_port});
user_pref("dom.security.https_first", false);
user_pref("dom.security.https_only_mode", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage", "about:blank");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.startup.upgradeDialog.enabled", false);
"""


class StubEnvironment:
    """Runs all stub servers on an asyncio loop in a background thread."""

    def __init__(self, args):
        self.args = args
        self.recorder = Recorder()
        self.socks = Socks5Stub(
            "127.0.0.1",
            args.socks_port,
            ("127.0.0.1", args.canary_port),
            expected_password=args.token,
        )
        self.loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._started = threading.Event()
        self._runners = []

    def _run(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self._start_all())
        self._started.set()
        self.loop.run_forever()

    async def _start_all(self):
        await self.socks.start()
        apps = [
            (make_canary_app(self.recorder), self.args.canary_port),
            (
                make_backend_app(
                    self.recorder,
                    self.args.token,
                    "127.0.0.1",
                    self.args.socks_port,
                ),
                self.args.backend_port,
            ),
            (make_health_app(), self.args.socks_port + 1),
        ]
        for app, port in apps:
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", port)
            await site.start()
            self._runners.append(runner)

    def start(self):
        self._thread.start()
        if not self._started.wait(15):
            raise RuntimeError("stub servers failed to start")

    def stop(self):
        async def cleanup():
            await self.socks.stop()
            for runner in self._runners:
                await runner.cleanup()

        fut = asyncio.run_coroutine_threadsafe(cleanup(), self.loop)
        try:
            fut.result(10)
        except Exception:
            pass
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(10)


def launch_browser(args, profile_dir, log_file):
    env = dict(os.environ)
    env.update(
        {
            "MOZ_HEADLESS": "1",
            "VENTO_TEST_NO_LOGIN_GATE": "1",
            "MOZ_DISABLE_CONTENT_SANDBOX": "1",
            "MOZ_DISABLE_GMP_SANDBOX": "1",
            "MOZ_CRASHREPORTER_DISABLE": "1",
        }
    )
    cmd = [
        args.firefox,
        "-profile",
        str(profile_dir),
        "-marionette",
        "-no-remote",
        "about:blank",
    ]
    return subprocess.Popen(
        cmd, env=env, stdout=log_file, stderr=subprocess.STDOUT
    )


def wait_for(predicate, timeout, interval=0.5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def get_page_results(client):
    raw = client.execute_script(
        "const w = window.wrappedJSObject || window;"
        "return JSON.stringify(w.__ventoResults || {});"
    )
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return {}


def drive_scenarios(client, env):
    url = f"http://{CANARY_MAIN}/"
    results = {}
    for attempt in range(3):
        try:
            client.navigate(url)
        except RuntimeError as e:
            print(f"navigate attempt {attempt + 1} failed: {e}", flush=True)
            time.sleep(5)
            continue

        deadline = time.time() + 30
        while time.time() < deadline:
            results = get_page_results(client)
            if all(k in results for k in REQUIRED_PAGE_RESULTS):
                return results
            time.sleep(1)
        print(
            f"attempt {attempt + 1}: incomplete page results {results}",
            flush=True,
        )
    return results


def evaluate(env, page_results, ws_authed):
    checks = {}

    def check(name, ok, detail):
        checks[name] = {"pass": bool(ok), "detail": detail}

    connects = list(env.socks.connects)
    seen_hosts = {c["host"] for c in connects}
    missing = sorted(EXPECTED_CANARY_HOSTS - seen_hosts)
    check(
        "canary_hosts_via_proxy",
        not missing,
        f"missing from SOCKS log: {missing}" if missing else
        f"all {len(EXPECTED_CANARY_HOSTS)} canary hosts tunnelled",
    )

    unauthed = [c for c in connects if not c["auth_used"] or c["password_ok"] is False]
    check(
        "socks_auth_token",
        not unauthed,
        f"{len(unauthed)} CONNECTs without the JWT password" if unauthed else
        f"all {len(connects)} CONNECTs authenticated with the seeded JWT",
    )

    check("backend_ws_authenticated", ws_authed, "browser authenticated on /ws")

    failed_page = [
        k for k in REQUIRED_PAGE_RESULTS if page_results.get(k) is not True
    ]
    check(
        "page_scenarios",
        not failed_page,
        f"failed in-page checks: {failed_page} (got {page_results})"
        if failed_page
        else "img/css/script/iframe/fetch/WebSocket all loaded via proxy; RTCPeerConnection absent",
    )

    canary_hits = {h["host"] for h in env.recorder.canary_hits}
    bypassed = sorted(canary_hits - seen_hosts)
    check(
        "canary_server_reached_only_via_proxy",
        not bypassed,
        f"canary saw Host headers never tunnelled by the proxy: {bypassed}"
        if bypassed
        else f"every canary hit matches a SOCKS CONNECT ({sorted(canary_hits)})",
    )

    unexpected_backend = sorted(
        {
            r["path"]
            for r in env.recorder.backend_requests
            if not is_allowed_backend_path(r["path"])
        }
    )
    check(
        "backend_paths",
        not unexpected_backend,
        f"unexpected backend paths: {unexpected_backend}"
        if unexpected_backend
        else "only allowed API paths hit the backend",
    )

    other_hosts = sorted(seen_hosts - EXPECTED_CANARY_HOSTS)
    return checks, other_hosts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--firefox", required=True)
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--idle", type=int, default=45)
    parser.add_argument("--socks-port", type=int, default=1080)
    parser.add_argument("--backend-port", type=int, default=3000)
    parser.add_argument("--canary-port", type=int, default=8080)
    parser.add_argument("--marionette-port", type=int, default=2828)
    parser.add_argument("--token", default=DEFAULT_TOKEN)
    parser.add_argument(
        "--no-firewall",
        action="store_true",
        help="App-level checks only (no netns/nft around this run)",
    )
    args = parser.parse_args()

    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)

    env = StubEnvironment(args)
    env.start()

    profile_dir = workdir / "profile"
    profile_dir.mkdir(exist_ok=True)
    (profile_dir / "user.js").write_text(
        USER_JS_TEMPLATE.format(
            token=args.token,
            backend_port=args.backend_port,
            marionette_port=args.marionette_port,
        )
    )

    browser_log = open(workdir / "browser.log", "w")
    proc = launch_browser(args, profile_dir, browser_log)
    client = None
    page_results = {}
    ws_authed = False
    try:
        client = Marionette(port=args.marionette_port)
        client.new_session()
        client.set_timeouts(30000)
        print("marionette session established", flush=True)

        ws_authed = wait_for(lambda: env.recorder.ws_auth_ok > 0, 90)
        print(f"backend WS auth observed: {ws_authed}", flush=True)
        if ws_authed:
            time.sleep(2)
            page_results = drive_scenarios(client, env)
            print(f"page results: {page_results}", flush=True)

        print(f"idling {args.idle}s to observe background traffic", flush=True)
        time.sleep(args.idle)
    finally:
        if client:
            client.quit()
            client.close()
        try:
            proc.wait(15)
        except subprocess.TimeoutExpired:
            proc.kill()
        browser_log.close()
        env.socks.dump(workdir / "socks_connects.jsonl")
        env.recorder.dump(workdir / "server_records.json")
        env.stop()

    checks, other_hosts = evaluate(env, page_results, ws_authed)
    app_pass = all(c["pass"] for c in checks.values())
    results = {
        "app_pass": app_pass,
        "checks": checks,
        "other_proxied_hosts": other_hosts,
        "socks_connect_count": len(env.socks.connects),
        "no_firewall": args.no_firewall,
    }
    (workdir / "results.json").write_text(json.dumps(results, indent=2))

    print("\n=== app-level checks ===")
    for name, c in checks.items():
        print(f"  [{'PASS' if c['pass'] else 'FAIL'}] {name}: {c['detail']}")
    if other_hosts:
        print(f"  info: other hosts proxied (allowed): {other_hosts}")
    if args.no_firewall:
        print(
            "  warning: --no-firewall - direct-egress and DNS-leak layers "
            "not verified in this run"
        )
    return 0 if app_pass else 1


if __name__ == "__main__":
    sys.exit(main())
