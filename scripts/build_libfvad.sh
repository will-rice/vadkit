#!/usr/bin/env bash
# Reproducible build of the vendored libfvad wasm module.
#
# libfvad (BSD-3-Clause) is the standalone extraction of WebRTC's VAD.
# The output is a single-file ES module (wasm embedded as base64) so
# consumers need no asset configuration, committed at
# src/providers/libfvad/fvad.js.
#
# Requires: emscripten (emcc), git.
set -euo pipefail

LIBFVAD_REPO="https://github.com/dpirch/libfvad"
LIBFVAD_SHA="532ab666c20d3cfda38bca63abbb0f152706c369" # master, 2024-02-19

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$HERE/../src/providers/libfvad"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

git clone --quiet "$LIBFVAD_REPO" "$WORK_DIR/libfvad"
git -C "$WORK_DIR/libfvad" checkout --quiet "$LIBFVAD_SHA"

mkdir -p "$OUT_DIR"
emcc \
  "$WORK_DIR"/libfvad/src/fvad.c \
  "$WORK_DIR"/libfvad/src/signal_processing/*.c \
  "$WORK_DIR"/libfvad/src/vad/*.c \
  -I"$WORK_DIR"/libfvad/include \
  -O3 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createFvadModule \
  -sSINGLE_FILE=1 \
  -sENVIRONMENT=web,worker,node \
  -sFILESYSTEM=0 \
  -sALLOW_MEMORY_GROWTH=0 \
  -sEXPORTED_FUNCTIONS=_fvad_new,_fvad_free,_fvad_reset,_fvad_set_mode,_fvad_set_sample_rate,_fvad_process,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAP16 \
  -o "$OUT_DIR/fvad.js"

# /*! */ banners survive bundlers and minifiers, keeping the attribution
# pointer inside the artifact that actually ships the compiled BSD code.
printf '/*! libfvad (BSD-3-Clause) %s — see THIRD_PARTY_NOTICES. https://github.com/dpirch/libfvad */\n' "$LIBFVAD_SHA" \
  | cat - "$OUT_DIR/fvad.js" > "$OUT_DIR/fvad.js.tmp"
mv "$OUT_DIR/fvad.js.tmp" "$OUT_DIR/fvad.js"

echo "built $OUT_DIR/fvad.js from libfvad $LIBFVAD_SHA"
