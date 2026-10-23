# Architecture review 4 — Remove duplicates

Scope: stage 1 recording, stage 2 scan, grouping/levels/keeper, group view (thumbnails, EXIF), confirm, removal into the recovery store with undo/release, staleness, earlier-organization warning, library-overlap refusal, thumbnail cache. Read at `daaabd8`. Hash counts in `duplicate-removal.ts` and progress shapes are skipped (handled by other sessions); overlaps are noted.

## 1. Interface table

`2+` = more than one implementation of one capability.

| Capability | Entry | Implementation | |
|---|---|---|---|
| Stage 1 candidates (planning) | `plan(...,{duplicates})` `main.ts:526` | `confirmCandidates` `core/duplicates.ts:103` + `candidates` `duplicate-rules.ts:50` | 1 |
| Stage 1 record into library | `recordDuplicates` `main.ts:623` | `recordPlanDuplicates` `core/duplicates.ts:208` | 1 |
| Stage 2 scan | action `duplicatesScan` `main.ts:784` → `scanDuplicatesAction` `main.ts:678` | `scanDuplicates` `core/duplicates.ts:149` | 1 |
| Grouping + strength | — | `buildGroups` / `classify` `duplicate-rules.ts:77,69` (also reused by `afterRemoval` `duplicate-removal.ts:136`) | 1 |
| Levels 1–3, keeper | — | `resolveGroups` / `automatic` / `chooseKeeper` `duplicate-rules.ts:116,106,37`; called by renderer (preview, `DuplicatesPage.tsx:29`) and main (authoritative, `main.ts:718`) | 1 (two callers by design) |
| Summary + earlier count | — | `summarize` `duplicate-rules.ts:125` | 1 |
| Groups to renderer | IPC `importer:duplicates` `main.ts:980` → `preload.ts:18` → `DuplicatesPage.tsx:226` | in-memory `duplicateGroups` `main.ts:661` | 1 |
| Thumbnail | IPC `importer:thumbnail` `main.ts:978` | `thumbnail` `platform/thumbnails.ts:65` (sips → embedded fallback) | 1 |
| Embedded JPEG from a RAW | — | `embeddedPreview` `platform/metadata.ts:290` **and** `preview` `platform/metadata.ts:266` (other tag order, data-URL) | **2+** |
| Full EXIF of one file | IPC `importer:exif` `main.ts:977` **and** `importer:inspect` `main.ts:976` | both `metadata()` `platform/metadata.ts:428`, differ only by `{preview:false}` | **2+ entries** |
| Detailed EXIF display | Group view / file inspector | curated `categorize` `exif-categories.ts:85` + `basicExif` `DuplicatesPage.tsx:56` **vs** raw searchable list + basic block `RootApp.tsx:1798-1827` | **2+** |
| Two-step confirm sheet | — | `DuplicatesConfirm` `DuplicatesPage.tsx:124`, `DeleteRecoveryConfirm` `RootApp.tsx:981`, `OriginalsConfirm` `RootApp.tsx:1387` (same shell; step machine `nextDeleteRecoveryStep` `RootApp.tsx:972` is shared) | **3 copies** |
| Undo / Release a job | actions `undoOrganization` / `finalizeOrganization` | `RemovedDuplicates` `DuplicatesPage.tsx:140` **vs** `RetainedOriginals` `RootApp.tsx:929` (same buttons + `ReleaseConfirm`) | **2+** |
| Removal into recovery | action `duplicatesRemove` `main.ts:786` → `removeDuplicatesAction` `main.ts:713` | `removeDuplicates` `duplicate-removal.ts:40` → `beginDuplicateRemoval` (recovery.ts) | 1 |
| In-memory update after removal | — | `applyRemoval` `main.ts:697` → `afterRemoval` `duplicate-removal.ts:129` | 1 |
| Staleness after jobs/undo | — | `duplicatesStale` `main.ts:705`, called at `main.ts:337` (jobs) and `main.ts:306` (undo/resume) | 1 |
| Earlier-organization warning | — | `placedByEarlierJournals` `core/recovery.ts:934` → `dup.earlier` `main.ts:689` → `summarize` | 1 |
| Library-overlap refusal | action `duplicatesChooseFolder` `main.ts:783` | `overlappingLibraries` `core/duplicates.ts:21` | 1 |
| Thumbnail cache LRU | — | `pruneThumbnails` / `pruneSometimes` `thumbnails.ts:44,60` | 1 |
| Scope list | every `emit` `main.ts:174` | `duplicateScopes` `main.ts:664` | 1 |
| "Can scan/remove now" | — | main `busy()` `main.ts:135` + inline `state.review||state.busyReview||duplicateControl` `main.ts:681,716`; renderer `duplicatesBusy` `DuplicatesPage.tsx:204` | **2+** |
| Scan button | — | page `DuplicatesPage.tsx:268` and titlebar `RootApp.tsx:590` (same action) | 2 entries, 1 impl |

