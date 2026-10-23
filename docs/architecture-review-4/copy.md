# Architecture review 4: copy execution, integrity and drive-to-drive backup

This is a read-only analysis of the worktree at `daaabd8`. All paths are relative to `desktop/`. "2+" marks a capability with more than one implementation. Data-safety redundancy (receipts, stage→verify→publish, re-verify before deleting originals, `Removed by mirror` holding) is required and is not counted as a smell. Hash-count reduction is skipped because another session owns it. Progress and ETA shapes are also skipped, owned by `claude/progress-everywhere` and `claude/speed-accuracy`.

## 1. Interface table

| Capability | Entry | Implementation |
|---|---|---|
| Start / queue | `action('start')` main.ts:879 → `enqueue` main.ts:322 | `enqueue` + `pump` main.ts:330 |
| Queue order / move to top | `moveToTop` main.ts:925 | `queue-order.ts:17` `queueOrder`, `:30` `nextRunnable`. `nextQueued` `:24` is used only by tests |
| 1–N parallel, per-device limit | `pump` main.ts:330-333 | `deviceHasRoom` core/devices.ts:141 on `STREAMS` devices.ts:11 |
| Per-file stream slots | every read/copy | `DeviceStreams.run` devices.ts:95 (one implementation) |
| Stop | `action('stop')` main.ts:940 | AbortController per job, held in `active` |
| Pause | `action('pause')` main.ts:905 | `pausing` set, then the catch branch in `run` main.ts:614 **and** in `resumeOrganizationJob` main.ts:306 (**2+**) |
| Retry | `retryJob` main.ts:885 | re-`enqueue`, or `queueOrganization` |
| Skip / Skip all | `skipFile`/`skipAndContinue` main.ts:893 | `skipRequests` map → `pump` main.ts:336 |
| Run one job | `run` main.ts:539 | one function serving both direct imports and applied reviews |
| Job start/finish bookkeeping | pump main.ts:335-337, applyReview :656-658, resumeOrganizationJob :296/:306-308, removeDuplicatesAction :724/:739-747 | **2+ (4 hand-written copies)** |
| Multi-destination execute | `executeDestinations` core/destinations.ts:10 | copy branch → `executeMany` core/index.ts:855; `reorganize` flag branch → `executeReorganization` index.ts:1013 (two functions behind one boolean) |
| Single-destination execute | `execute` index.ts:839 | wrapper over `executeMany`, used only by tests (one adapter = hypothetical seam) |
| Stage (one read → N destinations) | `stageMany` index.ts:658 | one implementation |
| Verify staged file | `check` index.ts:918 | one implementation |
| Publish (hard link or exclusive copy) | `publish` index.ts:770 | link at :779, copy fallback at :796. `exclusiveCopy` :754 is set only by tests |
| Stage cleanup | `cleanStage` index.ts:721 | per family :981, bulk on Stop :1002 |
| Half-written resume, receipts | `findPartial`/`openPartial`/`recordPartial`/`recordCreation`/`releaseCreations`/`clearPartialRecord` core/import-recovery.ts:87-177 | one implementation |
| exFAT identity | `settle`/`rebindStage`/`rebound` index.ts:626-648, `unreliableIno`/`sameBirth` paths.ts:147-159, `binds` import-recovery.ts:44, `cleanStage` "temporary" index.ts:729 | spread over 4 sites (see S5) |
| Capture-date timestamps | `applyFileTimestamps` platform/file-timestamps.ts:30 | called at index.ts:699 (stage) and :817 (copy-publish) |
| AppleDouble cleanup | `AppleDoubleCleaner` core/appledouble.ts:106 | one implementation; report summary written twice (S4) |
| Residue find / clean | `scheduleResidueCheck`/`checkResidue` main.ts:434/443, `cleanResidue` action main.ts:788 | `findResidue`/`cleanResidue` core/residue.ts:143/177; file-name patterns duplicated (S3) |
| Delete originals | `deleteOriginals` action main.ts:822 → `removeOriginals` main.ts:752 | `deleteOriginals` core/originals.ts:41. The verified list is built in main.ts:607-611 (S6) |
| Drive backup additive/mirror | `prepare` main.ts:506-509, plan `backup` | `driveFolder`/`claimDriveFolder`/`mirrorChanges`/`moveMirrorRemovals` core/drive-backup.ts:35-117; legacy `.mirror-removed`/hidden marker are migrated at drive-backup.ts:27,98-99 |
| Operation reports | `operation-reports/<job>/*.json` | **2+**: `saveReport` main.ts:542, inline loop main.ts:733, inline main.ts:769-770, `acknowledgeSummary` acknowledge.ts:34 (temp + rename, no fsync) |
| Keep-awake | `emit` → `awake(state.jobs)` main.ts:174 | `keepAwake` keep-awake.ts:7, with its own phase set at :5 (S2) |
| Release helpers when idle | `releaseIfIdle` main.ts:345 | the `idle()` predicate main.ts:344 (S2) |
| Bounded pool | — | **2+**: `pool` index.ts:36 and `mapPool` devices.ts:124 do the same thing. `limiter` resource-limits.ts:124 is a different thing (a shared gate whose cap can change) and stays |
| Atomic JSON write | — | **2+, 11 copies** (S7) |
| Directory fsync | — | **2+**: paths.ts:32 is strict, main.ts:178 is lenient |

