# Requirements check — 20 October 2026

This check covers every ID in [user-requirements.md](user-requirements.md). Each verdict comes from reading the current source, plus test runs on the same tree. It does not rely on the claims in earlier reports. The earlier per-ID audit in [user-requirements-verification.md](user-requirements-verification.md) was left unchanged.

**Verdicts:** **MET** means the code path was read and, where possible, a test or Electron check passed. **PARTIAL** means part is implemented and the gap is named. **NOT MET** means it is missing. **OPEN** means an operational task that the receipts show is unfinished. **EVIDENCE** means it is supported by repository receipts or docs only. **N/V** means it cannot be verified from the repository (process or chat preferences).

## Checks run on this tree

| Check | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm test` | 271 / 271 pass, 0 fail |
| `bash Scripts/test.sh` (Swift) | 4 / 4 pass |
| `npm run build` | Pass |
| `npm run codex:test -- --no-build` (isolated Electron, temporary fixtures, real drives excluded) | **22 / 22 checks pass**. The report and 37 screenshots are in `$TMPDIR/photo-importer-codex-ei3fBo/artifacts/` |

None of these runs touched a real drive. This check did not launch the real app or read the error menu of a running app.

## Update after the gap fixes (same day)

| ID | Now | Change |
|---|---|---|
| COPY-11 | Backend MET, UI pending | Drive backups go to `<backup folder>/Drive backups/<drive name>` on each destination, owned by a marker that records the drive's filesystem UUID plus its folder path. `preferences.backupMode` is `additive` (default, never removes) or `mirror`. Mirror reviews list files that are missing from the drive or changed; Apply moves them to `Drive backups/.mirror-removed/<time>/<drive>/…` after an inode/timestamp check, and nothing is permanently deleted. Direct or automatic runs that would move files stop and ask for Review. Mirror is refused with Fill-first copy mode and for drives without a filesystem UUID. Tests: `desktop/tests/drive-backup.test.ts`. The Settings control and the review list of moved files are with the UI overhaul session. |
| FMT-09 | MET | Folder rules now apply to camera cards (the `mediaOnly` filter was removed). |
| COPY-03 | MET (code) | Automatic import queues only when every destination the copy policy needs is available. |
| ARCH-03 | Improved | The stale preview-picker IPC was removed (by the UI/integration work). The unused USB i18n key is with the UI overhaul session. |
| UI-11/12 | Pending | With the UI overhaul session. |

Existing drive backups made before this change sit directly under the backup folder; the next backup of that drive copies into its new per-drive folder.

## Summary of gaps

| ID | Verdict | Gap |
|---|---|---|
| COPY-11 | **NOT MET** | Drive-to-drive backup has no mirror vs additive choice. Backup is always additive. "Mirror" exists only as a two-destination copy policy (`desktop/shared.ts:5`, `RootApp.tsx:363`). Section 16 notes that deletion semantics were never specified. |
| FMT-09 | PARTIAL | For camera cards, `rules(..., mediaOnly)` drops "copy to folder" rules (`desktop/core/inventory.ts:18`), so a remembered destination folder has no effect on card imports. Only "copy to camera folders" and "exclude" work there. A test asserts this on purpose (`unknown-camera.test.ts:42-49`). |
| FMT-14 / COPY-13 | PARTIAL | Whole-drive backup keeps folder structure but skips symlinks and OS service files (`.DS_Store`, `.Spotlight-V100`, `.Trashes`, `._*`, `Thumbs.db`, …) (`inventory.ts:9,33`). This is disclosed in the UI and tested, but it is not literally "every file". Empty folders are not recreated. |
| UI-11 / UI-12 | PARTIAL | The hero is gone. The statistics dashboard (speed, active/queued, destinations ready, transferred) lives in the **Total progress** dialog (`RootApp.tsx:223`), not on the Import desk. The desk itself shows per-card status only. |
| UI-36 / DST-07 | PARTIAL | Path, template, edited folder, unknown rules, language, text size and theme are in Settings. These persistent options stay on the Import desk: the parallel slider (which COPY-07 requires there), "Enable media folder selection", grid/list, and a copy-policy/destination summary. |
| DST-01 | PARTIAL | First launch shows an inline banner and disables Start (`RootApp.tsx:234`). There is no first-launch prompt or dialog. |
| FMT-12 | PARTIAL | Format issues and unknown-file choices appear only under **All errors** (Electron check passed). Source cards still show inline job detail and error state (`RootApp.tsx:310,319`). |
| COPY-03 | PARTIAL | Automatic import queues new sources when any destination path is set (`main.ts:76`). It does not check that both disks needed by mirror or sequential mode are present first. Those jobs then fail later in `run()`. No automated test covers auto-queue on a newly detected source. |
| SAFE-03 | PARTIAL | I/O errors from a removed source or destination fail the job cleanly, publish nothing, and can be retried (unit-tested with injected EIO/ENODEV). No unmount handler aborts the job early. A physical unplug test was never run. |
| SAFE-12 | PARTIAL | On macOS, Created and Modified are set to the capture time. Linux and Windows set Modified only (`platform/file-timestamps.ts`). |
| SAFE-04 / TEST-07 | PARTIAL | SIGKILL resume is tested in a real child process. Physical power loss and unplug were never tested (Section 16 says this too). |
| UI-33 / ARCH-03 | PARTIAL | Cleanup: the unused i18n key "{count} direct USB cameras" (`i18n.tsx:330`) and the leftover `importer:pick-preview` IPC/preload channel (`main.ts:298`, `preload.ts:16`) remain after the preview option was removed. |
| META-12 / UI-32 | PARTIAL (ambiguous) | The preview option was removed from the UI. The per-file metadata dialog still shows an embedded preview image (`RootApp.tsx:491`). Section 16 leaves this open. |
| TEST-10, A006-04, A006-10, A006-13, MON-11, MON-17, ORG-14 | **OPEN** | `build/media-organization-audit/tracking.json` shows `completed:false`. The root-year 2024/2025/2026 organization is still queued and not executed. The final audit log shows `waiting-for-app, checked: 0`. |
| TEST-16 | **OPEN** | The release 0.2.1 scope is camera import only. `build/release-0.2.1/paths.json` now reads `hardwareStatus: "intentionally stopped before copying to fix metadata preparation performance"`, so no completed real-card import exists for 0.2.1. |
| A006-18 | OPEN | The error menu of the running app has not been read. Only historical snapshots exist. |

## 1. Project and platform

| ID | Verdict | Evidence / note |
|---|---|---|
| PROJ-01 | MET | origin `github.com/Sager1145/automatic-photo-importer` |
| PROJ-02 | MET | `gh repo view` shows visibility PUBLIC. A local clone exists. Most of the work is untracked locally, with one "Initial commit". |
| PROJ-03 | N/V | Process. |
| PROJ-04 | MET (superseded) | The macOS-first request was superseded by PROJ-05. Swift remains as the ImageCaptureCore helper (`Package.swift`). |
| PROJ-05 | MET | Electron with mac, win and linux builder targets. `platform/volumes.ts:90-109` has darwin, win32 and linux branches. It has not been run on Windows or Linux. |
| PROJ-06 | MET | One renderer for all platforms. Only the titlebar branches on platform (`RootApp.tsx:146`). |
| PROJ-07 | MET | `titleBarStyle:'hidden'` with traffic lights on darwin (`main.ts:292`). The Electron check "macOS uses native window controls" passed. |
| PROJ-08 | N/V | Scope note. Windows and Linux packages are only `dir` targets and were never built here. |
| PROJ-09 | MET | Copies to filesystem roots only. There is no catalog. |

## 2. Research and development process

| ID | Verdict | Evidence / note |
|---|---|---|
| DEV-01 | EVIDENCE | `docs/research.md` covers Rapid Photo Downloader, Shotwell, PhotoPrism and libgphoto2. |
| DEV-02 | EVIDENCE (partial) | A ChatGPT link is recorded in `docs/research.md:3`. The content cannot be verified. |
| DEV-03 | PARTIAL | The ExifTool Nikon/Sony shutter-counter sources are cited. No other shutter-count projects are surveyed. |
| DEV-04 | EVIDENCE | `docs/camera-metadata-research.md` plus the Sony/Apple/Nikon/DJI tag tests. |
| DEV-05 | EVIDENCE | `docs/scan-performance.md`. The scan publishes a fast inventory first, then reads metadata. There is no catalog. |
| DEV-06, DEV-07 | PARTIAL | Skill use and installs are claimed in docs. They cannot be confirmed. |
| DEV-08 | EVIDENCE | Several separate consultations, including `build/failure-modes/chatgpt-review.txt`. |
| DEV-09 – DEV-11 | PARTIAL | `docs/handoffs/coordination.md` records three chats. Their integration checkpoint predates the Electron migration. |
| DEV-12 | MET | UI overhaul is present (screenshots from this run). |
| DEV-13 | PARTIAL | Review and fixes were done, but the gaps above remain. |
| DEV-14 | EVIDENCE | `docs/ui-overhaul.md` has Lightroom, darktable and digiKam references. |
| DEV-15 | PARTIAL | The crash cause is documented (`docs/verification.md`). The current build launches and passes 22 Electron checks. There is no specific regression test for the crash. |
| DEV-16 | N/V | Preference. |

## 3. Sources and camera detection

| ID | Verdict | Evidence / note |
|---|---|---|
| SRC-01 | MET | 5-second volume polling (`main.ts:76,296`) and `getSources` (`platform/volumes.ts:125`). Unit-tested. |
| SRC-02 | PARTIAL (aspiration) | Mounted storage with DCIM/PRIVATE/AVCHD/M4ROOT/XDROOT/CONTENTS layouts, OS-flagged removable media, and ImageCaptureCore PTP cameras on macOS. PTP is macOS-only. |
| SRC-03 | MET | `volumes.ts:15-22,125-137`. Swift classifier tests separate mass storage from PTP. |
| SRC-04 | EVIDENCE | `docs/hardware-a006-20261020.md` records real-card detection. This check had no hardware to verify current detection. |
| SRC-05 | MET | Recursive walk (`core/inventory.ts:26-40`). `core.test.ts`. |
| SRC-06 | MET | Sony `PRIVATE/M4ROOT/CLIP/C####M01.XML` is linked to its MP4 (`inventory.ts:55-65`, `core.test.ts:22`). |
| SRC-07 | MET | "Enable media folder selection" switch. `main.ts:265` refuses folder sources until it is enabled. |
| SRC-08 | MET | Separate "Choose media folder" and "Back up a drive or folder" actions. |
| SRC-09 | MET | `source-cameras.ts` uses drive-name, layout and file hints (labelled unconfirmed) plus EXIF-confirmed models. Tested. |
| SRC-10 | MET | Per-model map with counts and per-file routing. `source-cameras.test.ts` "multiple cameras". |
| SRC-11 | MET | No advertising line is rendered (see the UI-33 cleanup note). |

