"""Google Gmail + Calendar: one adapter package serving the mail and calendar ports with one login.

    [adapters]  mail = "google"   calendar = "google"
    [adapter.google]  credentials_dir = "~/.config/edith-google"   # OAuth client + token; never in git

Nothing touches Google or the token until the first call: create() only records the settings, and
the Google libraries (in ~/edith/venv) are imported on first use, so loading this adapter is free.
Migrated from legacy/edith/google/ (PLAN.md §4.9).
"""
import os

from edith.common.paths import resolve

from .auth import Session
from .gcal import GoogleCalendar
from .gmail import GmailBox

PORTS = ("mail", "calendar")


class Google:
    def __init__(self, session: Session):
        self.session = session
        self.mail = GmailBox(session)
        self.calendar = GoogleCalendar(session)


def create(config: dict) -> Google:
    folder = config.get("credentials_dir")
    return Google(Session(os.path.expanduser(folder) if folder else resolve().google_dir))
