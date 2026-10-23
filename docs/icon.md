# App icon

`Icon.icon` is the editable Apple Icon Composer document. It contains original SVG layers for a cream memory card, amber contacts, and a coral import arrow. The coral automatic gradient and native Liquid Glass effects provide the background and material treatment. The simple silhouette and heavy arrow retain the import cue at small sizes.

The document was created, opened, inspected, and saved in Apple's installed **Icon Composer 27.1 (129)**, bundled with `/Applications/Xcode-27.1-RC.app`. The artwork was authored as SVG and imported into the native document. No generated bitmap is used as the editable source.

## Build

```sh
XCODE_APP=/Applications/Xcode-27.1-RC.app Scripts/build_icon.sh
```

The script uses Icon Composer's bundled `Contents/Executables/ictool` with its current `--export-image` interface. The older `--export-preview` interface is unavailable in this version. It renders macOS Default with design generation 26 at 824 pixels, pads it to a transparent 1024-pixel canvas, creates standard 16–1024 pixel representations, then calls Apple's `iconutil`.

Outputs:

- `Assets/AppIcon-preview.png`: flattened macOS preview with transparent spacing.
- `Icon.icns`: macOS 14-compatible fallback for the app bundle's Resources directory and `CFBundleIconFile=Icon`.
- `build/icon/Icon.iconset`: generated size representations, including Retina variants.

`Icon.icon/Assets` contains the actual document artwork; `Assets/IconLayers` keeps the original imported vectors. Open `Icon.icon` in Icon Composer to edit layer materials and preview Default, Dark, and Mono. The `.icon` document can also be compiled by an Xcode asset build for modern appearance adaptation; the ICNS fallback is intentionally a fixed Default rendition.

Validation: native Icon Composer displayed all three layers with Liquid Glass enabled; native `ictool` export succeeded; the exported 1024 PNG was visually inspected; `iconutil` built the ICNS and decoded it back into an iconset. On this managed host the renderer needs access to native graphics services beyond the command sandbox; sandbox failure misleadingly reports that the document cannot be opened.

## Highlight and visual balance refinement

The import arrow has `glass: false`, set through the native Icon Composer layer Effects switch. This removes the renderer's bright horizontal glass highlight at the arrow shoulders. The card, contacts, and background retain the native material treatment. The arrow remains an editable vector; no raster retouching is used.

The memory-card silhouette originally spanned x=263…712 (center 487.5) in the 1024-unit SVG. Its card and contact layers now translate +24.5 units, placing the card bounds at x=287.5…736.5 and center 512. The arrow translates +2 units from center 510 to 512. The card's vertical bounds remain y=194…831 (center 512.5). Equal left and right card margins, the centered arrow, and optical review keep the composition calm while retaining the card's asymmetric clipped corner.

Default, Dark, and Mono were exported using the native `ictool` renderer and visually inspected. All retain a solid, clean arrow without the shoulder highlight. The 16-, 32-, and 128-pixel Default iconset exports were also checked for silhouette and import-arrow legibility. `build_icon.sh` now regenerates the padded Dark and Mono evidence previews alongside Default. The ICNS was rebuilt and decoded successfully after this refinement.

## Balanced redesign and boot animation

The artwork was redrawn in four vector layers on top of the coral automatic-gradient background: `01-card.svg` (card plus fold), `02-contacts.svg`, `03-arrow.svg`, `04-tray.svg`. All coordinates are in 1024-unit space and are the single source of truth in `desktop/renderer/brand-geometry.ts`; `desktop/tests/brand-logo.test.ts` fails if the layers and the React logo drift apart.

- Card 440 x 600, centred exactly on (512, 512), so the left/right and top/bottom margins are equal. The clipped corner is 72 units (was 121) with a small rounded fold.
- Four contacts, 90 units apart, centred on x=512, 68 units tall (was 82), 71 units from each card edge.
- Gap above the contacts (88), contacts band (68), then the arrow + tray group centred in the space below (about 93 to 98 units above and below it), giving a calm vertical rhythm. The bounding box of contacts + arrow group is centred at y=510.
- Arrow stroke 49 (was 58, 15% lighter); the tray is as wide as the arrow head (176 path width, was 182 offset and heavier) and is separate from the arrow so the animation can drop the arrow into it.

`desktop/renderer/BrandLogo.tsx` draws those same parts (tile, card, contacts, arrow, tray) as one React SVG used by the sidebar header and by the boot splash. `public/icon.png` is the rebuilt native `ictool` preview.

### Boot splash

`Boot.tsx` + `boot-controller.ts` show an overlay on cold start only: tile scales 0.92 to 1 (250 ms), card rises 8 px, contacts light up left to right 40 ms apart, the arrow drops into the tray with an overshoot and the tray pulses, then the logo glides and shrinks onto the real sidebar logo (measured with getBoundingClientRect) while the app fades up. Total 1.2 s (900 ms intro + 300 ms glide). The splash never delays readiness: it ends when the first state has rendered and the intro is over, with a hard cap at 2.5 s; any click or key skips it. Reduced motion shows a 150 ms crossfade only. It is in normal stacking order, so `[data-error-layer]` toasts and sheets (top layer) stay above it. `html[data-boot]` is `running`, `reveal` or `done`; QA waits for `done`.
