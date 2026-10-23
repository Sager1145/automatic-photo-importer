# Architecture review 4: planning an import

Scope: media recognition, routing metadata, folder rules, skip-existing, space allocation, `prepare()` and reviews.
Base: `daaabd8`. Read-only analysis. Hashing (verify-once) and progress shapes are out of scope here; overlaps with them are only noted.

## 1. Interface table

| Capability | Entry (seam) | The one implementation | Count |
|---|---|---|---|
| Media kind by extension | `mediaKindForPath` | `desktop/media-formats.ts:15` | 1 |
| Camera/card system files | `knownSystemFile`, `finderAliasFile` | `desktop/core/known-files.ts:30`, `:36` | 1 |
| Companions (sidecars, Sony XML/BIM, LRF/LRV proxies, NKSC, Capture One, AAE) | `inventory()` | `desktop/core/inventory.ts:128-168` | 1 |
| Unknown-format rule precedence | `unknownRule` | `desktop/core/inventory.ts:40` | **2**: the renderer re-derives "unruled extensions" at `desktop/renderer/RootApp.tsx:538` and the unknown-file set at `RootApp.tsx:1574` |
| Remembered/session unknown rules | `act({type:'unknownRule'})` | `desktop/main.ts:941` (validated by `rules()` `inventory.ts:46`) | 1 |
| Live Photo pairing | `pairLivePhotos` | `desktop/core/index.ts:148`, called at `:292` | 1 |
| Routing metadata (camera, date+TZ, edited, DJI/Sony/Samsung/Insta360) | `metadata(file,{preview:false,details:false})` | `desktop/platform/metadata.ts:428` → `metadataFromTags` `:220` | 1 |
| Routing-metadata cache (scan → main → disk → import) | `routingEntries`/`primeRouting`/`carryRouting` | `desktop/platform/metadata.ts:337-353` | 1 |
| Metadata inspector (META-07..11) | `importer:inspect` | `desktop/main.ts:976` → `metadata()` with preview on | **2 paths**: `importer:inspect` and `importer:exif` (`main.ts:977`) differ only in whether an unused preview is built (smell S1) |
| Folder template → path | `folder()` | `desktop/core/index.ts:59-82` | **3**: the renderer's `samplePath` `RootApp.tsx:57` and `monthSample` `RootApp.tsx:59` re-implement the token values (smell S2) |
| Path builder (order, Y/M/D toggles, English months) | `buildTemplate`/`parseTemplate` | `desktop/folder-template.ts:16`, `:22` | 1 |
| 6 media layouts | `layoutFolders`, `formatFolder` | `desktop/media-formats.ts:22`, `:34` (shared by core and Settings) | 1 |
| Video backup root | `backupFolders` + `options.videoRoots` | `desktop/platform/destination-roots.ts:9`, `core/index.ts:198-217` | 1 (path checks duplicated, S7) |
| Edited folder | `folder()` edited branch | `desktop/core/index.ts:72-75` | **2**: the edited preview hardcodes `'2026','202610'` at `RootApp.tsx:1768` (S2) |
| Conflicts folder | `target()` + `allocate()` | `desktop/core/index.ts:91-126` | 1 |
| Skip-existing at the intended path (ORG-05) | `existingMatches` + `DestinationIndex` | `desktop/core/index.ts:99`, `desktop/core/destination-index.ts:36` | 1 (hashing overlap: verify-once session) |
| Space: single / mirror / sequential | `allocateDestinations` | `desktop/core/allocation.ts:31` | 1 |
| Destination validation and folder creation | `destinationRoots` | `desktop/platform/destination-roots.ts:18` | 1 |
| Frozen preferences per run | `snapshotPreferences` | `desktop/main.ts:487` | 1 |
| Settings lock | `settingsLocked`/`acceptedPreferences` | `desktop/settings-lock.ts:11`, `:23` | 1 (plus a dead copy at `main.ts:126`, S5) |
| Plan → reservations → review | `prepare()` | `desktop/main.ts:501-541` | 1 (shared by direct import and review, which is good) |
| Review lifecycle | `previewSource` / `applyReview` / `discardReview` | `desktop/main.ts:643`, `:654`, `:633` | 1 |

## 2. Smells, ranked

