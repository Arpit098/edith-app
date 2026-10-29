#!/usr/bin/env python3
"""One-time Google login for EDITH (Gmail + Calendar), done over Telegram.

  auth.py url             -> prints the sign-in URL (saves PKCE state)
  auth.py finish <URL>    -> exchanges the http://localhost/?code=... URL Arpit pastes back
  auth.py status          -> shows which account the saved token belongs to
"""
import json
import os
import sys

from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow

DIR = os.path.expanduser("~/.config/edith-google")
CLIENT = os.path.join(DIR, "client.json")
TOKEN = os.path.join(DIR, "token.json")
STATE = os.path.join(DIR, "pending-auth.json")
REDIRECT = "http://localhost:8765/"
SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
]


def save_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(data)


def cmd_url():
    flow = Flow.from_client_secrets_file(CLIENT, scopes=SCOPES, redirect_uri=REDIRECT, autogenerate_code_verifier=True)
    url, state = flow.authorization_url(access_type="offline", prompt="consent", include_granted_scopes="true")
    save_private(STATE, json.dumps({"state": state, "code_verifier": flow.code_verifier}))
    print(url)


def cmd_finish(resp_url):
    pending = json.load(open(STATE))
    flow = Flow.from_client_secrets_file(CLIENT, scopes=SCOPES, redirect_uri=REDIRECT, state=pending["state"])
    flow.code_verifier = pending["code_verifier"]
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"  # redirect is http://localhost, never actually served
    os.environ["OAUTHLIB_RELAX_TOKEN_SCOPE"] = "1"
    flow.fetch_token(authorization_response=resp_url.strip())
    save_private(TOKEN, flow.credentials.to_json())
    os.remove(STATE)
    cmd_status()


def cmd_status():
    from googleapiclient.discovery import build
    creds = Credentials.from_authorized_user_file(TOKEN)
    gmail = build("gmail", "v1", credentials=creds, cache_discovery=False)
    prof = gmail.users().getProfile(userId="me").execute()
    print(f"Logged in as {prof['emailAddress']} ({prof.get('messagesTotal', '?')} messages)")
    print("Scopes:", ", ".join(s.rsplit("/", 1)[-1] for s in (creds.scopes or [])))


if __name__ == "__main__":
    c = sys.argv[1] if len(sys.argv) > 1 else "status"
    {"url": cmd_url, "status": cmd_status}.get(c, lambda: cmd_finish(sys.argv[2]))()
