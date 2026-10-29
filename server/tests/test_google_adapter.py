"""adapters/google: one session per process, token refreshed only when expired, services built
once, and one adapter instance shared by the mail and calendar ports. No Google libraries,
no ~/.config/edith-google, no network."""
import contextlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

from edith.adapters.google import auth, login
from edith.adapters.google.auth import Session
from edith.core import load_port
from edith.main import build
from tests.fakes.google import FakeGmail

SERVER = pathlib.Path(__file__).resolve().parents[1]
SHIMS = SERVER.parent / "deploy" / "shims" / "edith" / "google"


class Creds:
    def __init__(self, valid=True):
        self.valid = valid
        self.scopes = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar"]

    def to_json(self):
        return json.dumps({"token": "fresh"})


class SessionTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.loads, self.refreshes, self.builds = [], [], []

    def session(self, creds):
        return Session(self.dir, load=lambda p: self.loads.append(p) or creds,
                       refresh=lambda c: self.refreshes.append(c) or setattr(c, "valid", True),
                       build=lambda n, v, c: self.builds.append((n, v)) or object())

    def test_valid_token_is_read_once_and_services_built_once(self):
        s = self.session(Creds(valid=True))
        gmail = s.service("gmail", "v1")
        self.assertIs(s.service("gmail", "v1"), gmail)
        s.service("calendar", "v3")
        s.credentials()
        self.assertEqual(len(self.loads), 1)
        self.assertEqual(self.refreshes, [])
        self.assertEqual(self.builds, [("gmail", "v1"), ("calendar", "v3")])
        self.assertFalse(os.path.exists(s.token_path))  # nothing written

    def test_each_thread_gets_its_own_service_and_shares_credentials(self):
        creds = Creds(valid=True)
        s = Session(self.dir, load=lambda p: creds, build=lambda n, v, c: (object(), c))
        got = {}

        def use(name):
            first = s.service("gmail", "v1")
            got[name] = (first, s.service("gmail", "v1"))

        threads = [threading.Thread(target=use, args=(n,)) for n in ("a", "b")]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        (a1, a2), (b1, b2) = got["a"], got["b"]
        self.assertIs(a1, a2)                       # reused within a thread
        self.assertIsNot(a1[0], b1[0])              # never shared across threads (httplib2 isn't thread-safe)
        self.assertIs(a1[1], creds)                 # one credentials object for everyone
        self.assertIs(b1[1], creds)

    def test_expired_token_is_refreshed_once_and_saved_privately(self):
        s = self.session(Creds(valid=False))
        s.credentials()
        s.credentials()
        self.assertEqual(len(self.refreshes), 1)
        self.assertEqual(json.loads(pathlib.Path(s.token_path).read_text()), {"token": "fresh"})
        self.assertEqual(os.stat(s.token_path).st_mode & 0o777, 0o600)
        self.assertEqual(os.listdir(self.dir), ["token.json"])  # no temp file left

    def test_legacy_gauth_api_follows_home(self):
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"HOME": home}):
            self.assertEqual(auth.TOKEN, os.path.join(home, ".config/edith-google/token.json"))
            self.assertIs(auth.default_session(), auth.default_session())


class LoadPortTest(unittest.TestCase):
    def test_google_serves_mail_and_calendar_with_one_session(self):
        _, _, ports, _, _ = build({"adapters": {"mail": "google", "calendar": "google"},
                                   "adapter": {"google": {"credentials_dir": "/nonexistent"}}})
        self.assertIs(ports.mail._session, ports.calendar._session)
        self.assertEqual(ports.mail._session.dir, "/nonexistent")
        self.assertNotIn("googleapiclient", sys.modules)  # nothing touched until the first call

    def test_port_it_does_not_serve(self):
        with self.assertLogs("edith.registry", "ERROR"):
            self.assertIsNone(load_port("stt", "stt", "google", {}))

    def test_missing_adapter(self):
        with self.assertLogs("edith.registry", "ERROR"):
            self.assertIsNone(load_port("mail", "mail", "nope", {}))


class FakeFlow:
    """Stands in for google_auth_oauthlib.flow.Flow."""
    made = []

    def __init__(self, **kw):
        self.kw, self.code_verifier = kw, "verifier"
        self.credentials = Creds()
        FakeFlow.made.append(self)

    @classmethod
    def from_client_secrets_file(cls, path, **kw):
        return cls(path=path, **kw)

    def authorization_url(self, **kw):
        return "https://accounts.example/auth?x=1", "state-1"

    def fetch_token(self, authorization_response):
        self.response = authorization_response


class LoginTest(unittest.TestCase):
    def test_url_finish_status(self):
        with tempfile.TemporaryDirectory() as folder:
            api = FakeGmail([])
            s = Session(folder, load=lambda p: Creds(), build=lambda n, v, c: api)
            out = io.StringIO()
            with mock.patch.object(login, "_flow", return_value=FakeFlow), contextlib.redirect_stdout(out):
                login.main(["url"], session=s)
                pending = json.loads(pathlib.Path(folder, "pending-auth.json").read_text())
                login.main(["finish", " http://localhost:8765/?code=abc "], session=s)
            self.assertEqual(pending, {"state": "state-1", "code_verifier": "verifier"})
            self.assertEqual(FakeFlow.made[-1].kw["state"], "state-1")
            self.assertEqual(FakeFlow.made[-1].response, "http://localhost:8765/?code=abc")
            self.assertFalse(os.path.exists(os.path.join(folder, "pending-auth.json")))
            self.assertEqual(os.stat(os.path.join(folder, "token.json")).st_mode & 0o777, 0o600)
            self.assertEqual(out.getvalue(), "https://accounts.example/auth?x=1\n"
                                             "Logged in as arpit@example.com (1234 messages)\n"
                                             "Scopes: gmail.modify, calendar\n")


class GauthWrapperTest(unittest.TestCase):
    def test_wrapper_exposes_the_legacy_names(self):
        with tempfile.TemporaryDirectory() as home:
            code = "import gauth; print(gauth.TOKEN, callable(gauth.creds), callable(gauth.service))"
            r = subprocess.run([sys.executable, "-I", "-c", f"import sys; sys.path.insert(0, {str(SHIMS)!r}); {code}"],
                               capture_output=True, text=True,
                               env={"HOME": home, "EDITH_APP_SERVER": str(SERVER), "PATH": "/usr/bin:/bin"})
            self.assertEqual(r.stdout, f"{home}/.config/edith-google/token.json True True\n", r.stderr)


if __name__ == "__main__":
    unittest.main()
