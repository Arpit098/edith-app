"""Step 5 (docs/PHASE1_PLAN.md): sessions, approvals, control and quick actions must answer every
command and button exactly like the legacy bridge.

Each scenario runs in a world built from one fixture (a temp HOME with three conversations, a
side-lane fork and a current tmux session): the new features on the real claude_tmux adapter
(FakeTmux), with their replies, buttons and button results turned into the Telegram calls the
step 6 frontend makes. The legacy bridge's Telegram calls for the same scenario are the golden
files in tests/golden/data/commands/. Reactions and "typing…" are the frontend's (step 6) and
were left out of those.
"""
import json
import os
import pathlib
import re
import time
import unittest
from unittest import mock

from edith.adapters.agents.claude_tmux.backend import ClaudeTmux
from edith.adapters.agents.claude_tmux.tmux import Tmux
from edith.core import CommandCall, EventBus, Ports, Registry, load_features
from edith.ports.agent import RunInfo, StopResult
from tests.fakes import FakeTmux, run_workers
from tests.golden import assert_matches, load as golden
from tests.home import temp_home

NOW = 1793600000.0
STAMP = "2026-11-02 10:43 IST"
CURRENT = "c0ffee01-1111-4aaa-8bbb-000000000001"
OLD = "0dd5e55e-2222-4aaa-8bbb-000000000002"
OLDER_DUP = "0dd5e55f-3333-4aaa-8bbb-000000000003"
FORK = "f04c0000-4444-4aaa-8bbb-000000000004"
FEATURES = ["sessions", "control", "quick_actions", "approvals", "reminders"]


def transcripts_dir(home):
    return home / ".claude/projects" / re.sub(r"[^A-Za-z0-9]", "-", str(home / "edith"))


def write_session_file(home, sid, ts):
    state = home / ".cache/edith"
    tmp = state / "tmux-session.json.tmp"
    tmp.write_text(json.dumps({"session_id": sid, "transcript_path": str(transcripts_dir(home) / f"{sid}.jsonl"),
                               "source": "resume", "ts": ts}))
    os.replace(tmp, state / "tmux-session.json")


def build_fixture(home):
    folder = transcripts_dir(home)
    folder.mkdir(parents=True)
    for sid, title, mtime in ((CURRENT, "Fix the disk alert", NOW - 120), (OLD, "YouTube automation ideas", NOW - 7200),
                              (OLDER_DUP, "YouTube automation ideas", NOW - 90000), (FORK, "A side lane fork", NOW - 60)):
        path = folder / f"{sid}.jsonl"
        path.write_text(json.dumps({"type": "user", "message": {"content": f"[Telegram message from Arpit, x]\n{title}"}}) + "\n")
        os.utime(path, (mtime, mtime))
    (home / ".cache/edith").mkdir(parents=True, exist_ok=True)
    write_session_file(home, CURRENT, 1.0)
    (home / ".cache/edith/bridge-state.json").write_text(json.dumps(
        {"sessions": {"111": CURRENT}, "side_sessions": [FORK], "offset": 5}))


class SwitchingTmux(FakeTmux):
    """A FakeTmux whose respawn-pane restarts "Claude" in the given conversation: the SessionStart
    hook then rewrites tmux-session.json, as on edith."""

    def __init__(self, home):
        super().__init__()
        self.home = home

    def __call__(self, *args, input=None):
        result = super().__call__(*args, input=input)
        if args[0] == "respawn-pane":
            write_session_file(self.home, args[-1].split()[-1], time.time() + 1)
        return result


