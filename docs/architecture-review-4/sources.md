# Architecture review 4 — Sources: discovery, selection, read-only scan

Scope: `desktop/platform/volumes.ts`, `platform/camera-bridge.ts`, `Sources/CameraBridge`, `Sources/CameraAdapters`, `device-selection.ts`, `folder-sources.ts`, `drive-groups.ts`, `source-cameras.ts`, `scan-process.ts`, `scan-worker.ts`, `scan-stop.ts`, `platform/scan-memory.ts`, `platform/listing-memory.ts`, `listing-estimate.ts`, the source parts of `main.ts` and `renderer/RootApp.tsx`. Read at `daaabd8`. Paths below are relative to `desktop/` unless they start with `Sources/`.

Verdict: the feature is mostly **one implementation per capability**, and the modules are deep (`volumes.ts` hides diskutil/lsblk/PowerShell, fingerprint caching and single-flight behind `mountedVolumes()`/`getSources()`). The smells are small: one dead duplicate filter, the "listing estimate" logic living in three layers, helpers repeated inside `volumes.ts`, and the device-prompt state split between main and renderer.

## 1. Interface table

| Capability | Entry | The one implementation | 2+? |
|---|---|---|---|
| Enumerate mounted volumes | `mountedVolumes()` (single-flight) | `platform/volumes.ts:148-171`; mac `describeVolumes` :134, win :85, linux :75 | no (per-OS adapters are real: `package.json:13-15` ships all three) |
| Classify a volume as a source | inside `getSources` | `classifyVolume` `volumes.ts:16-23`, cached by `classifyMounted` :188-199 | no |
| Detect sources (cards, readers, mass-storage cameras) | 5 s timer `main.ts:981` + `refresh` IPC `main.ts:862`, `R` key / button `RootApp.tsx:341,582,602` | `refresh()` `main.ts:188-208` → `getSources` `volumes.ts:201-216` | no |
| Detect PTP cameras (macOS) | `getSources` → `cameraSources()` | `camera-bridge.ts:72-79` → JSONL `list` `Sources/CameraBridge/main.swift:33-35` → `DeviceDiscovery.sources` `Sources/CameraAdapters/DeviceDiscovery.swift:49-52` | no |
| Keep mass storage out of the PTP list | in Swift | `CameraSourceClassifier.shouldListAsPTP` `DeviceDiscovery.swift:284-287` | no |
| Read a camera (stage to a temp folder) | `prepare` `main.ts:513` | `prepareCamera` `camera-bridge.ts:80-96` → `stage` `main.swift:36-47` | no |
| Exclude destination drives from sources | `refresh` | `getSources` option `volumes.ts:207` **and** `main.ts:134` | **yes (2)**, see S1 |
| Choose folder sources / backup sources | `chooseSource` `main.ts:878`; buttons `RootApp.tsx:1075,1079` | `resolveFolderSources` `folder-sources.ts:13-31` | no |
| Folder sources that share a drive | render-time | `driveContext` `drive-groups.ts:9-18`, used at `RootApp.tsx:464,880,1074,1890` | no |
| Select / ignore a drive | `selectSource` `main.ts:931-934`; chips `RootApp.tsx:924,1130,1515` | `DeviceSelection.select` `device-selection.ts:40-47` | no |
| Remember / ignore / forget | `forgetDevice` `main.ts:936-938`; Settings `RootApp.tsx:893,916` | `DeviceSelection.forget` `device-selection.ts:51-54`; stored in `Preferences.rememberedDevices/ignoredDevices` | no |
| New-device and reconnection notice | `state.newDevices/reconnectedDevices` (`main.ts:123`); `dismissReconnected` `main.ts:930` | `DeviceSelection.apply` `device-selection.ts:23-39`; sheet `NewDrivePrompt` `RootApp.tsx:1093-1133` | dismissal has 2 owners, see S5 |
| Device history (last scan/import, cameras) | `noteDevice` `main.ts:115` | `recordDeviceHistory` `device-selection.ts:60-68` | no |
| Read-only scan (inventory) | `scanSource`/`scanSources` `main.ts:780-781` | `scanSource` `main.ts:209-217` → `scanSourceInWorker` `scan-process.ts:10-31` → `scan-worker.ts:16-30` → `core.inventory` | no |
| Camera/lens detection | in the scan worker | `analyzeSourceCameras` + `inferCameraHints` `source-cameras.ts:29-110` | no |
| Stop a scan | `stop` `main.ts:313` (`scanControls`) | `stopScanChild` `scan-stop.ts:16-31` | no |
| Scan memory across restarts | `loadRememberedScans` `main.ts:102-114`, `rememberScan` `main.ts:97-101` | `loadScanMemory`/`saveScanMemory` `platform/scan-memory.ts:22-61` | no (2 writers, see S7) |
| Listing-size memory | `listingOptions` `main.ts:316-319` (imports only) | `platform/listing-memory.ts:21-38` | no |
| "How far is the listing" | scan: `main.ts:213` (`topShare`) + `RootApp.tsx:1452-1466`; import: `core` with `listingHint` | `listing-estimate.ts` | **yes (3 places)**, see S2 |
| Source capacity shown | card/sidebar | `getSources` statfs `volumes.ts:210`, `folderCapacity` :244, renderer `sourceCapacity` `RootApp.tsx:173-183` | **yes (3)**, see S3/S4 |