## 4. Destinations and first launch

| ID | Verdict | Evidence / note |
|---|---|---|
| DST-01 | PARTIAL | See the summary: an inline banner, not a prompt. |
| DST-02 | MET | Folder chooser with `createDirectory`, then `validateDestination`. |
| DST-03 | MET | `platform.test.ts:207`: an external SSD is a valid destination. |
| DST-04 | MET | `volumes.ts:166-171` rejects a camera card or removable flash media. Tests at `platform.test.ts:150,196`. |
| DST-05 | MET | 4 translated presets plus an editable template (`RootApp.tsx:22-27,447`), shown in the Settings screenshot. |
| DST-06 | MET | Per-level `mkdir` (`core/paths.ts:63`). The Electron check "Concurrent sources create a fresh nested backup folder without directory races" passed. |
| DST-07 | PARTIAL | See UI-36. |

## 5. Media discovery and unknown formats

| ID | Verdict | Evidence / note |
|---|---|---|
| FMT-01 | MET | Card scans use `mediaOnly`. `core.test.ts:33-46`. |
| FMT-02, FMT-03 | MET | `.DSC` is classified Other and excluded. `NIKON001.DSC` is asserted `included===false` (`core.test.ts:43`). |
| FMT-04 | EVIDENCE | A006 source audit tooling (`desktop/qa/a006-source-audit.ts`) and the hardware doc. |
| FMT-05 | MET | Missing metadata leads to the Unknown Camera folder, not exclusion. `unknown-camera.test.ts`. |
| FMT-06 | MET | RAW, JPEG, HEIF, images and video tables in `media-formats.ts`. |
| FMT-07 | MET | Sidecars (xmp, aae, lrv, thm, xml, wav, srt, dop, cos) are copied only when paired with a primary file. |
| FMT-08 | MET | Unknown formats are excluded by default and reported in All errors (Electron check passed). |
| FMT-09 | PARTIAL | See the summary: "copy to folder" is ignored for camera cards. |
| FMT-10 | MET | `remember` writes `unknownRules` into `settings.json` (`main.ts:268`). It reloads at `main.ts:63`. |
| FMT-11 | MET | "Keep unknown files excluded" and "Copy to camera folders" route per DCIM camera (`unknown-camera.test.ts`). |
| FMT-12 | PARTIAL | See the summary. |
| FMT-13 | EVIDENCE | `tracking.json` `unknownRules` shows every prompted extension excluded. |
| FMT-14 | PARTIAL | See the summary. |
| FMT-15 | MET | `lrf` is a video format (`media-formats.ts:9`). Standalone and paired LRF are copied byte-exact (`dji-lrf.test.ts`). |

