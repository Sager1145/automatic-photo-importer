#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRATCH="${SWIFT_BUILD_DIR:-${TMPDIR:-/tmp}/photo-importer-camera-bridge-build}"
cd "$ROOT"
swift build --scratch-path "$SCRATCH" --product NativeCameraBridge -c release
BIN_DIR=$(swift build --scratch-path "$SCRATCH" --show-bin-path -c release)
mkdir -p "$ROOT/build/native"
cp -X "$BIN_DIR/NativeCameraBridge" "$ROOT/build/native/NativeCameraBridge"
codesign --force --sign - "$ROOT/build/native/NativeCameraBridge"