class NewWorld:
    def __init__(self, home):
        self.home = home
        build_fixture(home)
        self.tmux = SwitchingTmux(home)
        self.agent = ClaudeTmux({"chat_key": "111"},
                                tmux=Tmux(runner=self.tmux, start_service=lambda: None, settle_limit=0.2, settle_step=0.01))
        self.sent = []
        self.agent.send = lambda text, origin, ref, force_queue=False, parallel=False: self.sent.append([text, force_queue])
        self.bus, self.registry = EventBus(), Registry()
        report = load_features(FEATURES, self.bus, Ports(agent=self.agent), self.registry, {})
        assert report.loaded == FEATURES, report.failed
        self._calls, self._ids, self._system = [], iter(range(1000, 2000)), {}
        self.bus.subscribe("message.system", self._system_message)
        self.bus.subscribe("message.buttons_cleared", self._clear_buttons)

    # What the step 6 Telegram frontend sends for each kind of output.
    def _send(self, chat, out):
        call = {"method": "sendMessage", "chat_id": chat, "text": out if isinstance(out, str) else out.text}
        if not isinstance(out, str) and out.buttons:
            call["reply_markup"] = {"inline_keyboard": [[{"text": b.label, "callback_data": b.action} for b in row]
                                                        for row in out.buttons]}
        self._calls.append(call)
        return next(self._ids)

    def _system_message(self, ev):
        rows = ev.data["buttons"]
        # To the chat of the turn it belongs to; else the first allowed chat (a string, as legacy read it).
        call = {"method": "sendMessage", "chat_id": 111 if ev.data.get("ref") else "111", "text": ev.data["text"]}
        if rows:
            call["reply_markup"] = {"inline_keyboard": [[{"text": b["label"], "callback_data": b["action"]} for b in row]
                                                        for row in rows]}
        self._calls.append(call)
        self._system[ev.data.get("key")] = next(self._ids)

    def _clear_buttons(self, ev):
        self._calls.append({"method": "editMessageReplyMarkup", "chat_id": "111",
                            "message_id": self._system[ev.data["key"]], "reply_markup": {"inline_keyboard": []}})

    def send(self, text, prompt=None):
        name, _, args = text[1:].partition(" ")
        out = self.registry.commands[name].handler(CommandCall(args, "telegram", lambda r: self._send(111, r), "7", prompt))
        if out is not None:
            self._send(111, out)

    def press(self, data, text=""):
        """Telegram answers the button first; replies made while the handler runs wait until then,
        later ones (e.g. from the switch job) go straight out."""
        held, holding = [], [True]

        def reply(r):
            if holding[0]:
                held.append(r)
            else:
                self._send(111, r)
        result = self.registry.press(data, "telegram", reply)
        holding[0] = False
        answer = {"method": "answerCallbackQuery", "callback_query_id": "cb1"}
        if result and result.toast:
            answer["text"] = result.toast
        self._calls.append(answer)
        if result and result.note:
            self._calls.append({"method": "editMessageText", "chat_id": 111, "message_id": 500,
                                "text": f"{text}\n\n{result.note}"})
        for r in held:
            self._send(111, r)

    def settle(self):
        run_workers(self.registry)  # the switch worker's queued switches, here and now

    def busy(self):
        self.agent.main_busy.set()

    def forget_conversation(self):
        self.agent.state.update(lambda s: s.__setitem__("sessions", {}))

    def no_tmux_session(self):
        (self.home / ".cache/edith/tmux-session.json").unlink()

    def running(self, runs, queued=0):
        infos = [RunInfo(f"r{i}", lane, started, step) for i, (lane, started, step) in enumerate(runs)]
        self.agent.status = lambda: (infos, queued)
        self.agent.stop = lambda: StopResult(len(runs), [str(100 + i) for i in range(queued)])

    def permission(self, rid, tool, inp, lane=None):
        perms = self.home / ".cache/edith/perms"
        perms.mkdir(parents=True, exist_ok=True)
        (perms / f"{rid}.req.json").write_text(json.dumps({"id": rid, "tool_name": tool, "input": inp, "ts": NOW, "run": None}))
        detail = inp.get("command") or inp.get("file_path") or json.dumps(inp)[:500]
        from edith.core import Event
        self.bus.publish(Event("permission.request", {"id": rid, "tool": tool, "detail": detail,
                                                      "ref": "9" if lane else None, "lane": lane}, origin="telegram"))

    def permission_gone(self, rid):
        (self.home / ".cache/edith/perms" / f"{rid}.req.json").unlink()
        from edith.core import Event
        self.bus.publish(Event("permission.resolved", {"id": rid, "decision": "gone", "ref": None, "lane": None}))

    def dispatched(self):
        out, self.sent = self.sent, []
        return out

    def calls(self):
        return self._calls


# Each scenario drives a world and returns what to compare (the Telegram calls, plus anything else).
def help_and_start(w):
    w.send("/help")
    w.send("/start")


def menu(w):
    w.send("/menu")


def sessions(w):
    w.send("/sessions")


def resume_lists(w):
    w.send("/resume")
    w.send("/resume nothing-matches-this")


def resume_switch(w):
    w.send("/sessions")
    w.send("/resume 2")
    w.settle()
    return {"respawned": w.tmux.respawned[-1].split()[-1]}


def resume_by_name_and_already(w):
    w.send(f"/resume {CURRENT[:8]}")
    w.settle()


def switch_button_missing(w):
    w.press("sess:deadbeef-0000-4000-8000-000000000000")
    w.settle()


def switch_while_busy(w):
    w.busy()
    w.send("/sessions")
    w.send("/resume 2")
    w.settle()
    w.press(f"sess:{OLD}")
    w.settle()


