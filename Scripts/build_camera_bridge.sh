#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRATCH="${SWIFT_BUILD_DIR:-${TMPDIR:-/tmp}/photo-importer-camera-bridge-build}"
cd "$ROOT"
# macOS releases are Apple silicon only (release-targets.json), so the helper is built for arm64. This works with
# the Command Line Tools alone, without Xcode. The minimum macOS matches Package.swift.
TRIPLE="arm64-apple-macosx14.0"
swift build --scratch-path "$SCRATCH-arm64" --product NativeCameraBridge -c release --triple "$TRIPLE"
mkdir -p "$ROOT/build/native"
cp "$(swift build --scratch-path "$SCRATCH-arm64" --show-bin-path -c release --triple "$TRIPLE")/NativeCameraBridge" "$ROOT/build/native/NativeCameraBridge"
codesign --force --sign - "$ROOT/build/native/NativeCameraBridge"