## 2. Smells, ranked

**S1. `dup.earlier` (a library-sized path list) is re-sent on every state emit.** Evidence: `placedByEarlierJournals` adds every destination of every live organization journal (`core/recovery.ts:944`), so it can be the whole library. It is stored as `DuplicatesState.earlier: string[]` (`shared.ts:46`), and `emit` copies it into `state.duplicates` each time (`main.ts:174`). The state channel only deduplicates inventories and the review (`state-channel.ts:5,25-29`), so the array crosses IPC up to 10×/s while any progress runs (`main.ts:176`), including during imports that have nothing to do with duplicates. Cost: tens of thousands of strings serialized per emit, plus a structured clone on the renderer side. Fix (merge): mark the members once at scan time, `DuplicateFile.earlier?: true`, set only for group members (`earlier ∩ group files`) in `scanDuplicatesAction`. Groups already travel once per revision through `importer:duplicates`. Delete `DuplicatesState.earlier`, and make `summarize(resolved)` count `file.earlier`. `applyRemoval`'s filtering (`main.ts:701`) goes away because removed files leave the groups. Risk: low. `summarize`'s signature changes (tests in `duplicates-ui.test.ts`); the warning text is unchanged.  Note: the uncommitted `state-channel.ts` change in this worktree (reference-deduped `details`) could also carry `earlier` by reference. That is a cheaper stopgap, but the per-member flag still removes the field.

**S2. The group view reads full EXIF eagerly, and `inspect` ships a preview no one renders.** Evidence: (a) the scan already has each file's EXIF fingerprint from the routing read (`main.ts:687`, `core/duplicates.ts:165-167`). `useFileDetails` then calls `importer.exif` (a full `RequestAll=3` exiftool read, `metadata.ts:436`) for every file on the page (`DuplicatesPage.tsx:181`), although "Full EXIF" is a collapsed `<details>` (`:86`). `basicExif` needs the full read only for exposure and focal length (`:57-62`); camera, lens, date, size and dimensions are already in `file.exif` (`shared.ts:35`). (b) `importer:inspect` calls `metadata(file)` with the preview on (`main.ts:976`), which extracts an embedded JPEG of up to 20 MB as base64 (`metadata.ts:266-287,439`). No renderer code reads `Metadata.preview`: the inspector `RootApp.tsx:1790-1830` has no `<img>`, and the only `<img>` in `RootApp.tsx` is the app icon at `:371`. Cost: one heavy exiftool read per visible file per page, and a multi-MB IPC payload per inspected RAW. Fix (delete + merge): delete `preview()` and the `preview` option from `metadata()`. Then `inspect` and `exif` are identical, so delete `importer:exif`, `DesktopAPI.exif` and `preload.ts:17`. In `FullExif`, fetch on the `<details>` `toggle` event. Build the basic rows from `file.exif`, and add `focalLength` to `DuplicateExif` if it is still wanted. Risk: low. The requirement at `user-requirements.md:339` asks to remove the preview photo option, which supports the deletion. The `PreviewStatus` field (`metadata.ts:440`) goes too.

**S3. Two embedded-preview extractors.** `preview` (`metadata.ts:266`, order PreviewImage→JpgFromRaw→ThumbnailImage) and `embeddedPreview` (`metadata.ts:290`, JpgFromRaw→PreviewImage→OtherImage→ThumbnailImage) do the same job with different tag orders. Fix: deleting `preview` (S2) leaves one. Risk: none beyond S2.

**S4. Three copies of the two-step confirm sheet, and two copies of the Undo/Release row.** Evidence: `DuplicatesConfirm` (`DuplicatesPage.tsx:124-138`), `DeleteRecoveryConfirm` (`RootApp.tsx:981-997`) and `OriginalsConfirm` (`RootApp.tsx:1387-1405`) repeat the same lines: ref, `useAnimatedClose`, `showSheet` + second-step autofocus effect, `onCancel` guard, and a footer with Cancel autofocused on step 2. `RemovedDuplicates` (`DuplicatesPage.tsx:140-159`) repeats `RetainedOriginals` (`RootApp.tsx:929-955`): the retained note, Undo, Release and `ReleaseConfirm`. Fix (merge): one `TwoStepConfirm({step,testId,title,body,confirmLabel,disabled,onCancel,onConfirm})` that owns the shell; the three callers keep only their texts. `RemovedDuplicates` maps jobs to `<RetainedOriginals job …/>` with an Undo-label prop. Risk: low. Test ids must be kept, and the duplicates job has no "Delete recovery files" button today, so `RetainedOriginals` needs to hide it or show it consistently. That is a product choice; it is consistent with the doc at `remove-duplicates.md:55`.

