"""Wake word (contracts/wakeword.md, PLAN.md §4.5): recording sessions the app uploads "Hey Edith"
and noise clips into, downloads of them for the trainer on Arpit's Mac, and the model's status.

Clips are streamed to disk while hashed, then checked with the stdlib `wave` module (16 kHz mono
16-bit, nothing converted) before they are kept; see store.py for the layout, lock and caps.

Config [features.wakeword]: max_total_mb (500), models_dir (default: this checkout's wakeword/models).
"""
import json
import os
import pathlib
import threading

from edith.common.paths import resolve
from edith.core import ApiError, Context, Feature, Response

from .store import MAX_CLIP_BYTES, Recordings, StoreError

MODELS = pathlib.Path(__file__).resolve().parents[4] / "wakeword" / "models"


def json_answer(data, audit):
    """A JSON answer with fields for the audit log (Response, since plain dicts carry none)."""
    return Response(200, {"content-type": "application/json"}, json.dumps(data).encode(), audit={"wakeword": audit})


def setup(ctx: Context) -> None:
    cfg = ctx.config
    root = os.path.join(resolve(cfg).state_dir, "wakeword", "recordings")
    max_total = int(float(cfg.get("max_total_mb", 500)) * 1024 * 1024)
    model_file = pathlib.Path(os.path.expanduser(cfg.get("models_dir", str(MODELS)))) / "hey_edith.json"
    lock, holder, model_cache = threading.Lock(), [], {}

    def store():
        """Opened on first use, so loading the feature (e.g. `make check`) touches no file."""
        with lock:
            if not holder:
                holder.append(Recordings(root, max_total))
            return holder[0]

    def call(fn, *args):
        try:
            return fn(*args)
        except StoreError as e:
            raise ApiError(e.status, e.message)

    # ---- sessions ----

    def create(req):
        session = call(store().create, ((req.get("body") or {}).get("label") or ""))
        return json_answer(session, {"created": session["id"]})

    def listing(req):
        s = store()
        return {"sessions": s.sessions(), "usage": {"bytes": s.used, "max_bytes": s.max_total_bytes}}

    def delete(req):
        sid = req["params"]["id"]
        call(store().delete, sid)
        return json_answer({"deleted": sid}, {"deleted": sid})

    def manifest(req):
        return call(store().manifest, req["params"]["id"])

    # ---- clips ----

    def upload(req):
        sid, kind = req["params"]["id"], (req.get("query") or {}).get("kind", "")
        clip, created = call(store().add, sid, kind, req["body_stream"], req["length"],
                             (req.get("headers") or {}).get("x-clip-sha256"))
        return json_answer({"clip": clip, "created": created},
                           {"session": sid, "kind": kind, "sha256": clip["sha256"], "seconds": clip["seconds"],
                            "created": created})

    def download(req):
        path = call(store().clip_path, req["params"]["id"], req["params"]["sha256"])
        return Response(200, {"content-type": "audio/wav", "etag": f"\"{req['params']['sha256']}\""}, file=path)

    def remove(req):
        sid, sha = req["params"]["id"], req["params"]["sha256"]
        call(store().remove, sid, sha)
        return json_answer({"deleted": sha}, {"session": sid, "deleted": sha})

    # ---- model ----

    def model_info():
        """hey_edith.json, re-read only when the file changes."""
        try:
            st = model_file.stat()
        except OSError:
            return None
        key = (st.st_mtime_ns, st.st_size)
        if model_cache.get("key") != key:
            try:
                model_cache.update(key=key, value=json.loads(model_file.read_text()))
            except (OSError, ValueError):
                ctx.log("wake word model info unreadable: %s", model_file)
                return None
        return model_cache["value"]

    def model(req):
        info = model_info()
        recorded = [s for s in store().sessions() if s["clips"]]
        latest = recorded[0] if recorded else None
        if latest is None:
            state = "no_recordings"
        elif info and info.get("session") == latest["id"]:
            state = "trained"
        else:
            state = "waiting_for_training"
        return {"state": state, "model": info,
                "latest_session": latest and {k: latest[k] for k in ("id", "clips", "updated_at")}}

    ctx.add_route("POST", "/v1/wakeword/sessions", create)
    ctx.add_route("GET", "/v1/wakeword/sessions", listing)
    ctx.add_route("DELETE", "/v1/wakeword/sessions/{id}", delete)
    ctx.add_route("GET", "/v1/wakeword/sessions/{id}/manifest", manifest)
    ctx.add_route("POST", "/v1/wakeword/sessions/{id}/clips", upload, max_body=MAX_CLIP_BYTES, stream=True)
    ctx.add_route("GET", "/v1/wakeword/sessions/{id}/clips/{sha256}", download)
    ctx.add_route("DELETE", "/v1/wakeword/sessions/{id}/clips/{sha256}", remove)
    ctx.add_route("GET", "/v1/wakeword/model", model)


FEATURE = Feature(name="wakeword", setup=setup, description="Wake word recordings for training, and the model's status")
