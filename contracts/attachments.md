# Attachments contract (app ⇄ server)

Images and audio files Arpit sends from the app reach EDITH exactly like Telegram attachments: saved in
`~/edith/inbox/` and named in the message with `[Attached file saved at: <path>]` lines. Two steps: upload
each file, then send the message with their ids.

Change this file first, then the sides. Times in JSON are unix seconds.

## 1. Upload: `POST /v1/attachments`

On the App API (Tailscale IP only, `Authorization: Bearer <token>`, 401 without it, audited).

- **Body:** the raw file bytes (not multipart), with `Content-Length` (411 without; chunked uploads are refused).
- **Headers:**
  - `Content-Type`: the app's idea of the type. It is only a hint: the server decides the type from the
    file's first bytes (magic numbers) and never trusts the client's type or name.
  - `x-filename` (optional): the original name, percent-encoded UTF-8 (e.g. `IMG_2041.HEIC`,
    `Voice%20note.m4a`). Only used to make the saved name readable; see §3.
  - `x-content-sha256` (optional): the app's hex SHA-256 of the file; on a mismatch: 400 `"sha256 mismatch"`.
- **Allowed types** (by content):

| `type` | Detected by | Saved as | Max size |
|---|---|---|---|
| `image/jpeg` | `FF D8 FF` | `.jpg` | 20 MB |
| `image/png` | `89 50 4E 47 0D 0A 1A 0A` | `.png` | 20 MB |
| `image/webp` | `RIFF` … `WEBP` | `.webp` | 20 MB |
| `image/heic` | ISO BMFF `ftyp` brand `heic`, `heix`, `hevc`, `hevx`, `heim`, `heis`, `mif1` or `msf1` | `.heic` | 20 MB |
| `audio/ogg` | `OggS` | `.ogg` | 25 MB |
| `audio/mpeg` | `ID3`, or an MPEG audio frame sync (layer I–III) | `.mp3` | 25 MB |
| `audio/mp4` | ISO BMFF `ftyp` brand `M4A `, `M4B `, `mp41`, `mp42`, `isom`, `iso2`, `3gp4`, `3gp5` or `dash` | `.m4a` | 25 MB |
| `audio/wav` | `RIFF` … `WAVE` | `.wav` | 25 MB |
| `audio/aac` | an ADTS frame sync (`FF F1` / `FF F9`) | `.aac` | 25 MB |

  Anything else: 415 `"unsupported file type"` (nothing is kept). Over 25 MB: 413 before the body is read;
  an image over 20 MB: 413 after it is detected.
- **Answer** 200:

```json
{ "id": "a3f9c2d17b0e4e21", "name": "1793600123_IMG_2041.heic", "type": "image/heic", "size": 2340112,
  "sha256": "9b1e…" }
```

  `id` is for `POST /v1/messages` (below); `name` is the saved file name in `~/edith/inbox/`.
- An id stays valid for 7 days (and across server restarts); the file itself stays in the inbox like
  Telegram's.

## 2. Sending: `POST /v1/messages` gains `attachments`

`{text, voice?, queue?, attachments?: [id]}`, at most 10 ids. `text` may be empty when there is at least
one attachment (like a Telegram photo without a caption). An unknown or expired id: 400
`"unknown attachment <id>"` and nothing is sent. The prompt Claude gets is the Telegram format with the App
header:

```
[App message from Arpit, 2026-11-02 10:43 IST]
what is this plant?
[Attached file saved at: /home/ubuntu/edith/inbox/1793600123_IMG_2041.heic]
```

**Audio is not transcribed by the server**, the same as Telegram voice and audio files (they arrive as
`[Attached file saved at: …]` too). For speaking to EDITH the app uses `/v1/stt` and `voice: true` instead
(contracts/events.md, "Voice").

## 3. Storage

- Saved in `~/edith/inbox/` as `<unix time>_<safe name>.<ext>`, the Telegram naming: the safe name is the
  `x-filename` stem with everything outside `[A-Za-z0-9._-]` replaced by `_` (at most 60 characters;
  `image` or `audio` without one), and the **extension always comes from the detected type**. A name
  that is already taken gets `-2`, `-3`, … (never overwritten).
- Mode 0600, written to a temp file in the inbox while hashed, then moved into place (atomic).
- The ids are kept in `~/.cache/edith/app-attachments.json` (atomic writes), at most 500.
