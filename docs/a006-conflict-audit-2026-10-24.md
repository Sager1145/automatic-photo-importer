# A006 conflicts and edited-folder audit — 2026-10-24

Checked branches and pull requests before changes: checkout `main` at `d89394f`; GitHub has `main` and `claude/tab-regrouping`, with open [PR #1](https://github.com/Sager1145/automatic-photo-importer/pull/1). That PR changes navigation and unknown-file routing, but does not change the conflict exclusion or edited export route. Local changes are on `codex/a006-edited-placement`. No commit or push was made.

## Real-folder results

All audit operations against `/Volumes/A006` were read-only. No audit operation moved, renamed, deleted or wrote media on A006. The volume was changing independently during the audit, so these results describe observed snapshots, not a locked library.

The initial ordinary-file inventory contained 88,147 files, including 362 under `Conflicts` and 7,782 under edited-folder trees outside conflicts. Metadata was read for all 8,144 conflict/edited files. This is not a metadata audit of all 88,147 files.

### Conflicts

The 362 conflict files total 4,245,576,747 bytes. Every former target (the same relative path with `Conflicts/<id>` removed) exists and differs in content. Same-size candidates were SHA-256 compared; different sizes already establish different content. No byte-identical **same-name** copy was found anywhere in the inventoried tree. This does not rule out identical content under different names.

Metadata classified these as 273 edited exports, 19 RAW originals, and 70 files without recognized photo-editor provenance. All 273 recognized exports already have an edited-folder ancestor.

The app intentionally excludes existing `Conflicts` descendants from both Check folder layout and Organize. Changing Same-name handling to numbering affects later allocations; it does not rename existing conflict files. Therefore the current app cannot automatically resolve these existing folders. Their different versions must be preserved unless a separate choice authorizes selecting/removing a version. Numbering could retain both, but no migration of existing conflict trees is implemented here.

### Edited placement

Using recorded camera/capture metadata and the configured monthly edited route, the initial 7,782-file edited snapshot had:

- 7,767 files at the expected path.
- One file missing its camera subfolder: `2026/202610/editied/_NZF9998.jpg` belongs under `2026/202610/editied/NIKON Z f/`.
- 14 files missing routing metadata, already under `Unknown files`; their camera/date placement cannot be established from the available metadata.

A subsequent call to the app's actual read-only `findMisplaced` function checked all 55 observed edited-folder scopes with the saved app preferences (`video-root`, monthly template, `editied`, unknown files in `Unknown files`). It observed seven additional files and reported eight misplaced paths, all directly under `2026/202610/editied`:

`_NZF0005.jpg`, `_NZF0010.jpg`, `_NZF0012.jpg`, `_NZF0016.jpg`, `_NZF0039.jpg`, `_NZF0042.jpg`, `_NZF0045.jpg`, `_NZF9998.jpg`.

Fresh app metadata reads confirm all eight are edited Nikon Z f images; their expected parent is `2026/202610/editied/NIKON Z f/`. No organization was executed against the real drive. The app check reused the audit's parsed metadata for existing snapshot paths and freshly read paths absent from that snapshot; it did not use saved placement-memory shortcuts. A concurrent writer can change these results after inspection.

## Code finding and fix

A disposable fixture reproduced a separate bug: Organize moved an existing JPEG out of the configured edited folder when its editor tags were absent. Routing used metadata alone, although duplicate classification already respected edited-folder ancestry.

Organization now preserves that existing folder classification for non-RAW files, including sidecars of rendered images. Import source folder names do not classify new files as edited. RAW originals and their RAW sidecars keep original routing. The rules version is bumped so previously saved placement memories are checked again.

Regression coverage exercises all six media layouts, a custom edited folder, actual fixture organization with preserved bytes and an idempotent second plan, RAW/sidecar routing, import non-inference, and invalidation of old routing/placement memories. Edited exports intentionally remain flat under year/month/edited-folder/camera regardless of the original-media template, as required by ORG-16–19 and ORG-21.

## Other photo editors

The current parser already recognizes explicit provenance from Photoshop/Camera Raw, Lightroom, Capture One, darktable, RawTherapee, Affinity Photo, DxO PhotoLab/PureRAW/OpticsPro, and GIMP. It reads Software, ProcessingSoftware, CreatorTool, ImageEditingSoftware, RAWDevelopingSoftware, and flattened/structured history software-agent tags. Existing editor-metadata tests cover these programs, firmware/metadata-utility exclusions, and routing/inspection agreement. No speculative editor names were added.

Files exported without recognizable provenance cannot be classified from software tags alone. The fix preserves the user's existing configured edited-folder classification during organization in that situation. It does not infer editor provenance for every unclassified file elsewhere in the library.

## Evidence

Detailed local evidence is under `build/a006-conflict-audit/` (ignored build artifacts): `inventory.json`, `conflict-content.json`, `conflict-routing.json`, `metadata-complete.json`, `edited-placement.json`, `app-folder-check.json`, and `current-misplaced-metadata.json`.

Validation:

- Six new edited-placement cases failed before the fix; the placement-memory case failed before the rules-version bump.
- Focused edited/editor/layout/conflict suites: 45 passed; final edited-organization and folder-rules suites: 21 passed (overlapping runs, not summed).
- Final `npm run typecheck`, production build, and `git diff --check`: passed. Build emitted the existing bundle-size warning.
- Full `npm test`: 1,703 tests, 1,636 passed, 62 skipped, five failed in the original concurrent restricted run. The failures were the read-only-volume test, both folder-drive mounted-image tests, recovery-deletion heartbeat, and elapsed/time-left display. The mounted-image/filesystem rerun outside the sandbox passed 14/14. The display test passed on rerun. Recovery-deletion heartbeat first repeated a 3.32-second gap against its 3-second limit, then passed in isolation; unchanged main passed the same isolated test. A fully green single full-suite run is not claimed.
- Sandboxed Electron aborted before a report. Unrestricted organization QA passed the organization review/apply/idempotence, recovery, edited-folder settings and source-preservation checks; it initially failed dashboard drive activity, theme-gallery budget, and the final stress check not run before deadline. A fresh filtered run of those three checks plus final heartbeat/stall/preservation checks passed in 37 seconds. This does not replace the initial full report.

Initial and rerun logs are retained under the evidence directory. Full Electron report: `/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-kQ5cW7/artifacts/report.json`; passing filtered rerun: `/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-ELNMOc/artifacts/report.json`.
