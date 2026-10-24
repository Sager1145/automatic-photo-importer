# Architecture review 4: organizing existing files and organization recovery

Scope: one-click organize, Organize backup, organize a folder in place, organize a folder source, review-first, the backup-folder check and placement memory, problem files, removing emptied folders, releasing duplicates, the recovery list, resume/recheck, undo, finalize, delete recovery files, pause/continue.
Read at `daaabd8`. Line numbers are for `desktop/main.ts` (no prefix) unless another file is named.
Out of scope, overlap only: hashing/verify-once and records-v5 (`core/recovery.ts` storage), and the progress-shape and ETA branches.

## 1. Interface table

| Capability | Entry (Action → main) | The one implementation | Notes |
|---|---|---|---|
| Organize a destination (or its chosen subfolders) | `organize` :824 | `queueOrganization` :468 → `pump` :330 → `run` :571 → `prepare` :501 → `plan(reorganize)` `core/index.ts:167` → `executeDestinations` `core/destinations.ts:10` → `executeReorganization` `core/index.ts:1013` → `beginOrganization` `core/recovery.ts:901` | Source = destination root, `sourceFolders` = `state.organizationFolders` |
| Organize backup folder | `organizeBackup` :844 → `queueBackupOrganization` :481 | same as above | Source = `backupLibrary()` :476 |
| Organize any folder in place | `organizeFolder` :828 → `organizeFolderInPlace` :635 | same | Refuses the video-root layout :640 |
| Organize a folder source instead of copying | `organizeSourceFolder` :836 → `organizeFolderInPlace` :635 | same | |
| Review first | `previewOrganization` :845 → `previewSource` :643 → `prepare`; `applyReview` :653 → `run` | **2 paths: the job is built in `applyReview` :656, not in `queueOrganization`** | See smell S2 |
| Choose / reset subfolders | `chooseOrganizationFolders` :801, `resetOrganizationFolders` :823 | `state.organizationFolders[root]` | Used only by `organize` and preview, not by Organize backup |
| Per-run options (remove empty folders, release duplicates) | `organizeOptions` :808 | `takeOrganizeOptions` :62 + `sourcePolicy` `run-policy.ts:20` | Single place |
| Problem-file collection | review switch → `previewOrganization{collectProblemFiles}` `RootApp.tsx:1872` | `plan` `collectProblems` `core/index.ts:433` | |
| Remove emptied source folders | (option) | **2: journaled `removeEmptySourceFolders` `core/recovery.ts:409,891` AND non-journaled `removeOrganizedFolders` `core/redundant-folders.ts:51` called at :599** | See smell S3 |
| Release duplicates after organizing | (option) | `beginOrganization` → `finalizeOrganization` `core/recovery.ts:911-913` | |
| Backup-folder check (off/ask/auto) | `preferences.autoOrganizeBackup` :873; Settings `RootApp.tsx:847` **and** `BackupCheck` `RootApp.tsx:1701` | `scheduleMisplacedCheck` :396 → `findMisplaced` `core/index.ts:180` (= `planOnce` with `misplacedOnly`) | One planner, good. Two UI controls for one setting | *(Retired 2026-10-23: off/ask/auto replaced by a manual Check folder layout button.)*
| Placement memory | (internal) | `platform/placement-memory.ts`; `placementOf` :375, `rememberPlaced` :382 | Used by the check only, not by organization (S5) |
| Recovery list | `refreshOrganization` :787, scope change :204, job end :306/:618/:739, continue :918 | `refreshOrganizations` :227 → `listOrganizations` :231 → `getOrganizationRecovery` `core/recovery.ts:1010` | **2 coalescers stacked** (S4) |
| Resume / recheck / full recheck | `resumeOrganization` :789 | `resumeOrganizationJob(kind='resume')` :283 → `resumeOrganization` `core/recovery.ts:951` | |
| Undo / finalize / delete recovery | :790-792 | `resumeOrganizationJob(kind)` → `undoOrganization` / `finalizeOrganization` / `deleteOrganizationRecovery` | One host function, good |
| Measure recovery size | `measureOrganizationRecovery` :793 | `measureOrganizationRecovery` `core/recovery.ts:1287` | |
| Pause / continue | `pause` :905, `continueOrganization` :914 | Queued job: `organizationQueue`. Started job: a full list refresh, then `resumeOrganizationJob`; with no journal yet, re-queue from `organizationRuns` | Not available for reviewed runs (S2) |

