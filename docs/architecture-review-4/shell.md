# Architecture review 4 — app shell, settings, renderer↔main interface

Scope: `desktop/shared.ts`, `preload.ts`, `state-channel.ts`, `preferences.ts`, `settings-lock.ts`, `main.ts`
(emit/save/load/action/boot/allowed/trusted), `renderer/RootApp.tsx` (shell, title bar, sidebar, settings,
confirm sheets), `Boot.tsx`, `boot-controller.ts`, `BrandLogo.tsx`, `brand-geometry.ts`, `sidebar-fit.ts`, `styles.css`.
Line numbers are for the `architecture-review-4` worktree at `daaabd8`. Hashing and progress shapes are out
of scope (owned by other sessions); overlaps are only noted.

## 1. Interface table

The seam is real: one IPC adapter (`preload.ts:6-19`) and one in-process caller (`qa/codex-smoke.ts`, `qa/a006-hardware`
via `action` at `main.ts:983`), so `Action` is a genuine interface, not a hypothetical seam. Each method is guarded
by `trusted` (`main.ts:973`); file reads also go through `allowed` (`main.ts:187`).

### DesktopAPI (`shared.ts:98`)

| Method | IPC channel → handler | Implementation | Note |
|---|---|---|---|
| `state()` | `importer:state` `main.ts:974` | `stateChannel.snapshot` `state-channel.ts:32` | full reset snapshot |
| `subscribe()` | `importer:updated` push, `main.ts:141` | `stateChannel.publish` from `emit` `main.ts:174` | see smell S2 |
| `action()` | `importer:action` `main.ts:975` | `action()` switch `main.ts:776-951` | errors become `state.error` |
| `inspect(path)` | `importer:inspect` `main.ts:976` | `metadata(allowed(file))` (with preview) | **MERGE into `exif`**, S1 |
| `exif(path)` | `importer:exif` `main.ts:977` | `metadata(…,{preview:false})` | the survivor |
| `thumbnail(path)` | `importer:thumbnail` `main.ts:978` | `platform/thumbnails` behind `thumbnailSlots` | ok |
| `duplicateGroups()` | `importer:duplicates` `main.ts:980` | module variable `duplicateGroups` | pull model, ok |
| `errorPaths(jobId,code)` | `importer:errorPaths` `main.ts:979` | `issuePaths` (`job-issues.ts`) | pull model, ok |

### Action union (`shared.ts:97`, 50 types; every one has exactly one `case` and at least one sender, checked by grep)

| Action | `main.ts` case | Implementation | Merge? |
|---|---|---|---|
| `preview` | 779 | `previewSource` | — |
| `previewOrganization` | 845 | `previewSource` (library) | — |
| `applyReview` / `discardReview` | 846 / 847 | `applyReview` 655 / `discardReview` 633 | — |
| `start` | 879 | `enqueue`+`pump`; with an open review it calls `applyReview` | — |
| `stop` / `pause` | 940 / 905 | inline abort loops | different semantics, keep |
| `retryJob` | 885 | `enqueue` / `queueOrganization` | — |
| `skipFile` / `skipAndContinue` | 893–904 (shared case) | `enqueue` + `skipRequests` | **M1** → `{type:'skip';jobId;all?:true}`; `path` is only compared with `skippablePath` (896) |
| `continueOrganization` | 914 | `resumeOrganizationJob` / `queueOrganization` | — |
| `moveToTop` | 925 | `moveToFront` | — |
| `scanSource` / `scanSources` | 780 / 781 | `scanSource` 209 | **M2** → `{type:'scan';sourceId?}`; same guard, same error |
| `resumeOrganization` / `finalizeOrganization` / `undoOrganization` / `deleteOrganizationRecovery` | 789–792 | all `resumeOrganizationJob(root,id,kind)` | **M3** → `{type:'recovery';op:'resume'\|'finalize'\|'undo'\|'delete';root;id;full?}` (4→1) |
| `measureOrganizationRecovery` | 793 | `measureOrganizationRecovery` | keep (writes `recoverySize`) |
| `refreshOrganization` | 787 | `refreshOrganizations` 227 | — |
| `organize` / `organizeBackup` | 824 / 844 | `queueOrganization` / `queueBackupOrganization` 481 | different roots; organization reviewer decides |
| `organizeFolder` / `organizeSourceFolder` | 828 / 836 | both `organizeFolderInPlace` | **M4** → `{type:'organizeFolder';sourceId?}` (dialog when absent) |
| `organizeOptions` | 808 | mutates `state.organizeOptions` | — |
| `chooseOrganizationFolders` / `resetOrganizationFolders` | 801 / 823 | `state.organizationFolders[root]` | optional merge (`reset?:true`) |
| `measureOriginals` / `deleteOriginals` | 815 / 822 | `core/originals` | — |
| `cleanResidue` | 788 | `checkResidue(true)` | — |
| `duplicatesScope` / `ChooseFolder` / `Scan` / `Stop` / `Remove` | 782–786 | duplicates module | owned by duplicates review |
| `preferences` | 863 | `acceptedPreferences`→`normalizePreferences`→`save` | see S4 |
| `chooseDestination` / `removeDestination` | 876 / 877 | dialog / splice + `save` + `refresh` | — |
| `chooseSource` | 878 | dialog, `folders` map | — |
| `selectSource` / `forgetDevice` / `dismissReconnected` | 931 / 936 / 930 | `DeviceSelection` | — |
| `unknownRule` | 941 | `sessionRules` / prefs | — |
| `reveal` | 942 | `allowed` + `shell.showItemInFolder` | — |
| `refresh` | 862 | `refresh` 188 | — |
| `window` | 848 | `BrowserWindow` min/max/close | non-mac only (`RootApp.tsx:385`) |
| `clearError` / `clearErrorIds` / `clearErrors` | 849 / 860 / 861 | `error-log` `clearErrors`/`clearErrorIds` | **M5** → `{type:'clearErrors';ids?;severity?}`; `clearError` without `id` (app error) becomes `ids:['app']` (3→1, error-panel review owns the call sites) |
| `acknowledgeErrors` | 850 | `acknowledgeJob` | — |

