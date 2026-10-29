"""A throwaway HOME laid out like edith's, so no test ever touches the live ~/edith or ~/.cache/edith.

(The legacy code this repo replaced is gone since Phase 1's step 10. What it did is kept in
tests/golden/data/: recorded from it while it was still here, and the new code is held to those files.)
"""
import contextlib
import json
import os
import pathlib
import tempfile

ALLOWED = 111  # Arpit's chat/user id in tests


@contextlib.contextmanager
def temp_home(**env):
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