**S1. The inspector builds an embedded preview that nothing displays (wasted ExifTool and IPC work).**
- **Evidence:** the renderer's `inspect` calls `window.importer.inspect` (`RootApp.tsx:361`). That reaches `metadata()` with `preview` left on (`main.ts:976`), which runs `preview()` (`metadata.ts:266-288`): up to 3 `extractBinaryTag` calls, a temp dir, and a base64 data URL of up to 20 MB (`metadata.ts:262`) sent over IPC. The metadata dialog never reads `metadata.preview` (`RootApp.tsx:1790-1830`; no `.preview` use in the renderer). The only trace is a junk `PreviewStatus` field (`metadata.ts:440`) listed under "All metadata". META-12/UI-32 asked for the preview to be removed.
- **Cost:** about 3 extra ExifTool spawns plus 20 MB of IPC per inspected RAW. Two booleans also encode three modes (`metadata.ts:430,436,439`).
- **Fix:** delete `preview()`, `PreviewStatus` and `importer:inspect`/`window.importer.inspect`. The renderer calls `exif` instead, and `metadata()` keeps only `details`. Keep `embeddedPreview` (`metadata.ts:290`), which thumbnails use.
- **Risk:** low. The `qa/a006-hardware.ts:536` check named "metadata and preview" needs its label or assertion updated.

**S2. Template tokens have three implementations: core plus two renderer copies, and the edited path is hardcoded twice.**
- **Evidence:** core builds the values at `core/index.ts:71`. The renderer re-implements them in `samplePath` (`RootApp.tsx:57`) and `monthSample` (`RootApp.tsx:59`). The edited template is fixed in core as `{year}/{yyyymm}/${editedFolder}/{camera}` (`core/index.ts:75`), and its preview is separately hardcoded as `'2026','202610'` (`RootApp.tsx:1768`).
- **Cost:** a new token or month format has to be changed in three places, and the preview can drift from real routing. The edited path also ignores the user's order and toggles (camera-first users still get date-first edits; partial ORG-22).
- **Fix:** add `templateValues(date, camera)`, `expandTemplate(template, values)` and `editedTemplate(folder)` to `desktop/folder-template.ts`, which is already the Node-free shared module. Core `folder()` and the renderer previews then call them, and `samplePath`/`monthSample` are deleted.
- **Risk:** low. This is pure functions plus tests.

**S3. The renderer re-derives core's unknown-file decision with a different predicate.**
- **Evidence:** `collectErrors` (`RootApp.tsx:538`) raises "Unknown file formats" for any extension in `unknownExtensions` that has no user rule. But `unknownExtensions` (`inventory.ts:185-186`) also counts extensions already routed by the built-in audio→camera rule (`inventory.ts:42`), so with the default set to `ask`, an unpaired `.wav` still prompts. `RootApp.tsx:1574` rebuilds the unknown list with `file.included || size>0` where core uses `backup || size>0`.
- **Cost:** two places own one policy, and false prompts are plausible.
- **Fix:** core already records the result as `skipped[].reason==='unknown-ask'|'unknown-skip'|'unknown-rule'` (`inventory.ts:183`). The renderer reads those reasons, or core adds `InventoryFile.unknown:boolean` set once at `inventory.ts:185`. Then delete the renderer predicates.
- **Risk:** low.

**S4. Inventory data crosses layers repeatedly, carrying a payload nobody downstream reads.**
- **Evidence:**
  - The scan worker lists and classifies the card (`scan-worker.ts:24`), and the result goes worker→main→renderer (`main.ts:213`, `state-channel.ts:21-27`).
  - `prepare()` → `plan()` runs `inventory()` again (`core/index.ts:238`). With `reuse`, only `readdir` is skipped: every folder is still lstat'ed and every file reclassified. The new object then replaces `state.sourceInventories` (`main.ts:650`, `:569`), so the whole inventory crosses IPC a second time.
  - Each `Inventory` also carries `listing` (`inventory.ts:187`): every folder's full entry-name list, which only `inventory()` reuse in main needs. That list is cloned to the renderer and also written to `plan.json` (`main.ts:575`).
- **Cost:** for a 100k-file card, roughly two full structured clones to the renderer and a duplicated name list in every report.
- **Fix (minimal):** keep `listing` main-side only. Strip it in `createStateChannel.reference` (`state-channel.ts:21`) and in the `plan.json` write. Optional: when the planned inventory's file set equals the scan's (same listing keys), keep the scan object so the reference stays the same.
- **Risk:** low.

