# Wake word contract (app ⇄ server ⇄ Mac trainer)

How the "Hey Edith" model is made (PLAN.md §4.5): the app records clips and uploads them to edith; the
Claude agent on Arpit's MacBook downloads them, trains with openWakeWord (`wakeword/training/`) and
pushes the model to `main`; the app gets it in an OTA update. Three parties:
- **the app** (Train wake word screen): sessions, uploads, status;
- **the server** (`server/edith/features/wakeword/`): stores the clips, serves them, reports model status;
- **the trainer** (`wakeword/training/fetch.py`): downloads a session.

Change this file first, then the sides. Times in JSON are unix seconds; anything shown to Arpit is in IST.

## 1. Auth and transport

Every route is on the App API: Tailscale IP only (`http://edith:8787`), `Authorization: Bearer <token>`
(401 without it), errors as `{"error": "<message>"}`, every request in the audit log. The trainer reads
the token from a file and never prints it. Recordings never go in git.

## 2. Clip format and kinds

- **Format (checked by the server from the WAV header, with Python's `wave` module):** RIFF/WAVE, PCM,
  **1 channel, 16000 Hz, 16-bit**, and the data chunk holds exactly the frames the header declares.
  Anything else is a 400 that says what is wrong (e.g. `"expected 16000 Hz, got 44100"`). The server
  never converts audio.
- **Kinds:**

| `kind` | What | Duration |
|---|---|---|
| `positive_near` | "Hey Edith" at normal voice, phone within ~1 m | 0.5–5 s |
| `positive_far` | "Hey Edith" from across the room | 0.5–5 s |
| `positive_whisper` | "Hey Edith" whispered | 0.5–5 s |
| `noise` | Home background, TV, music, talk without "Hey Edith" | 1–120 s |

- **Caps:** a request body of at most 4 MB (413); at most 300 clips per session and 20 sessions (409);
  all recordings together at most 500 MB (507, `"recordings are using all their space; delete a session"`).
- A clip is identified by the **SHA-256 of the whole WAV file** (lowercase hex).

## 3. Routes

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `/v1/wakeword/sessions` | `{label?}` (≤ 60 chars) | `Session` |
| GET | `/v1/wakeword/sessions` | | `{sessions: [Session], usage: {bytes, max_bytes}}`, newest first |
| DELETE | `/v1/wakeword/sessions/{id}` | | `{deleted: id}`: the session and all its clips; 404 if unknown |
| POST | `/v1/wakeword/sessions/{id}/clips?kind=<kind>` | the WAV file, `Content-Type: audio/wav` | `{clip: Clip, created: bool}` |
| GET | `/v1/wakeword/sessions/{id}/clips/{sha256}` | | the WAV file (`audio/wav`, `content-length`, `etag: "<sha256>"`); 404 if unknown |
| DELETE | `/v1/wakeword/sessions/{id}/clips/{sha256}` | | `{deleted: sha256}` (a bad take); 404 if unknown |
| GET | `/v1/wakeword/sessions/{id}/manifest` | | `Manifest` (§4) |
| GET | `/v1/wakeword/model` | | `ModelStatus` (§5) |

`Session`:

```json
{ "id": "20261102-1043-a1b2", "label": "Living room", "created_at": 1793600000, "updated_at": 1793600300,
  "clips": 42, "bytes": 3120000, "seconds": 96.5,
  "kinds": { "positive_near": {"count": 20, "seconds": 30.1}, "positive_far": {"count": 10, "seconds": 16.0},
             "positive_whisper": {"count": 8, "seconds": 12.4}, "noise": {"count": 4, "seconds": 38.0} } }
```

- `id` is the creation time in IST (`YYYYMMDD-HHMM`) plus 4 random hex characters: only `[0-9a-z-]`.
  `kinds` lists all four kinds, with zeros for those not recorded yet.

**Uploading a clip** (`POST …/clips?kind=`):
- The body is streamed to disk while its SHA-256 is computed; it is never held whole in memory. Send
  `Content-Length` (chunked uploads are refused with 411).
- Optional header `x-clip-sha256: <hex>`: the app's own hash of the file. If it differs from what arrived:
  400 `"sha256 mismatch"` and nothing is stored.
- **Idempotent on the SHA-256:** the same file uploaded again to the same session returns the stored clip
  with `created: false` (retries after a lost answer are safe). The same file with a different `kind`
  is a 409.
- `Clip`:

```json
{ "sha256": "9b1e…", "kind": "positive_near", "seconds": 1.52, "bytes": 48684,
  "peak_dbfs": -6.2, "rms_dbfs": -27.9, "uploaded_at": 1793600123 }
```

  `peak_dbfs` / `rms_dbfs` are the server's measure of the level (dB relative to full scale; `-inf` is sent
  as `-120.0`). The app does its own checks before uploading (length, level, clipping); these let the
  trainer and the app double-check.

## 4. Manifest (for the trainer)

`GET /v1/wakeword/sessions/{id}/manifest` returns the session's `manifest.json` as stored:

```json
{ "version": 1, "session": "20261102-1043-a1b2", "label": "Living room",
  "created_at": 1793600000, "updated_at": 1793600300,
  "format": { "sample_rate": 16000, "channels": 1, "sample_width": 2 },
  "clips": [ { "sha256": "9b1e…", "kind": "positive_near", "file": "clips/9b1e….wav", "seconds": 1.52,
               "bytes": 48684, "peak_dbfs": -6.2, "rms_dbfs": -27.9, "uploaded_at": 1793600123 } ] }
```

- `clips` is in upload order. `file` is the path inside the session folder on edith (for reference); the
  trainer downloads each clip by `sha256` and checks the SHA-256 of what it got.

## 5. Model status

`GET /v1/wakeword/model`:

```json
{ "state": "waiting_for_training",
  "model": { "version": "hey_edith-20261102-1130", "created_at": 1793603400, "file": "hey_edith.onnx",
             "sha256": "…", "size": 412345, "session": "20261102-1043-a1b2", "threshold": 0.5,
             "metrics": { "false_reject_rate": 0.031, "false_accepts_per_hour": 0.4,
                          "held_out_positives": 32, "negative_hours": 11.3,
                          "noise_false_accepts_per_hour": 0.0, "noise_hours": 0.2 },
             "device": "mps", "openwakeword": "0.6.0" },
  "latest_session": { "id": "20261102-1043-a1b2", "clips": 42, "updated_at": 1793600300 } }
```

- `model` is `wakeword/models/hey_edith.json` from the **server's deployed checkout** (the trainer writes
  it next to `hey_edith.onnx` and `metrics.md`; they reach `main` together), or `null` if there is none yet.
  The app compares `model.version` with the `hey_edith.json` it bundles: if they differ, the new model
  arrives with the next app update.
- `state`:
  - `no_recordings`: no session has a clip;
  - `waiting_for_training`: the newest session with clips is not the one `model.session` was trained on
    (or there is no model);
  - `trained`: the model was trained on the newest session with clips.
- Metrics: `false_reject_rate` on the held-out real recordings (every 5th positive clip of the session,
  by SHA-256 order, never used for training); `false_accepts_per_hour` on openWakeWord's negative
  validation set (`negative_hours` of audio); `noise_false_accepts_per_hour` on the held-out real noise
  clips (every 3rd `noise` clip). All at `threshold`.

## 6. Storage on edith

`~/.cache/edith/wakeword/recordings/<session>/manifest.json` and `clips/<sha256>.wav`, mode 0600 (folders
0700). Written atomically (temp file, then rename); the manifest is changed under a lock. Never in git.