**S5. Write-only machinery in `DuplicateStore` and `scanDuplicates` (speculative seams).** Evidence: `restore()` (`core/duplicates.ts:75`), `ScanOptions.mode:'recorded'` (`:130,177,190-192`), `ScanOptions.folders` (`:124,195-196`), `complete` and `updated` (`:37-38,51,197,226`) are never used or read by production code. `main.ts:687` passes neither `mode` nor `folders`, and nothing calls `restore`. `store.groups` is written by the scan and by `recordPlanDuplicates` (`:195,219-224`) but read only in tests (`duplicates-detection.test.ts:167`). The only stored data the app consumes is the per-file record: EXIF, `read` and `sha256`, reused by the stage 2 scan (`:162-163,181`). Cost: about 40 lines, an extra on-disk field, and a group-merge loop at `:219-224` that is O(groups×members×stored) on every import. Fix (delete): drop `restore`, `mode`, `folders`, `complete`, `updated` and stored `groups`. Reduce `recordPlanDuplicates` to "store the file records". Bump the record version, or keep 2 and ignore the extra keys. Risk: low, and removal re-verifies anyway. The doc promises sub-folder scope (`remove-duplicates.md:46`) and showing groups on page open (`:42`); either wire them up or remove them from the doc. Overlap: the records-v5 session is changing stores, so coordinate the on-disk format there.

**S6. The removal finally-block flickers and keeps a dead condition.** Evidence: `main.ts:739` sets `dup.status='idle'` and emits. Then `:744` checks `dup.status==='idle'`, which is always true (the only async step in between is `refreshOrganizations`, and `duplicatesStale` acts only on `'ready'` at `:706`). Only then does it set `'ready'` and emit again. Between the two emits the page hides the group list (`DuplicatesPage.tsx:277`). `:741-742` are two contradictory comments. `applyRemoval` (`main.ts:699`) recomputes `gone` and `removed` from the report that `afterRemoval` (`duplicate-removal.ts:130`) has just filtered. Fix: decide the next status before the single emit; let `afterRemoval` return the removed set; delete the stale comment. Risk: low.

**S7. The busy predicate is duplicated across layers.** Evidence: main's guards are `busy()` (`main.ts:135`, which already includes `duplicateControl`) plus a redundant `||duplicateControl` and the review checks at `:681,716`. The renderer re-derives the same rule in `duplicatesBusy` (`DuplicatesPage.tsx:204-207`). Fix: one `canStartDuplicates()` in main, published as `DuplicatesState.blocked:boolean`; the renderer reads it, and the title-bar button (`RootApp.tsx:590`) and page button use it. Risk: low. Overlaps with other per-feature reports, which will likely find the same pattern for imports and organizations.

**S8. Renderer layering cycle.** `RootApp.tsx:26` imports `DuplicatesPage`, and `DuplicatesPage.tsx:8` imports 10 primitives back from `RootApp` (`Button`, `CardHeader`, `showSheet`, `useAnimatedClose`, `ReleaseConfirm`, `OperationProgress`, …). Shared UI primitives live in the 1891-line app root. Fix: move them to `renderer/ui.tsx` (or similar) and import them from both files. Risk: none at runtime; this is a mechanical move.

**S9. The scope list is recomputed and re-sent on every emit.** `emit` rebuilds `scopes` with `duplicateScopes()` (`main.ts:174,664-669`) on every progress tick. The compute is cheap, but it allocates a new object each time, and the scopes change only with preferences or `chosenScopes`. Fix: recompute it in the preferences handler and in `duplicatesChooseFolder` (cache it). Risk: low. Lower value than S1.

**S10. Small things.** `DuplicatesState.groups` is set in main (`main.ts:690,702`) but never read in the renderer, which uses the fetched `groups.length` (`DuplicatesPage.tsx:279`), so delete the field. `Spec.groups` (`exif-categories.ts:31`) and the `Formatter` second argument (`:9`, passed at `:103`) are unused. `removalPlan` (`DuplicatesPage.tsx:28-31`) is a 2-line pass-through that only tests use; it is shallow and could be inlined. The groups effect fetches even when `status!=='ready'` (`DuplicatesPage.tsx:223-233`; the main side returns `[]` after a scope switch, `main.ts:782`), so gate it on `ready`. Thumbnails cross IPC as base64 data URLs (`thumbnails.ts:61`); a `file://`-style custom protocol for the cache would avoid the base64 cost, but that is a design change and optional.