## 2. Smells, ranked

### S1. Job finish bookkeeping is copied four times and the copies have drifted (correctness)

**Evidence.** The same tail appears four times: `active.delete; organizationJobIds.delete; reservations.delete; emit(); pump(); if(!active.size&&!queued) scheduleAutomaticChecks(); releaseIfIdle()`. It is at main.ts:337, :658, :306-308 and :739-747. The start side is copied four times too: `unshift`, new AbortController, `cancelAutomaticChecks`, `active.set`, `organizationJobIds.add`. It is at :335, :656, :296 and :724.

**How they drifted.**
- `run` records `touchedLibraries` for every job (main.ts:576). Only pump's tail consumes it (`duplicatesStale(touchedLibraries.get…)`, :337). So an import started from **Review → Apply** (:658) leaves a stale Duplicates scan "ready" over a library it just changed, and it leaks the map entry.
- The duplicates tail (:739-747) never deletes `reservations` and never calls `scheduleAutomaticChecks`.
- The pump tail sets `organizeAfterImport` (:337). The applyReview tail does not, so an applied review never triggers the follow-up backup organization.

**Cost.** Each new kind of job copies the tail again. Two user-visible gaps already exist: a stale duplicate groups list after a reviewed import, and no automatic organize after it.

**Fix.** Add `startJob(job, {organization})` and `finishJob(job, {retryable, organization})` in main.ts. Both own every set and map named above, and the four call sites shrink to one line each. Do not merge the per-kind result text.

**Risk.** Low, provided the existing per-kind differences are kept as explicit flags. `retryable` is not set for a reorganize run from applyReview (:658).

### S2. "Is something running?" is answered in about nine places, and keep-awake and helper release give the wrong answer

**Evidence.**
- `busy()` main.ts:136.
- `idle()` :344.
- `residueIdle` :433.
- `assertOrganizationIdle` :462.
- The pump guard :330.
- `busy()||state.review||state.busyReview` written out 10 times (:285, :294, :781, :802, :823, :876, :877, …).
- The active-phase list `['queued','discovering','verifying','copying']` at :323, :464, :755, :840, :890 and :901, plus keep-awake.ts:5 and a subset at :171.

**Bug 1, keep-awake.** Keep-awake looks only at job phases (keep-awake.ts:10), and `removeOriginals` leaves the job's phase at `complete`/`error` (main.ts:754-774). The same goes for review planning (`busyReview`), Duplicates scans and residue Clean up. The Mac can therefore sleep in the middle of a delete-originals re-hash or a long review.

**Bug 2, helper release (PLAUSIBLE).** `idle()` (:344) does not count `deletingOriginals`. If another job finishes while originals are being deleted, `releaseIfIdle` calls `terminateHasher()` (:348). That fails the in-flight hashes (hasher.ts:49-51: "Call only while no hash is running"). Those files are then kept with `error`. That is safe, but the errors are spurious.

