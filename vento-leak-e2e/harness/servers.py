"""Local aiohttp servers for the leak test.

- canary: answers every HTTP request the SOCKS stub tunnels in, whatever
  the requested Host; serves the trigger page whose subresources fan out
  to several canary hostnames (img/css/script/iframe/fetch/WebSocket).
- backend: minimal vento_backend lookalike (REST + /ws WebSocket that
  answers auth with the proxy coordinates).
- health: vento_proxy health endpoint (proxy port + 1).
"""

import base64
import json
import time

from aiohttp import WSMsgType, web

PIXEL_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhf"
    "DwAChwGA60e6kgAAAABJRU5ErkJggg=="
)

TRIGGER_PAGE = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<script>
window.__ventoResults = {};
function __set(k, v) { window.__ventoResults[k] = v; }
</script>
<link rel="dns-prefetch" href="//canary-prefetch.vento.test/">
<link rel="stylesheet" href="http://canary-css.vento.test/style.css">
</head>
<body>
<img src="http://canary-img.vento.test/pixel.png"
     onload="__set('img', true)" onerror="__set('img', false)">
<iframe src="http://canary-frame.vento.test/frame"
        onload="__set('frame', true)"></iframe>
<script src="http://canary-js.vento.test/x.js"
        onerror="__set('script', false)"></script>
<script>
__set('rtc_absent', typeof RTCPeerConnection === 'undefined');
fetch('http://canary-xhr.vento.test/xhr', { mode: 'cors' })
  .then(r => r.json())
  .then(d => __set('xhr', d.ok === true))
  .catch(() => __set('xhr', false));
try {
  const ws = new WebSocket('ws://canary-ws.vento.test/ws');
  ws.onopen = () => ws.send('ping');
  ws.onmessage = ev => { __set('ws', ev.data === 'pong'); ws.close(); };
  ws.onerror = () => __set('ws', false);
} catch (e) {
  __set('ws', false);
}
</script>
</body>
</html>
"""


class Recorder:
    def __init__(self):
        self.canary_hits = []
        self.backend_requests = []
        self.ws_auth_ok = 0
        self.ws_auth_bad = 0

    def dump(self, path):
        with open(path, "w") as f:
            json.dump(
                {
                    "canary_hits": self.canary_hits,
                    "backend_requests": self.backend_requests,
                    "ws_auth_ok": self.ws_auth_ok,
                    "ws_auth_bad": self.ws_auth_bad,
                },
                f,
                indent=2,
            )


def make_canary_app(recorder):
    async def record(request):
        recorder.canary_hits.append(
            {"ts": time.time(), "host": request.host, "path": request.path}
        )

    async def index(request):
        await record(request)
        return web.Response(text=TRIGGER_PAGE, content_type="text/html")

    async def pixel(request):
        await record(request)
        return web.Response(body=PIXEL_PNG, content_type="image/png")

    async def script(request):
        await record(request)
        return web.Response(
            text="__set('script', true);", content_type="application/javascript"
        )

    async def style(request):
        await record(request)
        return web.Response(
            text="body { background: #012345; }", content_type="text/css"
        )

    async def frame(request):
        await record(request)
        return web.Response(
            text="<!doctype html><body>frame</body>", content_type="text/html"
        )

    async def xhr(request):
        await record(request)
        return web.json_response(
            {"ok": True}, headers={"Access-Control-Allow-Origin": "*"}
        )

    async def ws(request):
        await record(request)
        wsr = web.WebSocketResponse()
        await wsr.prepare(request)
        async for msg in wsr:
            if msg.type == WSMsgType.TEXT and msg.data == "ping":
                await wsr.send_str("pong")
        return wsr

    async def fallback(request):
        await record(request)
        return web.Response(text="canary", content_type="text/plain")

    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/pixel.png", pixel)
    app.router.add_get("/x.js", script)
    app.router.add_get("/style.css", style)
    app.router.add_get("/frame", frame)
    app.router.add_get("/xhr", xhr)
    app.router.add_get("/ws", ws)
    app.router.add_route("*", "/{tail:.*}", fallback)
    return app


def make_backend_app(recorder, token, proxy_host, proxy_port):
    async def record(request):
        recorder.backend_requests.append(
            {"ts": time.time(), "path": request.path, "method": request.method}
        )

    async def settings(request):
        await record(request)
        return web.json_response({"client_display_name": "Vento Leak Test"})

    async def validate(request):
        await record(request)
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {token}":
            return web.json_response({"error": "unauthorized"}, status=401)
        return web.json_response(
            {
                "email": "leaktest@vento.test",
                "display_name": "Leak Test",
                "permissions": ["ADMIN"],
            }
        )

    async def dashboard(request):
        await record(request)
        return web.json_response({"online_users_count": 1})

    async def ws(request):
        await record(request)
        wsr = web.WebSocketResponse()
        await wsr.prepare(request)
        async for msg in wsr:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except ValueError:
                continue
            if data.get("type") == "auth":
                if data.get("token") == token:
                    recorder.ws_auth_ok += 1
                    await wsr.send_str(
                        json.dumps(
                            {
                                "type": "auth_ok",
                                "proxy_host": proxy_host,
                                "proxy_port": proxy_port,
                            }
                        )
                    )
                else:
                    recorder.ws_auth_bad += 1
                    await wsr.send_str(json.dumps({"type": "auth_error"}))
        return wsr

    async def fallback(request):
        await record(request)
        return web.json_response({"error": "unexpected endpoint"}, status=404)

    app = web.Application()
    app.router.add_get("/api/settings", settings)
    app.router.add_get("/api/auth/validate", validate)
    app.router.add_get("/api/auth/dashboard", dashboard)
    app.router.add_get("/ws", ws)
    app.router.add_route("*", "/{tail:.*}", fallback)
    return app


def make_health_app():
    async def health(_request):
        return web.Response(text="OK")

    app = web.Application()
    app.router.add_get("/health", health)
    return app
