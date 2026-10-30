"""HTTP + WebSocket API for the Android app (PLAN.md §4.1; shapes in contracts/events.md, "App API").

Stdlib only: ThreadingHTTPServer and the small WebSocket in ws.py. Security:
- It binds only to the Tailscale IP (100.64.0.0/10), found without running anything (a UDP
  "connect" to Tailscale's 100.100.100.100 shows which local address routes there; no packet is
  sent). 0.0.0.0, ::, and LAN or public addresses are refused. While the Tailscale IP is missing,
  it retries with backoff (5 s → 60 s); Telegram is unaffected.
- Every request needs `Authorization: Bearer <token>`, the token read from a private (0600) file
  and compared in constant time. Requests and their answers go to an audit log (never the token).
- Bounded: at most MAX_CONNECTIONS requests at once, MAX_CLIENTS stream clients, body limits per
  route, a socket timeout per connection; a stream client that can't keep up is disconnected.

Routes: features register theirs with ctx.add_route; this adapter adds /v1/messages, /v1/actions,
/v1/commands and the /v1/stream WebSocket (every bus event, as JSON).
"""
import hmac
import http.server
import ipaddress
import json
import logging
import os
import re
import secrets
import select
import socket
import stat
import sys
import threading
import time
import urllib.parse

from edith.common.paths import resolve
from edith.core import ApiError, CommandCall, Event, Reply, Response, Route

from . import ws
from .attachments import MAX_BYTES as MAX_ATTACHMENT, AttachmentError, Attachments

log = logging.getLogger("edith.adapter.app_api")

TAILSCALE_NET = ipaddress.ip_network("100.64.0.0/10")
TAILSCALE_DNS = "100.100.100.100"
MAX_CONNECTIONS = 16
MAX_CLIENTS = 4
CLIENT_BACKLOG = 1000     # frames waiting for one stream client; more and it is disconnected
PING_EVERY = 25.0         # seconds; a client that misses two pings is dropped
AUDIT_MAX = 5 * 1024 * 1024
IDLE_POLL = 60.0          # serve_forever's idle wake-up; stop() wakes it at once anyway
DRAIN_MAX = 256 * 1024    # an upload refused early: read and drop a rest up to this, so the client gets the answer


def tailscale_ip():
    """This machine's Tailscale IPv4, or None if Tailscale is down."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect((TAILSCALE_DNS, 53))  # UDP connect: picks the route, sends nothing
            ip = s.getsockname()[0]
    except OSError:
        return None
    return ip if ipaddress.ip_address(ip) in TAILSCALE_NET and ip != TAILSCALE_DNS else None


def check_bind(address, allow_loopback=False):
    """The address to bind, or ValueError if it isn't a Tailscale address."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        raise ValueError(f"bind address {address!r} is not an IP address")
    if ip.is_unspecified:
        raise ValueError(f"refusing to bind {address}: that is every interface")
    if ip in TAILSCALE_NET and address != TAILSCALE_DNS:
        return address
    if allow_loopback and ip.is_loopback:  # tests only; not reachable from config
        return address
    raise ValueError(f"refusing to bind {address}: not a Tailscale address (100.64.0.0/10)")


def read_token(path):
    st = os.stat(path)
    if st.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise PermissionError(f"{path} must be readable by its owner only (chmod 600)")
    with open(path) as f:
        token = f.read().strip()
    if len(token) < 32:
        raise ValueError(f"{path} must hold a long random token (32+ characters)")
    return token


def template(path):
    """'/v1/sessions/{id}/resume' -> (regex, number of literal parts) for matching and ordering."""
    parts = path.strip("/").split("/")
    regex = "/" + "/".join(f"(?P<{p[1:-1]}>[^/]+)" if p.startswith("{") else re.escape(p) for p in parts)
    return re.compile(regex + "$"), sum(not p.startswith("{") for p in parts)


