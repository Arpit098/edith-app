"""Build and sign an OTA bundle on edith, without CI (contracts/app-updates.md §2, "Local builds").

    cd ~/edith-app-live/server
    python3 -m edith.features.app_updates.local_build [--ref origin/main] [--no-bytecode]

The same steps as build-apk.yml's "OTA bundle", from a clean checkout of `--ref` in its own clone
(<state_dir>/ota-build/src, never the live checkout):

1. npm ci --ignore-scripts, skipped while package-lock.json and the Node version are those of the
   last install;
2. the runtimeVersion, resolved as CI does (EDITH_UPDATES_SIGNING=1, fingerprint policy). If no APK
   the store offers has it, the native side changed: that needs a real APK, and the build stops. It
   also stops unless the commit contains the newest build edith has for that runtimeVersion (the
   newest bundle is served, so an older one would roll the app back);
3. expo export for android, and the public expo config;
4. release notes (scripts/release-notes.js): the PRs merged since that newest build;
5. scripts/ota.js signs it with the key file, whose path is all this tool handles: the key is never
   read, copied or printed here, only checked to be the owner's, mode 600;
6. the artifact goes into the store's inbox (complete, then renamed into place). The bridge's collect
   job imports it with the same SHA-256 checks as a CI artifact, within one pass (2 min).

Hermes: `expo export` compiles to Hermes bytecode with the hermesc that npm ships, which is x86-64
only. On edith (ARM64) give a hermesc built from the same Hermes release (--hermes-dir, read as
REACT_NATIVE_OVERRIDE_HERMES_DIR: <dir>/build/bin/hermesc), or pass --no-bytecode for a plain-JS
bundle, which Hermes also runs (it starts a little slower). A --no-bytecode bundle is not what CI
ships: verify it on a phone before relying on it.

Steps 1-3 run npm packages' code: each runs as a transient user unit with a minimal environment
(third_party below), and only ota.js is given the key path. That is not a filesystem sandbox (edith
doesn't allow unprivileged user namespaces), so those packages could still read files we can.

--out DIR is a dry run: the artifact is written there, not to the inbox; only then may --cert name a
certificate other than the checkout's app/certs/updates-certificate.pem (a throwaway test key).
Exit codes: 0 built, 1 failed, 2 refused (bad key file, native change, nothing new).
"""
import argparse
import fcntl
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import time
import tomllib

from edith.common.paths import resolve

from .store import normalize_cert, read_json

REPO = "Arpit098/edith-app"
BASE_URL = "http://edith:8787"
DEFAULT_KEY = "~/.config/edith-signing/ota/private-key.pem"


class Refused(Exception):
    """The build must not go ahead (exit 2)."""


def step(name, cmd, cwd, env=None, timeout=900, stdout=None):
    """Run one build command, its output on our stderr; -> seconds taken. Raises on failure."""
    t = time.monotonic()
    print(f"== {name}", file=sys.stderr, flush=True)
    subprocess.run(cmd, cwd=cwd, env=env, timeout=timeout, check=True, stdout=stdout or sys.stderr,
                   stdin=subprocess.DEVNULL)
    return time.monotonic() - t


def third_party(name, cmd, cwd, env, timeout=900, stdout=None):
    """A step that runs npm packages' code (npm ci, expo): a transient user unit, so whatever it
    leaves running is killed when it ends, started through `env -i` with only `env`, so it gets no
    SSH agent, D-Bus or other variable of ours (a unit would inherit the user manager's). Not a
    filesystem sandbox: unprivileged user namespaces are off on edith
    (kernel.apparmor_restrict_unprivileged_userns=1), so ProtectHome= and the like don't apply."""
    unit = f"edith-ota-{name.replace(' ', '-')}-{os.getpid()}"
    cmd = ["systemd-run", "--user", "--quiet", "--wait", "--pipe", "--collect", f"--unit={unit}",
           f"--working-directory={cwd}", f"--property=RuntimeMaxSec={timeout}", "--property=NoNewPrivileges=yes",
           "--", "/usr/bin/env", "-i", *(f"{k}={v}" for k, v in env.items()), *cmd]
    try:
        return step(name, cmd, cwd, timeout=timeout + 30, stdout=stdout)
    except subprocess.TimeoutExpired:
        subprocess.run(["systemctl", "--user", "stop", unit], timeout=60)
        raise


