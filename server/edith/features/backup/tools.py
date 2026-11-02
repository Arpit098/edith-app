"""The backup AI's tools: read-only, a fixed list, no shell (contracts/backup.md, "Tools").

Files: only under the allowed roots (~/edith, ~/Projects, the inbox), judged on the real path (every
symlink and `..` resolved first) and on the path as asked. Never: ~/.config, ~/.claude, ~/.ssh and
other home dot-folders, any dot-file or dot-folder except a few harmless ones (.github, .gitignore…),
.git, key, token, secret, credential and password files, .env files, certificates and keystores,
~/edith/google (mail and calendar), the state folder (message log, tokens) and the Telegram folder.
Blocked entries are hidden from listings and searches, so the model doesn't even see their names.

Commands: a few read-only ones with fixed argv (systemctl --user status, journalctl --user for the
edith services, disk/memory/uptime), and EDITH's own tools from ~/edith/bin through BIN_TOOLS: a small
registry of (name, argv template, argument patterns, read-only flag). Only read-only entries are ever
offered. Each run has a timeout, a small environment and no shell.

Every result goes through redact.scrub before it is sent out (the loop does that), and is cut to
MAX_RESULT characters.
"""
import html
import ipaddress
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Callable

MAX_RESULT = 12000       # characters of one tool result
MAX_FILE = 256 * 1024    # bytes read from one file
MAX_FETCH = 512 * 1024   # bytes read from one web page
MAX_GREP_FILES = 4000
MAX_GREP_HITS = 60
GREP_FILE = 1024 * 1024  # files bigger than this aren't searched
CMD_TIMEOUT = 20.0
WEB_TIMEOUT = 15.0
SAFE_DOTS = {".github", ".gitignore", ".gitattributes", ".editorconfig", ".nvmrc", ".prettierrc", ".prettierrc.json",
             ".eslintrc", ".eslintrc.js", ".eslintrc.json", ".dockerignore", ".gitkeep", ".python-version"}
BLOCKED_NAME = re.compile(
    r"(?i)(?:^|[._-])(?:keys?|tokens?|secrets?|credentials?|creds|passwords?|passwd|cookies?|oauth|auth)(?:[._-]|$)"
    r"|\.(?:pem|key|p12|pfx|jks|keystore|crt|cer|der|asc|gpg|kdbx|ovpn|ppk|sqlite|db)$"
    r"|^id_(?:rsa|dsa|ecdsa|ed25519)|^authorized_keys$|^known_hosts$|^\.?env(?:\..*)?$|^\.?netrc$|^htpasswd$")
NOISE = {"node_modules", "__pycache__", "venv", ".venv", "dist", "build"}  # not secret, just skipped by grep
UNIT = re.compile(r"edith[A-Za-z0-9@._-]{0,60}")
MAIL_LOG = re.compile(r"edith\.(?:feature\.(?:mail|calendar)|adapter\.google)|gmail|calendar", re.I)


class ToolError(Exception):
    pass


# ---- paths ----

class PathPolicy:
    def __init__(self, home: str, roots: list[str], blocked: list[str], base: str):
        self.home = os.path.realpath(home)
        self.roots = [os.path.realpath(r) for r in roots]
        self.blocked = [os.path.realpath(b) for b in blocked]
        self.base = base  # relative paths are under this

    @staticmethod
    def _under(path, root):
        return path == root or path.startswith(root.rstrip("/") + "/")

    def _parts_ok(self, path):
        rel = os.path.relpath(path, self.home) if self._under(path, self.home) else path
        for part in rel.split(os.sep):
            if not part or part in (".", ".."):
                continue
            if part.startswith(".") and part not in SAFE_DOTS:
                return False
            if part == ".git" or BLOCKED_NAME.search(part):
                return False
        return True

    def allowed_real(self, real: str) -> bool:
        """Whether a resolved path may be read."""
        if not any(self._under(real, r) for r in self.roots):
            return False
        if any(self._under(real, b) for b in self.blocked):
            return False
        return self._parts_ok(real)

    def resolve(self, asked: str) -> str:
        """The real path of what the model asked for, or ToolError. Both the path as written (`..`
        collapsed) and the real one (symlinks followed) must pass."""
        if not isinstance(asked, str) or not asked.strip() or "\x00" in asked:
            raise ToolError("give a path")
        p = asked.strip()
        if p == "~" or p.startswith("~/"):
            p = self.home + p[1:]
        elif p.startswith(("$HOME/", "${HOME}/")):
            p = self.home + p[p.index("/"):]
        elif not os.path.isabs(p):
            p = os.path.join(self.base, p)
        written = os.path.normpath(p)
        real = os.path.realpath(written)
        if not (self.allowed_real(written) and self.allowed_real(real)):
            raise ToolError(f"{asked} is outside what the backup may read")
        return real


