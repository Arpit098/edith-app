"""Mail: Arpit's Gmail through the mail port (adapters/google).

For now it is the `gmail.py` script EDITH runs (cli.py, through the wrapper at
~/edith/google/gmail.py). `/mail` stays a quick action that asks EDITH to summarise unread mail
(features/quick_actions, step 5), so this feature registers nothing yet.
"""
from edith.core import Context, Feature


def setup(ctx: Context) -> None:
    pass


FEATURE = Feature(name="mail", setup=setup, description="Gmail (gmail.py)")
