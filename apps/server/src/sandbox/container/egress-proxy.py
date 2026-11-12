"""The sandbox's only way out: an HTTP proxy that forwards to public addresses only.

Harness runs this in a container of its own (see sandbox/egress.ts and DockerSandbox.startEgress).
Sandboxes sit on an internal Docker network with no route to the user's machine, its local network
or the internet; this proxy is on that network and on Docker's normal one, and sandboxes get it as
their HTTP(S) proxy. It refuses names of the user's machine (localhost, host.docker.internal) and
any name with an address that isn't public (private, loopback, link-local, reserved, ...), whatever
the name resolves to, and connects to the very address it checked, so a name can't change in
between. A sandboxed model can't reach Harness's API, Docker's API or any other local service.

Handles CONNECT (HTTPS, git, anything tunnelled) and plain http:// requests. With EGRESS_UPSTREAM
set (the user's own proxy) it connects through that one.

Usage: python3 egress-proxy.py <port> <own network name>
"""

import asyncio
import base64
import ipaddress
import os
import socket
import sys
from urllib.parse import unquote, urlsplit

REFUSAL = "Harness sandbox: connections to the user's machine, its local network and private addresses are blocked."

BLOCKED_NAMES = {
    "localhost",
    "host.docker.internal",
    "gateway.docker.internal",
    "kubernetes.docker.internal",
    "host-gateway",
    "metadata",
    "metadata.google.internal",
}
BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home", ".localdomain")

HEADER_LIMIT = 65536
CONNECT_TIMEOUT = 20


class Refused(Exception):
    """The destination is the user's machine, its network, or a private address."""


def parse_upstream(url):
    """(host, port, Proxy-Authorization value or None) of the user's proxy, or None."""
    url = (url or "").strip()
    if not url:
        return None
    parts = urlsplit(url if "://" in url else "http://" + url)
    auth = None
    if parts.username:
        token = f"{unquote(parts.username)}:{unquote(parts.password or '')}".encode()
        auth = "Basic " + base64.b64encode(token).decode()
    return parts.hostname, parts.port or 80, auth


def is_public(address):
    """Whether an IP address is on the public internet (an IPv4-mapped IPv6 address counts as its IPv4)."""
    ip = ipaddress.ip_address(address.split("%")[0])
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


async def resolve(host, port, blocked_names):
    """A public address for host, else Refused. Every address the name has must be public."""
    name = host.strip("[]").rstrip(".").lower()
    if not name or name in blocked_names or name.endswith(BLOCKED_SUFFIXES):
        raise Refused(host)
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(name, port, type=socket.SOCK_STREAM)
    except OSError as error:
        raise Refused(host) from error
    addresses = [info[4][0] for info in infos]
    if not addresses or not all(is_public(a) for a in addresses):
        raise Refused(host)
    ipv4 = [a for a in addresses if ":" not in a]
    return (ipv4 or addresses)[0]


async def pump(reader, writer):
    """Copy bytes from reader to writer until either side closes."""
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        writer.close()


async def answer(writer, status, text=""):
    """Reply with an HTTP status (and a short text) and close."""
    body = (text + "\n").encode() if text else b""
    head = f"HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n"
    writer.write(head.encode() + body)
    try:
        await writer.drain()
    finally:
        writer.close()


class Proxy:
    def __init__(self, own_name, upstream):
        self.blocked_names = BLOCKED_NAMES | {own_name.lower()}
        self.upstream = upstream

    async def handle(self, reader, writer):
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 30)
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
            writer.close()
            return
        lines = head.decode("latin-1").split("\r\n")
        try:
            method, target, version = lines[0].split(" ", 2)
        except ValueError:
            return await answer(writer, "400 Bad Request")
        dropped = ("proxy-", "connection:", "keep-alive:")
        headers = [line for line in lines[1:] if line and not line.lower().startswith(dropped)]

        if method.upper() == "CONNECT":
            host, _, port = target.rpartition(":")
            path = None
        else:
            url = urlsplit(target)
            if url.scheme != "http" or not url.hostname:
                return await answer(writer, "400 Bad Request", "Only http:// URLs and CONNECT go through this proxy.")
            host, port = url.hostname, url.port or 80
            path = (url.path or "/") + ("?" + url.query if url.query else "")
        try:
            port = int(port or 443)
            address = await resolve(host, port, self.blocked_names)
        except (Refused, ValueError):
            return await answer(writer, "403 Forbidden", REFUSAL)

        try:
            if self.upstream:
                up_reader, up_writer = await self.through_upstream(writer, method, target, version, headers, host, port, path)
                if up_reader is None:
                    return
            else:
                up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(address, port), CONNECT_TIMEOUT)
                if path is None:
                    writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
                else:
                    request = [f"{method} {path} {version}", *headers, "Connection: close"]
                    up_writer.write(("\r\n".join(request) + "\r\n\r\n").encode("latin-1"))
            await writer.drain()
            await up_writer.drain()
        except (OSError, asyncio.TimeoutError) as error:
            return await answer(writer, "502 Bad Gateway", f"Harness sandbox proxy could not connect: {error}")
        await asyncio.gather(pump(reader, up_writer), pump(up_reader, writer))

    async def through_upstream(self, writer, method, target, version, headers, host, port, path):
        """Open the connection through the user's proxy; (None, None) when it refused (its answer is passed on)."""
        up_host, up_port, auth = self.upstream
        up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(up_host, up_port), CONNECT_TIMEOUT)
        auth_header = [f"Proxy-Authorization: {auth}"] if auth else []
        if path is None:
            request = [f"CONNECT {host}:{port} HTTP/1.1", f"Host: {host}:{port}", *auth_header]
            up_writer.write(("\r\n".join(request) + "\r\n\r\n").encode("latin-1"))
            await up_writer.drain()
            reply = await asyncio.wait_for(up_reader.readuntil(b"\r\n\r\n"), 30)
            if b" 200" not in reply.split(b"\r\n", 1)[0]:
                writer.write(reply)
                await writer.drain()
                writer.close()
                up_writer.close()
                return None, None
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        else:
            request = [f"{method} {target} {version}", *headers, *auth_header, "Connection: close"]
            up_writer.write(("\r\n".join(request) + "\r\n\r\n").encode("latin-1"))
        return up_reader, up_writer


async def main(port, own_name):
    upstream = parse_upstream(os.environ.get("EGRESS_UPSTREAM"))
    proxy = Proxy(own_name, upstream)
    server = await asyncio.start_server(proxy.handle, "0.0.0.0", port, limit=HEADER_LIMIT)
    print(f"egress proxy on {port}" + (" through an upstream proxy" if upstream else ""), flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: egress-proxy.py <port> <own network name>")
    asyncio.run(main(int(sys.argv[1]), sys.argv[2]))