def name(w):
    w.send("/name")
    w.send("/name    ")
    w.send("/name " + "Disk alert work " * 5)


def name_without_session(w):
    w.no_tmux_session()
    w.send("/name anything")


def new_idle(w):
    w.send("/new")
    return {"typed": w.tmux.typed}


def new_busy(w):
    w.busy()
    w.send("/new")


def stop_nothing(w):
    w.send("/stop")


def stop_running(w):
    w.running([("main", NOW - 30, "$ npm test")], queued=2)
    w.send("/stop")


def stop_queue_only(w):
    w.running([], queued=1)
    w.send("/stop")


def status_idle(w):
    w.send("/status")
    w.forget_conversation()
    w.no_tmux_session()
    w.send("/status")


def status_busy(w):
    w.running([("main", NOW - 75, "$ npm test"), ("side", NOW - 12, None)], queued=1)
    w.tmux.alive = False
    w.send("/status")


def restart(w):
    with mock.patch("os.kill") as kill:
        w.send("/restart")
        w.running([("main", NOW - 5, None)])
        w.send("/restart")
        w.send("/restart now")
    return {"kills": len(kill.call_args_list)}


def quick_commands(w):
    for c in ("brief", "mail", "today", "servers", "changes"):
        w.send(f"/{c}")
    return {"prompts": w.dispatched()}


def quick_buttons(w):
    w.press("quick:brief")
    w.press("quick:nope")
    return {"prompts": w.dispatched()}


def queue_command(w):
    w.send("/queue fix the build", prompt=f"[Telegram message from Arpit, {STAMP}]\nfix the build")
    w.send("/queue")
    return {"prompts": w.dispatched()}


def approvals(w):
    w.permission("ab12cd34", "Bash", {"command": "sudo systemctl restart nginx"})
    text = "🔐 Permission needed: Bash\n\nsudo systemctl restart nginx"
    w.press("perm:allow:ab12cd34", text=text)
    decision = (w.home / ".cache/edith/perms/ab12cd34.decision").read_text()
    w.permission_gone("ab12cd34")
    w.press("perm:deny:ab12cd34", text=text)  # already answered
    w.press("perm:maybe:ab12cd34")            # not a valid action
    w.permission("ee55ff66", "Write", {"file_path": "/home/ubuntu/.ssh/config"}, lane="side")
    w.press("perm:deny:ee55ff66", text="x")
    deny = (w.home / ".cache/edith/perms/ee55ff66.decision").read_text()
    # perm.py removes the request once it has read the answer. (Legacy re-sent the question if its
    # 0.5 s scan came between the tap and that cleanup; the new watcher tracks the file itself.)
    w.permission_gone("ee55ff66")
    w.permission("99887766", "Bash", {"command": "sudo reboot"})
    w.permission_gone("99887766")  # timed out, never answered here: its buttons are taken off
    return {"decision": decision, "deny": deny}


SCENARIOS = [help_and_start, menu, sessions, resume_lists, resume_switch, resume_by_name_and_already,
             switch_button_missing, switch_while_busy, name, name_without_session, new_idle, new_busy, stop_nothing,
             stop_running, stop_queue_only, status_idle, status_busy, restart, quick_commands, quick_buttons,
             queue_command, approvals]


def run(scenario):
    with temp_home() as home, mock.patch("time.time", return_value=NOW), \
            mock.patch("time.strftime", return_value=STAMP):
        world = NewWorld(home)
        extra = scenario(world) or {}
        return {"calls": world.calls(), **extra}


class BridgeCommandsTest(unittest.TestCase):
    maxDiff = None

    def test_every_command_and_button_matches_legacy(self):
        for scenario in SCENARIOS:
            with self.subTest(scenario.__name__):
                assert_matches(self, f"commands/{scenario.__name__}.json", run(scenario))  # what legacy sent

    def test_command_menu_comes_from_the_registry_in_legacy_order(self):
        with temp_home() as home:  # the menu is legacy's setMyCommands list, in its order
            self.assertEqual(NewWorld(home).registry.menu(), golden("commands/set_my_commands.json"))

    def test_features_only_use_ports_and_core(self):
        root = pathlib.Path(__file__).resolve().parents[2] / "edith" / "features"
        for name in ("sessions", "control", "quick_actions", "approvals"):
            source = (root / name / "__init__.py").read_text()
            self.assertNotIn("edith.adapters", source)
            self.assertNotIn("perms", re.sub(r"#.*|\"\"\"[\s\S]*?\"\"\"", "", source))  # no file scanning


if __name__ == "__main__":
    unittest.main()