def check_key(path):
    """The key file must be a regular file of ours, readable by us only. Never opened here."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        raise Refused(f"no OTA signing key at {path}")
    if not stat.S_ISREG(st.st_mode):
        raise Refused(f"{path} is not a regular file")
    if st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise Refused(f"{path} must be ours and mode 600 (it is {stat.S_IMODE(st.st_mode):o}); not using it")


def offered_apks(index, pin):
    """The APKs the app_updates routes offer (release-signed, the pinned certificate)."""
    return [a for a in index.get("apks", {}).values()
            if a.get("signing") == "release" and (not pin or normalize_cert(a.get("cert_sha256")) == normalize_cert(pin))]


def plan(index, pin, runtime, sha, is_ancestor):
    """-> (the APK this bundle is for, the commit the notes start from). Raises Refused.
    `is_ancestor(a, b)`: commit a is in b's history (git merge-base --is-ancestor)."""
    apks = offered_apks(index, pin)
    matching = [a for a in apks if a.get("runtimeVersion") == runtime]
    if not matching:
        have = ", ".join(sorted({f"{a['runtimeVersion'][:12]} (APK {a['versionCode']})" for a in apks})) or "none"
        raise Refused(f"runtimeVersion {runtime} matches no APK edith offers ({have}). The native side changed "
                      "(a native dependency, config plugin or android-modules/): this needs a real APK build, "
                      "not an OTA bundle.")
    apk = max(matching, key=lambda a: a["versionCode"])
    updates = [u for u in index.get("updates", {}).values() if u.get("runtimeVersion") == runtime]
    newest = max(updates, key=lambda u: u["createdAt"]) if updates else None
    if newest and newest.get("sha") == sha:
        raise Refused(f"{sha[:8]} is already the newest bundle for this runtimeVersion ({newest['id']}); nothing new")
    # The newest bundle is served, so one built from a commit that lacks what is served now would
    # roll the app back.
    base = (newest or apk).get("sha")
    if not base or not is_ancestor(base, sha):
        raise Refused(f"{sha[:8]} doesn't contain {(base or '?')[:8]}, the newest build edith has for this "
                      f"runtimeVersion ({'bundle ' + newest['id'] if newest else 'APK ' + str(apk['versionCode'])}): "
                      "it would roll the app back. Build a newer ref.")
    return apk, base


def ancestry(src):
    def is_ancestor(a, b):
        return subprocess.run(["git", "merge-base", "--is-ancestor", a, b], cwd=src, capture_output=True,
                              timeout=60).returncode == 0
    return is_ancestor


def lock_stamp(app):
    with open(os.path.join(app, "package-lock.json"), "rb") as f:
        lock = hashlib.sha256(f.read()).hexdigest()
    node = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=30, check=True).stdout.strip()
    return f"{lock} {node}"


def checkout(src, url, ref, timings):
    if not os.path.isdir(os.path.join(src, ".git")):
        timings["clone"] = step("clone", ["git", "clone", "--no-checkout", "--quiet", url, src], os.path.dirname(src))
    timings["fetch"] = step("fetch", ["git", "fetch", "--prune", "--quiet", "origin"], src, timeout=300)
    sha = subprocess.run(["git", "rev-parse", "--verify", f"{ref}^{{commit}}"], cwd=src, capture_output=True,
                         text=True, timeout=30, check=True).stdout.strip()
    step("checkout", ["git", "checkout", "--quiet", "--detach", "--force", sha], src)
    # Clean, except the installed node_modules (npm ci below decides whether it is still right).
    step("clean", ["git", "clean", "-ffdxq", "-e", "/app/node_modules/"], src)
    return sha


