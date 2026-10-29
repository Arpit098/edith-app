#!/usr/bin/env python3
"""One-time Google login for EDITH (Gmail + Calendar), done over Telegram.

  auth.py url             -> prints the sign-in URL (saves PKCE state)
  auth.py finish <URL>    -> exchanges the http://localhost/?code=... URL Arpit pastes back
  auth.py status          -> shows which account the saved token belongs to
"""
# The docstring above is kept from legacy/edith/google/auth.py; this runs behind the wrapper at
# ~/edith/google/auth.py with the same commands and output. Files stay in ~/.config/edith-google.
import json
import os
import sys

from .auth import Session, default_session, save_private

REDIRECT = "http://localhost:8765/"
SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
]


def _flow():
    from google_auth_oauthlib.flow import Flow
    return Flow


def cmd_url(session: Session):
    flow = _flow().from_client_secrets_file(os.path.join(session.dir, "client.json"), scopes=SCOPES,
                                            redirect_uri=REDIRECT, autogenerate_code_verifier=True)
    url, state = flow.authorization_url(access_type="offline", prompt="consent", include_granted_scopes="true")
    save_private(os.path.join(session.dir, "pending-auth.json"),
                 json.dumps({"state": state, "code_verifier": flow.code_verifier}))
    print(url)


def cmd_finish(session: Session, resp_url):
    state_file = os.path.join(session.dir, "pending-auth.json")
    with open(state_file) as f:
        pending = json.load(f)
    flow = _flow().from_client_secrets_file(os.path.join(session.dir, "client.json"), scopes=SCOPES,
                                            redirect_uri=REDIRECT, state=pending["state"])
    flow.code_verifier = pending["code_verifier"]
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"  # redirect is http://localhost, never actually served
    os.environ["OAUTHLIB_RELAX_TOKEN_SCOPE"] = "1"
    flow.fetch_token(authorization_response=resp_url.strip())
    save_private(session.token_path, flow.credentials.to_json())
    os.remove(state_file)
    cmd_status(Session(session.dir, session._load, session._refresh, session._build))  # read the new token


def cmd_status(session: Session):
    prof = session.service("gmail", "v1").users().getProfile(userId="me").execute(num_retries=3)
    print(f"Logged in as {prof['emailAddress']} ({prof.get('messagesTotal', '?')} messages)")
    print("Scopes:", ", ".join(s.rsplit("/", 1)[-1] for s in (session.credentials().scopes or [])))


def main(argv=None, session=None):
    argv = sys.argv[1:] if argv is None else argv
    session = session or default_session()
    c = argv[0] if argv else "status"
    if c == "url":
        cmd_url(session)
    elif c == "status":
        cmd_status(session)
    else:
        cmd_finish(session, argv[1])


if __name__ == "__main__":
    main()
