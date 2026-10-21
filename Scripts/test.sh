#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
SWIFT_BUILD_DIR=${SWIFT_BUILD_DIR:-${TMPDIR:-/tmp}/automatic-photo-importer-build}
swift test --scratch-path "$SWIFT_BUILD_DIR" "$@"
