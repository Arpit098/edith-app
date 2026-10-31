"""Adding an account with Claude Code's own login, headless (contracts/accounts.md, "Add").

`claude auth login --claudeai` runs with CLAUDE_CONFIG_DIR set to a fresh private folder, so the
live login is never touched. With no browser it prints the sign-in URL and then reads the code from
stdin, no TTY needed. The app shows the URL, Arpit signs in on his phone and pastes the code, which
goes to the process's stdin; on success the folder holds the new .credentials.json and .claude.json
(oauthAccount), which Profiles.add saves. The process's output is read only for the URL and a
failure message; it is never logged.

One login at a time; it expires after `ttl` seconds (the process is killed and its folder removed).
"""
import os
import re
import secrets
import shutil
import subprocess
import threading
import time

ESCAPES = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]")
URL = re.compile(r"https://\S+/oauth/authorize\?\S+")
CODE = re.compile(r"^[A-Za-z0-9_#.~-]{8,512}$")  # what the sign-in page shows: <code>#<state>
PROMPT = re.compile(r"^\s*Paste code here if prompted >")
SECRETISH = re.compile(r"[A-Za-z0-9_-]{24,}")


class LoginError(Exception):
    pass


def plain(text: str) -> str:
    return ESCAPES.sub("", text).replace("\r", "\n")


def failure_line(text: str) -> str:
    """The last line of the output, for the app: "Login failed: That code wasn't accepted…"."""
    lines = [PROMPT.sub("", ln).strip() for ln in plain(text).splitlines()]
    line = next((ln for ln in reversed(lines) if ln), "")
    return SECRETISH.sub("…", line)[:200] or "the login failed"


class Login:
    """One `claude auth login`: start() -> the URL, finish(code) -> the config folder it logged in to."""

    def __init__(self, claude: str, root: str, env: dict, url_timeout=30.0, finish_timeout=90.0,
                 popen=subprocess.Popen, clock=time.monotonic):
        self.id = secrets.token_hex(4)
        self.dir = os.path.join(root, f".login-{self.id}")
        self.claude, self.env, self._popen, self._clock = claude, env, popen, clock
        self.url_timeout, self.finish_timeout = url_timeout, finish_timeout
        self.started = clock()
        self.url: str | None = None
        self._out = ""
        self._changed = threading.Condition()
        self._proc = None
        self._eof = False

    def start(self) -> str:
        os.makedirs(self.dir, mode=0o700)
        env = dict(self.env, CLAUDE_CONFIG_DIR=self.dir, BROWSER="/bin/false", NO_COLOR="1")
        self._proc = self._popen([self.claude, "auth", "login", "--claudeai"], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=self.dir,
                                 start_new_session=True)
        threading.Thread(target=self._read, name=f"accounts-login-{self.id}", daemon=True).start()
        with self._changed:  # woken by each chunk of output (no polling)
            self._changed.wait_for(lambda: self._find_url() or self._eof, self.url_timeout)
        if not self.url:
            self.cancel()
            raise LoginError("Claude's login didn't give a sign-in link" + (f": {failure_line(self._out)}" if self._eof else ""))
        return self.url

    def _find_url(self) -> bool:
        m = URL.search(plain(self._out))
        if m:
            self.url = m.group(0)
        return bool(m)

    def _read(self):
        stream = self._proc.stdout
        while True:
            chunk = stream.read1(4096) if hasattr(stream, "read1") else stream.read(4096)
            with self._changed:
                if not chunk:
                    self._eof = True
                else:
                    self._out = (self._out + chunk.decode(errors="replace"))[-16384:]
                self._changed.notify_all()
            if not chunk:
                return

    def finish(self, code: str) -> str:
        """Paste the code; wait for the login to end. -> the config folder (LoginError if it failed)."""
        code = (code or "").strip()
        if not CODE.match(code):
            raise LoginError("that doesn't look like a sign-in code")
        try:
            self._proc.stdin.write(code.encode() + b"\n")
            self._proc.stdin.close()
        except (OSError, ValueError):
            raise LoginError("the login has already ended; start again") from None
        try:
            rc = self._proc.wait(self.finish_timeout)
        except subprocess.TimeoutExpired:
            self.cancel()
            raise LoginError("Claude's login didn't finish in time") from None
        with self._changed:
            self._changed.wait_for(lambda: self._eof, 5)
        if rc != 0:
            detail = failure_line(self._out)
            self.cancel()
            raise LoginError(detail)
        return self.dir

    def expired(self, ttl: float) -> bool:
        return self._clock() - self.started > ttl

    def cancel(self) -> None:
        """Stop the process (if it runs) and remove its folder."""
        if self._proc:
            if self._proc.poll() is None:
                self._proc.kill()
                try:
                    self._proc.wait(5)
                except subprocess.TimeoutExpired:
                    pass
            for pipe in (self._proc.stdin, self._proc.stdout):
                try:
                    pipe.close()
                except (OSError, ValueError):
                    pass
        shutil.rmtree(self.dir, ignore_errors=True)
