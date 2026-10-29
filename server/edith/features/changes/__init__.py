"""Changes: uncommitted changes across Arpit's repos, as a text summary plus a phone-friendly HTML diff.

For now it is the `changes.py` script EDITH runs (report.py, through the wrapper at
~/edith/bin/changes.py). `/changes` stays a quick action that asks EDITH to run it
(features/quick_actions, step 5), so this feature registers nothing yet.
"""
from edith.core import Context, Feature


def setup(ctx: Context) -> None:
    pass


FEATURE = Feature(name="changes", setup=setup, description="Uncommitted changes report (changes.py)")
