"""Minimal Marionette protocol-3 client (raw TCP, no external deps)."""

import json
import socket
import time


class Marionette:
    def __init__(self, host="127.0.0.1", port=2828, connect_timeout=90):
        deadline = time.time() + connect_timeout
        last_err = None
        while time.time() < deadline:
            try:
                self._sock = socket.create_connection((host, port), timeout=5)
                break
            except OSError as e:
                last_err = e
                time.sleep(0.5)
        else:
            raise TimeoutError(f"marionette not reachable: {last_err}")
        self._sock.settimeout(120)
        self._buf = b""
        self._msgid = 0
        self._recv_msg()  # handshake {"applicationType": "gecko", ...}

    def _recv_msg(self):
        while b":" not in self._buf:
            self._buf += self._read()
        length_s, _, rest = self._buf.partition(b":")
        length = int(length_s)
        while len(rest) < length:
            rest += self._read()
        body, self._buf = rest[:length], rest[length:]
        return json.loads(body)

    def _read(self):
        data = self._sock.recv(65536)
        if not data:
            raise ConnectionError("marionette connection closed")
        return data

    def _cmd(self, name, params):
        self._msgid += 1
        payload = json.dumps([0, self._msgid, name, params]).encode()
        self._sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._recv_msg()
            if isinstance(msg, list) and msg[0] == 1 and msg[1] == self._msgid:
                if msg[2]:
                    raise RuntimeError(f"{name}: {msg[2]}")
                return msg[3]

    def new_session(self):
        return self._cmd("WebDriver:NewSession", {})

    def set_timeouts(self, page_load_ms):
        self._cmd("WebDriver:SetTimeouts", {"pageLoad": page_load_ms})

    def navigate(self, url):
        self._cmd("WebDriver:Navigate", {"url": url})

    def execute_script(self, script):
        result = self._cmd(
            "WebDriver:ExecuteScript", {"script": script, "args": []}
        )
        return result.get("value") if isinstance(result, dict) else result

    def quit(self):
        try:
            self._cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except (ConnectionError, OSError):
            pass

    def close(self):
        try:
            self._sock.close()
        except OSError:
            pass
