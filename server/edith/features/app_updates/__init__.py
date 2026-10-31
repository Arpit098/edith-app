"""App updates (contracts/app-updates.md): collect the app's builds from GitHub and serve them.

- A job lists successful build-apk.yml runs on main (gh), downloads only artifacts it has not seen
  (edith-apk, edith-ota; one at a time), verifies every file's SHA-256 and keeps them under
  <state_dir>/app-updates (store.py). It runs every `interval` seconds (2 min); a failed pass is
  retried by the job runner with backoff. A pass whose run list hasn't changed makes that one gh call
  and nothing else: no download, no write. Each pass first imports the OTA bundles built on edith
  itself (local_build.py) from the store's inbox; the newest update per runtimeVersion is served,
  from CI or local.
- Routes: GET /v1/updates/manifest and /v1/updates/assets/{sha256} (Expo Updates protocol v1),
  GET /v1/app/latest and /v1/app/apk/{versionCode} (Range resume). Files are streamed from disk.
- Only release-signed APKs whose certificate matches the pinned `cert_sha256` are offered.
- After each pass, a new offerable update is announced once on the bus as `app.update_available`
  (contracts/app-updates.md §7; the notifications feature pushes it). What was announced is kept in
  the index, so a restart never repeats it; the first pass on a store that has never announced only
  records what is there.

Config [features.app_updates]: cert_sha256, repo, workflow, branch, interval, gh.
"""
import logging
import os
import re
import secrets
import shutil
import threading

from edith.common.paths import resolve
from edith.core import ApiError, Context, Event, Feature, Response

from .github import GhError, GitHub, MissingArtifact
from .store import Rejected, Store, is_sha256, normalize_cert

log = logging.getLogger("edith.feature.app_updates")

EXPO_HEADERS = {"expo-current-update-id": "current_update_id", "expo-embedded-update-id": "embedded_update_id",
                "expo-fatal-error": "fatal_error"}
OFFERED = ("versionName", "versionCode", "sha", "built_at", "runtimeVersion", "size", "sha256", "cert_sha256")
NOTE_LISTS = {"new": 20, "fixes": 20, "changes": 20, "details": 30}  # list -> most items kept
PLAIN = (("new", "New"), ("fixes", "Fix"), ("changes", "Change"))
ARTIFACT_FILES = ("update.json", "manifest.json", "manifest.sig")  # an edith-ota artifact's own files
REJECTED_KEEP = 7 * 86400  # seconds a rejected local build stays in the inbox for a look
ANNOUNCED_OTA_KEEP = 50    # OTA ids remembered as announced (older ones are long pruned)
SUMMARY_ITEMS = 3          # release-note lines in an announcement's summary


def release_notes(value):
    """apk.json's release_notes (contracts/app-updates.md §2) as {new, fixes, changes, details}: lists
    of short strings, whatever the build wrote; None when the build has none (older builds)."""
    if not isinstance(value, dict):
        return None
    return {key: [str(x).strip()[:200] for x in (value.get(key) or []) if isinstance(x, str) and x.strip()][:cap]
            if isinstance(value.get(key), list) else [] for key, cap in NOTE_LISTS.items()}


def has_items(notes):
    return bool(notes) and any(notes[key] for key, _ in PLAIN)


def plain_notes(notes):
    """The release notes as the plain `notes` text that apps from before them show."""
    return "\n".join(f"{label}: {line}" for key, label in PLAIN for line in notes[key])


def summary(notes, fallback):
    """One line for a push: the first SUMMARY_ITEMS `New:`/`Fix:`/`Change:` items, else `fallback`."""
    items = [f"{label}: {line}" for key, label in PLAIN for line in notes[key]] if has_items(notes) else []
    return " · ".join(items[:SUMMARY_ITEMS]) or fallback


def announcement(kind, record, apk):
    """The app.update_available data for an OTA update `record` or an APK `apk` (contracts/app-updates.md §7)."""
    notes = release_notes(record.get("release_notes"))
    if kind == "apk":
        fallback = f"EDITH {apk['versionName']} (build {apk['versionCode']}) is ready to install"
        update_id = str(apk["versionCode"])
    else:
        fallback = "A newer version of the app's code is ready"
        update_id = record["id"]
    return {"kind": kind, "id": update_id, "versionName": apk["versionName"] if kind == "apk" else None,
            "versionCode": apk["versionCode"] if kind == "apk" else None,
            "runtimeVersion": record["runtimeVersion"], "sha": record.get("sha"), "summary": summary(notes, fallback)}


