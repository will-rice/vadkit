#!/usr/bin/env bash
# Consumer-side packaging checks against the packed tarball, the artifact
# npm actually publishes:
#   1. a Vite app and a webpack 5 app each build a webrtc-only entry and a
#      silero entry; the webrtc-only bundle must be free of onnxruntime and
#      the silero build must emit the model as a hashed asset;
#   2. every exports-map subpath imports under Node with no DOM
#      (and under $EXTRA_NODE too, when set — CI passes Node 22);
#   3. the no-bundler path: dist/ + models/ + ort served as static files
#      behind an import map, driven by Playwright (tests/packaging/cdn.mjs).
# Run: npm run check:packaging   (needs `npx playwright install chromium`)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== pack"
(cd "$ROOT" && npx vp pack >/dev/null)
TARBALL="$WORK/$(cd "$ROOT" && npm pack --silent --pack-destination "$WORK" | tail -1)"

for app in vite webpack; do
  echo "== $app"
  cp -R "$ROOT/tests/packaging/$app" "$WORK/$app"
  (cd "$WORK/$app" && npm install --no-audit --no-fund --silent "$TARBALL")
  for entry in webrtc-only silero; do
    (cd "$WORK/$app" && ENTRY="$entry" npm run -s build >/dev/null)
  done
  if grep -rq onnxruntime "$WORK/$app/out/webrtc-only"; then
    echo "FAIL: $app webrtc-only bundle contains onnxruntime" >&2
    exit 1
  fi
  if ! find "$WORK/$app/out/silero" -name '*.onnx' | grep -q .; then
    echo "FAIL: $app silero build emitted no .onnx asset" >&2
    exit 1
  fi
  echo "ok: $app webrtc-only is ort-free; silero emits the model asset"
done

echo "== node import"
mkdir "$WORK/node"
(cd "$WORK/node" && npm install --no-audit --no-fund --silent "$TARBALL")
cp "$ROOT/tests/packaging/node_import.mjs" "$WORK/node/"
for NODE_BIN in "$(command -v node)" ${EXTRA_NODE:-}; do
  (cd "$WORK/node" && "$NODE_BIN" node_import.mjs)
done

echo "== cdn"
(cd "$ROOT" && node tests/packaging/cdn.mjs "$WORK/node/node_modules")
echo "packaging checks passed"