## 2. Smells (ranked by cost × how easy the fix is)

**S1. Destination filter runs twice (dead code).** `getSources` already drops any volume whose id or path matches a destination (`volumes.ts:207`). `main.ts:134` then applies the same check to its result (`d.volumeId===s.id` is the same test, because `id = volumeId||path`, `volumes.ts:210`). Camera paths are `camera://…` (`camera-bridge.ts:77`) and never match. *Cost:* O(sources×destinations) work on every 5 s refresh, plus two rules to keep in step. *Fix:* delete the `detected` filter at `main.ts:134` and use `found`. *Risk:* none. The QA path passes `[]`.

**S2. The listing estimate lives in three layers, and scans don't use listing memory.** Imports get `listingHint` from `listing-memory`, falling back to the previous scan or the used bytes (`main.ts:225-227,316-319`), and `core` computes the share. Scans get a `topShare` from main (`main.ts:213`, `listingEstimate(undefined,…)`) while the renderer computes its own byte share (`scanTotalBytes` `RootApp.tsx:1450-1454`, `listingShare` at :1466). That byte share sums every file of the previous inventory on each render (:1452). Scans never call `rememberListing`/`loadListingHint`. *Cost:* the same rule ("hint, else used bytes, else top folders") exists twice, the renderer does O(files) work per render, and the first scan of a card gets a worse estimate than its import. *Fix:* in `scanSource`, build the hint with `listingOptions(source.path,undefined,false,…)` and pass it into the worker's `inventory` options (`scan-worker.ts:24`). Have the worker report the `share` that `core` already computes. Then delete `scanTotalBytes`, the `listingShare` branch in `ScanProgress` and `topShare`. *Risk:* low. **Overlap:** `claude/progress-everywhere` and `claude/speed-accuracy` own progress/ETA shapes, so hand them this, don't fix it here.

**S3. The same volume helpers are repeated inside `volumes.ts`.** "Longest mounted volume containing a path" appears in `backupDriveIdentity` :240, `folderDrive` :253, `volumeInfo` :262, and again in `main.ts:103` (`etaDrive`). `statfs`→`{total,free}` appears at :210, :245 and :260-263. *Fix:* one `volumeFor(path,volumes)` and one `capacity(path)` in `volumes.ts`, then make `folderCapacity` that helper. *Risk:* none (pure refactor; `tests/volume-identity.test.ts` and `drive-backup.test.ts` cover it).

**S4. The renderer re-derives which drive holds a path.** `sourceCapacity` (`RootApp.tsx:173-183`) matches path prefixes against sources and destinations to find a capacity. Main already knows this (`folderDrive`, `volumeInfo`). Folder sources carry `total/free` (`folder-sources.ts:28`), so the fallback serves only library/organization sources and folders whose statfs failed. *Fix:* have main set `total/free` (and `drive.name`) on every `Source` it publishes, including organization sources, and delete the fallback. *Risk:* low; check the organization cards.

**S5. Dismissal of the device prompt has two owners.** "Decide later" for *new* devices is renderer `useState` (`RootApp.tsx:314-317`), so it is lost when the renderer reloads. Dismissal of *reconnected* devices goes through IPC to `DeviceSelection` (`RootApp.tsx:1108` → `main.ts:930`; also `start` `main.ts:881`). *Fix:* add `dismiss(id)` to `DeviceSelection` that drops the id from `newDevices` without deciding (cards still show "needs choice" through a separate `undecided` set). The renderer then reads only `state`. *Risk:* low; the behavior is specified in `device-selection.ts:15-17`.