# ---- tool registry ----

@dataclass
class Tool:
    name: str
    description: str
    params: dict  # JSON-schema properties
    run: Callable[..., str]
    required: list[str] = field(default_factory=list)
    timeout: float = CMD_TIMEOUT

    def spec(self) -> dict:
        return {"type": "function", "function": {"name": self.name, "description": self.description, "parameters": {
            "type": "object", "properties": self.params, "required": self.required, "additionalProperties": False}}}


@dataclass(frozen=True)
class BinTool:
    """One of EDITH's tools in ~/edith/bin, offered to the backup as a named tool. `argv` is the
    script and its fixed words, with {name} parts filled from the arguments; each argument must
    fully match its pattern in `args`. Only `read_only` ones are ever offered. Adding one is one line."""
    name: str
    description: str
    argv: tuple[str, ...]
    args: dict = field(default_factory=dict)  # name -> regex
    read_only: bool = True


BIN_TOOLS = (
    BinTool("reminders_list", "Arpit's reminders: what is set and when it fires (IST).", ("remind.py", "list")),
    BinTool("project_changes", "Uncommitted changes in Arpit's project repos: a summary of files and +/- lines "
            "(no diff). `project` is part of a repo name, e.g. edith-app.", ("changes.py", "{project}"),
            {"project": r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}"}),
    BinTool("agents_status", "The coding agents in tmux: busy, idle or blocked, and their last line.",
            ("agent.py", "status")),
    # Never offered (they change things; such requests go to "queue for Claude"): remind.py add/cancel,
    # agent.py send/compact/watch/read.
)


def run_cmd(argv: list[str], timeout: float, env: dict) -> str:
    try:
        r = subprocess.run(argv, capture_output=True, text=True, errors="replace", timeout=timeout, env=env,
                           stdin=subprocess.DEVNULL, start_new_session=True)
    except subprocess.TimeoutExpired:
        raise ToolError(f"timed out after {timeout:.0f}s") from None
    except OSError as e:
        raise ToolError(f"couldn't run it ({type(e).__name__})") from None
    out = (r.stdout or "") + (("\n" + r.stderr) if r.returncode and r.stderr else "")
    return out.strip() or f"(no output, exit {r.returncode})"


def bin_argv(tool: BinTool, bin_dir: str, given: dict) -> list[str]:
    """The argv for one BinTool call, or ToolError: unknown or missing arguments, or one that doesn't
    fully match its pattern."""
    if not tool.read_only:
        raise ToolError(f"{tool.name} changes things; ask Claude")
    given = given or {}
    extra = set(given) - set(tool.args)
    if extra:
        raise ToolError(f"unknown argument(s): {', '.join(sorted(extra))}")
    values = {}
    for name, pattern in tool.args.items():
        v = given.get(name)
        if not isinstance(v, str) or not re.fullmatch(pattern, v):
            raise ToolError(f"{name} must match {pattern}")
        values[name] = v
    script, *words = tool.argv
    path = os.path.join(bin_dir, script)
    if not os.path.isfile(path):
        raise ToolError(f"{script} isn't installed")
    return ["python3", "-I", path] + [w.format(**values) for w in words]


# ---- the web ----

def public_host(host: str, resolver=socket.getaddrinfo) -> bool:
    """Whether every address `host` resolves to is a public one (no loopback, private, link-local,
    CGNAT/Tailscale, metadata or reserved addresses)."""
    try:
        infos = resolver(host, None)
    except (socket.gaierror, UnicodeError, OSError):
        return False
    if not infos:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved
                or ip.is_unspecified or ip in ipaddress.ip_network("100.64.0.0/10")
                or (ip.version == 6 and ip.ipv4_mapped and not public_ip(ip.ipv4_mapped))):
            return False
    return True