class Client:
    """One /v1/stream connection: frames to send wait here; a pipe wakes its thread."""

    def __init__(self):
        self.frames, self.lock = [], threading.Lock()
        self.wake_r, self.wake_w = os.pipe()
        self.too_slow = False

    def push(self, frame):
        with self.lock:
            if len(self.frames) >= CLIENT_BACKLOG:
                self.too_slow = True
            else:
                self.frames.append(frame)
        try:
            os.write(self.wake_w, b"x")
        except OSError:
            pass

    def take(self):
        with self.lock:
            out, self.frames = self.frames, []
        return out

    def close(self):
        for fd in (self.wake_r, self.wake_w):
            try:
                os.close(fd)
            except OSError:
                pass


class AppApi:
    name = "app_api"

    def __init__(self, config: dict, resolve_ip=None, allow_loopback=False, retry_wait=5.0):
        self.config = config
        self.paths = resolve(config)
        self.port = int(config.get("port", 8787))
        self.bind = config.get("bind", "tailscale")
        self.token_file = os.path.expanduser(config.get("token_file", "~/.config/edith/app-token"))
        self.audit_file = os.path.expanduser(config.get("audit_log") or os.path.join(self.paths.state_dir, "api-audit.jsonl"))
        self._resolve_ip = resolve_ip or tailscale_ip
        self._allow_loopback = allow_loopback  # tests only: config can't turn this on
        self._retry_wait = retry_wait
        self.server = None
        self.address = None
        self.listening = threading.Event()  # set once it is bound and serving
        self.changed = threading.Condition()  # notified when an audit line is written or a client joins/leaves
        self._stopping = threading.Event()
        self._clients: set[Client] = set()
        self._clients_lock = threading.Lock()
        self._audit_lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        self._thread = None
        self.attachments = Attachments(self.paths.inbox, os.path.join(self.paths.state_dir, "app-attachments.json"))

    # ---- lifecycle ----

    def start(self, bus, registry, agent):
        if self.bind in ("0.0.0.0", "::", ""):
            raise ValueError(f"refusing to bind {self.bind!r}: the App API listens on the Tailscale IP only")
        self.bus, self.registry, self.agent = bus, registry, agent
        self.token = read_token(self.token_file)
        os.makedirs(os.path.dirname(self.audit_file), exist_ok=True)
        self.routes = self._routes(registry)
        bus.subscribe("*", self._broadcast, owner="app_api")
        self._thread = threading.Thread(target=self._serve, name="app_api:server", daemon=True)
        self._thread.start()

    def stop(self):
        self._stopping.set()
        server = self.server
        if server:
            # serve_forever notices shutdown only when select() wakes; an empty local connection wakes
            # it at once (so it can idle with a long poll interval instead of waking twice a second).
            stopper = threading.Thread(target=server.shutdown, name="app_api:stop")
            stopper.start()
            while stopper.is_alive():
                try:
                    socket.create_connection(self.address, timeout=1).close()
                except OSError:
                    pass
                stopper.join(0.05)
            with self._clients_lock:
                clients = list(self._clients)
            for c in clients:  # stream clients get a proper close frame first
                c.push(ws.close_frame(ws.CLOSE_NORMAL, "server stopping"))
            server.close_connections()
            server.server_close()
        if self._thread:
            self._thread.join(5)

    def _serve(self):
        """Bind the Tailscale IP (retrying while it is missing) and serve until stop()."""
        wait = self._retry_wait
        while not self._stopping.is_set():
            address = self._resolve_ip() if self.bind == "tailscale" else self.bind
            try:
                if not address:
                    raise OSError("Tailscale IP not found (is Tailscale up?)")
                address = check_bind(address, self._allow_loopback)
                self.server = Server((address, self.port), Handler, self)
            except ValueError:
                log.exception("App API not started")
                return  # a bad address in config won't fix itself
            except OSError as e:
                log.warning("App API waiting for its address: %s; retrying in %.0fs", e, wait)
                self._stopping.wait(wait)
                wait = min(60.0, wait * 2)
                continue
            self.address = self.server.server_address
            log.info("App API listening on %s:%s", *self.address)
            self.listening.set()
            self.server.serve_forever(poll_interval=IDLE_POLL)
            return

    # ---- routes ----

    def _routes(self, registry):
        own = [Route("POST", "/v1/messages", self._messages, self.name, 16 * 1024),
               Route("POST", "/v1/attachments", self._attach, self.name, MAX_ATTACHMENT, stream=True),
               Route("POST", "/v1/actions", self._actions, self.name),
               Route("GET", "/v1/commands", self._command_list, self.name),
               Route("POST", "/v1/commands/{name}", self._command, self.name, 16 * 1024)]
        table = []
        for route in list(registry.routes.values()) + own:
            regex, literals = template(route.path)
            table.append((route.method, regex, literals, route))
        table.sort(key=lambda r: -r[2])  # "/v1/sessions/new" before "/v1/sessions/{id}"
        return table

    def match(self, method, path):
        """-> (route, params), or raise ApiError 404/405."""
        allowed = False
        for m, regex, _, route in self.routes:
            found = regex.match(path)
            if found:
                if m == method:
                    return route, found.groupdict()
                allowed = True
        raise ApiError(405 if allowed else 404, "method not allowed" if allowed else "not found")

    def _replier(self, ref, collected, done):
        def reply(out):
            data = out.as_data() if isinstance(out, Reply) else {"text": out, "buttons": []}
            if not done[0]:
                collected.append(data)
            else:  # replies after the answer was sent (e.g. a conversation switch) go on the stream
                self.bus.publish(self._event("command.reply", {"ref": ref, **data}))
        return reply

    @staticmethod
    def _event(type, data):
        return Event(type, data, origin="app")

    def _prompt(self, text, voice=False):
        return f"[App message from Arpit, {time.strftime('%Y-%m-%d %H:%M %Z')}]" + (" [voice]" if voice else "") + f"\n{text}"

    def _messages(self, req):
        body = req.get("body") or {}
        text = (body.get("text") or "").strip()
        ids = body.get("attachments") or []
        try:
            files = self.attachments.paths(ids)
        except AttachmentError as e:
            raise ApiError(e.status, e.message)
        if not text and not files:
            raise ApiError(400, "text is required")
        ref = f"app:{secrets.token_hex(6)}"
        if body.get("voice"):  # before send, so the voice feature knows the ref before any of its turn events
            self.bus.publish(self._event("voice.turn", {"ref": ref}))
        prompt = self._prompt(text, bool(body.get("voice"))) + "".join(f"\n[Attached file saved at: {f}]" for f in files)
        handle = self.agent.send(prompt, "app", ref, force_queue=bool(body.get("queue")))
        answer = {"ref": ref, "lane": handle.lane}
        if not files:
            return answer
        return Response(200, {"content-type": "application/json"}, json.dumps(answer).encode(),
                        audit={"attachments": [str(i) for i in ids]})

    def _attach(self, req):
        h = req.get("headers") or {}
        try:
            record = self.attachments.add(req["body_stream"], req["length"], h.get("x-filename"), h.get("x-content-sha256"))
        except AttachmentError as e:
            raise ApiError(e.status, e.message)
        return Response(200, {"content-type": "application/json"}, json.dumps(record).encode(),
                        audit={"attachment": {k: record[k] for k in ("id", "type", "size", "sha256")}})

    def _actions(self, req):
        action = (req.get("body") or {}).get("action") or ""
        ref, collected, done = f"app:{secrets.token_hex(6)}", [], [False]
        result = self.registry.press(action, "app", self._replier(ref, collected, done), ref=ref)
        done[0] = True
        if result is None:
            raise ApiError(404, "unknown action")
        return {"ref": ref, "toast": result.toast, "note": result.note, "replies": collected}

    def _command_list(self, req):
        return {"commands": [{"name": c.name, "description": c.description, "usage": c.usage, "help": c.help}
                             for c in sorted(self.registry.commands.values(), key=lambda c: (c.order, c.name)) if c.help]}

    def _command(self, req):
        command = self.registry.commands.get(req["params"]["name"])
        if command is None:
            raise ApiError(404, "unknown command")
        body = req.get("body") or {}
        args = str(body.get("args") or "")
        ref, collected, done = f"app:{secrets.token_hex(6)}", [], [False]
        prompt = self._prompt(args) if command.takes_prompt and args.strip() else None
        out = command.handler(CommandCall(args, "app", self._replier(ref, collected, done), ref, prompt))
        if out is not None:
            self._replier(ref, collected, done)(out)
        done[0] = True
        return {"ref": ref, "replies": collected}

    # ---- the live stream ----

    def _broadcast(self, ev):
        with self._clients_lock:
            if not self._clients:
                return
            clients = list(self._clients)
        frame = ws.encode(ws.OP_TEXT, json.dumps({"type": ev.type, "ts": ev.ts, "session_id": ev.session_id,
                                                  "origin": ev.origin, "data": ev.data},
                                                 ensure_ascii=False, default=str).encode())
        for c in clients:
            c.push(frame)

    def stream(self, sock):
        """Serve one /v1/stream client until it leaves, falls behind or the server stops."""
        client = Client()
        with self._clients_lock:
            if len(self._clients) >= MAX_CLIENTS:
                sock.sendall(ws.close_frame(ws.CLOSE_POLICY, "too many clients"))
                client.close()
                return
            self._clients.add(client)
        self._notify()
        reader = ws.Reader(sock.recv, max_message=4096)
        missed = 0
        try:
            while not self._stopping.is_set():
                ready, _, _ = select.select([sock, client.wake_r], [], [], PING_EVERY)
                if client.wake_r in ready:
                    os.read(client.wake_r, 4096)
                    frames = client.take()
                    if client.too_slow:
                        sock.sendall(ws.close_frame(ws.CLOSE_POLICY, "too slow"))
                        return
                    if frames:
                        sock.sendall(b"".join(frames))
                        if any(f[0] & 0x0F == ws.OP_CLOSE for f in frames):
                            return
                if sock in ready:
                    opcode, payload = reader.read()
                    missed = 0  # anything from the client shows it is still there
                    if opcode == ws.OP_CLOSE:
                        sock.sendall(ws.close_frame(ws.CLOSE_NORMAL))
                        return
                    if opcode == ws.OP_PING:
                        sock.sendall(ws.encode(ws.OP_PONG, payload))
                    elif opcode == ws.OP_BINARY:
                        raise ws.ProtocolError(ws.CLOSE_UNSUPPORTED, "binary messages are not accepted")
                    elif opcode == ws.OP_TEXT and (pong := self._pong(payload)):
                        sock.sendall(pong)  # this thread is the socket's only writer, so frames never interleave
                    # other text from the client is read and ignored
                if not ready:
                    missed += 1
                    if missed > 2:
                        return  # gone quiet: no pong to two pings
                    sock.sendall(ws.encode(ws.OP_PING, b"edith"))
        except ws.ProtocolError as e:
            try:
                sock.sendall(ws.close_frame(e.code, e.reason))
            except OSError:
                pass
        except (OSError, ConnectionError):
            pass
        finally:
            with self._clients_lock:
                self._clients.discard(client)
            client.close()
            self._notify()

    @staticmethod
    def _pong(payload):
        """{"type": "ping", "id"?} from the app's watchdog -> a pong frame (echoing its id), else None."""
        try:
            msg = json.loads(payload)
        except ValueError:
            return None
        if not isinstance(msg, dict) or msg.get("type") != "ping":
            return None
        pong = {"type": "pong", "ts": time.time(), "session_id": None, "origin": "system", "data": {}}
        if "id" in msg:
            pong["data"]["id"] = msg["id"]
        return ws.encode(ws.OP_TEXT, json.dumps(pong).encode())

    # ---- audit ----

    def audit(self, entry):
        line = json.dumps(entry, ensure_ascii=False) + "\n"
        with self._audit_lock:
            try:
                if os.path.exists(self.audit_file) and os.path.getsize(self.audit_file) > AUDIT_MAX:
                    os.replace(self.audit_file, self.audit_file + ".1")
                fd = os.open(self.audit_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                with os.fdopen(fd, "a") as f:
                    f.write(line)
            except OSError:
                log.exception("audit log write failed")
        self._notify()

    def _notify(self):
        with self.changed:
            self.changed.notify_all()


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, api):
        self.api = api
        self.active: set = set()               # open connections, so stop() can end them
        self.idle = threading.Condition()      # notified when a connection's thread is done
        super().__init__(address, handler)

    def close_connections(self, timeout=5.0):
        """End every open connection (idle keep-alive and stream ones included) and wait until their
        threads are done, so nothing still runs (or writes the audit log) after stop()."""
        with self.idle:
            for sock in list(self.active):
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            self.idle.wait_for(lambda: not self.active, timeout)

    def process_request(self, request, client_address):
        if not self.api._slots.acquire(blocking=False):  # at most MAX_CONNECTIONS at once
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            finally:
                self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        with self.idle:
            self.active.add(request)
        self.api._notify()
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.api._slots.release()
            with self.idle:
                self.active.discard(request)
                self.idle.notify_all()

    def handle_error(self, request, client_address):
        """A client that hangs up is normal (the phone loses signal); anything else is logged."""
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            log.debug("client %s went away", client_address[0])
        else:
            log.exception("App API connection from %s failed", client_address[0])


