#!/usr/bin/env bash
# Build whisper.cpp for edith (ARM64 Neoverse-N1, NEON + dotprod) and download its models.
#
#   deploy/whisper/build.sh            # build (if needed) + download the default models
#   deploy/whisper/build.sh build      # build only
#   deploy/whisper/build.sh models [name…]   # download models only, e.g. small-q5_1
#
# The build runs under `nice -n 19` / `ionice -c3` with 2 jobs so the live Telegram bridge keeps the CPU.
# Everything stays in the user's home: no sudo, nothing in /usr.
#   source + build:  ~/opt/whisper.cpp/{src,build}
#   binaries:        ~/opt/whisper.cpp/bin/{whisper-server,whisper-cli,whisper-bench}
#   models:          ~/.local/share/whisper/ggml-<name>.bin
# Re-running is safe: a finished build at the pinned commit and verified models are skipped.
set -euo pipefail

# Pinned release. The commit is checked after the clone, so a moved tag fails the build.
TAG="v1.9.5"
COMMIT="d1be6fde11ac6e0407606b4e42fe72d34add8037"
REPO="https://github.com/ggml-org/whisper.cpp"
# Official model files (Hugging Face ggerganov/whisper.cpp); sha256 from the repo's LFS metadata.
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
declare -A SHA256=(
  [base]=60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe
  [base-q5_1]=422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898
  [base-q8_0]=c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9
  [small]=1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b
  [small-q5_1]=ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb
  [small-q8_0]=49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f
)
DEFAULT_MODELS=(base-q5_1 base-q8_0 small-q5_1 small-q8_0)

PREFIX="${WHISPER_PREFIX:-$HOME/opt/whisper.cpp}"
MODELS="${WHISPER_MODELS:-$HOME/.local/share/whisper}"
JOBS="${JOBS:-2}"
LOW=(nice -n 19 ionice -c3)

log() { printf '[whisper] %s\n' "$*" >&2; }

build() {
  local src="$PREFIX/src" out="$PREFIX/build"
  if [[ -x "$PREFIX/bin/whisper-server" && "$(cat "$PREFIX/bin/.commit" 2>/dev/null)" == "$COMMIT" ]]; then
    log "already built at $TAG ($COMMIT)"
    return
  fi
  mkdir -p "$PREFIX"
  if [[ ! -d "$src/.git" ]]; then
    git clone --depth 1 --branch "$TAG" "$REPO" "$src"
  else
    git -C "$src" fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG"
    git -C "$src" checkout --detach "$TAG"
  fi
  local head
  head="$(git -C "$src" rev-parse HEAD)"
  [[ "$head" == "$COMMIT" ]] || { log "tag $TAG is at $head, expected $COMMIT: refusing to build"; exit 1; }

  # GGML_NATIVE: tune for this CPU (armv8.2-a + dotprod + fp16 NEON on Neoverse-N1); it is built here, for here.
  # Static libs so the binaries don't depend on the build folder. No GPU backends, no tests.
  "${LOW[@]}" cmake -S "$src" -B "$out" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_NATIVE=ON \
    -DGGML_OPENMP=ON \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_EXAMPLES=ON \
    -DWHISPER_BUILD_SERVER=ON \
    -DWHISPER_SDL2=OFF \
    -DWHISPER_CURL=OFF
  "${LOW[@]}" cmake --build "$out" --config Release -j "$JOBS" --target whisper-server whisper-cli whisper-bench

  mkdir -p "$PREFIX/bin"
  for b in whisper-server whisper-cli whisper-bench; do
    install -m 755 "$out/bin/$b" "$PREFIX/bin/$b"
  done
  echo "$COMMIT" > "$PREFIX/bin/.commit"
  log "built $TAG into $PREFIX/bin"
}

verify() {  # verify <file> <sha256>
  [[ "$(sha256sum "$1" | cut -d' ' -f1)" == "$2" ]]
}

model() {
  local name="$1" want="${SHA256[$1]:-}"
  [[ -n "$want" ]] || { log "unknown model $name (known: ${!SHA256[*]})"; exit 1; }
  local file="$MODELS/ggml-$name.bin"
  if [[ -f "$file" ]] && verify "$file" "$want"; then
    log "$name: present, checksum ok"
    return
  fi
  mkdir -p "$MODELS"
  # Download to .part (resumable), verify, then rename: a half or bad file never gets the real name.
  curl -fL --retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 20 -C - \
    -o "$file.part" "$MODEL_URL/ggml-$name.bin"
  if ! verify "$file.part" "$want"; then
    rm -f "$file.part"
    log "$name: checksum mismatch, deleted"
    exit 1
  fi
  mv "$file.part" "$file"
  log "$name: downloaded, checksum ok"
}

case "${1:-all}" in
  build) build ;;
  models) shift; (($#)) || set -- "${DEFAULT_MODELS[@]}"; for m in "$@"; do model "$m"; done ;;
  all) build; for m in "${DEFAULT_MODELS[@]}"; do model "$m"; done ;;
  *) echo "usage: $0 [all|build|models [name…]]" >&2; exit 2 ;;
esac