## 6. Metadata, dates and exposure

| ID | Verdict | Evidence / note |
|---|---|---|
| META-01 | MET | `platform/metadata.ts:57-70` reads the model into the `{camera}` token. |
| META-02 | MET | Sony `XML:DeviceModelName` is preferred over the invalid IFD0 model (`platform.test.ts:47-78`). `metadata-extraction.test.ts` runs on a real MP4. |
| META-03 | MET | Sony `CreationDateValue`, Apple Keys, Nikon NCTG timezone, EXIF `OffsetTime*` and DJI are handled (see `camera-metadata-research.md`). |
| META-04 | MET | The offset is kept. Folders use wall-clock time with no UTC shift. |
| META-05 | MET | Date, time and timezone are separate fields (`metadata-display.ts:4-17`). |
| META-06 | N/V | Example only. |
| META-07, META-08 | MET | Metadata dialog with exposure summary: lens, aperture, ISO, shutter, focal length and EV. |
| META-09 | MET | `<details>` without `open`. The Electron check "Photo metadata is readable and collapsed" passed. |
| META-10 | MET | ExifTool maker-note counters, with notes for conflicting or unavailable values. |
| META-11 | MET | Hidden for video. The Electron check "video summaries omit shutter count in every language" passed. |
| META-12 | PARTIAL (ambiguous) | See UI-32. |

