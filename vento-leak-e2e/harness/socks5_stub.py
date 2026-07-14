"""Recording SOCKS5 stub.

Accepts RFC 1929 username/password auth, records every CONNECT (host, port,
credentials) and tunnels the connection to a fixed local canary server so
page loads actually succeed through the proxy. Used as the positive control:
traffic that reaches the canary server MUST have appeared in this log first.
"""

import asyncio
import json
import socket
import time


class Socks5Stub:
    def __init__(self, host, port, tunnel_to, expected_password=None):
        self.host = host
        self.port = port
        self.tunnel_to = tunnel_to
        self.expected_password = expected_password
        self.connects = []
        self._server = None

    async def start(self):
        self._server = await asyncio.start_server(
            self._handle, self.host, self.port
        )

    async def stop(self):
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    async def _handle(self, reader, writer):
        try:
            await self._session(reader, writer)
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    async def _session(self, reader, writer):
        ver, nmethods = await reader.readexactly(2)
        if ver != 5:
            return
        methods = await reader.readexactly(nmethods)

        username = None
        password = None
        if 0x02 in methods:
            writer.write(b"\x05\x02")
            await writer.drain()
            auth_ver = (await reader.readexactly(1))[0]
            ulen = (await reader.readexactly(1))[0]
            username = (await reader.readexactly(ulen)).decode("utf-8", "replace")
            plen = (await reader.readexactly(1))[0]
            password = (await reader.readexactly(plen)).decode("utf-8", "replace")
            writer.write(b"\x01\x00")
            await writer.drain()
        elif 0x00 in methods:
            writer.write(b"\x05\x00")
            await writer.drain()
        else:
            writer.write(b"\x05\xff")
            await writer.drain()
            return

        ver, cmd, _rsv, atyp = await reader.readexactly(4)
        if atyp == 0x01:
            dst_host = socket.inet_ntop(
                socket.AF_INET, await reader.readexactly(4)
            )
        elif atyp == 0x03:
            dlen = (await reader.readexactly(1))[0]
            dst_host = (await reader.readexactly(dlen)).decode("utf-8", "replace")
        elif atyp == 0x04:
            dst_host = socket.inet_ntop(
                socket.AF_INET6, await reader.readexactly(16)
            )
        else:
            return
        dst_port = int.from_bytes(await reader.readexactly(2), "big")

        self.connects.append(
            {
                "ts": time.time(),
                "host": dst_host,
                "port": dst_port,
                "cmd": cmd,
                "username": username,
                "auth_used": username is not None,
                "password_ok": (
                    None
                    if self.expected_password is None
                    else password == self.expected_password
                ),
            }
        )

        if cmd != 0x01:
            writer.write(b"\x05\x07\x00\x01" + b"\x00" * 6)
            await writer.drain()
            return

        writer.write(b"\x05\x00\x00\x01" + b"\x00" * 6)
        await writer.drain()

        up_reader, up_writer = await asyncio.open_connection(*self.tunnel_to)
        await asyncio.gather(
            self._pipe(reader, up_writer),
            self._pipe(up_reader, writer),
            return_exceptions=True,
        )
        try:
            up_writer.close()
        except Exception:
            pass

    @staticmethod
    async def _pipe(reader, writer):
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                writer.write(data)
                await writer.drain()
        finally:
            try:
                writer.write_eof()
            except Exception:
                pass

    def dump(self, path):
        with open(path, "w") as f:
            for entry in self.connects:
                f.write(json.dumps(entry) + "\n")