**Answer to "five entries, one path?"** `organize`, `organizeBackup`, `organizeFolder` and `organizeSourceFolder` all reach `queueOrganization` :468, then one planner and one executor. They differ only in `(root, prefs tweaks, sourceFolders, options)`. `previewOrganization` shares `prepare` and `run`, but it creates its job in a second place, `applyReview` :656, and that job carries different flags.

## 2. Smells, ranked

### S1 (bug). `idle()` is always false, so exiftool and the hasher threads are never released
- Evidence: `idle` at :344 contains `!recoveryRefresh`. `recoveryRefresh` has been a `deferredRefresh` object since `058592d` (:72), so `!recoveryRefresh` is always `false`. Before that commit it was `Promise|undefined`, and `adc83de` wrote `idle` against that type. TypeScript accepts the negated object.
- Cost: `releaseIfIdle` :345 never closes metadata or `terminateHasher`. The "nothing may touch a drive once the work is done, so macOS can eject it" contract (:340) is broken in every feature.
- Fix: replace `!recoveryRefresh` with `!recoveryRefresh.running`. Add a regression test that `releaseIfIdle` closes once idle.
- Risk: low. A listing that is only deferred (not running) does not hold the drive.

### S2. The reviewed organization job is built outside `queueOrganization` and is missing the organization flags
- Evidence: `applyReview` :656 builds `Job` without `organization:true` and without `folders`, and never writes `organizationRuns`. It does add `organizationJobIds`.
  - Consequences: `pause` :908 treats it as an import job, so "Pause all" pauses it and the detail reads `job.paused`.
  - `continueOrganization` :916 requires `job.organization`, so a paused reviewed run cannot be continued from its card. Only the recovery list can resume it.
  - The renderer's organization cards (`RootApp.tsx:1054`, `:742`) and `organizeBusy` (`RootApp.tsx:575`) do not see it, and neither does `assertOrganizationIdle` :463.
  - Skip/retry are unavailable: the check at :616 needs `organizationRuns`.
- Cost: two places that create an organization job. The review-first path (a requirement in its own right) gets weaker UI and pause semantics than one-click.
- Fix: one job factory. `organizationJob(root, name, request)` used by both `queueOrganization` and `applyReview` (when `kind==='reorganize'`), setting `organization`, `folders` and `organizationRuns`. Alternatively, let `applyReview` call `queueOrganization` with the prepared plan.
- Risk: low to medium. `pump` gating via `organizationJobIds` is already shared.

### S3. Two implementations of "remove emptied source folders"
- Evidence:
  - Journaled: `removeEmptySourceFolders` `core/recovery.ts:409` runs inside `run` (:891) unless `keepFolders`. It removes only reviewed parents, checks identity, and uses non-recursive `rmdir`.
  - Not journaled: after a clean run, :597-600 calls `removeOrganizedFolders` `core/redundant-folders.ts:51`. It sweeps `.DS_Store`/`._`/`Thumbs.db` and removes nested folders.
  - Both are driven by the same option (`keepSourceFolders:!policy.removeEmptySourceFolders` :580).
  - On macOS almost every folder has a `.DS_Store`, so the journaled `rmdir` usually hits `ENOTEMPTY` (:415) and the second sweep does the real work. That work is outside the journal, not resumable, and not re-run by Resume.
- Cost: about 60 lines plus a second safety model. Folder cleanup does not happen after a resume or recheck, only after a fresh clean run.
- Fix: give the journaled remover the service-file rule (`serviceFile`, `redundant-folders.ts:9`). Extend `emptiable` to chosen `sourceFolders` that are now empty. Delete `removeOrganizedFolders`, `removeRedundantFolders` (check `index.ts:15` exports and tests) and :597-600.
- Risk: medium. The journaled version must keep "never remove a folder holding user files or recovery data" (`redundant-folders.ts:29`). Port those tests.