**Fix.**
- Add an `originalsTask` counter to `idle()`.
- Drive keep-awake from `!idle()`: change `awake(state.jobs)` to `awake(!idle())` and reduce keep-awake.ts to a boolean latch.
- Add `const ACTIVE=new Set([...])` and `sourceBusy(id)`, and use them at the six phase-list sites.
- Add `uiBusy()=busy()||!!state.review||state.busyReview` for the 10 copies.

**Risk.** Low. Keep-awake would then also hold during idle-time automatic checks, which is wanted.

### S3. App-file name patterns are defined twice: by the code that creates the files and by residue detection (safety-relevant drift)

**Evidence.**
- Stage names are created at index.ts:615 and matched at import-recovery.ts:133 and residue.ts:19.
- Receipt names are created at import-recovery.ts:100 and matched at import-recovery.ts:64 and residue.ts:19.
- Index/duplicates temporary names are created at destination-index.ts:97 and duplicates.ts:62, and matched at residue.ts:20 and inventory.ts:25-26.
- Journal scratch names are matched at residue.ts:21 and created in recovery.ts.

**Cost.** Residue removes files by name, and inventory hides files by name. If a creator changes a name and one matcher is not updated, leftovers are either never cleaned or, worse, imported as media. Tests catch only the names they list (tests/visible-app-files.test.ts:106-108).

**Fix.** Create one `core/app-files.ts` that exports `stageName()`, `receiptName(kind)`, `indexTemp()` and the matching `RegExp`s. Creators and matchers both import from it. Delete the local regexes.

**Risk.** Low. The patterns are identical today, so nothing should behave differently.

### S4. Report writing is copied four times with four durability levels, and `run` is a report and text composer living in the Electron layer

**Evidence.**
- `saveReport` main.ts:542: `wx`, then fsync, no directory sync.
- Duplicates main.ts:733: the same code pasted inline.
- Originals main.ts:769-770: inline, with a timestamped name.
- `acknowledgeSummary` acknowledge.ts:38-41: pid temp + rename, no fsync.
- The `producer`/`finished` fields are hand-built at each site (:573, :574, :603, :614, :733, :770).
- `failure.json` is lost when the failure happens before :571, because `reportDirectory` is still unset (:542 returns early).
- Organization resume, finalize and undo (main.ts:298-305) write no report at all.

**Also.** `appleDoubleLine` (main.ts:595) re-implements `appleDoubleActivity` (appledouble.ts:95). That export is otherwise unused, which fails the deletion test in reverse: the helper exists and is bypassed.

**Fix.**
- Add a `core/reports.ts` module: `openReport(userData, jobId)` returns `{write(name,value), replace(name,value)}`. It stamps `producer` and the time, and syncs once. Use it at all four sites and for organization runs.
- Create the directory before `prepare`, so `failure.json` always exists.
- Use `appleDoubleActivity` in main.ts:595.

**Risk.** Low. The report schemas stay the same.

### S5. Six slightly different "same file" checks

**Evidence.**
- `sameStat` paths.ts:149 (strict, includes ctime).
- `samePlaced` index.ts:765 (no ctime).
- The inline copies of samePlaced at index.ts:785 and :984, and originals.ts:64.
- `statKey` paths.ts:161 and the separate `statKey` in platform/metadata.ts:342 (no birth-time fallback).
- `snapshot`/`sourceMatches` import-recovery.ts:39-40 (`JSON.stringify` equality, no exFAT fallback).
- `binds` import-recovery.ts:44.
- The `exact`/`temporary` pair in `cleanStage` index.ts:727-729.
- recovery.ts:78-79 `matches` (owned by the records-v5 session).

**Cost.** exFAT rules (synthetic inode, whole-second birth time) are applied at some of these sites and not others. For example, `sourceMatches` rejects a zero-byte exFAT source whose synthetic inode moved, so it cannot resume. A reader cannot tell which rule is intended where.

