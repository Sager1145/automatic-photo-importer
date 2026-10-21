# Verification record

This is a development build for macOS 14+, built with Swift 6.4 / Xcode 27.1 on Apple Silicon. The native interface uses the standard SwiftUI profile: split-view navigation, semantic controls, a resizable table, independent source cards, and a photo/metadata inspector. No custom motion or shader effects are used.

## Review

Two independent local review passes checked the spec and SwiftUI/state standards. A separate ChatGPT architecture/edge-case consultation and dedicated shutter-count consultation supplied additional hypotheses, which were checked against local code and upstream sources:

- [Architecture and import edge cases](https://chatgpt.com/c/6ad725c1-42bc-83e9-9a1b-1ee112b0d5f5)
- [Shutter-count semantics and backend checks](https://chatgpt.com/c/6ad72c70-a778-83e9-a48b-7d641f3e66fe)

Concrete findings included duplicate SD discovery through ImageCapture mass-storage transport, concurrent destination-name selection, RAW/sidecar family naming, JPEG-only sidecar dates, wrong calendar folders near timezone boundaries, queued auto-imports after disabling automation, and main-thread cleanup. These are addressed in code and regression coverage as applicable.

The EXIF checker distinguishes total, mechanical and image counters, rejects invalid numeric fields, gates version-sensitive Sony fields, and reports provenance. Relevant primary sources: [ExifTool Nikon.pm](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Nikon.pm), [Sony.pm](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Sony.pm), [ILCE-7M5 correction](https://github.com/exiftool/exiftool/issues/369), and [Apple Nikon keys](https://developer.apple.com/documentation/imageio/nikon-camera-dictionary-keys).

## Filesystem and metadata tests

Tests use public plan/execute behavior and real temporary folders. They cover repeated content verification, changed sources, missing or changed destinations, destination-root replacement, traversal, symlinks, cancellation, concurrent copying, progress events, collision preservation, reorganization, and paired metadata. ImageIO tests create actual TIFF fixtures with make/model and timezone boundaries. Destination policy tests cover local/external destinations and protected camera/removable volumes. Shutter tests cover missing, malformed, zero, model/version-sensitive and ambiguous counters.

## Real media test policy

The user explicitly authorized the connected SD card and SSD for testing and instructed that no existing files be deleted. Tests on those volumes use copy-only import and read-only organization previews. Before writing any photo copies, all existing backup files were hashed and the SD inventory recorded. New small publication-test files are kept in a separate hidden test directory; they do not replace existing files.

The actual SD reader reports itself as internal plus removable, and ImageCaptureCore exposes a duplicate mass-storage device with a nil mount point. The transport classifier now lists it once. Actual Nikon NEF and Sony ARW metadata have been read successfully; the Nikon total/mechanical counts remain distinct and the tested Sony file has no available supported count.

The actual SSD is exFAT. It returns ENOTSUP for RENAME_EXCL, so exclusive-create publication is required rather than an unsafe replacing rename. APFS can use atomic exclusive rename. The fallback is verified before success, but its final path is visible during publication; interrupted outputs must remain identifiable and must not be considered complete from existence alone.

## Remaining evidence limits

Physical PTP/MTP camera sessions, deliberate unplug/power-loss recovery, full accessibility assistive-technology checks and the complete light/dark/contrast/reduced-effects visual matrix are not yet established. Native controls and no custom effects provide the baseline, but static audit results are not a substitute for those runtime checks. No performance frame-rate claim or final Apple Fidelity score is made. The build is ad-hoc signed, not notarized or App Store sandbox validated.

Final build/test and real-copy results are recorded below when those runs complete.


## Verified development result

- Full regression suite: 21 importer tests and 38 adapter/metadata tests passed (59 total), including six parameterized RAW/JPEG/HEIF metadata-conflict cases.
- Final native build compiled successfully; the installed app and extracted archive passed `codesign --verify --deep --strict` outside the synced source folder.
- Runnable local build: `~/Applications/Automatic Photo Importer.app`; archive: `build/AutomaticPhotoImporter.zip`.
- First-run setup, rejection of the actual SD card as a destination, acceptance of the actual exFAT SSD, camera metadata, the real RAW thumbnail/exposure/EXIF panel, and keyboard dismissal were exercised.
- The existing SSD library preview found 49 recognized media files, all with readable camera metadata, and proposed 49 organization moves. No move operation was executed on real existing files.
- The original SD card completed: 969 files / 29.83 GB imported, zero errors. A separate read-only full-content duplicate scan then verified all 969 files already in the correct backup paths, requiring zero additional copies.
- The third connected volume completed: 134 files / 7.45 GB imported, zero errors. The second Nikon volume was still copying at the final observation (1,016 / 6,778 files, 6.13 / 44.24 GB, about 55 MB/s). The running process was preserved so that import could continue.

The two newly connected camera volumes were independently distinguished by their filesystem volumes. They share display names, so active cards now also display their volume path. Additional hardware testing is copy-only and source originals are preserved.

Preservation audit during the real test: all 58 pre-existing SSD backup files matched their recorded SHA-256 hashes. Original source inventories (969, 6,778 and 134 files across the three real volumes) had zero missing files or changed size/mtime. No existing file was deleted or reorganized. Completion is recorded only for jobs whose dashboard reported completion.

## Three-chat integration — 2026-10-20

The scanner, interface, and transfer chats finished and released their files before the parent performed final integration. Ownership/API conflicts were resolved through their handoff documents. The parent added a separate IntegrationTests target and corrected two presentation details: capacity status now uses the same physical free-space measure as capacity bars, and the desk uses explicit light/dark surfaces instead of the system under-page gray.

Fresh final combined command:

```sh
swift test --disable-sandbox --scratch-path /private/tmp/photo-importer-integration-build
```

Result: **91 passing tests** (33 core, 55 adapters/routing, 3 integration), zero failures. Evidence: `/private/tmp/photo-importer-integration-final.log`. Integration coverage combines real temporary filesystem copies with routing: mirrored folder backups preserve destination extras and files missing from later source scans; Sony video and M01 XML stay together when all copies overflow to disk two; changing the reviewed second destination cannot damage an already verified first copy or source originals. Only uniquely generated disposable fixture directories are cleaned up by tests.

Cross-component regressions fixed during integration include empty-primary/full-secondary preview enablement and totals, capacity reservation release as bytes are written, contradictory source snapshots between mirror plans, and directory-picker `/private/tmp` versus `/tmp` containment for newly created backup folders. Backward compatible preference checks passed independently; previous bookmarks/settings are retained when new fields are absent.

Final runtime checks used separately signed QA bundles with `--ui-testing --ui-light`, isolated UserDefaults, and Automatic off. The old real importer was never quit or relaunched. The final model successfully saved the default `photobackup` under a disposable destination selected through NSOpenPanel. Every-file backup preview included five files in original relative folders (a hidden file, nested text document, photo, companion and DSC); execution reported five imported, zero errors. An independent SHA-256 comparison matched all five destination fixtures to all five intact source fixtures. The UI chat separately exercised camera-media filtering and unknown-rule validation. Final packaged UI exposed capacity values and the accessible slider changed 2→5 without starting any transfer. Final screenshot is kept in the task's private visualization directory rather than the public repository.

Read-only preservation audit: all **58** baseline SSD files still match their original SHA-256 hashes; baseline source inventories of **969 / 6,778 / 134** files have zero missing paths or changed size/mtime. Audit evidence: `/private/tmp/photo-importer-work/integration-preservation-report.json`. No existing real file was deleted, moved, reorganized or overwritten by this integration.

Final installed app and ZIP were rebuilt; packaging verifies the ad-hoc signature, and an independently extracted ZIP passed `codesign --verify --deep --strict`. Installed path remains `~/Applications/Automatic Photo Importer.app`. Source changes remain local/uncommitted/unpushed.

Remaining limits: physical two-destination full/unplug behavior was not induced on user drives. Mirror/fill/capacity/failure scenarios use disposable fixtures and policy tests. Full VoiceOver, narrow-window/reflow and accessibility appearance matrix remain unverified. Final static SwiftUI audit reports zero high and 14 medium review flags; these include intentional desktop sizes, brand colors, layout and existing camera session timeout code. This is a tested development build, not a notarized release or an accessibility certification.


## Shared Electron app verification — 2026-10-20

The active app is now React/TypeScript + Electron with a portable Node copy engine. The historical Swift results above describe the preserved legacy implementation.

- `npm run build` passed TypeScript checking and production bundling.
- `npm test` passed 40 backend/platform tests, including camera-card classification, installer disk-image exclusion, destination identity, source preservation, SHA-256 duplicates, collisions, Sony video/XML companions, cancellation, and reviewed library reorganization.
- The full Electron fixture suite passed seven checks: System default, live system theme changes, explicit Light/Dark, native macOS controls, five active sources plus one queued, Stop/retry, duplicate verification and source/marker byte preservation. Evidence: `/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-GsIX0g/artifacts/report.json`.
- After readability and Settings were added, `npm run codex:test -- --no-build --ui-only` passed six UI/isolation/preservation checks. The actual text slider changed 125→150%, changed computed text sizes, and persisted its value; the test restored 125%. Evidence: `/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-xh01MU/artifacts/report.json`.
- Read-only production detection found both Nikon volumes and three further camera-layout volumes. Installer disk images were excluded. A real camera card was rejected as a destination; `/Volumes/A006` was accepted without writing to it.

The earlier QA crashes were caused by changing Electron's internal bundle name so its helper apps could not be located. The normal executable and internal bundle/helper names are now preserved; the corrected QA and development app launched successfully. Native traffic-light controls were also inspected visually. The shared app is installed separately as `~/Applications/Automatic Photo Importer Desktop.app`; the existing Swift app remains intact. Windows/Linux binaries and native camera hardware protocols were not exercised by these fixture checks. No existing real files were deleted or overwritten.

Dashboard follow-up: the hero headline was replaced by live source, queue, throughput, byte/file and destination metrics plus state-dependent instructions. The final UI-only suite passed seven checks, including real fixture counts (6 sources, 1/1 destination online) and absence of the old hero title. Evidence: `/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-5xC4om/artifacts/report.json`. The installed normal app independently displayed the real connected volumes and System/125% defaults before the dashboard update. The dashboard was rebuilt, packaged and installed with a valid ad-hoc signature.


## Recoverable organization, drive detail and localization — 2026-10-20

Fresh `npm test`: **75 passed, zero failures**. Coverage includes 19 durable recovery scenarios (child-process exits after publication/relocation and during exclusive copy, retained originals, changed/corrupt data, hostile manifests, root/parent replacement, cancellation, stash collisions and cached listing), multiple cameras per source, media-only format summaries and all four language catalogs/rendering. Build/typecheck passed.

Full Electron QA passed **12 checks** on unique temporary files, including five-source queue/Stop/retry, duplicate verification, changed-base-folder organization and recovery recheck. Report: `/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-irWjRc/artifacts/report.json`. After integration review fixes, the focused organization suite passed **10 checks**, including concurrent double-Apply and double-Resume creating just one job. Report: `/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-ENmQWj/artifacts/report.json`. Source files and the pre-existing destination marker retained their SHA-256 hashes.

Read-only real-card validation inventoried 967, 6,773 and 132 media files on three mounted cards. Three-file EXIF samples identified Nikon Z f on both Nikon volumes and Fujifilm X100VI on the unnamed card. This is sampled model verification, not a claim that every file on those cards was analyzed. No real card or SSD files were copied, moved, deleted or overwritten for these tests.

Recovery retains originals under a hidden store after publishing and synchronizing verified targets. The Resume/Recheck operation uses the saved paths; changed templates require a new review. Directory-sync failure stops organization safely. Process-interruption tests do not certify physical power-loss behavior of every filesystem or storage controller; hardware that fails or falsely reports durable writes cannot be covered by application-level guarantees.


Installed-app startup follow-up: a live process sample showed all four libuv filesystem workers blocked opening volume directories. macOS layout probes now skip internal/disk-image volumes and run in bounded `/bin/ls` subprocesses instead of the shared filesystem pool. A native camera-helper failure also leaves mounted storage available. The updated installed app displayed all six actual sources, and an accent preference saved while discovery ran; the original accent was restored. All 75 regression tests passed again after this fix.


Final isolated-scan build: production bundling uses Rolldown (also used by Vite), after the separate esbuild executable repeatedly stalled in a host file-open call. TypeScript checking and production bundling passed. Read-only inventory and camera metadata now run in an Electron utility process; Stop terminates that process and labels partial metadata as stopped. There is no arbitrary scan deadline that could reject a healthy large card.

The final full Electron suite passed all 12 checks, including immediate scan cancellation/rescan, five-source queue/Stop/retry, duplicate verification, organization/recheck and original/marker hash preservation. Report: `/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-QHFRLR/artifacts/report.json`. UI-only suite: `/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-idb5fd/artifacts/report.json` (9 passed). The updated app was packaged, installed and passed strict deep signature verification.

Native installed-app validation showed six real sources. A read-only scan of `/Volumes/Untitled` found 132 media files (66 JPG and 66 RAF), totaling approximately 7.5 GB. The earlier complete metadata pass confirmed X100VI on all 132 files. The isolated scanner was then stopped after 8 files: the UI immediately returned to idle and correctly retained a stopped partial X100VI summary; rescanning was available. No real files were copied, moved, overwritten or deleted.


## Architecture cleanup — 2026-10-20

See `architecture-and-features.md` for the complete production interface inventory and requirements audit. `plan(source, roots[])` now prepares source inventory/metadata/SHA256 once; destination allocation and execution validation remain independent. Main-to-renderer updates share unchanged inventory details and review plans across progress, with aggregation only after the context bridge. A synthetic 10,000-file state measured 2,820,857 bytes for the previous full snapshot versus 806 bytes for a progress update containing zero file arrays (99.97% smaller serialized payload; not a copy-throughput claim).

Build/typecheck passed. All 85 code tests passed. The full Electron suite passed 13 checks, including both destination organization selections, source-copy retry/duplicate verification and exact fixture/marker preservation: `/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-26RlKw/artifacts/report.json`. NativeCameraBridge built with mounted-volume discovery disabled only in the helper; legacy UI behavior remains unchanged. No real card/SSD files were modified.