## 7. Paths and organization

| ID | Verdict | Evidence / note |
|---|---|---|
| ORG-01 | MET | Defaults `basePath:'photobackup'` and `template:'{year}/{yyyymm}/{camera}'` (`main.ts:26`). |
| ORG-02 | MET | Camera from metadata, otherwise `Unknown Camera`. |
| ORG-03 | MET | Presets and tokens (Settings screenshot). |
| ORG-04 | MET | `separateMedia` creates RAW / Photos / HEIF / Videos subfolders under the camera folder. |
| ORG-05 | MET | SHA-256 match means skip. A repeat run copies 0 and skips 3 (`core.test.ts`). The Electron check "second run verifies duplicates" passed. |
| ORG-06 | MET | "Organize now" sends `organize` to a queued job. The Electron check "One-click organization executes through the public app action" passed. |
| ORG-07 | MET | Current preferences are passed into `plan(…reorganize)`. The Electron check "Organization applies changed folder settings" passed. |
| ORG-08 – ORG-09 | MET | Wrong camera folders are moved into the correct one. Identical files merge and different files are retained (`edited-organization.test.ts`, `organization-supersession.test.ts`). |
| ORG-10 | MET | Only emptied, reviewed source folders are removed, with non-recursive `rmdir` (`core/recovery.ts:180-195`). |
| ORG-11 | MET | Copy, fsync and verify run first. The original is held in the journal and removed only at finalize. |
| ORG-12 | MET | HMAC-sealed journal with resume and recheck. Crash-point tests in `recovery.test.ts` and `process-crash.test.ts`. |
| ORG-13 | EVIDENCE | The feature and its tests exist. The order (tested before use) is recorded in docs only. |
| ORG-14 | **OPEN** | The root-year organization is queued and not executed (`tracking.json`). |
| ORG-15 | MET | Editor provenance from Software, CreatorTool and History tags. Editors not on the list are not detected. |
| ORG-16, ORG-17 | MET | `{year}/{yyyymm}/editied/{camera}` by default. Configurable, and unsafe names are rejected (Electron check passed). |
| ORG-18, ORG-19 | MET | RAW is never classed as edited, and XMP follows its RAW (`core/index.ts:180`, `edited-organization.test.ts:12`). |
| ORG-20 | OPEN | The real run through the app's one-click action has not executed for the root-year folders. |