def build(a):
    timings = {}
    key = os.path.expanduser(a.key)
    check_key(key)
    with open(os.path.expanduser(a.config), "rb") as f:
        config = tomllib.load(f)
    feature = config.get("features", {}).get("app_updates", {})
    root = resolve(feature).app_updates
    try:
        index = read_json(os.path.join(root, "index.json"))  # read only: the bridge is its only writer
    except FileNotFoundError:
        index = {}

    work = os.path.expanduser(a.work) if a.work else os.path.join(resolve(feature).state_dir, "ota-build")
    os.makedirs(work, mode=0o700, exist_ok=True)
    lock = open(os.path.join(work, ".lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise Refused("another local OTA build is running")

    src = os.path.join(work, "src")
    sha = checkout(src, a.repo_url, a.ref, timings)
    app = os.path.join(src, "app")
    cert = os.path.abspath(os.path.expanduser(a.cert)) if a.cert else os.path.join(app, "certs/updates-certificate.pem")

    # Only what each step needs: our environment (tokens, the SSH agent) never reaches npm packages.
    base_env = {"HOME": os.path.expanduser("~"), "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
    # As CI: expo-updates on (it is part of the fingerprint), non-interactive.
    build_env = {**base_env, "EDITH_UPDATES_SIGNING": "1", "CI": "1"}
    hermes = a.hermes_dir or os.environ.get("REACT_NATIVE_OVERRIDE_HERMES_DIR")
    if hermes:
        if not os.access(os.path.join(hermes, "build/bin/hermesc"), os.X_OK):
            raise Refused(f"no hermesc at {hermes}/build/bin/hermesc")
        build_env["REACT_NATIVE_OVERRIDE_HERMES_DIR"] = os.path.abspath(hermes)
    elif not a.no_bytecode:
        raise Refused("npm's hermesc is x86-64 only: pass --hermes-dir (a hermesc built for this machine) "
                      "or --no-bytecode (a plain-JS bundle; verify it on a phone before relying on it)")

    tmp = os.path.join(work, "tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    stamp_file, stamp = os.path.join(app, "node_modules/.edith-npm-ci"), lock_stamp(app)
    try:
        with open(stamp_file) as f:
            fresh = f.read() == stamp
    except FileNotFoundError:
        fresh = False
    if fresh:
        print("== npm ci: skipped (same package-lock.json and Node)", file=sys.stderr)
    else:
        # No install scripts: exporting a JS bundle needs none (the native builds they serve are CI's).
        timings["npm ci"] = third_party("npm ci", ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund",
                                                   "--prefer-offline"], app, build_env)
        with open(stamp_file, "w") as f:
            f.write(stamp)

    resolved = os.path.join(tmp, "runtime.json")
    with open(resolved, "w") as f:
        timings["runtimeVersion"] = third_party("runtimeVersion", ["npx", "expo-updates", "runtimeversion:resolve",
                                                                   "--platform", "android"], app, build_env, 300, f)
    with open(resolved) as f:
        runtime = json.load(f)["runtimeVersion"]
    if not runtime:
        raise RuntimeError("no runtimeVersion")
    apk, since = plan(index, feature.get("cert_sha256") or "", runtime, sha, ancestry(src))
    print(f"== {sha[:8]}: runtimeVersion {runtime} (APK {apk['versionCode']}); notes since {since[:8]}",
          file=sys.stderr)
    build_env["EDITH_VERSION_CODE"] = str(apk["versionCode"])  # the public config matches the installed APK

    artifact = os.path.join(tmp, "ota")
    timings["expo export"] = third_party("expo export", ["npx", "expo", "export", "--platform", "android",
                                                         "--output-dir", os.path.join(artifact, "dist"),
                                                         *(["--no-bytecode"] if not hermes else [])],
                                         app, build_env)
    expo_config = os.path.join(tmp, "expo-config.json")
    with open(expo_config, "w") as f:
        third_party("expo config", ["npx", "expo", "config", "--type", "public", "--json"], app, build_env, 120, f)

    # Our own scripts (Node built-ins only). gh finds its login under HOME; only ota.js gets the key.
    notes = os.path.join(tmp, "release-notes.json")
    # Never fails the build: on a GitHub problem the script writes empty notes and a warning.
    timings["release notes"] = step("release notes", ["node", "scripts/release-notes.js", "--repo", REPO, "--sha", sha,
                                                      "--since", since, "--out", notes], app, base_env, 180)
    timings["sign"] = step("sign", ["node", "scripts/ota.js", "--dir", artifact, "--runtime-version", runtime,
                                    "--key", key, "--cert", cert, "--base-url", BASE_URL, "--sha", sha,
                                    "--run-id", "0", "--expo-config", expo_config, "--release-notes", notes],
                           app, base_env, 120)
    update = read_json(os.path.join(artifact, "update.json"))

    if a.out:
        dest = os.path.join(os.path.abspath(os.path.expanduser(a.out)), update["id"])
        shutil.rmtree(dest, ignore_errors=True)
        shutil.copytree(artifact, dest)
        where = f"dry run: written to {dest} (not to the store)"
    else:
        inbox = os.path.join(root, "inbox")
        os.makedirs(inbox, exist_ok=True)
        partial, dest = os.path.join(inbox, f".{update['id']}"), os.path.join(inbox, update["id"])
        shutil.rmtree(partial, ignore_errors=True)
        shutil.copytree(artifact, partial)
        os.replace(partial, dest)  # complete before the job can see it
        where = f"in the store's inbox; edith imports it on its next collect pass (within 2 min)"
    shutil.rmtree(tmp, ignore_errors=True)
    size = sum(f["size"] for f in update["files"])
    print(f"OTA update {update['id']} for {sha[:8]}: runtime {runtime[:12]}, APK {apk['versionCode']}, "
          f"{len(update['files'])} files, {size / 1e6:.1f} MB; {where}")
    print("times: " + ", ".join(f"{k} {v:.1f} s" for k, v in timings.items()))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build and sign an OTA bundle on edith (no CI).")
    ap.add_argument("--ref", default="origin/main", help="the commit to build (default origin/main, fetched first)")
    ap.add_argument("--key", default=DEFAULT_KEY, help=f"OTA signing key file, mode 600 (default {DEFAULT_KEY})")
    ap.add_argument("--config", default="~/.config/edith/config.toml")
    ap.add_argument("--repo-url", default=f"https://github.com/{REPO}.git")
    ap.add_argument("--work", help="build folder (default <state_dir>/ota-build)")
    ap.add_argument("--hermes-dir", help="a Hermes build for this machine (<dir>/build/bin/hermesc)")
    ap.add_argument("--no-bytecode", action="store_true", help="a plain-JS bundle instead of Hermes bytecode")
    ap.add_argument("--out", help="dry run: write the artifact here instead of the store's inbox")
    ap.add_argument("--cert", help="dry run only: the certificate to check the signature against")
    a = ap.parse_args(argv)
    if a.cert and not a.out:
        ap.error("--cert is only for a dry run (--out): a real build is checked against the APK's certificate")
    try:
        build(a)
    except Refused as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError, ValueError, KeyError) as e:
        print(f"failed: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