**Fix.**
- Export `samePlaced` from paths.ts and replace the three inline copies.
- Have `sourceMatches` compare through `statKey`.
- Leave `binds` and `cleanStage` as they are (receipt-specific), but document them beside `sameStat`.

**Risk.** Medium. Each replacement must keep its exact field set, so do them one at a time with the exFAT tests (tests/exfat-*.test.ts).

### S6. The verified-originals list is rebuilt in main with a quadratic join

**Evidence.**
- The `onVerified` callback (main.ts:581) fills `verified`.
- Main then rebuilds `destinationEntries` and, for each verified file, runs `entries.filter(entry=>entry.source===file)` (:608-609). That is O(V·E): about 2.5·10⁹ comparisons for a 50k-file import, run synchronously on the main process.
- The same callback also feeds `rememberImported` (:592).

**Cost.** The window freezes at the end of large folder imports. Domain data crosses the core→main seam twice.

**Fix.** At minimum, build `Map<source,entry[]>` once. Better: return the verified list from `executeDestinations`, since `executeMany` already holds entry and destination for each `onVerified` at index.ts:966/972. Main then only stores it.

**Risk.** Low.

### S7. Atomic and durable writes: 11 hand-written copies with three durability levels

**Evidence.**
- Temp + rename: main.ts:179 (fsync and dirsync, via its own lenient `syncDirectory` :178), main.ts:182, acknowledge.ts:38 (no fsync), eta-priors.ts:105 (no fsync), platform/scan-memory.ts:34 and :81, platform/placement-memory.ts:51, platform/listing-memory.ts:32, destination-index.ts:97, duplicates.ts:62, recovery.ts:491.
- Exclusive create (`wx`): main.ts:542/733/769, recovery.ts:82, drive-backup.ts:80, import-recovery.ts:100.

**Fix.** Put `writeJsonAtomic(file, value, {durable})` and `createJsonExclusive(file, value)` in core/paths.ts. main.ts:178 becomes `syncDirectory(...).catch(ignoreUnsupported)`. Caches keep `durable:false`; settings and media-side files use `durable:true`.

**Risk.** Low. Keep the caller-specific temp-name prefixes, because residue and inventory match them (S3).

### S8. Two bounded pools

**Evidence.** `pool` index.ts:36 is `mapPool` devices.ts:124 without the result array.

**Fix.**
- Delete `pool` and use `mapPool` at index.ts:901, :945 and :1002.
- Move `mapPool` out of devices.ts. A generic pool does not belong to a device-classification module; it could go to resource-limits.ts next to `limiter`.
- `limiter` (a shared gate with a cap that changes) and `DeviceStreams` (per-device slots) are different, and both stay.

**Risk.** None.

### S9. One-adapter seams and dead code

- `execute` index.ts:839, the `exclusiveCopy` option index.ts:754 and `nextQueued` queue-order.ts:24 are used only by tests.
  - `execute` and `exclusiveCopy` are legitimate test seams: they force the copy path a non-hard-link filesystem takes. Keep them, but mark them "@internal test".
  - Delete `nextQueued` and point its tests at `nextRunnable(…, ()=>true)`.
- `executeDestinations(…, {reorganize})` (destinations.ts:47-63) is two functions behind one flag. The reorganize branch shares only `validate` and `settled`. Splitting it into `executeOrganization` would make `run`'s branch explicit. This is optional and low value, because the call site is single.
- The legacy `.mirror-removed` folder and hidden drive marker migration (drive-backup.ts:10, 27-32, 98-99) are a deliberate data fallback. Keep them until a release note retires them.

### S10. Pause/stop/error classification is copied three times

**Evidence.** The same pause/stop/error classification is at main.ts:614, :306 and :738. The duplicates copy has no pause branch, although `pause` (:905) aborts duplicate jobs as well: an `organization:true` job whose source id matches.

**Fix.** Add `endedBy(job, error, signal)`. Fold it into `finishJob` (S1).

### Overlap with other sessions (not re-analyzed)