## 8. Copying, queueing and multiple disks

| ID | Verdict | Evidence / note |
|---|---|---|
| COPY-01, COPY-02 | MET | Start, Stop and Automatic are in the titlebar. The Electron check "Fresh launch … Automatic is off" passed. |
| COPY-03 | PARTIAL | See the summary. |
| COPY-04, COPY-05 | MET | `parallel` is clamped to 1–5, with a FIFO queue. The Electron check "Five sources run and the sixth queues; Stop settles every job" passed. |
| COPY-06, COPY-07 | MET | Range slider (1–5) in the "Sources & queue" heading row (screenshot and Electron assertion). |
| COPY-08 | MET | One destination / Copy to both / Fill first then second. Two physical disks are required. |
| COPY-09 | MET (as specified) | Both disks get a full copy, written one after the other, or disk 1 fills first and then disk 2. There is no parity, matching Section 16. |
| COPY-10 | MET | Separate "Back up a drive or folder" flow keeps relative paths. |
| COPY-11 | **NOT MET** | See the summary. |
| COPY-12 | MET | Backup never deletes destination files. Nothing in the copy engine unlinks user files. No test asserts it. |
| COPY-13 | PARTIAL | See FMT-14. |
| COPY-14 | MET | Stage all files, then a separate verify phase, then publish (`copy-phases.test.ts`). |

## 9. Recovery, integrity and filename conflicts

| ID | Verdict | Evidence / note |
|---|---|---|
| SAFE-01 | Mechanisms MET, absolute guarantee N/V | Source files are never modified. The Electron check "Every source original and the existing destination marker retain their exact bytes" passed. |
| SAFE-02 | MET | `.partial` staging, then publish with `link` / `wx` (never overwrites), then re-hash. |
| SAFE-03 | PARTIAL | See the summary. |
| SAFE-04, SAFE-05 | MET (process kill) | Sealed stage and intent journals. A partial is resumed only after a prefix check (`process-crash.test.ts`, `import-recovery.test.ts`). |
| SAFE-06 | MET | Resume needs an authenticated journal, the same inode and birthtime (a whole-second birthtime recorded after the date helper also matches within that second, because exFAT re-reads the stored 10 ms value), `nlink==1`, and the bytes must be a prefix of the source. A different complete file becomes a conflict and is never overwritten. |
| SAFE-07, SAFE-08 | MET | Name and content are checked separately. Different content goes to `<camera>/Conflicts/<hash>/…`. "Newer" means arrival order. |
| SAFE-09 | EVIDENCE | `docs/failure-modes-20261020.md`. |
| SAFE-10 | Respected | The docs do not claim completion. The final audit is still open. |
| SAFE-11 | MET / EVIDENCE | The organization journal retains originals. Reset receipts are scoped. |
| SAFE-12 | PARTIAL | See the summary (macOS complete). |

## 10. Interface and settings