### S4. The recovery list is re-read too often and in full; two coalescers stacked
- Evidence: every trigger re-lists **every** root on both destinations. For each root, `listOrganizations` runs `journalWeight` (readdir+lstat) at :251, `volumeInfo` at :258, and `getOrganizationRecovery(includeEnded)` at :262, which reads manifests and events.
  - Triggers: a scope change :204 (note that `listOrganizations` itself pushes onto `organizationLocations` :264, which changes the scope and causes one more full listing on the next `refresh()`); the end of every organization run :618; the end of every resume/undo/finalize/delete :306; the end of every duplicate removal :739; `continueOrganization` :918, which re-lists all roots just to find one journal under `paused.source.path`; the Refresh button :787.
  - Two concurrency guards wrap the same listing: `deferredRefresh` (`deferred-refresh.ts:4`, defers while planning) and `organizationListing`/`organizationListingAgain` :226-229.
  - The direct callers (:306, :739, :787, :918) bypass `deferredRefresh`, which defeats its purpose: the listing should not run beside a planner (:69).
- Cost: on a USB drive with a legacy journal, a listing can take minutes (:236). After a one-root job it is repeated for every root, and the list shows "loading" each time.
- Fix:
  - (a) `refreshOrganizations(roots?)`: `byRoot` :238 already replaces results per folder. After a job, list only the touched root (`touchedLibraries`/`root`). For `continueOrganization`, list only the roots within `paused.source.path`, or record the journal id on the job when `beginOrganization` creates it.
  - (b) Keep a single guard: move the "again" flag into `deferredRefresh` and route every caller through `recoveryRefresh`. Delete `organizationListing`/`organizationListingAgain`.
  - (c) Exclude `organizationLocations` growth from `recoveryScope` :204, since the listing that added the location already read it.
- Risk: low. A per-root refresh still drops roots that are no longer listed (:269), but only on a full listing.

### S5. Auto/ask backup organization reads the backup folder's metadata twice
- Evidence:
  - The check reads metadata for every file not in placement memory (:410), then discards the file list and keeps only `count`/`bytes` :412.
  - "Organize backup", or `auto` (:413), then re-plans from scratch through `prepare` :501 → `plan`, without `inPlace`. `inPlace` only takes effect when `misplacedOnly` is set (`core/index.ts:253`).
- Cost: a full second metadata pass over a large backup folder right after the check; the placement cache exists but organization never uses it.
- Fix: in `prepare`, pass `inPlace` from `loadPlacement` when the request is a backup organization (`placementOf`). In `planOnce`, let `inPlace` skip files that are already in place for `reorganize` as well as for `misplacedOnly`.
- Risk: medium. A stale memory key (size+mtime+ino with the scope hash) would leave a file unmoved, exactly as the check already accepts. The hashing session owns the "read once" rules: coordinate.

### S6. `OrganizationProgress` is a second progress shape, converted twice
- Evidence:
  - `OrganizationProgress` `core/recovery.ts:1071` is a 4-field subset of `Progress`.
  - `resumeOrganization` already emits `Progress`, while finalize, undo and delete emit `OrganizationProgress`.
  - The same step→phase mapping is written twice, in main `stepProgress` :300 and in `core/recovery.ts:912`. Both hard-code `bytes:0,speed:0`, so finalize and undo cannot show speed or ETA.
- Fix: have `finalize`/`undo`/`delete` emit `Progress` directly, and delete `OrganizationProgress` plus both mappings. The phase-specific `job.detail` text stays in main.
- Risk: low. This overlaps `claude/progress-everywhere` and `claude/speed-accuracy`: land it there, not separately.

### S7. Single-destination organization goes through a multi-destination adapter
- Evidence: `executeDestinations` `core/destinations.ts:44-62` has an `if(reorganize)` branch that loops over `plans` (always one; `snapshotPreferences` :492, and `planOnce` throws on more than one, `core/index.ts:194`) and re-sums fields from `ReorganizationResult`. This is a shallow pass-through: the deletion test passes.
- Fix: have `run` call `executeReorganization` for `destinationParts(plans[0])` directly, keeping `validate`, or move that branch into a `executeOrganization` in `core/index.ts`. Low value, so do it only if S2 touches `run`.
- Risk: low.

### S8. UI duplicates
- "Review changes…" and "Organize now" exist both in the title bar (`RootApp.tsx:586`) and in the page card (`RootApp.tsx:1722`), with different disabled predicates (`pageBusy` vs `busy`).
- The backup-check mode control exists both in Settings (`RootApp.tsx:847`) and in `BackupCheck` (`RootApp.tsx:1701`).
- Fix: keep one of each. The page card owns organize; Settings links to the page.
- Risk: low (QA selectors `titlebar-organize`).

