#!/usr/bin/env python3
"""Pull one recording session from edith over the App API into a local work dir (contracts/wakeword.md).

    python3 fetch.py [--base-url http://edith:8787] [--token-file ~/.config/edith/app-token]
                     [--session latest|<id>] [--work ../work]

Writes <work>/recordings/<session>/manifest.json and clips/<sha256>.wav, checking the SHA-256 of
every clip. Clips already there with the right hash are not downloaded again. Stdlib only. The token
is read from the file and never printed.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import FetchError, download, request, sha256_file, write_json  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def read_token(path):
    path = os.path.expanduser(path)
    if os.stat(path).st_mode & 0o077:
        raise FetchError(f"{path} must be readable by you only: chmod 600 {path}")
    with open(path) as f:
        token = f.read().strip()
    if len(token) < 32:
        raise FetchError(f"{path} does not hold the App API token")
    return token


def get_json(base, path, token):
    with request(base + path, {"Authorization": f"Bearer {token}"}, timeout=30) as r:
        return json.load(r)


def fetch(base, token, session="latest", work=os.path.join(HERE, "..", "work"), log=print):
    """-> the local session folder."""
    base = base.rstrip("/")
    if session == "latest":
        recorded = [s for s in get_json(base, "/v1/wakeword/sessions", token)["sessions"] if s["clips"]]
        if not recorded:
            raise FetchError("no session with clips on edith yet: record some in the app first")
        session = recorded[0]["id"]
    manifest = get_json(base, f"/v1/wakeword/sessions/{session}/manifest", token)
    folder = os.path.join(os.path.abspath(work), "recordings", session)
    os.makedirs(os.path.join(folder, "clips"), exist_ok=True)
    got = 0
    for clip in manifest["clips"]:
        dest = os.path.join(folder, "clips", f"{clip['sha256']}.wav")
        if os.path.exists(dest) and sha256_file(dest) == clip["sha256"]:
            continue
        download(f"{base}/v1/wakeword/sessions/{session}/clips/{clip['sha256']}", dest, sha256=clip["sha256"],
                 headers={"Authorization": f"Bearer {token}"}, timeout=60)
        got += 1
    write_json(os.path.join(folder, "manifest.json"), manifest)
    kinds = {}
    for c in manifest["clips"]:
        kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
    log(f"session {session}: {len(manifest['clips'])} clips ({', '.join(f'{k} {n}' for k, n in sorted(kinds.items()))}); "
        f"{got} downloaded, all SHA-256 checked -> {folder}")
    return folder


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--base-url", default=os.environ.get("EDITH_URL", "http://edith:8787"))
    p.add_argument("--token-file", default="~/.config/edith/app-token")
    p.add_argument("--session", default="latest")
    p.add_argument("--work", default=os.path.join(HERE, "..", "work"))
    args = p.parse_args(argv)
    try:
        fetch(args.base_url, read_token(args.token_file), args.session, args.work)
    except (FetchError, OSError, ValueError, KeyError) as e:
        print(f"fetch failed: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