Merges M1–M5 take the union from 50 to 41 types without losing any capability; each is a rename at 1–3 call sites
plus test updates (`qa/codex-smoke.ts` sends `resumeOrganization`, `clearError`, `scanSource`).

## 2. Smells, ranked

**S1. `inspect` moves a full-size preview the renderer never shows (high cost, delete).**
`inspect` calls `metadata()` with the preview on (`main.ts:976`); `platform/metadata.ts:270-272` reads a JPEG/PNG of up
to 20 MB (`previewLimit`, :262) and base64-encodes it into a `data:` URL (about 27 MB string), or runs the embedded-preview
extractor for RAW/HEIF (:274-286). That string crosses IPC and the context bridge, but `MetadataDialog`
(`RootApp.tsx:1789-1833`) never reads `metadata.preview` (no match for `.preview`/`<img` in the dialog). UI-32 removed
the preview picture, and this is what is left of it. Fix: delete `inspect` from `DesktopAPI`, `preload.ts:14` and `main.ts:976`;
`RootApp.tsx:361` calls `exif(path)`. Also delete the `PreviewStatus` field written at `metadata.ts:440` if nothing
else reads it. Risk: low. Check that no test asserts `preview` from `inspect`.

**S2. Every emit republishes all of AppState except inventories and `review` (medium, a small change in one module).**
`state-channel.ts:26-30` deduplicates only `Inventory` (by WeakMap identity) and `review` (by reference). Everything else
in `StateFields` (`state-channel.ts:3`) is structured-cloned on every emit: `preferences` (including `deviceHistory` with
camera/lens tallies per drive, `rememberedDevices`, `ignoredDevices`, `unknownRules`), `history` (≤50, `main.ts:186`),
`errorLog.at` (one timestamp per error id ever seen, `error-log.ts:27`), `organizationRecovery`, `sourceCameraInfo`,
`destinationStatus`, `misplacedFiles`, `residue`, `duplicates` (rebuilt on every emit, `main.ts:174`), and every job
without its inventory but with `errors[]`, `groups[].items` (≤200 paths each, `shared.ts:67`), `problemFiles[]`
(unbounded) and `excluded[]`.
Frequency: `progressEmit` up to 4/s while copying and 10/s otherwise (`main.ts:176`), plus one per drive-activity sample
that changed (1/s, `drive-activity.ts:194-201`, wired at `main.ts:982`), the 5 s heartbeat (`main.ts:171`), memory-governor
changes (`main.ts:956`) and one at the end of every action (`main.ts:950`). Estimate, to be measured: a stable 5–30 KB of
slow fields per emit plus about 20 KB per issue group, so up to roughly 0.5 MB/s at 10 Hz on a job with problems, each
cloned twice (IPC, then the bridge) and rebuilt by `createStateReceiver` (`state-channel.ts:48`), which then re-renders
the whole `RootApp` tree (13 `memo`/`useMemo` in 1891 lines).
Smallest fix: extend the `review` rule in `createStateChannel` to a fixed list of slow keys
(`preferences`, `history`, `errorLog`, `organizationRecovery`, `destinationStatus`, `misplacedFiles`, `sourceCameraInfo`,
`residue`, `duplicates`). Send a key only when its `JSON.stringify` signature differs from the last one sent; the receiver
keeps the previous value when a key is missing (`reset` sends everything). Use a signature, not identity, because main
changes these values in place (`main.ts:115` `deviceHistory`, `:877` `destinations.splice`, `:213` `sourceCameraInfo[id]=`,
`job.errors.push` at `:306,568,585…`). Leave jobs as they are for now: their static arrays are changed in place, so a
reference scheme needs the copy/job owners to replace those arrays immutably first. Before and after, measure
`JSON.stringify(update).length` per emit in `tests/state-channel.test.ts` or a QA counter. Risk: medium. A missed key
leaves stale UI, and the existing reset path covers reconnects.

