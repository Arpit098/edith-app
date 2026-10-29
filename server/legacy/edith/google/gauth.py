"""Shared Google credentials for EDITH scripts (refreshes and re-saves the token)."""
import os

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

TOKEN = os.path.expanduser("~/.config/edith-google/token.json")


def creds():
    c = Credentials.from_authorized_user_file(TOKEN)
    if not c.valid:
        c.refresh(Request())
        fd = os.open(TOKEN, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(c.to_json())
    return c


def service(name, version):
    return build(name, version, credentials=creds(), cache_discovery=False)