def setup(ctx: Context) -> None:
    cfg = ctx.config
    pin = cfg.get("cert_sha256") or ""
    interval = float(cfg.get("interval", 120))  # an unchanged run list costs one `gh run list` and nothing else
    gh = GitHub(cfg.get("repo", "Arpit098/edith-app"), cfg.get("workflow", "build-apk.yml"), cfg.get("branch", "main"),
                cfg.get("gh", "gh"))
    root = resolve(cfg).app_updates
    lock, holder = threading.Lock(), []

    def store():
        """Opened on first use, so loading the feature (e.g. `make check`) touches no file."""
        with lock:
            if not holder:
                holder.append(Store(root))
            return holder[0]

    def offerable(apk):
        return apk.get("signing") == "release" and (not pin or normalize_cert(apk.get("cert_sha256")) == normalize_cert(pin))

    # ---- collecting ----

    def notes_for(s, record):
        older = [a for v, a in s.index["apks"].items() if int(v) < record["versionCode"] and offerable(a)]
        base = max(older, key=lambda a: a["versionCode"])["sha"] if older else None
        try:
            return gh.subjects(base, record["sha"])
        except GhError as e:
            log.warning("no commit notes for %s: %s", record["versionCode"], e)
            return []

    def collect_one(s, run_id, kind):
        folder = s.scratch(f"run-{run_id}-{kind}")
        try:
            gh.download(run_id, "edith-apk" if kind == "apk" else "edith-ota", folder)
            if kind == "ota":
                s.add_update(run_id, folder)
                return "collected"
            result = s.add_apk(run_id, folder, pin)
            if isinstance(result, str):
                return result
            # Builds with release notes need no commit subjects from GitHub (one gh call saved).
            s.update_apk(result["versionCode"],
                         notes=[] if has_items(release_notes(result.get("release_notes"))) else notes_for(s, result))
            return "collected"
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    def import_local(s):
        """OTA bundles built on edith (local_build.py) waiting in the inbox: checked like a CI artifact."""
        s.sweep_rejected(REJECTED_KEEP)
        for folder in s.inbox():
            name = os.path.basename(folder)
            try:
                missing = [f for f in ARTIFACT_FILES if not os.path.isfile(os.path.join(folder, f))]
                if missing:  # a complete build is renamed in, so a missing file never turns up later
                    raise Rejected(f"no {', '.join(missing)}")
                record = s.add_update(0, folder, source="local")
                log.info("imported local OTA update %s (%s)", record["id"], (record["sha"] or "")[:8])
            except (Rejected, ValueError) as e:  # ValueError: a malformed JSON file
                # Kept aside under a dot name (never imported or retried) for a look at what was wrong;
                # removed after REJECTED_KEEP.
                log.warning("local OTA build %s rejected: %s", name, e)
                s.set_aside(folder)
                continue
            except OSError as e:  # left in the inbox: the next pass tries again
                log.warning("local OTA build %s not imported yet: %s", name, e)
                continue
            shutil.rmtree(folder, ignore_errors=True)

    def collect():
        s = store()
        import_local(s)  # first: it needs no GitHub, so a gh failure doesn't hold it up
        runs = gh.runs()
        if runs:
            s.forget_runs_before(min(r["id"] for r in runs))
        failed = []
        for run in sorted(runs, key=lambda r: r["id"]):  # oldest first: notes and versionCodes follow the order
            for kind in ("apk", "ota"):
                if s.seen(run["id"], kind):
                    continue  # collected, missing or rejected before: never downloaded again
                try:
                    outcome = collect_one(s, run["id"], kind)
                except MissingArtifact:
                    outcome = "missing"
                except Rejected as e:
                    outcome = f"rejected: {e}"
                    log.warning("run %s %s rejected: %s", run["id"], kind, e)
                except (GhError, OSError) as e:  # transient: not recorded, so the next pass tries again
                    failed.append(f"{run['id']} {kind}: {e}")
                    continue
                s.mark(run["id"], kind, outcome)
                if outcome == "collected":
                    log.info("collected run %s %s", run["id"], kind)
        s.prune()
        announce(s)
        if failed:
            raise GhError("; ".join(failed)[:500])  # the job runner retries with backoff
        return interval

    def announce(s):
        """Publish app.update_available for what this pass made newly offerable (contracts/app-updates.md §7).

        - APK: the newest offerable versionCode, when it is above the last one announced.
        - OTA: the newest update for the newest APK's runtimeVersion (the code an up-to-date app runs),
          when its id wasn't announced.
        - A new APK whose runtimeVersion is the previous one's (only JS changed) comes with an OTA for
          the phone: then only the OTA is announced, as nothing needs installing. Either way both are
          recorded, so each update is announced at most once.
        The record is written before publishing: a crash in between loses one push, never repeats it."""
        apks = [a for a in s.index["apks"].values() if offerable(a)]
        if not apks:
            return
        newest = max(apks, key=lambda a: a["versionCode"])
        ota = s.newest_update(newest["runtimeVersion"], "main")
        known = s.index.get("announced")
        now = {"apk": newest["versionCode"], "ota": [ota["id"]] if ota else []}
        if known is None:  # never announced from this store: what is here is the baseline, not news
            s.set_announced(now)
            return
        seen_ota = list(known.get("ota") or [])
        new_apk = newest["versionCode"] > int(known.get("apk") or 0)
        new_ota = ota is not None and ota["id"] not in seen_ota
        if not new_apk and not new_ota:
            return
        previous = [a for a in apks if a["versionCode"] <= int(known.get("apk") or 0)]
        native_changed = not previous or max(previous, key=lambda a: a["versionCode"])["runtimeVersion"] != newest["runtimeVersion"]
        if new_apk and (native_changed or not new_ota):
            data = announcement("apk", newest, newest)
        else:
            data = announcement("ota", ota, newest)
        if new_ota:
            seen_ota.append(ota["id"])
        s.set_announced({"apk": max(newest["versionCode"], int(known.get("apk") or 0)),
                         "ota": seen_ota[-ANNOUNCED_OTA_KEEP:]})
        log.info("announcing %s update %s", data["kind"], data["id"])
        ctx.bus.publish(Event("app.update_available", data))

    ctx.add_job("collect", collect)

    # ---- routes ----

    def expo_audit(headers):
        found = {key: headers[h][:1024] for h, key in EXPO_HEADERS.items() if headers.get(h)}
        return {"expo": found} if found else {}

    def manifest(req):
        h = req.get("headers") or {}
        runtime, platform = h.get("expo-runtime-version"), h.get("expo-platform", "android")
        if not runtime:
            raise ApiError(400, "expo-runtime-version is required")
        if platform != "android":
            raise ApiError(400, f"unsupported platform {platform!r}")
        audit = expo_audit(h)
        protocol = {"expo-protocol-version": "1", "expo-sfv-version": "0", "cache-control": "private, max-age=0"}
        update = store().newest_update(runtime, h.get("expo-channel-name", "main"))
        if not update or update["id"] == h.get("expo-current-update-id"):
            return Response(204, protocol, audit=audit)
        try:
            with open(store().update_file(update["id"], "manifest.json"), "rb") as f:
                body = f.read()
            with open(store().update_file(update["id"], "manifest.sig")) as f:
                signature = f.read().strip()
        except OSError:  # pruned between the lookup and here
            return Response(204, protocol, audit=audit)
        boundary = secrets.token_hex(16)
        part = (f"--{boundary}\r\ncontent-type: application/json; charset=utf-8\r\n"
                f"content-disposition: form-data; name=\"manifest\"\r\nexpo-signature: {signature}\r\n\r\n").encode()
        return Response(200, {**protocol, "content-type": f"multipart/mixed; boundary={boundary}"},
                        part + body + f"\r\n--{boundary}--\r\n".encode(), audit=audit)

    def asset(req):
        sha = req["params"]["sha256"].lower()
        info = store().assets.get(sha) if is_sha256(sha) else None
        if not info:
            raise ApiError(404, "unknown asset")
        return Response(200, {"content-type": info["contentType"], "cache-control": "public, max-age=31536000, immutable"},
                        file=store().asset_path(sha))

    def offered():
        return [a for a in store().index["apks"].values() if offerable(a)]

    def latest(req):
        apks = offered()
        if not apks:
            raise ApiError(404, "no app build yet")
        apk = max(apks, key=lambda a: a["versionCode"])
        notes = release_notes(apk.get("release_notes"))
        text = plain_notes(notes) if has_items(notes) else "\n".join((apk.get("notes") or [])[:20])
        return {**{k: apk.get(k) for k in OFFERED}, "notes": text, "release_notes": notes,
                "url": f"/v1/app/apk/{apk['versionCode']}"}

    def apk_file(req):
        code = req["params"]["versionCode"]
        apk = next((a for a in offered() if str(a["versionCode"]) == code), None)
        if apk is None:
            raise ApiError(404, "no such app build")
        size, headers = apk["size"], {"content-type": "application/vnd.android.package-archive",
                                      "etag": f"\"{apk['sha256']}\"", "accept-ranges": "bytes"}
        path = store().apk_path(apk["versionCode"])
        m = re.fullmatch(r"bytes=(\d+)-(\d*)", ((req.get("headers") or {}).get("range") or "").strip())
        if not m:  # no Range (or one we don't serve, e.g. several ranges): the whole file
            return Response(200, headers, file=path)
        start, end = int(m[1]), min(int(m[2]) if m[2] else size - 1, size - 1)
        if start >= size or end < start:
            return Response(416, {**headers, "content-range": f"bytes */{size}"})
        return Response(206, {**headers, "content-range": f"bytes {start}-{end}/{size}"}, file=path,
                        offset=start, length=end - start + 1)

    ctx.add_route("GET", "/v1/updates/manifest", manifest)
    ctx.add_route("GET", "/v1/updates/assets/{sha256}", asset)
    ctx.add_route("GET", "/v1/app/latest", latest)
    ctx.add_route("GET", "/v1/app/apk/{versionCode}", apk_file)


FEATURE = Feature(name="app_updates", setup=setup, description="Collects app builds from GitHub and serves app updates")