| ID | Verdict | Evidence / note |
|---|---|---|
| UI-01, UI-02 | MET | Custom React shell (screenshots). |
| UI-03 | MET (subjective) | Controls at least 44 px tall, plus inline guidance. |
| UI-04 | MET | Text size 100–150 %, default 125 %, persisted (Electron check passed). |
| UI-05 | MET | Settings page. |
| UI-06 | MET | Accent colours coral, ocean and forest. |
| UI-07 | MET | Default System. Live OS switching and Light/Dark overrides (2 Electron checks). |
| UI-08 | MET | Container and media queries. The Electron check "adapting to narrow windows" passed. |
| UI-09 | MET | Grid has 2 columns at container width of at least 760 px, list has 1 (screenshot and Electron check). |
| UI-10 | N/V | Only macOS was rendered. |
| UI-11, UI-12 | PARTIAL | See the summary. |
| UI-13, UI-14 | MET | One card per source, each with its own status. |
| UI-15, UI-16 | MET | Compact cards (Electron `source-cards-compact` at 100 % and 150 %). |
| UI-17 | MET | `<details>` collapsed by default. |
| UI-18, UI-39 | MET | Continuous strip with "used of total" and a free-space legend. The Electron check "Storage strips … without overflow" passed. |
| UI-19 | MET | Name in the header. The path is inside details. |
| UI-20, UI-21 | MET | Only Photos and Videos are listed, per format, with count and size (screenshot). |
| UI-22 | MET | Camera information with evidence labels. |
| UI-23, UI-41 | MET | The pie chart is removed. No `pie`, `conic-gradient` or arc remains. |
| UI-24 | N/V | Design guidance. |
| UI-25 – UI-27, UI-29 | MET | Page title, Start, Stop, Automatic, Total progress and All errors in one titlebar row (screenshot, and Electron titlebar checks in 4 languages at 150 %). |
| UI-28 | MET | Errors appear in the All errors dialog (see the FMT-12 caveat). |
| UI-30 | MET | `aria-pressed` button toggle. |
| UI-31 | MET | The sidebar starts at the top edge (screenshot). |
| UI-32 | PARTIAL (ambiguous) | See the summary. |
| UI-33 | MET (cleanup pending) | No line is rendered. An unused i18n key remains. |
| UI-34, UI-35 | MET | Compact two-column Settings with the folder configurator (screenshot). |
| UI-36 | PARTIAL | See the summary. |
| UI-37, UI-38 | MET | View transitions and CSS motion, with `prefers-reduced-motion` honoured (Electron check passed). |
| UI-40 | MET | Per-extension colour map with hashed-hue fallback. |

## 11. Localization and icon

| ID | Verdict | Evidence / note |
|---|---|---|
| LOC-01, LOC-02 | MET | en, zh-Hans, zh-Hant and ja. The Electron check "All four interface languages switch live and persist" passed. |
| LOC-03 | MET | All 347 literal `t()` keys exist in all 4 columns, and presets go through `t()`. Example placeholder paths are untranslated by design. |
| ICON-01 | MET | `Icon.icon` Icon Composer bundle. |
| ICON-02 | MET | Viewed: no highlight clipping outside the squircle. |
| ICON-03 | MET | Viewed: content is centred with even margins. |
| ICON-04 | MET | `Icon.icns` is set as the package icon. The in-app `icon.png` is byte-identical to `Assets/AppIcon-preview.png`. |

## 12. Architecture

| ID | Verdict | Evidence / note |
|---|---|---|
| ARCH-01, ARCH-02 | MET / PARTIAL | `docs/architecture-and-features.md` has the inventory. Its preview-picker entry is stale. |
| ARCH-03 | PARTIAL | One copy engine (`core/index.ts`) and one scanner. The leftover `pick-preview` IPC remains. |
| ARCH-04 – ARCH-06 | N/V | Judgement. No duplicate engines were found. |
| ARCH-07, ARCH-08 | EVIDENCE | Layer fixes and before/after IPC payload measurements (`build/transfer-io-*.json`). The state channel sends diffs. |
| ARCH-09 – ARCH-11 | PARTIAL | Review done. The gaps above remain unfixed. |
| ARCH-12 | MET | Data redundancy (journals, retained originals) is kept separate from code redundancy. |
| ARCH-13 | MET | Grid and list share one card component and one planner. |

