# 0.2.1 release and real-camera import test

Date: 20 October 2026, America/Toronto.

Scope follows the user's latest clarification: fix/build the app and test camera importing only. **No file-organization tests or operations are part of this hardware run.** Camera cards are read-only; existing A006 files are not reset, deduplicated or cleaned up. The app uses an isolated temporary profile and creates a new `photobackup-hardware-*` destination directory on pinned A006 UUID `7FCAB978-19AB-35F1-B849-4EF53D1C0448`.

## Release evidence

- Version: 0.2.1, macOS ARM64 release build.
- Native camera/timestamp helper built for production; app bundle locally ad-hoc signed and strict deep signature verification passed. This is not Developer ID notarization.
- Project logo verified: bundled ICNS equals project `Icon.icns`; renderer logo equals `Assets/AppIcon-preview.png`. Hash receipts: `build/release-0.2.1/logo-verification.json` and `package-integrity.json`.
- Production build/typecheck passed. Last full backend suite: 271 passed, zero failed. That run preceded the later camera-only scope clarification; no new organization tests were launched afterward.
- Fresh UI-only fixture suite: all 16 checks passed, including the previously failing Settings check. Root cause was missing focus in the synthetic test, not a product TextPreference defect. The harness now explicitly focuses the window/input and preserves the original failure if cleanup also fails.
- An earlier full fixture run was intentionally stopped when the user narrowed testing scope. It must not be presented as a completed full-suite success.
- Archive: `build/release-0.2.1/AutomaticPhotoImporter-0.2.1-mac-arm64.zip`, with adjacent SHA-256 receipt. The installed production app is not replaced during testing.

The release ZIP was extracted into a fresh temporary directory and its deep strict signature check passed (`archive-verify.log`). Packaged code equals the final compiled code; both native and in-app project logos match their sources (`package-integrity.json`).

## Hardware run — restart after performance repair

The signed packaged application itself runs its import exercise through the same action handler used by the interface. No standalone maintenance copier substitutes for app functionality. Six storage sources were detected and authorized using native read-access dialogs.

Current run paths are saved in `build/release-0.2.1/paths.json`. The test profile, live state, original-file baseline, execution receipts and final summaries are stored in the hardware report root specified there. App output is retained in `build/release-0.2.1/hardware-app.log`.

Planned checks: read-only inventories; before/after SHA-256 and filesystem identity manifests for all eligible originals (including ordinary hidden and unknown files); two parallel imports and queueing; Stop/restart; complete imports; repeat imports with no new copies; independent per-path destination hashes; Created/Modified capture timestamps; real-photo metadata inspection. Source content preservation and strict identity preservation are reported separately, without hiding volatile exFAT inode failures.

No physical unplugging, electrical power-loss test, or two-physical-destination test is performed. DJI LRF coverage depends on actual connected-card contents; the earlier supplied A006 LRF path was unavailable, so fixture LRF coverage is not substituted for physical LRF coverage.

Completion is not claimed until the hardware summaries and independent content checks finish.

### Preparation performance repair

The first isolated hardware attempt was deliberately stopped before any copied-byte progress. All six source baselines completed. Metadata routing had unnecessarily used ExifTool `RequestAll=3`, which requests per-file macOS stat/Spotlight/xattr work and optional extra scans. Lightweight routing now retains grouped duplicate/numeric metadata without that option; the full inspector retains full extraction.

47 camera-import regression checks passed after this repair. Read-only real-card NEF, MOV, JPG, RAF and ARW samples produced identical camera/date/edited routing with lightweight and full extraction; measurements are recorded in `real-camera-metadata-comparison.json`. Single-sample timings are not a complete import throughput benchmark. The next packaged-app run supplies final hardware evidence. No organization operation was run.
