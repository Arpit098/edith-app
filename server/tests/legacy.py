"""Load the legacy code (server/legacy/edith) inside a throwaway HOME, to record golden files.

Nothing touches the live ~/edith or ~/.cache/edith: legacy modules compute their paths from HOME
when imported, so each load() inside legacy_home() sees only the temp directory. Delete this file
with server/legacy/ at the end of Phase 1; the golden files stay.
"""
import contextlib
import importlib.util
import json
import os
import pathlib
import sys
import tempfile

LEGACY = pathlib.Path(__file__).resolve().parents[1] / "legacy" / "edith"
ALLOWED = 111  # Arpit's chat/user id in tests


@contextlib.contextmanager
def legacy_home(**env):
    """A temp HOME laid out like edith's (allowlist with ALLOWED), with env vars set while inside."""
    with tempfile.TemporaryDirectory() as home:
        tg_dir = os.path.join(home, ".claude/channels/telegram")
        for d in (tg_dir, ".cache/edith/perms", "edith/inbox", ".claude/projects/-home-ubuntu-edith"):
            os.makedirs(os.path.join(home, d), exist_ok=True)
        with open(os.path.join(tg_dir, "access.json"), "w") as f:
            json.dump({"allowFrom": [str(ALLOWED)]}, f)
        values = {"HOME": home, "TELEGRAM_BOT_TOKEN": "test-token", "TELEGRAM_STATE_DIR": tg_dir, **env}
        saved = {k: os.environ.get(k) for k in values}
        os.environ.update(values)
        try:
            yield pathlib.Path(home)
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


def load(relpath, extra_paths=(), modules=None):
    """Import a legacy file as a fresh module: `relpath` under legacy/edith/, or any absolute path
    (e.g. a temp copy of the bridge next to a wrapper). Its sibling imports (the bridge's
    `import reminders`) are reloaded too, so they pick up the current HOME. `extra_paths` go on
    sys.path while it loads (e.g. legacy/edith/bridge for bin/remind.py). `modules` stand in for
    imports while it loads (e.g. a fake `gauth` for google/gmail.py, so nothing reaches Google)."""
    path = pathlib.Path(relpath) if pathlib.Path(relpath).is_absolute() else LEGACY / relpath
    dirs = [path.parent, *map(pathlib.Path, extra_paths)]
    siblings = {f.stem for d in dirs for f in d.glob("*.py")} | set(modules or {})
    for name in siblings:
        sys.modules.pop(name, None)
    sys.modules.update(modules or {})
    before = list(sys.path)
    sys.path[:0] = [str(d) for d in extra_paths]
    spec = importlib.util.spec_from_file_location(f"legacy_{path.stem}", path)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path[:] = before  # undo the module's own sys.path.insert
        for name in siblings:
            sys.modules.pop(name, None)
    return module