**S6. Four copies of re-applying the selection.** `state.sources=selection.apply(state.sources,remembered,ignored,history);publishDevices()` appears at `main.ts:195`, :878, :934 and :938, with the same four preference maps each time. *Fix:* give `DeviceSelection` the `Preferences` object once (or add a `reselect()` helper in main) so `apply(sources)` takes one argument and returns `{sources,newDevices,reconnectedDevices}`. That also deletes `publishDevices`. *Risk:* none.

**S7. Scan memory is written by two flows, and the write is copy-pasted.** `rememberScan` runs after a scan (`main.ts:213`) and again after every import plan (`main.ts:534`). Each run rewrites the whole listing plus all routing entries (`scan-memory.ts:22-38`). The atomic temp+rename write is copy-pasted at `scan-memory.ts:34-37`, :81-84, `listing-memory.ts:32-35` and `main.ts:120`. *Fix:* skip the save when the inventory is the reused one (`inventory===reusableScan(source)`), and use one `writeJsonAtomic`. **Overlap:** records-v5 (`core/app-store.ts`) should own that writer. Also, `loadImported`/`rememberImported` (`scan-memory.ts:63-93`) are verified-copy receipts, not scan memory. They are in the wrong module and belong to the hashing/verify-once work; noted, not analyzed.

**S8. The mount fingerprint is computed three times per refresh.** `describeVolumes` (`volumes.ts:135`), the `physicalStores` key (:160) and `classifyMounted` (:191) each `stat`+`statfs` every mount. Every extra `mountedVolumes()` caller (destination checks, `destinationRoots`, ETA) repeats this. *Fix:* compute fingerprints once in `enumerateVolumes` and carry them on `MountedVolume` (internal field) for `physicalStores` and `classifyMounted`. *Risk:* low. *Cost today:* small (cached syscalls), but it runs every 5 s per mount.

**S9. Inventory and routing data cross processes twice per rescan.** worker→main: `inventory` (`scan-worker.ts:25`) and `routing` every 1 s (:20-21). main→renderer: once, by reference (`state-channel.ts:24-29`), which is good. main→worker on the next scan: the whole `reuse` inventory plus the routing filtered by prefix (`main.ts:213`, `scan-process.ts:26`). The second crossing is the price of process isolation and buys the fast rescan, so **keep it**. Two smaller costs: `sourceCameraInfo`, including per-file `issues` paths (`source-cameras.ts:72`), is republished in full on every `emit` (it is not reference-tracked like inventories, `state-channel.ts:3`). The renderer also gets every file path, but needs only per-format totals and unknown extensions (`formatSegments` `RootApp.tsx:158-161`). *Fix (cheap):* reference-track `sourceCameraInfo` in `state-channel` the way inventories are. Sending a summary instead of the inventory is a cross-feature decision; it also touches review and the unknown-files prompt.

**S10. A stored fallback hides behind live state.** `folder-sources.ts:17,27` calls `volumeInfo` for every destination to store `drive.sameAsDestination`. `drive-groups.ts:15-16` uses that value only when no destination is available, which is exactly when "on a destination drive" no longer matters. *Fix:* delete `sameAsDestination` and the `destinationVolumes` lookup; `onDestination` becomes live only. *Risk:* low (check `tests/folder-drives.test.ts`).

**S11. Folder capacity goes stale.** Folder `total/free` is refreshed only after a scan (`updateFolderCapacity` `main.ts:116-122`), while cards are re-`statfs`'d every refresh (`volumes.ts:210`). *Fix:* recompute folder capacity in `refresh` through the S3 `capacity()` helper, then delete `updateFolderCapacity`.

**Small items:**
- The Swift `list` result sends an `id` (`main.swift:34`) that TypeScript rebuilds and ignores (`camera-bridge.ts:77`). Delete it on one side.
- `classifyMounted` repeats `classifyVolume`'s guard (`volumes.ts:190` vs :19). It is needed to skip the directory listing, but naming it `isInternalOrSystem(volume)` would make it one rule.
- The final branch of `enumerateVolumes` (`volumes.ts:170`) is unreachable in shipped builds (darwin/win32/linux only). It is harmless.
- `startScan` takes 8 positional arguments, 4 of them callbacks (`scan-process.ts:15`). Use one `{onInventory,onCameras,onListing,onRouting}` object. This is interface width only.

