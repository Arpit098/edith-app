"""Golden files: what the legacy code did for fixed inputs, recorded so the new code can be held to it.

    assert_golden(self, "bridge/help.json", fake_telegram.record())

Record or re-record with `UPDATE_GOLDEN=1 make test`, then review the diff in the PR. The files in
tests/golden/data/ stay after server/legacy/ is deleted; the new code's tests compare against them.
"""
import json
import os
import pathlib

DATA = pathlib.Path(__file__).parent / "data"


def render(value) -> str:
    if isinstance(value, str):
        return value if value.endswith("\n") else value + "\n"
    return json.dumps(value, indent=1, ensure_ascii=False, sort_keys=True) + "\n"


def assert_golden(test, name: str, value) -> None:
    path, text = DATA / name, render(value)
    if os.environ.get("UPDATE_GOLDEN") == "1":
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return
    if not path.exists():
        test.fail(f"no golden file {name}; record it with UPDATE_GOLDEN=1 make test")
    test.maxDiff = None
    test.assertEqual(text, path.read_text(), f"differs from golden file {name}")