**S5. Dead and test-only code in planning and settings.**
- **Evidence and fix:**
  - `main.ts:126` `livePreferences` is never used; `settings-lock.ts:20` owns it. Delete the `main.ts` copy.
  - `lockedPreferenceKeys` (`settings-lock.ts:17`) is used only by tests (`tests/settings-lock.test.ts:27`, `appledouble.test.ts:99`, `resource-limits.test.ts:89`). Fold those assertions into `acceptedPreferences` and delete it.
  - `pairLivePhotos(...,{stemOf})` (`core/index.ts:148-149`) is a seam that exists only for `tests/whitelist-companions.test.ts:170` (counting calls). Delete `stemOf`; linearity is a code-review property.
  - `setRoutingLimit`/`setRoutingBatch` (`metadata.ts:333,359`) are test knobs. Keep them; they are cheap and gate memory.
- **Risk:** none.

**S6. Rules are normalized and evaluated repeatedly.**
- **Evidence:**
  - `rules()` runs in `planOnce` (`core/index.ts:195`) and again inside `inventory()` on the already-normalized map (`inventory.ts:56`).
  - `unknownRule()` runs per file at `inventory.ts:166`, again at `:182`, and a third time at `core/index.ts:415`.
  - `knownSystemFile` is matched twice for a media-looking system file (`inventory.ts:125` then `:130`).
  - Saved `unknownRules` are not validated on load (`preferences.ts:68`), so a malformed saved rule throws during planning (`inventory.ts:50`) instead of being dropped.
- **Fix:**
  - Validate in `normalizePreferences` (call `rules()` and drop invalid entries).
  - Have `inventory()` store the resolved rule on the file (`file.rule`) so `planOnce` reads it.
  - Skip re-matching when `file.system` is already set.
- **Cost/risk:** small CPU; low risk.

**S7. Destination path invariants are checked in two layers with different error keys.**
- **Evidence:** a video root nested in the photo root is refused at `destination-roots.ts:24` (`error.videoFolderPath`) and again at `core/index.ts:215` (`error.videoFolderNested`). "Source inside backup" is refused at `destination-roots.ts:28/37` and again at `core/index.ts:208`.
- **Why it exists:** the platform check runs before folders are created, while the core check is authoritative after `realpath`.
- **Fix:** keep both, but have `destination-roots` call one exported predicate from `core/paths` and use one message key each.
- **Risk:** low. This is defense in depth, not data-safety redundancy to remove.

**S8. Edited-folder and template validity are enforced only at plan time.**
- **Evidence:**
  - `normalizePreferences` accepts any `editedFolder`/`template` (`preferences.ts:48,69`).
  - `folder()` throws a non-localized `Error('Choose a single safe folder name…')` (`core/index.ts:73`) on every call, and `planOnce` dry-runs `folder()` to validate (`core/index.ts:220`).
  - The `??'editied'` fallbacks at `core/index.ts:72,356` and `RootApp.tsx:1751` never fire, because normalization always sets the field (`preferences.ts:69`).
- **Fix:** add `validTemplate`/`validFolderName` to `folder-template.ts`, used by `normalizePreferences` (reject on save) and by the Settings field. `folder()` then trusts its input; delete the fallbacks and the dry-run.
- **Risk:** low. The settings lock already blocks changes during a review.

**S9. `planOnce` (`core/index.ts:191-568`, about 380 lines) is shallow inside: one function owns listing, metadata, Live Photo pairing, families, GoPro chapters, duplicate stage 1, unknown-file context, routing, problem collection, reorganization hashing and per-root allocation.**
- **Note:** the interface is deep, which is good, but each concern can only be tested through the whole plan.
- **Fix (when touched next):** extract the pure part, `route(files, infos, mtimes, options) → prepared[]` (`:315-432`), into its own module next to `folder()`. That covers families, chapters, `unknownContext` and the routing loop. The I/O stages stay in `planOnce`.
- **Risk:** medium (large move). Only worth doing together with S2.

**Overlaps (not re-analyzed):**
- Pre-hash pool and `existingMatches`/`DestinationIndex.hinted` (`core/index.ts:510-527`, `:99`) belong to verify-once.
- `PlanProgress` steps (`core/index.ts:190`) belong to progress-everywhere.
- `etaTracker.plan` in `prepare` (`main.ts:504`) belongs to speed-accuracy.
- `sourcePolicy` is computed in both `prepare` (`main.ts:539`) and `run` (`main.ts:560`), which contradicts the "one place" comment. Low priority.