**S3. The settings lock is computed in two places that disagree (correctness drift, merge).**
Main locks on `busy()||settingsLocked(state)` (`main.ts:869`), where `busy()` includes a running Duplicates scan
(`main.ts:135`). The renderer uses `busy||settingsLocked(state)` with `busy=pageBusy(state)` (`RootApp.tsx:402,574`).
`pageBusy` is a strict subset of `settingsLocked` (`settings-lock.ts:11-13`), so that OR does nothing, and neither one
sees a Duplicates scan. During a scan Settings shows job settings as editable, and main silently drops the change
(`settings-lock.ts:23-24`). Fix: add `state.duplicates?.status==='scanning'||…==='removing'` to `settingsLocked`, call only
`settingsLocked(state)` on both sides, and delete `busy()` from `main.ts:869` and `pageBusy` from `RootApp.tsx:402`. Risk: low.
Add a case to `tests/settings-lock.test.ts`.

**S4. `livePreferences` is defined twice, and the main copy is dead (trivial, delete).**
`main.ts:126` declares it and nothing uses it. The live one is `settings-lock.ts:20`. Delete `main.ts:126`. Risk: none.

**S5. The job-phase list is spelled out 12 times (low cost, merge).**
`['discovering','verifying','copying']` (plus `'queued'`) appears at `settings-lock.ts:4`, `keep-awake.ts:5`,
`main.ts:171,323,464,755,840,890,901`, `eta.ts:310,313`, and `RootApp.tsx:46` (as `activePhases`, used again at 575, 591-597,
719, 1041). Fix: export `activeJobPhases` and `isActive(job)` / `isLive(job)` (active or queued) from `settings-lock.ts`, or
better from `shared.ts`, so the renderer imports the same constant. Replace the literals. Overlaps with `claude/speed-accuracy`
(`eta.ts`) and the progress branch, so land it after they merge. Risk: low.

**S6. The main-side idle guard is repeated 10 times (low cost, merge).**
`if(busy()||state.review||state.busyReview)throw new MessageError(…)` appears at `main.ts:285,294,681,716,780,781,802,823,876,877`.
At `:681` and `:716` it also adds `||duplicateControl`, which is redundant because `busy()` already includes it (`:135`).
`assertOrganizationIdle` (`:462`) is a sibling. Fix: one `assertIdle(code='error.busy')` that does the check and the throw.
Risk: none.

**S7. "How many destinations this copy mode needs" is computed 8 times (low cost, merge).**
`copyMode==='single'?1:2` appears at `main.ts:199` and `RootApp.tsx:36,342,473,595,737,1055,1064`. `ImportDashboard`
(`:737-739`) and `ImportDesk` (`:1064-1065`) partly redo `destinationReadiness` (`:35`). Fix: `requiredDestinations(prefs)`
in `preferences.ts`, and make `destinationReadiness` the only readiness check. Risk: none.

**S8. Dead variables in `ImportDesk` (trivial, delete).**
`progressJobs`, `transferred`, `total`, `speed` (`RootApp.tsx:1047-1050`) and `requiredDestinations`, `readyDestinations`
(`:1064-1065`) are never read. The dashboard does its own math at `:722-724`. Delete all six. Risk: none (tsc/lint should
flag them; `noUnusedLocals` is evidently off).

**S9. Four confirm sheets share one skeleton (medium code size, merge).**
`ReleaseConfirm` `RootApp.tsx:957`, `DeleteRecoveryConfirm` `:981`, `OriginalsConfirm` `:1387` and `DuplicatesConfirm`
`DuplicatesPage.tsx:124` each repeat the `dialog` ref, `useAnimatedClose`, `showSheet` with second-step autofocus, heading,
the `activity-content` body and the Cancel/danger footer (about 12 identical lines each). The two-step state machine is
already shared (`nextDeleteRecoveryStep`, used at `RootApp.tsx:938,1413`, `DuplicatesPage.tsx:248`). Fix: one
`ConfirmSheet({step?,title,confirmLabel,confirmDisabled?,testId,onCancel,onConfirm,children})`. Callers keep only their copy
and measurements. Rename `nextDeleteRecoveryStep` to `nextConfirmStep`. Keep the testids. The data-safety double
confirmation stays; only the component code merges. Risk: low (QA testids).