- `prefixMatches` (import-recovery.ts:108) re-reads the source prefix that `stageMany` reads and hashes again anyway (index.ts:664-690). That belongs to the hashing/verify-once session.
- Progress-object composition in `executeDestinations` (destinations.ts:29-45) and `executeMany` (index.ts:860-862) belongs to progress-everywhere.

## 3. Requirements check

| Req | Status | Evidence |
|---|---|---|
| COPY-01 Start/Stop | implemented | main.ts:879, :940 |
| COPY-02/03 Automatic | implemented | `state.preferences.automatic` → `enqueue(...,automatic)` main.ts:201; disabling it stops queued automatic jobs :872 |
| COPY-04 ≤5 concurrent | implemented, exceeds | default 5, but bounds 1–10 (preferences.ts:6, :43; RootApp.tsx:826 `max={10}`); per-device limit devices.ts:141 |
| COPY-05 Queue | implemented | `enqueue`/`pump` main.ts:322-339, queue-order.ts:17 |
| COPY-06/07 Slider on the heading row | implemented | RootApp.tsx:1070 (Sources & queue heading holds `parallel`) |
| COPY-08/09 Two destinations, redundant/sequential | implemented | `allocateDestinations(...,copyMode)` allocation.ts:31; one read for N destinations index.ts:658 |
| COPY-10/11 Drive backup, mirror/additive | implemented | main.ts:506-509; drive-backup.ts:35-117; mirror only from a review main.ts:559-561 |
| COPY-12 Additive never deletes | implemented | removals only when `drive.mirror` (index.ts:878-882); mirror moves to `Removed by mirror`, never deletes (drive-backup.ts:88-106) |
| COPY-13 Every file, folder structure kept | implemented | `relative=file.relative` index.ts:418; every file is its own family :323 |
| COPY-14 Copy, then validate | implemented | stage pool index.ts:901-908, then the verify/publish pass :912-995 |
| SAFE-01 No loss | implemented (by design) | stage→verify→publish index.ts:770-837; source never touched by an import (`retainedOriginals:true` main.ts:603) |
| SAFE-02 Keep a copy until verified | implemented | delete originals re-hashes source and every copy first (originals.ts:55-64) |
| SAFE-03 Drive removal | implemented | `rootUnchanged`/`makeParent(rootIdentity)` paths.ts:28, :85-121; per-destination `validate` destinations.ts:70; checks abort on unmount main.ts:363-370 |
| SAFE-04 Interrupt/power loss | implemented | durable receipts import-recovery.ts:95-106; residue keeps resumable copies residue.ts:186 |
| SAFE-05 Continue half-copied files | implemented | `findPartial` + resume at offset (import-recovery.ts:118, index.ts:612-617, :682) |
| SAFE-06 "Overwrite" stays scoped | implemented | resume only into an authenticated, inode-bound, prefix-checked own partial (import-recovery.ts:132-145); publish is `wx`/link only (index.ts:779, :804) |
| SAFE-07/08 Same name, different content | implemented | `existingMatches` index.ts:99; `<camera folder>/Conflicts/<hash>/` index.ts:91-96 |
| SAFE-09 Live-app inspection | n/a (process) | — |
| SAFE-10 Not just counts | implemented | re-hash at publish (index.ts:827-830) and before delete (originals.ts:55-57) |
| SAFE-11 Keep recovery copies | out of scope | belongs to organization/recovery; reports say `retainedOriginals:true` |
| SAFE-12 Capture date as Created/Modified | partial (intended) | `applyFileTimestamps` file-timestamps.ts:30-35; dates the destination cannot store fall back to the source's dates (:32-34); drive backups use source dates (index.ts:431 `captureTimeMs:undefined` when `backup`), which FMT-14 requires |
| FMT-14 Whole-drive scope | implemented | `inventory(...,{backup})` index.ts:238; no media filter when `backup` (:271, :291, :339, :355) |

Gaps tied to the requirements:
- SAFE-04 and SAFE-10 are weakened in practice by S2: the Mac can sleep during a delete-originals re-hash or a review, and the hasher can be stopped mid-hash.
- S1 means a reviewed import leaves a stale Duplicates scan.