Not a smell: `resolveGroups` and `summarize` run in both the renderer (preview) and main (authoritative). They are one pure module with two callers. The re-hash at removal and the journal are data-safety work, not redundancy.

## 3. Requirements check

| Requirement | Status | Evidence |
|---|---|---|
| A006-07: remove duplicates without wrongly deleting (`user-requirements.md:289`) | Implemented | Stash into the recovery journal (`duplicate-removal.ts:119`); re-hash and stat checks (`:82-89`); never removes a kept or linked file (`:84-85`); Release is separate (`DuplicatesPage.tsx:153`) |
| SAFE-07: name duplicates vs content duplicates (`:168`) | Implemented | Strengths `sha` / `exif` / `exif-size` / `similar` (name+time) `duplicate-rules.ts:69-100`, labelled `DuplicatesPage.tsx:38-40` |
| SAFE-08: same name, different content → keep both in a camera subfolder (`:169`) | Implemented elsewhere (import) | `Conflicts/<content id>` `core/index.ts:88-95`. Duplicates never auto-removes `similar`/`exif-size` (`duplicate-rules.ts:106-108`) |
| META-07 / detailed EXIF, full collapsed, no video shutter count (`:111,341`) | Partial | Collapsed curated view `DuplicatesPage.tsx:83-93`. `categorize` gets no media kind, so a video's `ShutterCount` would show (`exif-categories.ts:66,85-111`). There are two different full views (S2/S4 table row) |
| Remove the preview photo option (`:339`) | Partial / unclear | The inspector does not render the preview, but main still computes it (S2). Inline duplicate thumbnails are required by `remove-duplicates.md:10,48` |
| Doc A stage 1 during planning | Implemented | `main.ts:526` (`duplicates:!backup&&!reorganize`), `main.ts:588` |
| Doc A stage 2 "during full verification hashing" (`remove-duplicates.md:19`) | Changed | Runs only from the page (`:73`; `main.ts:620-622`); `:19` is stale |
| Doc index format `version:1` (`:37`) | Doc drift | Code uses `version:2` (`core/duplicates.ts:48,65`) |
| Doc: page shows recorded groups / incremental (`:42`) | Partial | Records make the rescan incremental (`core/duplicates.ts:163`), but stored groups are never shown (S5) |
| Doc B1 sub-folder scope (`:46`) | Missing in UI | `ScanOptions.folders` is not wired (`main.ts:687`) |
| Doc B2 levels, B3 badges/basic/full | Implemented | `duplicate-rules.ts:106`; `DuplicatesPage.tsx:44-66,83-93` |
| Doc B4 confirm with summary | Implemented (two-step) | `DuplicatesPage.tsx:124-138,247-251` |
| Doc B5 `kept:{digest,size}`, missing keeper stops | Implemented | `duplicate-removal.ts:72,91` |
| Doc B6 Undo/Release on the page and in Organization recovery | Implemented (twice, S4) | `DuplicatesPage.tsx:140`; `RootApp.tsx:929` |
| Doc B7 companions follow / carry / stay | Implemented | `duplicate-removal.ts:95-112`, `afterRemoval` `:129-138` |
| Doc B8 report + history | Implemented | `main.ts:733-736` |
| Staleness after jobs and undo (`:74`) | Implemented | `main.ts:337,306,705-711` |
| Overlap refusal and app folders skipped (`:75`) | Implemented | `main.ts:783`, `core/duplicates.ts:18,152` |
| Earlier-organization warning (`:55,77`) | Implemented (costly, S1) | `main.ts:689`, `DuplicatesPage.tsx:130,288` |
| After a clean removal, groups updated in memory (`:78`) | Implemented (flicker, S6) | `main.ts:697-703,744` |
| Thumbnail cache LRU 2 GB (`:80`) | Implemented | `thumbnails.ts:42-60` |
| Doc API names (`:59-65`) | Doc drift | `stageOneCandidates` and `planRemoval` do not exist; `buildGroups` is in `duplicate-rules.ts:77`; IPC list omits `importer:duplicates` and `importer:exif` |

Overlap notes: S5 touches the store format (records-v5). Removal digests (`duplicate-removal.ts:62-66,101-103`) belong to the hashing/verify-once session. The progress `step` names in `confirmCandidates`/`scanDuplicates` belong to progress-everywhere.