**S10. Capacity math is done twice (low cost, merge).**
`CapacityBar` (`RootApp.tsx:186-187`) and `SidebarCapacity` (`:417-418`) each validate total/free, clamp free, compute the
used fraction and apply the same 90% "low" threshold. Fix: one `capacityUse(total,free)→{known,available,used,fraction,low}`
next to `sourceCapacity` (`:173`). Risk: none.

**S11. Test-only code in `sidebar-fit.ts` and a stale comment (trivial, delete).**
`shortCapacity` (`sidebar-fit.ts:2-5`) is imported only by `tests/sidebar-fit.test.ts:3`. The sidebar's compact text is
`"{size} free"` (`RootApp.tsx:421`), while the comment at `:426-428` still describes the "342.9 GB/2.00 TB" form. Fix: delete
`shortCapacity` and its test, and fix the comment. Risk: none.

**S12. Two reduced-motion probes (trivial, merge).**
`Boot.tsx:13` `prefersReducedMotion` duplicates `reducedMotion` (`RootApp.tsx:246`). Boot cannot import from RootApp (cycle).
Move `reducedMotion`, `motionToken` and `motionMs` (`:246-248`) into a small `renderer/motion.ts` that both import. This is
also where `animateInterfaceChange`/`showSheet` belong: they are shell infrastructure, not page code. Risk: none.

**S13. `RootApp.tsx` is one 1891-line module holding every page (layer smell, informational).**
The shell (`RootApp` `:295`, title bar `:579`, sidebar `:415-492`, motion `:246-293`, settings `:772-875`, `:1667-1772`)
lives with the Import desk, Organization, History, the metadata dialog and the review panel. `DuplicatesPage.tsx` imports
shell primitives back from it (`DuplicatesPage.tsx:8`). This is not a depth problem (the pages are what they are), but it
blocks S9/S12 reuse without cycles. The minimal move: `shell/` = {RootApp, TitlebarControls, sidebar, motion, ConfirmSheet,
Button/Icon/Switch}. Pages import from it, never the other way round. Do it last; it touches every other session's lines.

**S14. `allowed` calls `realpath` on every root for every file (minor perf).**
`main.ts:187` resolves every approved, source and destination root on each `thumbnail`/`exif` call, and the Duplicates grid
makes one call per tile (`DuplicatesPage.tsx:180-181`). Fix only if profiling shows it: cache root realpaths per `refresh`.
Risk: low.

Checked and fine: `preload.ts` is a pure pass-through, as intended (`:4-5`). `normalizePreferences` is the single rule
set for disk and IPC (`preferences.ts:32`). `save` is atomic with fsync and directory sync, and serialized (`main.ts:179`).
That is data-safety redundancy; keep it. The boot controller is DOM-free and tested (`boot-controller.ts:1-3`). `BrandLogo`
and the Icon Composer layers share one geometry (`brand-geometry.ts:1-2`). `duplicateGroups` and `errorPaths` are pull
methods that already keep large lists out of the push channel.

## 3. Requirements check