## 3. Requirements check

| ID | Status | Evidence |
|---|---|---|
| FMT-01/02/03/04 | Implemented | Media whitelist `media-formats.ts:4-10`; `NIKON\d{3}.DSC` catalogued as a system file `known-files.ts:9`; system files skipped with label `inventory.ts:131,183` |
| FMT-05 | Implemented | Cameraless media still imported to `Unknown Camera` `core/index.ts:71`; only catalogued files skipped |
| FMT-06 | Implemented | RAW/JPEG/HEIF/Images/Videos sets `media-formats.ts:5-9` |
| FMT-07 | Implemented | Sidecar/companion pairing incl. Sony `CnnnnM01.XML` and `BIM` `inventory.ts:138-163`; Sony catalogs are system files `known-files.ts:12-14` |
| FMT-08/09/10/11 | Implemented (prompt partial, S3) | `unknownDefault` skip/other/ask `preferences.ts:64`; rule menu `main.ts:941` with `remember`; `{action:'camera'}` with folder context `core/index.ts:416` |
| FMT-12 | Implemented | Format warnings go to the error list `RootApp.tsx:538-541`; ExifTool errors to `scan.issues` `core/index.ts:272,285` |
| FMT-13 | N/A (test procedure) | — |
| FMT-14 | Implemented | `backup` includes every file and keeps relative paths `inventory.ts:167`, `core/index.ts:418` |
| FMT-15 | Implemented | `lrf` is Video `media-formats.ts:9`; proxy pairing `inventory.ts:13-21,134-137` |
| META-01/02/03 | Implemented | `recordedCamera` incl. `DeviceModelName`, Samsung, DJI encoder, CinemaDNG `metadata.ts:64-87`; DJI products `dji-models.ts` |
| META-04 | Implemented | Offset kept, folder by wall-clock date `metadata.ts:29-39`, `core/index.ts:62-67`; DJI name/UTC reconciliation `metadata.ts:107-120` |
| META-05/06 | Implemented | `formatCaptureDateTime` with separate time zone `RootApp.tsx:1798,1811` |
| META-07/08/09 | Implemented | Exposure summary `metadata.ts:143`; collapsed `<details>` `RootApp.tsx:1822` |
| META-10/11 | Implemented | Shutter-count rules `metadata.ts:239-259`; videos get none (`RootApp.tsx:1797` `video` guard) |
| META-12 / UI-32 | Partial | No preview is shown, but one is still built and shipped on every inspect (S1) |
| ORG-01/02 | Implemented | Default `photobackup` + `{year}/{yyyymm}/{camera}` `preferences.ts:6`. Note: default layout `video-root` sends videos to `videobackup` |
| ORG-03 | Implemented | Builder + custom template `RootApp.tsx:1755-1764` |
| ORG-04/21 | Implemented | 6 layouts `preferences.ts:4`, `media-formats.ts:22`; companions use the original's format folder `core/index.ts:427`; edited exports flat `:81`; identical files skip, different files go to `Conflicts/` `:91-126` |
| ORG-05 | Implemented | Same path, same size, SHA-256 compare `core/index.ts:99-104,118` |
| ORG-15/18/19 | Implemented | Editor provenance `metadata.ts:166`; RAW never edited, XMP follows its RAW `core/index.ts:414` |
| ORG-16/17 | Implemented | `editied` default, changeable `preferences.ts:6`, `RootApp.tsx:1767`; month-level edited folder `core/index.ts:75` |
| ORG-20 | N/A here (organization run) | — |
| ORG-22 | Partial | Order and Y/M/D/English toggles for photo and video `folder-template.ts:16`, `RootApp.tsx:1756,1758`; the edited path ignores the chosen order (S2) |
| DST-05 | Implemented | Presets + builder + custom (as ORG-03/22) |
| DST-06 | Implemented | `makeParent`/`syncParents` `destination-roots.ts:30`; per-file parents created during publication |
| COPY-08/09 | Implemented | `single`/`mirror`/`sequential` `preferences.ts:46`, `allocation.ts:31-54`; separate physical disks enforced `destination-roots.ts:32`. True parity is unresolved by the requirement itself |
