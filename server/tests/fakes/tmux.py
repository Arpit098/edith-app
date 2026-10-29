"""A fake `tmux -L edith …` for the main lane.

Same call shape as the bridge's tmux(*args, input=None), returning a CompletedProcess. Pasted text
is "submitted" on the next Enter, and `on_submit(text)` lets a test play the hooks' part
(e.g. append a prompt/stop event).
"""
import subprocess


class FakeTmux:
    def __init__(self, alive: bool = True, pane: str = "❯ ", on_submit=None):
        self.alive, self.pane, self.on_submit = alive, pane, on_submit
        self.calls: list[tuple] = []
        self.submitted: list[str] = []   # pasted text that was sent with Enter
        self.typed: list[str] = []       # literal keys (send-keys -l), e.g. "/clear"
        self.keys: list[str] = []        # named keys: Enter, Escape
        self.respawned: list[str] = []   # respawn-pane commands
        self._buffers: dict[str, str] = {}
        self._pending: str | None = None

    def __call__(self, *args, input=None):
        self.calls.append(args)
        cmd, rc, out = args[0], 0, ""
        if cmd == "has-session":
            rc = 0 if self.alive else 1
        elif cmd == "capture-pane":
            rc, out = (0, self.pane) if self.alive else (1, "")
        elif cmd == "load-buffer":
            self._buffers[args[args.index("-b") + 1]] = input or ""
        elif cmd == "paste-buffer":
            self._pending = (self._pending or "") + self._buffers.pop(args[args.index("-b") + 1], "")
        elif cmd == "send-keys":
            self._send_keys(list(args[1:]))
        elif cmd == "respawn-pane":
            self.respawned.append(args[-1])
            self.alive = True
        elif cmd == "kill-server":
            self.alive = False
        return subprocess.CompletedProcess(("tmux", "-L", "edith") + args, rc, out, "")

    def _send_keys(self, rest: list[str]) -> None:
        literal = False
        while rest:
            a = rest.pop(0)
            if a == "-t":
                rest.pop(0)
            elif a == "-l":
                literal = True
            elif literal:
                self.typed.append(a)
                self._pending = (self._pending or "") + a
            else:
                self.keys.append(a)
                if a == "Enter" and self._pending is not None:
                    text, self._pending = self._pending, None
                    self.submitted.append(text)
                    if self.on_submit:
                        self.on_submit(text)
