"""Calendar: Arpit's Google Calendar through the calendar port (adapters/google).

For now it is the `gcal.py` script EDITH runs (cli.py, through the wrapper at
~/edith/google/gcal.py). `/today` stays a quick action (features/quick_actions, step 5), so this
feature registers nothing yet.
"""
from edith.core import Context, Feature


def setup(ctx: Context) -> None:
    pass


FEATURE = Feature(name="calendar", setup=setup, description="Google Calendar (gcal.py)")
