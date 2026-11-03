# Attachments contract (app ⇄ server)

Images, audio files and documents Arpit sends from the app reach EDITH exactly like Telegram attachments: saved in
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
| `application/pdf` | `%PDF-` | `.pdf` | 25 MB |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | a zip (`PK 03 04`) whose directory lists `word/document.xml` | `.docx` | 25 MB |
| `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | a zip listing `xl/workbook.xml` | `.xlsx` | 25 MB |
| `application/vnd.openxmlformats-officedocument.presentationml.presentation` | a zip listing `ppt/presentation.xml` | `.pptx` | 25 MB |
| `application/zip` | any other readable zip | `.zip` | 25 MB |
| `application/msword`, `application/vnd.ms-excel`, `application/vnd.ms-powerpoint` | the OLE signature `D0 CF 11 E0 A1 B1 1A E1`, with an `x-filename` ending `.doc`, `.xls` or `.ppt` (else 415) | that extension | 25 MB |
| `text/csv`, `text/markdown`, `application/json`, `text/plain` | the **whole file** is text: UTF-8 (a BOM is fine) with no control bytes other than tab, LF, VT, FF, CR and ESC; or UTF-16 starting with a BOM (`FF FE` / `FE FF`), no control characters but those; or Windows-1252 (Excel's CSV export) with no control bytes but tab, CR and LF. `x-filename` ending `.csv`, `.md`/`.markdown`, `.json`, anything else → `text/plain` | `.csv`, `.md`, `.json`, `.txt` | 25 MB |

  The name only ever chooses within a class the bytes already proved (OLE → doc/xls/ppt, text → csv/md/json/txt).
  A zip is checked after the upload by reading its central directory only (never extracted); a broken zip is
  415. Its end-of-central-directory entry count is read first: over 10,000 entries (or Zip64's `FFFF` marker),
  the directory isn't listed and the file is stored as a plain `.zip`. Text that turns binary part-way is
  refused as soon as the bad chunk arrives (UTF-16 is checked after the upload). UTF-16 and Windows-1252 text
  is **stored converted to UTF-8** (no BOM); the answer's `size` and `sha256` are still the upload's.

  Anything else: 415 `"unsupported file type"` (nothing is kept). Over 25 MB: 413 before the body is read;
  an image over 20 MB: 413 after it is detected. The app checks the same caps, byte for byte, before uploading
  (`app/src/features/live-session/attachments.ts`).
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

**Documents:** Claude reads PDFs and text files with its Read tool from the path as they are. For files it
can't (Office and zip), a note line follows the file's line, so it knows what the file is and where the text
lives:

```
[Attached file saved at: /home/ubuntu/edith/inbox/1793600123_CV_final.docx]
[Attached file note: 1793600123_CV_final.docx is a Word document (a zip of XML: the text is in word/document.xml)]
```

Telegram uses the same lines (`common/text.py` `attachment_lines`): its documents are still saved under their
own names with no type check (as before), and get the note when the name ends `.docx`, `.xlsx`, `.pptx`,
`.doc`, `.xls`, `.ppt` or `.zip`. The message history (`clean_prompt`) drops note lines like attachment lines.

**Audio is not transcribed by the server**, the same as Telegram voice and audio files (they arrive as
`[Attached file saved at: …]` too). For speaking to EDITH the app uses `/v1/stt` and `voice: true` instead
(contracts/events.md, "Voice").

## 3. Storage

- Saved in `~/edith/inbox/` as `<unix time>_<safe name>.<ext>`, the Telegram naming: the safe name is the
  `x-filename` stem with everything outside `[A-Za-z0-9._-]` replaced by `_` (at most 60 characters;
  `image`, `audio` or `document` without one), and the **extension always comes from the detected type**. A name
  that is already taken gets `-2`, `-3`, … (never overwritten).
- Mode 0600, written to a temp file in the inbox while hashed, then moved into place (atomic).
- The ids are kept in `~/.cache/edith/app-attachments.json` (atomic writes), at most 500.

## 4. Files EDITH sends: `sent_files` and `GET /v1/files/{id}`

The other way round. EDITH sends a file with a `SEND_FILE: /path` line in its reply; Telegram attaches it.
For the app, the App API registers each path under an opaque random id and adds `sent_files` next to the
event's `files` paths (`message.assistant`, `turn.done`, on the stream and in history; contracts/events.md):

```json
"sent_files": [{ "id": "9f2c…(32 hex)", "name": "Plan v2.pdf", "size": 204800, "mime": "application/pdf" },
               { "name": "id_rsa", "error": "in a private folder" }]