**Checked and kept (not smells):**
- `scan-stop.ts`: one adapter, but the seam exists so the stop sequence can be tested without Electron. It passes the deletion test because the complexity would otherwise sit untested in `scan-process.ts`.
- The `staging` guard in `cameraSources` (`camera-bridge.ts:73`) is required. The Swift loop serves one command at a time (`main.swift:28-47`), so a `list` sent during a stage would time out after 10 s and `closeCameraBridge` would kill the stage (`camera-bridge.ts:67`).
- The diskutil description memory (`volumes.ts:95-110`) and single-flight (:142-149) are data-safety and performance measures, not redundancy.

## 3. Requirements check (`docs/user-requirements.md`)

| ID | Status | Evidence |
|---|---|---|
| SRC-01 auto-detect cards | implemented | 5 s poll `main.ts:981` → `getSources` `volumes.ts:201`; layout or removable test `volumes.ts:16-23` |
| SRC-02 any form factor | **partial** | mounted storage on all OSes; PTP/MTP cameras only on macOS (`camera-bridge.ts:27`), not on Windows or Linux |
| SRC-03 USB mass-storage cameras | implemented | mounted like a card; excluded from the PTP list so a camera is not listed twice (`DeviceDiscovery.swift:284-287`) |
| SRC-04 real test cards detected | implemented (hardware not verified here) | DCIM/PRIVATE/AVCHD/MP_ROOT/M4ROOT/CONTENTS/XDROOT `volumes.ts:21`; A006 harness `main.ts:983` |
| SRC-05 layouts, media anywhere | implemented | whole-card `inventory` (`scan-worker.ts:24`); layouts `volumes.ts:21` |
| SRC-06 Sony separate video + companions | implemented | companion linking `core/inventory.ts:136-165`; M4ROOT/XDROOT hint `source-cameras.ts:44` |
| SRC-07 folder source behind an option | implemented | gate `main.ts:878`; switches `RootApp.tsx:833,1075`. Backup sources bypass the gate by design (`input.backup`) |
| SRC-08 manual vs card choices clear | implemented | separate "Choose media folders…" and "Back up drives or folders…" `RootApp.tsx:1075,1079`; "Folder backup" tag :1513 |
| SRC-09 camera from name/files/EXIF | **partial** | storage: `inferCameraHints` + EXIF `source-cameras.ts:29-110`. PTP cameras cannot be scanned (`main.ts:211`, `RootApp.tsx:1612`) |
| SRC-10 several cameras per card | implemented | `models` map `source-cameras.ts:63-96`; history keeps all `device-selection.ts:66-67` |
| SRC-11 remove direct-USB claim | **check** | still shows "Connected USB camera" (`RootApp.tsx:1535`) and "Use Review for USB cameras." (:1612, :1513). Labels rather than claims, but the user should confirm |
| DST-04 block cards as destinations | implemented | `validateDestination` `volumes.ts:277-279` |
| COPY-03 auto-import new camera media | **partial / conflict** | auto-import takes only *selected* drives (`main.ts:140-142`); an unknown card starts deselected and is announced (`device-selection.ts:32-34`), so a first-time card waits for one answer. Intended by `device-selection.ts:15-17`, but it narrows COPY-03; needs a user decision |
| A006-14 already-connected drives found | implemented | `refresh()` at boot `main.ts:981` |
| UI-13/14 several drives as cards | implemented | `SourceRow` per source `RootApp.tsx:1074`; sidebar list :880 |
| UI-15/16 compact, well-stacked | not assessed | visual; list/grid switch :1070 (ARCH-13: one scan implementation for both views) |
| UI-17 collapsed details | implemented | `<details>` with summary `RootApp.tsx:1533` |
| UI-18 capacity bar | implemented | `CapacityBar` :184, used at :1533; a shared drive shows "Same drive as …" (`drive-groups.ts`, :466) |
| UI-19 name and path | implemented | :1513, :1535 |
| UI-20 media formats only | implemented | `formatSegments` skips `Other` `RootApp.tsx:161` |
| UI-21 counts by format, total size | implemented | `SourceMediaSummary` `RootApp.tsx:1598` |
| UI-22 cameras on the drive | implemented (storage) | `SourceCameraInformation` :1553; hints in the new-drive sheet :1121; remembered cameras :893 |

## Overlap with other sessions (noted, not analyzed)
- Progress/ETA shapes (`scanProgress`, S2) belong to `claude/progress-everywhere` and `claude/speed-accuracy`.
- The atomic JSON writer and the scan/listing memory files (S7) belong to records-v5 `core/app-store.ts`.
- The `loadImported`/`rememberImported` receipts belong to hashing/verify-once.
