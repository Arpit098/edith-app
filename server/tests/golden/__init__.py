"""Golden files: what the legacy code did for fixed inputs, recorded from it while it was still in
this repo (server/legacy/, deleted at the end of Phase 1). The new code is held to them:

    assert_matches(self, "commands/help_and_start.json", world.calls())

They are never re-recorded from the new code: there is no longer a reference to record them from.
A golden file changes only by a reviewed edit, when the intended behaviour changes.
"""
import json
import pathlib

DATA = pathlib.Path(__file__).parent / "data"


def render(value) -> str:
    if isinstance(value, str):
        return value if value.endswith("\n") else value + "\n"
    return json.dumps(value, indent=1, ensure_ascii=False, sort_keys=True) + "\n"


def load(name: str):
    """A JSON golden file's value."""
    return json.loads((DATA / name).read_text())


def assert_matches(test, name: str, value) -> None:
    """`value` must be exactly what the golden file `name` recorded (rendered the same way)."""
    path = DATA / name
    if not path.exists():
        test.fail(f"no golden file {name}")
    test.maxDiff = None
    test.assertEqual(render(value), path.read_text(), f"differs from golden file {name}")