def public_ip(ip) -> bool:
    return not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_unspecified
                or ip in ipaddress.ip_network("100.64.0.0/10"))


class PublicOnly(urllib.request.HTTPRedirectHandler):
    def __init__(self, check):
        self.check = check

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.check(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


TAG = re.compile(r"<(script|style|noscript|svg|head)\b.*?</\1>|<[^>]+>", re.S | re.I)


def page_text(raw: bytes, ctype: str) -> str:
    text = raw.decode("utf-8", "replace")
    if "html" in ctype or text.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        text = html.unescape(TAG.sub(" ", text))
    return re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n\n", text)).strip()


# ---- the tool set ----

class Tools:
    """The backup's tools for one bridge. `status` returns EDITH's status (the GET /v1/status
    answer) or None; `queue` puts a task in Claude's queue and returns its id."""

    def __init__(self, policy: PathPolicy, bin_dir: str, queue: Callable[[str], str], status: Callable[[], dict | None],
                 env: dict, opener=None, resolver=socket.getaddrinfo, run=run_cmd, bin_tools=BIN_TOOLS):
        self.policy, self.bin_dir, self.env, self.resolver, self._run = policy, bin_dir, env, resolver, run
        self._queue, self._status = queue, status
        self._opener = opener
        self.tools: dict[str, Tool] = {}
        s = {"type": "string"}
        n = {"type": "integer"}
        self._add(Tool("read_file", "Read a text file under ~/edith, ~/Projects or the inbox. Lines are numbered.",
                       {"path": s, "start_line": n, "max_lines": n}, self.read_file, ["path"]))
        self._add(Tool("list_dir", "List a folder under ~/edith, ~/Projects or the inbox.", {"path": s}, self.list_dir,
                       ["path"]))
        self._add(Tool("grep", "Find lines containing `text` (plain text, not a regex; case-insensitive) in the "
                       "files under `path`.", {"text": s, "path": s}, self.grep, ["text", "path"]))
        self._add(Tool("service_status", "systemctl --user status of one of EDITH's services (edith-bridge, "
                       "edith-claude, …).", {"unit": s}, self.service_status, ["unit"]))
        self._add(Tool("service_logs", "The last lines of journalctl --user for one of EDITH's services.",
                       {"unit": s, "lines": n}, self.service_logs, ["unit"]))
        self._add(Tool("system_info", "Disk, memory, load and uptime of the server.", {}, self.system_info))
        self._add(Tool("edith_status", "EDITH's status: what her Claude is doing, lanes, the session, the coding "
                       "agents.", {}, self.edith_status))
        self._add(Tool("web_search", "Search the web (DuckDuckGo). Returns titles, links and snippets.",
                       {"query": s}, self.web_search, ["query"], timeout=WEB_TIMEOUT))
        self._add(Tool("fetch_url", "Fetch a public web page (http or https) as text.", {"url": s}, self.fetch_url,
                       ["url"], timeout=WEB_TIMEOUT))
        self._add(Tool("queue_for_claude", "Put a task in Claude's queue: anything that writes, sends, runs, "
                       "deploys, restarts or changes something. Arpit gets it with a 'Send to Claude' button when "
                       "Claude is back.", {"task": s}, self.queue_for_claude, ["task"]))
        for bt in bin_tools:
            if bt.read_only:  # anything else is never offered
                self._add(Tool(bt.name, bt.description, {k: s for k in bt.args},
                               lambda _bt=bt, **kw: self._run(bin_argv(_bt, self.bin_dir, kw), CMD_TIMEOUT, self.env),
                               list(bt.args)))

    def _add(self, tool):
        self.tools[tool.name] = tool

    def specs(self) -> list[dict]:
        return [t.spec() for t in self.tools.values()]

    def call(self, name: str, arguments: str) -> str:
        """Run one tool call from the model. Errors come back as text for the model, never raised."""
        tool = self.tools.get(name)
        if tool is None:
            return f"error: there is no tool {name!r}"
        try:
            args = json.loads(arguments or "{}")
            if not isinstance(args, dict):
                raise ValueError
        except ValueError:
            return "error: the arguments must be a JSON object"
        unknown = set(args) - set(tool.params)
        if unknown:
            return f"error: unknown argument(s) {', '.join(sorted(unknown))}"
        missing = [k for k in tool.required if k not in args]
        if missing:
            return f"error: missing {', '.join(missing)}"
        try:
            out = tool.run(**args)
        except ToolError as e:
            return f"error: {e}"
        except Exception as e:  # a tool bug must not end the reply
            return f"error: {type(e).__name__}"
        out = str(out)
        return out if len(out) <= MAX_RESULT else out[:MAX_RESULT] + "\n… (cut)"

    # ---- files ----

    def read_file(self, path, start_line=1, max_lines=200):
        real = self.policy.resolve(path)
        if os.path.isdir(real):
            raise ToolError("that's a folder; use list_dir")
        try:
            fd = os.open(real, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
        except OSError as e:
            raise ToolError(f"can't open it ({e.strerror})") from None
        with os.fdopen(fd, "rb") as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                raise ToolError("not a regular file")
            raw = f.read(MAX_FILE)
        if b"\x00" in raw[:4096]:
            raise ToolError("a binary file")
        lines = raw.decode("utf-8", "replace").splitlines()
        start = max(1, int(start_line or 1))
        count = max(1, min(int(max_lines or 200), 500))
        part = lines[start - 1:start - 1 + count]
        body = "\n".join(f"{i}\t{ln}" for i, ln in enumerate(part, start))
        more = len(lines) > start - 1 + count
        return body + (f"\n… {len(lines) - (start - 1 + count)} more lines" if more else "") if body else "(empty)"

    def list_dir(self, path):
        real = self.policy.resolve(path)
        if not os.path.isdir(real):
            raise ToolError("not a folder")
        out = []
        with os.scandir(real) as it:
            for e in sorted(it, key=lambda e: e.name):
                target = os.path.realpath(e.path)
                if not (self.policy.allowed_real(e.path) and self.policy.allowed_real(target)):
                    continue  # hidden: blocked names and links into blocked places
                kind = "dir" if e.is_dir() else "link" if e.is_symlink() else "file"
                size = ""
                if kind == "file":
                    try:
                        size = f" {e.stat().st_size} B"
                    except OSError:
                        pass
                out.append(f"{e.name}{'/' if kind == 'dir' else ''}{size}")
                if len(out) >= 300:
                    out.append("… (more)")
                    break
        return "\n".join(out) or "(empty, or nothing the backup may see)"

    def grep(self, text, path):
        if not isinstance(text, str) or not text.strip() or len(text) > 200:
            raise ToolError("give the text to find (at most 200 characters)")
        needle = text.lower()
        real = self.policy.resolve(path)
        hits, files, deadline = [], 0, time.monotonic() + CMD_TIMEOUT
        walk = [(real, [], [os.path.basename(real)])] if os.path.isfile(real) else os.walk(real, followlinks=False)
        for folder, dirs, names in walk:
            if os.path.isfile(real):
                folder = os.path.dirname(real)
            dirs[:] = [d for d in dirs if d not in NOISE and self.policy.allowed_real(os.path.join(folder, d))]
            for name in names:
                p = os.path.join(folder, name)
                rp = os.path.realpath(p)
                if not (self.policy.allowed_real(p) and self.policy.allowed_real(rp)) or not os.path.isfile(rp):
                    continue
                files += 1
                if files > MAX_GREP_FILES or time.monotonic() > deadline:
                    hits.append("… (stopped: too many files)")
                    return "\n".join(hits)
                try:
                    if os.path.getsize(rp) > GREP_FILE:
                        continue
                    with open(rp, "rb") as f:
                        raw = f.read()
                except OSError:
                    continue
                if b"\x00" in raw[:4096]:
                    continue
                for i, line in enumerate(raw.decode("utf-8", "replace").splitlines(), 1):
                    if needle in line.lower():
                        hits.append(f"{p}:{i}: {line.strip()[:200]}")
                        if len(hits) >= MAX_GREP_HITS:
                            hits.append("… (more)")
                            return "\n".join(hits)
        return "\n".join(hits) or "no matches"

    # ---- the server ----

    def _unit(self, unit):
        if not isinstance(unit, str) or not UNIT.fullmatch(unit.removesuffix(".service")):
            raise ToolError("only EDITH's services (names starting with edith)")
        return unit

    def service_status(self, unit):
        return self._run(["systemctl", "--user", "status", "--no-pager", "--lines=0", self._unit(unit)], CMD_TIMEOUT,
                         self.env)

    def service_logs(self, unit, lines=50):
        n = max(1, min(int(lines or 50), 200))
        out = self._run(["journalctl", "--user", "-u", self._unit(unit), "-n", str(n), "--no-pager", "-o", "short-iso"],
                        CMD_TIMEOUT, self.env)
        # Mail and calendar never go to the backup: their log lines are dropped.
        return "\n".join(ln for ln in out.splitlines() if not MAIL_LOG.search(ln))

    def system_info(self):
        lines = []
        for label, path in (("/", "/"), ("home", self.policy.home)):
            try:
                u = shutil.disk_usage(path)
                lines.append(f"disk {label}: {u.used / 2**30:.1f} of {u.total / 2**30:.1f} GiB used "
                             f"({u.free / 2**30:.1f} GiB free)")
            except OSError:
                pass
        try:
            with open("/proc/meminfo") as f:
                mem = {k: int(v.split()[0]) for k, v in (ln.split(":", 1) for ln in f if ":" in ln)}
            lines.append(f"memory: {(mem['MemTotal'] - mem['MemAvailable']) / 2**20:.1f} of "
                         f"{mem['MemTotal'] / 2**20:.1f} GiB used; swap free {mem.get('SwapFree', 0) / 2**20:.1f} GiB")
        except (OSError, KeyError, ValueError):
            pass
        try:
            with open("/proc/uptime") as f:
                up = float(f.read().split()[0])
            lines.append(f"uptime: {int(up // 86400)}d {int(up % 86400 // 3600)}h {int(up % 3600 // 60)}m")
            lines.append("load: " + " ".join(f"{x:.2f}" for x in os.getloadavg()))
        except (OSError, ValueError):
            pass
        return "\n".join(lines) or "unavailable"

    def edith_status(self):
        st = self._status()
        return json.dumps(st, default=str)[:MAX_RESULT] if st is not None else "status isn't available"

    # ---- the web ----

    def _check_url(self, url):
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ("http", "https") or not u.hostname:
            raise ToolError("only http and https links")
        if u.username or u.password:
            raise ToolError("no credentials in links")
        if not public_host(u.hostname, self.resolver):
            raise ToolError("that address isn't on the public internet")

    def _get(self, url, data=None):
        self._check_url(url)
        opener = self._opener or urllib.request.build_opener(PublicOnly(self._check_url))
        req = urllib.request.Request(url, data=data, headers={"User-Agent": "Mozilla/5.0 (EDITH backup)",
                                                              "Accept": "text/html,text/plain,application/json"})
        try:
            with opener.open(req, timeout=WEB_TIMEOUT) as r:
                return r.read(MAX_FETCH), r.headers.get("Content-Type", "")
        except urllib.error.HTTPError as e:
            raise ToolError(f"HTTP {e.code}") from None
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise ToolError(f"couldn't fetch it ({type(getattr(e, 'reason', e)).__name__})") from None

    def fetch_url(self, url):
        if not isinstance(url, str) or len(url) > 2000:
            raise ToolError("give one link")
        raw, ctype = self._get(url.strip())
        return page_text(raw, ctype) or "(no text)"

    def web_search(self, query):
        if not isinstance(query, str) or not query.strip() or len(query) > 300:
            raise ToolError("give a search (at most 300 characters)")
        raw, _ = self._get("https://html.duckduckgo.com/html/", urllib.parse.urlencode({"q": query}).encode())
        page = raw.decode("utf-8", "replace")
        out = []
        for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>(.*?)(?=<a[^>]+class="result__a"|$)',
                             page, re.S):
            link = html.unescape(m.group(1))
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(link).query).get("uddg")
            link = q[0] if q else link
            title = html.unescape(TAG.sub("", m.group(2))).strip()
            snip = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', m.group(3), re.S)
            snippet = html.unescape(TAG.sub("", snip.group(1))).strip() if snip else ""
            out.append(f"- {title}\n  {link}\n  {snippet}")
            if len(out) >= 8:
                break
        return "\n".join(out) or "no results"

    # ---- Claude's queue ----

    def queue_for_claude(self, task):
        if not isinstance(task, str) or not task.strip():
            raise ToolError("say what Claude should do")
        qid = self._queue(task.strip()[:2000])
        return f"queued for Claude (#{qid}); Arpit gets a 'Send to Claude' button when Claude is back"