## 13. Testing and Codex integration

| ID | Verdict | Evidence / note |
|---|---|---|
| TEST-01 | PARTIAL | Edge-case suite is extensive (271 tests). "Full" cannot be proven. |
| TEST-02 | MET for this tree | All suites listed at the top pass. |
| TEST-03, TEST-04 | EVIDENCE | Historical real-card runs (`docs/hardware-a006-20261020.md`). |
| TEST-05, TEST-06 | EVIDENCE | Card preservation check over 8,005 sources, with two documented strict-identity exceptions. |
| TEST-07 | PARTIAL | Injected faults, SIGKILL and a detached disposable exFAT image were tested. No physical unplug or power-loss test. |
| TEST-08, TEST-09 | EVIDENCE | `build/failure-modes/chatgpt-review.txt` and `old-process-activity.json`. |
| TEST-10 | **OPEN** | Final audit `checked: 0`. |
| TEST-11 | EVIDENCE | Retention bindings, later superseded by the scoped reset. |
| TEST-12 | MET | `npm run codex:test` passed 22/22 here. |
| TEST-13 | PARTIAL | Detection, import and formats were exercised on hardware. Real-hardware merge and organization are not finished. |
| TEST-14 | MET (code) | In-progress download suffixes and changing files are skipped (`core/inventory.ts:31`). |
| TEST-15 | N/V | One-time reply. |
| TEST-16 | **OPEN** | 0.2.1 scope is recorded as camera import only. The hardware run was stopped before copying. |

## 14. A006 operations

| ID | Verdict | Evidence / note |
|---|---|---|
| A006-01, A006-02 | EVIDENCE | Baseline manifests and progress samples. |
| A006-03 | EVIDENCE | The old work verified 27,189 / 27,189, then stopped intentionally. |
| A006-04 | **OPEN** | Not executed. |
| A006-05 | EVIDENCE | Retention bindings. |
| A006-06, A006-17 | N/V | Authorization scope. Deletion-scope audit receipts exist. |
| A006-07 | PARTIAL | An earlier dedupe is recorded. The root-year merge is pending. |
| A006-08 | EVIDENCE | Historical card-preservation checks. |
| A006-09 | MET (code) | See TEST-14. |
| A006-10, A006-13 | **OPEN** | Organization is queued in the app but has not run. |
| A006-11 | EVIDENCE | Reset passed. Six app imports (7,954 copies) recorded, not re-hashed. |
| A006-12 | EVIDENCE | `unknownRules` excluded. |
| A006-14 | EVIDENCE | `detectedSources: 6`. |
| A006-15, A006-16 | EVIDENCE | `reset-complete.json`. 786 edited files (4,223,039,854 B) preserved. Not re-hashed. |
| A006-18 | **OPEN** | The running app's error menu has not been checked. |

## 15. Read-only follow-up (MON)

MON-01 – MON-05, MON-08, MON-15 and MON-16 describe how the follow-up automation behaves and are **N/V** from the repository. MON-06, MON-07, MON-09, MON-12 and MON-13 are **EVIDENCE**, recorded correctly in `tracking.json` and its receipts (superseded attempts, 27,189 / 27,189 not reported as a failure, predecessor bindings, 19,227 restored and 786 edited). MON-10 and MON-14 are PARTIAL (superseded by the reset; there is no organization result yet). **MON-11 and MON-17 are OPEN**: no per-path SHA-256 audit has run, and `completed:false`.

## 16 – 18. Changes, collaboration, documentation

Section 16 records interpretations and does not add new requirements. The relevant rows are applied above: COPY-09 parity, COPY-11 mirror deletion, the UI-32 preview, and SAFE-08 "newer". WORK-01 – WORK-15 are agent-workflow preferences and are N/V. DOC-01 is MET: `docs/user-requirements.md` is a single document. DOC-02 is N/V.
