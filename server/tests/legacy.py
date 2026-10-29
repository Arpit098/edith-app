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


def load(relpath: str):
    """Import legacy/edith/<relpath> as a fresh module. Its sibling imports (e.g. the bridge's
    `import reminders`) are reloaded too, so they also pick up the current HOME."""
    path = LEGACY / relpath
    for sibling in path.parent.glob("*.py"):
        sys.modules.pop(sibling.stem, None)
    before = list(sys.path)
    spec = importlib.util.spec_from_file_location(f"legacy_{path.stem}", path)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path[:] = before  # undo the module's own sys.path.insert
        for sibling in path.parent.glob("*.py"):
            sys.modules.pop(sibling.stem, None)
    return module