### Minor
- Organize backup has no review and ignores the chosen subfolders: `organizeBackup` has no preview counterpart, while `previewOrganization` always previews the destination root (:845). If review-first is meant to cover the backup folder, `previewOrganization` needs a `scope:'backup'|'library'` parameter. That would also let `organize`/`organizeBackup` merge into one action with a scope.
- `placementOf` :375 builds a fake one-destination `Preferences` only to call `backupLibrary`. Folding it into `backupLibrary(prefs,index)` removes a clone.

## 3. Requirements check

| Req | Status | Evidence |
|---|---|---|
| ORG-06 in-app organize button | Implemented | `RootApp.tsx:1722`, `:586`; `organize` :824 |
| ORG-07 rule changes applied to existing files | Implemented | `plan(reorganize)` uses the current `template`/`layout`/`videoTemplate` (:524); the placement scope hashes them (`placement-memory.ts:20`) |
| ORG-08 fix camera-folder names | Implemented (planner) | `folder()` `core/index.ts:59` decides the target. Moves are journaled (`core/recovery.ts:728`) |
| ORG-09 merge overlapping folders | Implemented | `allocate`/`existingMatches` `core/index.ts:99-126` (an identical file already there is kept, with a retained copy), `supersedePriorOrganizations` `core/recovery.ts:599` |
| ORG-10 remove obsolete folders, never prematurely | Implemented, split (S3) | Journaled remover `core/recovery.ts:409`; second sweep only after a clean run :597; user files kept `redundant-folders.ts:29` |
| ORG-11 redundancy until checked | Implemented | Checksums are required before execution (`core/index.ts:1018`); originals are retained until Finalize; release re-verifies (`core/recovery.ts:910`) |
| ORG-12 recoverable after power loss | Implemented | Journal and manifest are synced before any move (`core/recovery.ts:906-908`); Resume/Recheck in the list (`RootApp.tsx:1728`) |
| ORG-13 feature built and tested before A006 use | Implemented (code); not verifiable here | Tests in `desktop/tests/` (not re-run; read-only task) |
| ORG-14 A006 2024/2025/2026 → photobackup | Capability present | `chooseOrganizationFolders` :801 + `organize` :826 with `sourceFolders`. Whether it was run is operational |
| ORG-20 via the real app, one click | Capability present | Same as ORG-14. No external command path exists |
| SAFE-01 no loss | Implemented, with gaps | Journaled moves; S3's sweep is outside the journal (it removes only service files) |
| SAFE-02 redundant copy until verified | Implemented | As ORG-11; `releaseDuplicates` (default on, `run-policy.ts:5`) releases only after re-verification |
| SAFE-03 drive removal | Implemented | `validateDestination` identity :290; `rootUnchanged` `core/index.ts:1023`; the list skips a changed volume :259; checks abort on unmount :364 |
| SAFE-04 interruption, recheck/resume | Implemented | `resumeOrganization` `core/recovery.ts:951`; pause → journal :306. Missing for reviewed runs' cards (S2) |
| SAFE-05 half-copied files continued | Implemented | `preserveIncomplete` `core/recovery.ts:363` (an owned partial is verified as a prefix, then preserved), `exclusivePublication` :354 |
| SAFE-06 "overwrite" only an owned partial | Implemented | Ownership by dev/ino in `state.exclusive` (`core/recovery.ts:365`); a non-owned or larger file is refused |
| SAFE-11 keep recovery copies on request | Partial | Originals stay until an explicit Finalize/Delete (`RootApp.tsx:948-952`). The release-duplicates switch defaults **on** each run (`run-policy.ts:5`, :62), so retained duplicate copies are released unless the user turns it off per run |
| A006-05 keep recovery copies | Partial | Same as SAFE-11 |
| A006-10/13 one-click in the app | Capability present | As ORG-14/20 |
| A006-17 scoped deletion | Implemented | Organization never deletes content outside the journal; folder sweeps keep user files |

## Summary
One execution path: four entries reach `queueOrganization`, but review-first builds its own job without `organization:true`, so pause, continue and its cards break (S2). Folder cleanup has two removers, and the non-journaled one does the real work (S3).
Bug: `idle()` tests `!recoveryRefresh`, an object, so drives and helpers are never released (S1, :344; regression from `058592d`).
Performance: the recovery list re-reads every root after every job, behind two stacked guards (S4); auto backup organization reads metadata twice because organization ignores placement memory (S5); `OrganizationProgress` is a redundant second shape (S6, overlaps the progress branch).
