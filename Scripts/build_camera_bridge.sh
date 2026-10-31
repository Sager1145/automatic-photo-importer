#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRATCH="${SWIFT_BUILD_DIR:-${TMPDIR:-/tmp}/photo-importer-camera-bridge-build}"
cd "$ROOT"
# One universal helper for Apple silicon and Intel Macs: each architecture builds on its own (this works with the
# Command Line Tools alone, without Xcode), then lipo joins them. The minimum macOS matches Package.swift.
SLICES=()
for ARCH in arm64 x86_64; do
  TRIPLE="$ARCH-apple-macosx14.0"
  swift build --scratch-path "$SCRATCH-$ARCH" --product NativeCameraBridge -c release --triple "$TRIPLE"
  SLICES+=("$(swift build --scratch-path "$SCRATCH-$ARCH" --show-bin-path -c release --triple "$TRIPLE")/NativeCameraBridge")
done
mkdir -p "$ROOT/build/native"
lipo -create "${SLICES[@]}" -output "$ROOT/build/native/NativeCameraBridge"
codesign --force --sign - "$ROOT/build/native/NativeCameraBridge"