```

- **Download:** `GET /v1/files/{id}` with the usual `Authorization: Bearer <token>` (401 without, audited
  with the id and size only). The answer streams the file with `Content-Type` (its `mime`), `Content-Length`,
  `Content-Disposition: attachment; filename*=UTF-8''<name>` and `X-Content-Type-Options: nosniff`.
  404 when the id is unknown or expired, or the file was changed, replaced or removed since it was
  registered (the app shows "no longer available"; EDITH can send it again).
- **Only registered ids** are served; a request never names a path. Ids are registered from the live
  events (whether or not the app is connected); history pages only look ids up (a file never registered,
  or expired, comes back as `{name, error: "no longer available"}`), so reading history never creates or
  renews one. Ids are 32 hex characters, kept 7 days
  (and across restarts) in `~/.cache/edith/app-sent-files.json` (mode 0600, atomic writes, at most 1000).
  The same file (resolved path, inode, size and mtime) keeps its id, so the live event and history agree.
- **Allowed roots:** a file must be inside one of `send_file_roots` (`[adapter.app_api]` in config.toml;
  default `~/edith`, `~/Projects`, `/tmp/edith-out` and `~/Downloads` if it exists), or inside a Claude
  session's scratchpad (`/tmp/claude-<uid>/<project>/<session>/scratchpad/…`, always allowed). Nothing else
  under `/tmp` (browser profiles, task outputs and prompt files live there). Checked on the resolved path, and not inside a dot-folder below that root (`.git`, `.venv`,
  `.claude`, …). So `~/.claude.json`, `~/.bash_history`, `~/edith-backups`, `~/.local/share` and
  `~/.cache/edith` are never offered. The rules below apply inside the roots as well.
- **What is refused** at registration, because Claude writes these lines: anything inside a folder named
  `.config`, `.claude`, `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.password-store`, `.mozilla`,
  `.pki` or `.git` (anywhere, so `~/edith/.claude` too), under `~/.local/share/keyrings` or
  `~/.cache/edith/accounts` (saved Claude logins), or under `/proc`, `/sys` or `/dev` (checked on the path as
  given and with symlinks resolved); `.env*`, `.netrc`, `.git-credentials`, `authorized_keys*`, `known_hosts*`,
  `.npmrc`, `.pypirc`, `.pgpass`,
  `id_rsa`-style keys, `client_secret*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.kdbx`,
  `*.gpg`, `*.asc`, and names whose stem ends in key(s), token(s), secret(s), credential(s), password(s) or
  passwd (`cracker-dev-key.json`, `app-token`; `token-analysis.pdf` is fine); anything that isn't a regular
  readable file; a file with more than one hard link (at registration and again when served); files over
  50 MB. A refusal is logged once per path and reason, with the path, never the file's contents, and the
  app gets `{name, error}`.
- **Which lines count:** only the turn's final reply (`turn.done`, and the transcript's text with
  `stop_reason` other than `tool_use`); `SEND_FILE:` lines in narration before a tool call are dropped, and
  lines inside fenced code blocks (```` ``` ```` or `~~~`) are never directives. The path is the rest of the
  line, trimmed, so it may hold spaces; backticks or quotes around it are dropped, and a trailing
  ` REACT: <emoji>` on the same line is the reply's reaction, not part of the path. A transcript entry
  without a `stop_reason` counts as the final reply only when it is its turn's last assistant entry. Telegram
  answers "⚠️ File not found: <path>" for a path that doesn't exist, as it always has. Telegram reads the lines the same way (`common/text.py` `take_files`).
- If the download comes back shorter than `Content-Length` (the file shrank while it was sent), the server
  closes the connection; the app also checks the size against `size`.
- Relative paths are taken from EDITH's working folder (`~/edith`), `~/` from the home.
- **The app** shows them on EDITH's bubble as chips (type icon, name, size; images as a thumbnail once
  downloaded). Tapping downloads into the app's cache with progress (kept 7 days, at most 200 MB), then:
  an image opens full screen, a text file (txt, md, csv, json, log, html, code; up to 1 MB) opens in a
  reader (the first 200 KB, long lines in 2,000-character rows, then "Save to see all"), anything else is saved to a folder Arpit picks once (Android's folder picker, e.g. Download/EDITH;
  no storage permission). A long press saves any file there. The folder is asked for again only when it
  is gone or its access was taken back; any other failure is shown as it is. Opening a file in another app (a PDF viewer)
  or the share sheet needs a native module the current APK doesn't have (expo-sharing or a FileProvider
  intent); it comes with a later APK.
