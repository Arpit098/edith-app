"""A fake `tmux -L edith …` for the main lane.

Same call shape as the bridge's tmux(*args, input=None), returning a CompletedProcess. Pasted or
typed text shows on the screen (capture-pane) until Enter, like Claude's input box, and is
"submitted" on Enter. `on_submit(text)` and `on_key(name)` let a test play the tmux Claude's part
(e.g. append hook events, or an interrupt line on Escape).
"""
import subprocess

PROMPT = "❯ "


class FakeTmux:
    def __init__(self, alive: bool = True, pane: str = PROMPT, on_submit=None, on_key=None):
        self.alive, self.pane, self.on_submit, self.on_key = alive, pane, on_submit, on_key
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
            self._type(self._buffers.pop(args[args.index("-b") + 1], ""))
        elif cmd == "send-keys":
            self._send_keys(list(args[1:]))
        elif cmd == "respawn-pane":
            self.respawned.append(args[-1])
            self.alive = True
        elif cmd == "kill-server":
            self.alive = False
        return subprocess.CompletedProcess(("tmux", "-L", "edith") + args, rc, out, "")

    def _type(self, text):
        self._pending = (self._pending or "") + text
        if self.pane.startswith(PROMPT):
            self.pane = PROMPT + self._pending

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
                self._type(a)
            else:
                self.keys.append(a)
                if a == "C-u":  # clears the input line (and any suggestion in it), as in Claude Code
                    self._pending = None
                    if self.pane.startswith(PROMPT):
                        self.pane = PROMPT
                elif a == "Enter" and self._pending is not None:
                    text, self._pending = self._pending, None
                    if self.pane.startswith(PROMPT):
                        self.pane = PROMPT
                    self.submitted.append(text)
                    if self.on_submit:
                        self.on_submit(text)
                elif self.on_key:
                    self.on_key(a)
