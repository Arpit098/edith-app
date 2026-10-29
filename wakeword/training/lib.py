"""Small stdlib-only helpers shared by fetch.py, data.py and train.py (and tested on edith without
any ML packages): HTTP with timeouts and retries, verified downloads, data splits, the .npy header,
activation counting and the model's JSON."""
import ast
import hashlib
import json
import os
import re
import struct
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta

IST = timezone(timedelta(hours=5, minutes=30), "IST")
CHUNK = 1024 * 1024
RETRIES = 4
FRAME_SECONDS = 1280 / 16000  # one openWakeWord prediction per 80 ms of audio


class FetchError(Exception):
    pass


def request(url, headers=None, timeout=60, retries=RETRIES, sleep=time.sleep):
    """urlopen with a timeout, retried with backoff on connection errors and 5xx/429. 4xx raise at once."""
    for attempt in range(retries + 1):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429 or attempt == retries:
                raise FetchError(f"{url.split('?')[0]}: HTTP {e.code} {e.read()[:200].decode(errors='replace')}")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == retries:
                raise FetchError(f"{url.split('?')[0]}: {getattr(e, 'reason', e)}")
        sleep(min(30, 2 ** attempt))


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()


def download(url, dest, sha256=None, headers=None, start=0, length=None, timeout=120):
    """Stream url (or `length` bytes of it from `start`) to dest, resuming a partial dest.part, then
    check sha256 if given and move it into place. Skips the download if dest already matches."""
    if os.path.exists(dest) and (sha256 is None or sha256_file(dest) == sha256):
        return dest
    os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
    part = dest + ".part"
    have = os.path.getsize(part) if os.path.exists(part) else 0
    end = None if length is None else start + length - 1
    if length is not None and have >= length:
        have = length
    else:
        ranged = bool(start + have) or end is not None
        rng = f"bytes={start + have}-{'' if end is None else end}"
        with request(url, {**(headers or {}), "Range": rng} if ranged else headers,
                     timeout=timeout) as r, open(part, "ab" if have else "wb") as f:
            if ranged and r.status != 206:
                raise FetchError(f"{url.split('?')[0]}: the server did not resume (HTTP {r.status}); delete {part}")
            while chunk := r.read(CHUNK):
                f.write(chunk)
    if sha256 and sha256_file(part) != sha256:
        os.remove(part)
        raise FetchError(f"{os.path.basename(dest)}: sha256 mismatch (deleted; run again)")
    os.replace(part, dest)
    return dest


# ---- .npy headers (format 1.0), so a slice of the negative features can be downloaded ----

def npy_header(raw: bytes):
    """-> (header length, descr, shape) of a .npy file from its first bytes."""
    if raw[:6] != b"\x93NUMPY":
        raise ValueError("not a .npy file")
    major = raw[6]
    if major == 1:
        n, start = struct.unpack("<H", raw[8:10])[0], 10
    else:
        n, start = struct.unpack("<I", raw[8:12])[0], 12
    info = ast.literal_eval(raw[start:start + n].decode("latin1"))
    return start + n, info["descr"], tuple(info["shape"])


def npy_header_bytes(descr, shape):
    """A format 1.0 header for a C-order array, padded to a multiple of 64 bytes as numpy writes it."""
    text = "{'descr': %r, 'fortran_order': False, 'shape': %r, }" % (descr, tuple(shape))
    total = 10 + len(text) + 1
    text += " " * ((64 - total % 64) % 64) + "\n"
    return b"\x93NUMPY\x01\x00" + struct.pack("<H", len(text)) + text.encode("latin1")


# ---- data ----

def pick_device(torch, wanted="auto"):
    """The torch device to train on: Apple's GPU (mps), then CUDA, then the CPU."""
    if wanted != "auto":
        return wanted
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def split(clips, every):
    """(train, held_out): every `every`-th clip by SHA-256 order is held out, so the split is the same
    on every run and on every machine (contracts/wakeword.md §5)."""
    ordered = sorted(clips, key=lambda c: c["sha256"])
    held = [c for i, c in enumerate(ordered) if i % every == every - 1]
    return [c for c in ordered if c not in held], held


def activations(scores, threshold, refractory_frames=25):
    """How many times a stream of per-frame scores crosses the threshold, counting one activation per
    burst: after one, the next `refractory_frames` frames (2 s) can't count again."""
    count, blocked = 0, 0
    for s in scores:
        if blocked:
            blocked -= 1
        elif s >= threshold:
            count, blocked = count + 1, refractory_frames
    return count


def model_info(onnx_path, session, threshold, metrics, device, oww_version, params, now=None):
    now = now or time.time()
    return {"version": f"hey_edith-{datetime.fromtimestamp(now, IST):%Y%m%d-%H%M}", "created_at": int(now),
            "file": os.path.basename(onnx_path), "sha256": sha256_file(onnx_path), "size": os.path.getsize(onnx_path),
            "session": session, "threshold": threshold, "metrics": metrics, "device": device,
            "openwakeword": oww_version, "training": params}


def metrics_md(info):
    m = info["metrics"]
    when = datetime.fromtimestamp(info["created_at"], IST).strftime("%d %b %Y, %H:%M IST")
    frr_ok = "✅" if m["false_reject_rate"] < 0.05 else "❌"
    fa_ok = "✅" if m["false_accepts_per_hour"] < 1 else "❌"
    return "\n".join([
        f"# Hey Edith model: {info['version']}", "",
        f"Trained {when} on session `{info['session']}` ({info['device']}, openWakeWord {info['openwakeword']}).",
        f"Threshold {info['threshold']}. Targets (PLAN.md §4.5): false rejects under 5%, false accepts under 1 per hour.", "",
        "| Metric | Value | Target |", "|---|---|---|",
        f"| False-reject rate (held-out real recordings, n={m['held_out_positives']}) | {m['false_reject_rate']:.1%} | {frr_ok} < 5% |",
        f"| False accepts per hour (negative validation set, {m['negative_hours']:.1f} h) | {m['false_accepts_per_hour']:.2f} | {fa_ok} < 1 |",
        f"| False accepts per hour (held-out home noise, {m['noise_hours']:.2f} h) | {m['noise_false_accepts_per_hour']:.2f} | |",
        "", f"`{info['file']}` sha256 `{info['sha256']}` ({info['size']} bytes).", ""])


def safe_name(text):
    return re.sub(r"[^A-Za-z0-9._-]", "_", text)


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
        f.write("\n")
    os.replace(tmp, path)
