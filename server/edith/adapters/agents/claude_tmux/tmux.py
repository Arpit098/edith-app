"""The tmux session that hosts the interactive Claude (`tmux -L edith`, session `edith`)."""
import re
import subprocess
import time

READY = re.compile(r"^\s*❯", re.M)  # Claude's input box


def poll(check, timeout, first=0.1, most=1.0):
    """check() until it is true or `timeout` passes, waiting with backoff. Only for state that has
    no notification (what tmux shows on screen); everything with a file behind it uses watch.py."""
    deadline, delay = time.monotonic() + timeout, first
    while True:
        if check():
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(delay, remaining))
        delay = min(most, delay * 2)


class Tmux:
    def __init__(self, socket="edith", target="edith", service="edith-claude", runner=None, start_service=None,
                 settle_limit=2.0, settle_step=0.05):
        self.base, self.target, self.service = ["tmux", "-L", socket], target, service
        self._runner, self._start_service = runner, start_service
        self.settle_limit, self.settle_step = settle_limit, settle_step

    def __call__(self, *args, input=None):
        if self._runner:
            return self._runner(*args, input=input)
        return subprocess.run(self.base + list(args), input=input, capture_output=True, text=True, timeout=10)

    def alive(self):
        return self("has-session", "-t", self.target).returncode == 0

    def pane(self):
        r = self("capture-pane", "-p", "-t", self.target)
        return r.stdout if r.returncode == 0 else ""

    def start(self):
        if self._start_service:
            return self._start_service()
        subprocess.run(["systemctl", "--user", "start", self.service], capture_output=True, timeout=30)

    def wait_ready(self, timeout=90):
        """Make sure the tmux Claude is up and showing its input box (legacy: checked every 1 s)."""
        if not self.alive():
            self.start()
        return poll(lambda: self.alive() and bool(READY.search(self.pane())), timeout)

    def submit(self, text):
        """Paste text into Claude's input box (bracketed paste keeps newlines) and submit it."""
        before = self.pane()
        self("load-buffer", "-b", "tg", "-", input=text)
        self("paste-buffer", "-p", "-d", "-b", "tg", "-t", self.target)
        self._settle(before)
        self("send-keys", "-t", self.target, "Enter")

    def command(self, cmd):
        """Run a slash command (e.g. /clear) in the tmux Claude."""
        before = self.pane()
        self("send-keys", "-t", self.target, "-l", cmd)
        self._settle(before)
        self("send-keys", "-t", self.target, "Enter")

    def interrupt(self):
        self("send-keys", "-t", self.target, "Escape")  # like pressing Esc

    def respawn(self, command):
        self("respawn-pane", "-k", "-t", self.target, command)

    def _settle(self, before):
        """Wait until the screen shows the input (it changed, then held still for one check), at most
        settle_limit seconds; legacy slept a fixed 0.7 s (paste) or 0.5 s (command) instead."""
        last, step = before, self.settle_step
        deadline = time.monotonic() + self.settle_limit
        while time.monotonic() < deadline:
            time.sleep(step)
            now = self.pane()
            if now != before and now == last:
                return
            last, step = now, min(0.2, step * 2)
