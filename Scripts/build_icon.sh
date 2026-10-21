#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
XCODE_APP="${XCODE_APP:-$(xcode-select -p | sed 's@/Contents/Developer$@@')}"
ICTOOL="$XCODE_APP/Contents/Applications/Icon Composer.app/Contents/Executables/ictool"
[[ -x "$ICTOOL" ]] || { echo "Icon Composer ictool not found; set XCODE_APP to Xcode 27.1 or later." >&2; exit 1; }
OUT="${1:-$ROOT/build/icon}"
mkdir -p "$OUT/Icon.iconset" "$ROOT/Assets"
# macOS icons use 824 pixels of artwork inside a transparent 1024 pixel canvas.
"$ICTOOL" "$ROOT/Icon.icon" --export-image --output-file "$OUT/artwork.png" \
  --platform macOS --rendition Default --width 824 --height 824 --scale 1 --design-generation 26
sips --padToHeightWidth 1024 1024 "$OUT/artwork.png" --out "$ROOT/Assets/AppIcon-preview.png" >/dev/null
for rendition in Dark Mono; do
  "$ICTOOL" "$ROOT/Icon.icon" --export-image --output-file "$OUT/$rendition.png" \
    --platform macOS --rendition "$rendition" --width 824 --height 824 --scale 1 --design-generation 26
  sips --padToHeightWidth 1024 1024 "$OUT/$rendition.png" --out "$ROOT/Assets/AppIcon-$rendition.png" >/dev/null
done
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ROOT/Assets/AppIcon-preview.png" --out "$OUT/Icon.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$ROOT/Assets/AppIcon-preview.png" --out "$OUT/Icon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$OUT/Icon.iconset" -o "$ROOT/Icon.icns"
echo "Built $ROOT/Icon.icns"
