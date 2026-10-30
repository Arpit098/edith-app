#!/usr/bin/env python3
"""Preflight before training: everything train.py needs, checked in seconds. Prints one line per
check (ok / MISSING / WRONG) and exits 1 if anything is missing. Never prints the token.

    python check.py [--work ../work] [--base-url http://edith:8787] [--token-file ~/.config/edith/app-token]
"""
import argparse
import glob
import json
import os
import sys
import urllib.error
import urllib.request
from importlib import metadata

HERE = os.path.dirname(os.path.abspath(__file__))


def pins(path):
    out = {}
    with open(path) as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if "==" in line:
                name, version = line.split("==", 1)
                out[name.strip()] = version.strip()
    return out


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--work", default=os.path.join(HERE, "..", "work"))
    p.add_argument("--base-url", default=os.environ.get("EDITH_URL", "http://edith:8787"))
    p.add_argument("--token-file", default="~/.config/edith/app-token")
    args = p.parse_args(argv)
    work, bad = os.path.abspath(args.work), []

    def report(ok, what, detail=""):
        print(f"{'ok     ' if ok else 'MISSING'} {what}{': ' + detail if detail else ''}")
        if not ok:
            bad.append(what)

    report(sys.version_info[:2] in ((3, 11), (3, 12)), "Python 3.11 or 3.12", sys.version.split()[0])
    wanted = {**pins(os.path.join(HERE, "requirements.txt")), **pins(os.path.join(HERE, "requirements-nodeps.txt"))}
    wrong = []
    for name, version in wanted.items():
        try:
            have = metadata.version(name)
        except metadata.PackageNotFoundError:
            have = None
        if have != version:
            wrong.append(f"{name} {have or 'not installed'} (want {version})")
    report(not wrong, "pinned packages", "; ".join(wrong[:6]) or f"{len(wanted)} as pinned")
    try:
        import torch
        sys.path.insert(0, HERE)
        import lib
        report(True, "torch device", lib.pick_device(torch))
    except Exception as e:  # torch missing or broken: the package line above says which
        report(False, "torch", str(e)[:120])

    data = os.path.join(work, "data")
    psg = os.path.join(data, "piper-sample-generator")
    report(os.path.exists(os.path.join(psg, "models", "en_US-libritts_r-medium.pt")), "Piper voice model (data.py)")
    report(bool(glob.glob(os.path.join(data, "*ACAV100M*.npy"))), "negative features (data.py)")
    report(os.path.exists(os.path.join(data, "validation_set_features.npy")), "negative validation set (data.py)")
    report(len(glob.glob(os.path.join(data, "rir", "*.wav"))) >= 200, "room impulse responses (data.py)")
    try:
        import openwakeword
        models = os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models")
        report(all(os.path.exists(os.path.join(models, m)) for m in ("melspectrogram.onnx", "embedding_model.onnx")),
               "openWakeWord feature models (data.py)")
    except ImportError:
        report(False, "openwakeword (pip install --no-deps -r requirements-nodeps.txt)")

    sessions = []
    for path in glob.glob(os.path.join(work, "recordings", "*", "manifest.json")):
        with open(path) as f:
            m = json.load(f)
        pos = sum(c["kind"].startswith("positive_") for c in m["clips"])
        sessions.append((m["created_at"], m["session"], pos, sum(c["kind"] == "noise" for c in m["clips"])))
    if sessions:
        _, sid, pos, noise = max(sessions)
        report(pos >= 10 and noise >= 1, "recordings (fetch.py)", f"session {sid}: {pos} \"Hey Edith\", {noise} noise")
    else:
        report(False, "recordings (fetch.py)")

    token_file = os.path.expanduser(args.token_file)
    if not os.path.exists(token_file):
        report(False, "token file", token_file)
    else:
        private = not os.stat(token_file).st_mode & 0o077
        report(private, "token file is private (chmod 600)", token_file)
        with open(token_file) as f:
            token = f.read().strip()
        try:
            req = urllib.request.Request(args.base_url.rstrip("/") + "/v1/wakeword/model",
                                         headers={"Authorization": f"Bearer {token}"})
            with urllib.request.urlopen(req, timeout=10) as r:
                state = json.load(r).get("state")
            report(True, "edith reachable with the token", f"model state: {state}")
        except urllib.error.HTTPError as e:
            report(False, "edith reachable with the token", f"HTTP {e.code} (401: wrong token)")
        except (urllib.error.URLError, OSError) as e:
            report(False, "edith reachable", f"{getattr(e, 'reason', e)} (is Tailscale up?)")
    print("all set: run train.py" if not bad else f"{len(bad)} missing: fix those first")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
