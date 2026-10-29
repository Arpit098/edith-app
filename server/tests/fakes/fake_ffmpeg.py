#!/usr/bin/env python3
"""A fake `ffmpeg` for the whisper_cpp adapter tests. Stdlib only, no imports from the repo.

Logs {"argv", "stdin_bytes", "input_bytes"} as one JSON line to $FAKE_FFMPEG_LOG, then writes
$FAKE_FFMPEG_SECONDS (default 2) seconds of 16 kHz mono s16le silence to stdout and exits with
$FAKE_FFMPEG_EXIT (default 0, with a message on stderr otherwise)."""
import json
import os
import sys


def main():
    argv = sys.argv[1:]
    source = argv[argv.index("-i") + 1]
    stdin = sys.stdin.buffer.read()
    size = len(stdin) if source == "pipe:0" else os.path.getsize(source)
    if os.environ.get("FAKE_FFMPEG_LOG"):
        with open(os.environ["FAKE_FFMPEG_LOG"], "a") as f:
            f.write(json.dumps({"argv": argv, "stdin_bytes": len(stdin), "input_bytes": size}) + "\n")
    code = int(os.environ.get("FAKE_FFMPEG_EXIT", "0"))
    if code:
        sys.stderr.write("pipe:0: Invalid data found when processing input\n")
        return code
    sys.stdout.buffer.write(b"\0\0" * int(float(os.environ.get("FAKE_FFMPEG_SECONDS", "2")) * 16000))
    return 0


if __name__ == "__main__":
    sys.exit(main())
