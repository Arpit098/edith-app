#!/usr/bin/env bash
# Benchmark whisper.cpp models the way EDITH uses them: whisper-server, one HTTP request per clip.
#
#   deploy/whisper/bench.sh <clips dir> [model…]     # models default to every ~/.local/share/whisper/ggml-*.bin
#
# Clips are 16 kHz mono WAV files (convert others with ffmpeg -ar 16000 -ac 1). For each model it starts a
# private whisper-server on 127.0.0.1:$PORT (not 8178, so it never clashes with the real service), sends
# one warm-up request, then RUNS timed requests per clip, and prints a markdown table:
#   time = median request time (s), RTF = time / clip length, RAM = the server's peak RSS (VmHWM).
# Transcripts go to <clips dir>/out/<model>/<clip>.txt so accuracy can be checked by eye.
set -euo pipefail

CLIPS="${1:?usage: $0 <clips dir> [model…]}"
shift
BIN="${WHISPER_PREFIX:-$HOME/opt/whisper.cpp}/bin/whisper-server"
MODELS_DIR="${WHISPER_MODELS:-$HOME/.local/share/whisper}"
PORT="${PORT:-18178}"
RUNS="${RUNS:-3}"
THREADS="${THREADS:-2}"
NICE="${NICE:-5}"  # the same priority as deploy/systemd/whisper-server.service
LANGUAGE="${LANGUAGE:-}"  # e.g. hi: skip detection, as /v1/stt?language=hi does
FALLBACK="${FALLBACK:-1}"  # 0: no temperature-fallback retries (caps the worst case on hard audio)
CTX="${CTX:-auto}"  # auto: send audio_ctx sized to the clip, like the adapter; full: whisper's fixed 30 s window

if (($#)); then models=("$@"); else
  models=()
  for f in "$MODELS_DIR"/ggml-*.bin; do n="${f##*/ggml-}"; models+=("${n%.bin}"); done
fi
clips=("$CLIPS"/*.wav)
[[ -e "${clips[0]}" ]] || { echo "no .wav clips in $CLIPS" >&2; exit 1; }

server_pid=""
stop_server() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  server_pid=""
}
trap stop_server EXIT

wait_ready() {
  # whisper-server has no readiness signal but /health (503 while the model loads), so poll it:
  # backoff from 0.1 s, give up after 60 s.
  local delay=100 waited=0  # ms
  until curl -sf "http://127.0.0.1:$PORT/health" >/dev/null; do
    kill -0 "$server_pid" 2>/dev/null || { echo "whisper-server exited; see $1" >&2; return 1; }
    ((waited < 60000)) || { echo "whisper-server not ready after 60 s" >&2; return 1; }
    sleep "$(printf '%d.%03d' $((delay / 1000)) $((delay % 1000)))"
    waited=$((waited + delay))
    delay=$((delay * 2 > 2000 ? 2000 : delay * 2))
  done
}

request() {  # request <clip> <out json> -> prints seconds
  local ctx=()
  [[ "$CTX" == auto ]] && ctx=(-F "audio_ctx=$(audio_ctx "$1")")
  [[ -n "$LANGUAGE" ]] && ctx+=(-F "language=$LANGUAGE")
  [[ "$FALLBACK" == 0 ]] && ctx+=(-F "temperature_inc=0.0")
  curl -sS -o "$2" -w '%{time_total}' --max-time 300 "${ctx[@]}" \
    -F "file=@$1" -F response_format=verbose_json -F temperature=0.0 "http://127.0.0.1:$PORT/inference"
}

# The same rule as audio_ctx() in server/edith/adapters/stt/whisper_cpp.
audio_ctx() { python3 -I -c 'import math,sys,wave; w=wave.open(sys.argv[1]); print(min(1500, math.ceil(w.getnframes()/w.getframerate()*50)+64))' "$1"; }

duration() { python3 -I -c 'import sys,wave; w=wave.open(sys.argv[1]); print(round(w.getnframes()/w.getframerate(), 2))' "$1"; }

median() { sort -n | awk '{a[NR]=$1} END {print (NR%2 ? a[(NR+1)/2] : (a[NR/2]+a[NR/2+1])/2)}'; }

echo "audio_ctx: $CTX, language: ${LANGUAGE:-auto}, fallback: $FALLBACK"
echo "| model | clip | audio s | time s (median of $RUNS) | RTF | RAM MB | language |"
echo "|---|---|---|---|---|---|---|"
for m in "${models[@]}"; do
  model="$MODELS_DIR/ggml-$m.bin"
  [[ -f "$model" ]] || { echo "missing $model" >&2; continue; }
  out="$CLIPS/out/$m"
  mkdir -p "$out"
  nice -n "$NICE" "$BIN" --host 127.0.0.1 --port "$PORT" --model "$model" --threads "$THREADS" --language auto \
    >"$out/server.log" 2>&1 &
  server_pid=$!
  wait_ready "$out/server.log"
  request "${clips[0]}" "$out/warmup.json" >/dev/null
  for c in "${clips[@]}"; do
    name="$(basename "$c" .wav)"
    times=()
    for ((i = 0; i < RUNS; i++)); do times+=("$(request "$c" "$out/$name.json")"); done
    t="$(printf '%s\n' "${times[@]}" | median)"
    d="$(duration "$c")"
    ram="$(awk '/VmHWM/ {printf "%d", $2/1024}' "/proc/$server_pid/status")"
    lang="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("language",""))' "$out/$name.json")"
    python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["text"].strip())' "$out/$name.json" >"$out/$name.txt"
    printf '| %s | %s | %s | %.2f | %.2f | %s | %s |\n' "$m" "$name" "$d" "$t" "$(awk -v t="$t" -v d="$d" 'BEGIN {print t / d}')" "$ram" "$lang"
  done
  stop_server
done