class BodyReader:
    """A request body read in chunks, never past its Content-Length."""

    def __init__(self, rfile, length):
        self.rfile, self.left = rfile, length

    def read(self, n=64 * 1024):
        if self.left <= 0:
            return b""
        data = self.rfile.read(min(n, self.left))
        if not data:
            raise ConnectionError("the client stopped sending")
        self.left -= len(data)
        return data

    def drain(self, limit):
        """Read and drop the rest of the body if it is at most `limit` bytes; -> True if it was read
        (each read has the connection's socket timeout)."""
        if self.left > limit:
            return False
        try:
            while self.read():
                pass
        except (OSError, ConnectionError):
            return False
        return True


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 30  # seconds per socket read/write: a stalled client can't hold a slot forever
    server_version = "edith"
    sys_version = ""

    def log_message(self, format, *args):  # the audit log replaces the default stderr access log
        pass

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        if status >= 400:  # the request body may be unread: never reuse this connection
            self.close_connection = True
        self.send_response(status)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _answer(self, result):
        """Send a handler's result (a Response, or JSON with 200). -> (status, extra audit fields)."""
        if isinstance(result, Response):
            return self._respond(result).get("status", result.status), dict(result.audit)
        self._send(200, result if result is not None else {})
        return 200, {}

    def _respond(self, r: Response):
        """A non-JSON answer: its body, or `length` bytes of its file from `offset`, sent with
        sendfile (zero-copy, never read into memory). -> extra audit fields."""
        f = None
        if r.file:
            try:
                f = open(r.file, "rb")
            except OSError:  # removed (e.g. pruned) since the handler looked
                self._send(404, {"error": "not found"})
                return {"status": 404}
        try:
            length = len(r.body) if f is None else (
                r.length if r.length is not None else os.fstat(f.fileno()).st_size - r.offset)
            self.send_response(r.status)
            for name, value in r.headers.items():
                self.send_header(name, value)
            if r.status not in (204, 304):
                self.send_header("Content-Length", str(length))
            self.end_headers()
            if f is not None:
                self.wfile.flush()
                self.connection.sendfile(f, r.offset, length)
            elif r.body:
                self.wfile.write(r.body)
        finally:
            if f is not None:
                f.close()
        return {}

    def _handle(self):
        api, started, status, summary, extra = self.server.api, time.monotonic(), 500, "", {}
        url = urllib.parse.urlsplit(self.path)
        try:
            given = self.headers.get("Authorization", "")
            if not hmac.compare_digest(given.encode(), f"Bearer {api.token}".encode()):
                raise ApiError(401, "unauthorized")
            if url.path == "/v1/stream" and self.command == "GET":
                status = self._upgrade()
                return
            route, params = api.match(self.command, url.path)
            length = int(self.headers.get("Content-Length") or 0)
            if length > route.max_body:
                self.close_connection = True
                raise ApiError(413, "request too large")
            if route.stream:
                if self.headers.get("Transfer-Encoding") or "Content-Length" not in self.headers:
                    self.close_connection = True
                    raise ApiError(411, "Content-Length is required")
                reader = BodyReader(self.rfile, length)
                try:
                    result = route.handler({"body_stream": reader, "length": length, "params": params, "origin": "app",
                                            "content_type": self.headers.get("Content-Type", ""),
                                            "query": dict(urllib.parse.parse_qsl(url.query)),
                                            "headers": {k.lower(): v for k, v in self.headers.items()}})
                finally:
                    # The handler stopped early (e.g. a 400). A small rest is read and dropped, so the
                    # client finishes sending and gets the answer (closing on it mid-send makes its write
                    # fail instead); a big one isn't worth the bandwidth: the connection is closed.
                    if reader.left and not reader.drain(DRAIN_MAX):
                        self.close_connection = True
                status, extra = self._answer(result)
                return
            raw = self.rfile.read(length) if length else b""
            ctype = self.headers.get("Content-Type", "")
            body = None
            if raw and "json" in ctype:
                try:
                    body = json.loads(raw)
                except ValueError:
                    raise ApiError(400, "body is not valid JSON")
            if isinstance(body, dict):
                summary = str(body.get("text") or body.get("action") or body.get("args") or body.get("title") or "")[:60]
            result = route.handler({"body": body, "raw": raw, "content_type": ctype, "params": params,
                                    "query": dict(urllib.parse.parse_qsl(url.query)), "origin": "app",
                                    "headers": {k.lower(): v for k, v in self.headers.items()}})
            status, extra = self._answer(result)
        except ApiError as e:
            status = e.status
            self._send(e.status, {"error": e.message})
        except (ValueError, TypeError) as e:
            status = 400
            self._send(400, {"error": str(e)})
        except (ConnectionError, TimeoutError):  # the phone went away mid-download: nothing to answer
            self.close_connection = True
            summary = summary or "client went away"
        except Exception:
            log.exception("App API %s %s failed", self.command, url.path)
            status = 500
            self._send(500, {"error": "internal error"})
        finally:
            api.audit({"ts": time.time(), "ip": self.client_address[0], "method": self.command, "path": url.path,
                       "status": status, "ms": int((time.monotonic() - started) * 1000), "summary": summary, **extra})

    def _upgrade(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if (self.headers.get("Upgrade", "").lower() != "websocket" or "upgrade" not in self.headers.get("Connection", "").lower()
                or self.headers.get("Sec-WebSocket-Version") != "13" or not ws.valid_key(key)):
            raise ApiError(400, "not a WebSocket upgrade")
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", ws.accept_key(key))
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True
        self.connection.settimeout(PING_EVERY * 3)
        self.server.api.stream(self.connection)
        return 101

    do_GET = do_POST = do_PATCH = do_DELETE = do_PUT = _handle


def create(config: dict):
    return AppApi(config)