| ID | Status | Evidence |
|---|---|---|
| PROJ-05 | Implemented (shell) | Electron with `win`/`linux` `dir` targets, `package.json:54-63`. Drive activity is darwin-only (`main.ts:982`); the native camera helper is in `Sources/` (other reviews). |
| PROJ-06 | Implemented | One renderer for every OS; only the window controls branch (`RootApp.tsx:385`). |
| PROJ-07 | Partial | macOS keeps native traffic lights (`main.ts:971` `titleBarStyle:'hidden'`, `trafficLightPosition`). Windows/Linux get `frame:false` with custom buttons (`RootApp.tsx:385`, `window` action `main.ts:848`), which are not system-native. `titleBarOverlay` on Windows would give native ones. |
| UI-01..03 | Implemented (subjective) | Custom design system in `styles.css`; capsule buttons with `--control-height` (`styles.css:144`). |
| UI-04 | Implemented | Default `textScale` 1.25, range 1–2 (`preferences.ts:6,40`); slider in Settings > General (`RootApp.tsx:856`); `--text-scale` (`styles.css:14`). |
| UI-05 | Implemented | `SettingsPage` `RootApp.tsx:793`. |
| UI-06 | Implemented | Accents coral/ocean/forest (`shared.ts:6`, `AppearanceControls` `RootApp.tsx:1031`, `data-accent` `:353`). |
| UI-07 | Implemented | Default `appearance:'system'` (`preferences.ts:6`); `nativeTheme.themeSource` (`main.ts:870`); system listener (`RootApp.tsx:325`). |
| UI-08 | Implemented | `useSidebarFit` (`RootApp.tsx:429`, `sidebar-fit.ts:14`), clamped font size (`styles.css:14`). |
| UI-09 | Implemented | `sourceLayout` list/grid (`preferences.ts:36`, `RootApp.tsx:1070-1071`). |
| UI-10 | Implemented | Same as PROJ-06. |
| UI-11 | Implemented | `ImportDashboard` replaces the hero (`RootApp.tsx:717`), with a Show/Hide toggle (`showDashboard`, `:859`, `:1070`). |
| UI-24 | Implemented (subjective) | Each page's actions are in the title bar (`TitlebarControls` `RootApp.tsx:579`). |
| UI-25 | Implemented | `global-start`/`global-stop`/`global-automatic` (`RootApp.tsx:598-603`), on the Import desk only (other pages show their own actions). |
| UI-26 | **Missing (regressed)** | `TitlebarControls` (`RootApp.tsx:579-603`) has no total-progress button. Total progress exists only in `ImportDashboard` (`:760`), which the user can hide. `docs/user-requirements-verification.md:175` cites a removed button and is stale. Fix: a title-bar progress button that opens the dashboard as a popover, or that shows while the dashboard is hidden. |
| UI-27 | Implemented | `errorsButton` on every page (`RootApp.tsx:581`). |
| UI-28 | Out of scope | Error panel review. |
| UI-29 | Implemented | Page title in the title bar (`RootApp.tsx:385`). |
| UI-30 | Implemented | Automatic is a button with `aria-pressed` (`RootApp.tsx:600-603`). |
| UI-31 | Implemented | `.sidebar{position:fixed;inset:0 auto 0 0}` (`styles.css:222`). |
| UI-32 | Implemented in the UI; leftover cost | The metadata dialog shows no picture (`RootApp.tsx:1789-1833`), but `inspect` still builds the preview (S1). |
| UI-33 | Implemented | No USB-detection advertising line found in the renderer. |
| UI-34 | Implemented | Category tabs with summaries (`RootApp.tsx:811-818`). |
| UI-35/36, DST-07 | Implemented, one exception | Paths, folders, copy mode and organization are in Settings (`RootApp.tsx:822-852`). The `allowFolderSource` switch is duplicated on the desk (`RootApp.tsx:1075`), which was a deliberate shortcut. Keep it or drop it, but it is one setting in two places. |
| UI-37/38 | Implemented | View transitions (`RootApp.tsx:253`), sheet exits (`:282`), motion tokens (`styles.css:62-66`), reduced motion respected (`:256,289`, `Boot.tsx:13`). |
| UI-39/40 | Implemented | Segmented storage strip and legend (`CapacityBar` `RootApp.tsx:184`); per-format colours (`:156`). |
| UI-41 | Implemented | No pie chart. |
| LOC (settings) | Implemented | Language select (`RootApp.tsx:855`) with 4 locales (`shared.ts:4`). Settings strings go through `t()`. Exception: native dialog titles in main are English-only (`main.ts:783,805,832,876,878`, e.g. "Choose folders to organize"). This is partial for LOC-03 and fixable by passing translated titles from the renderer or by translating in main. |
| ICON-04 | Implemented | `Icon.icns` for packaging (`package.json:34`); `BrandLogo` in the sidebar and the splash (`RootApp.tsx:387`, `Boot.tsx:66`), with geometry shared with `Icon.icon` (`brand-geometry.ts:1-2`). The connection screen still uses `./icon.png` (`RootApp.tsx:371`); fine, same artwork. |

## Overlaps with other sessions
- **S2 is already in progress:** the worktree has an uncommitted `state-channel.ts` diff that sends `errorLog`, `history`, job `errors` (versioned by length) and `problemFiles` by reference. Apply S2 only to the keys that diff leaves out (`preferences`, `organizationRecovery`, `destinationStatus`, `misplacedFiles`, `sourceCameraInfo`, `residue`, `duplicates`).
- S5 touches `eta.ts` (`claude/speed-accuracy`) and the progress branch. Land it after those merge.
- S2 changes `state-channel.ts`, which `claude/progress-everywhere` may also touch for progress shapes.
- M5 and the `errorLog` part of S2 touch the error-panel area.
