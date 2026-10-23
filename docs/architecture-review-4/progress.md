# Architecture review 4: progress, time left, speeds, drive activity, resource limits

Scope: `desktop/eta*.ts`, `listing-estimate.ts`, `platform/drive-activity.ts`, `resource-limits.ts`, `threadpool.ts`, `keep-awake.ts`, `state-channel.ts`, the publishing path in `main.ts`, and the progress UI in `renderer/RootApp.tsx`. Line numbers are on `main` @ `daaabd8`. Findings were also checked against the unmerged branches `claude/speed-accuracy` (SA), `claude/progress-everywhere` (PE) and `claude/stage-color-bars` (SCB, which contains SA). Hashing and the shape of progress reports are out of scope here and are only noted where they overlap.

## 1. Interface table

| Capability | Entry | Implementation | Count |
|---|---|---|---|
| Publish state to the renderer | `emit()` main.ts:174 | `createStateChannel().publish` state-channel.ts:15 | 1 |
| Throttle progress publishes | `progressEmit` main.ts:176 | `throttled` job-issues.ts:48 (leading edge only) | 1 |
| Republish a stalled job | timer main.ts:171 | **also** `refresh()` every 5 s main.ts:981, which calls `emit()` at :203 | **2** |
| Per-step time left | `EtaTracker.observe` eta.ts:213 | `JobModel` (eta-model) for modelled steps; `legacy()` + `EtaEstimator` eta.ts:252/31 for the rest | **2** |
| Smoothing the shown time left | eta.ts:238-245 | `EtaEstimator.smoother` → `stepSmoother` / `jobSmoother` (`EtaSmoother` eta.ts:14) → `DisplayHold` eta-format.ts:43 → `remainingBucket` in the renderer | 3 stacked layers |
| Fraction of a job | `job.fraction` stamped at eta.ts:328 (`FractionHold` eta-model.ts:257) | renderer `cardFraction` :1252, `importFraction` :1324 (fallback guess), `organizationFraction` :1318 | **2** (main + renderer guess) |
| Overview fraction | renderer `overviewFraction` :1266 | cost sum; otherwise a bytes-weighted fallback. SCB adds `totalStageLayers` (bytes-weighted, by stage) | **2**, **3** with SCB |
| Overview time left | `state.etaTotal` (`overviewEta` eta.ts:363) | renderer :736 `state.etaTotal?.eta ?? Math.max(job.eta)` | **2** (the second never runs) |
| Queue order | `state.queueOrder` main.ts:174 | renderer :1045 `?? queued.map(id)` | **2** (the second never runs) |
| Speeds (B/s, files/s) | `speeds()` eta.ts:293 | `RateMeter` eta.ts:65. It writes `progress.speed`, overwriting the speed the producer reported | 1 (but the field has two owners) |
| Combined speed | renderer :725-727 and :762 | on main the same sum is written twice with different rules; SA merges them into `combinedSpeed` | 2 on main → 1 on SA |
| Time-left text | `formatRemaining` / `formatEstimate` RootApp:1276/1283 | `remainingBucket`, `remainingRange` eta-format.ts:7/31 | 1 |
| Listing share | `listingShare` / `listingEstimate` listing-estimate.ts:12/31 | used by the scan worker (main.ts:213) and by eta.ts:187 | 1 |
| Drive utilization | `startActivityLoop` drive-activity.ts:193 → `state.driveActivity` | `createDriveSampler` drive-activity.ts:105 (ioreg) | 1 |
| Resource limits | `setResourceLimits` resource-limits.ts:40 | module singleton `current`; `cpuWorkers`, `limiter`, `scaledByBudget` | 1 |
| Memory governor | `governor.observe` main.ts:955 | `MemoryGovernor` resource-limits.ts:78 (3 s timer) | 1 |
| Thread pool size | `raiseThreadpool` threadpool.ts:9 | env var set at import, plus `LSEnvironment` in Info.plist (threadpool.ts:5) | 2 (the plist value is only a defence if module order breaks) |
| Keep awake | `awake(state.jobs)` inside `emit` main.ts:174 | `keepAwake` keep-awake.ts:7 | 1 |
| Job timing stamps | `stampJobs` main.ts:145 | one function | 1 |
| Drive info for the time-left model | `etaDrive` main.ts:161; `etaTotals` main.ts:166 | one function each | 1 |

## 2. Smells, ranked

**S1. Every emit serializes the whole state, at up to 10 Hz, and drive activity alone drives 1 Hz emits even when the app is idle.** (high)
- Evidence: `publish` sends `state` minus inventories and an unchanged review (state-channel.ts:25-29). That covers preferences (including `deviceHistory`), `history` (50 entries, about 12 KB measured with a synthetic entry), `errorLog`, `organizationRecovery[]`, `duplicates.earlier: string[]` (unbounded relative paths, shared.ts:46), and every job's `problemFiles`, `groups` (≤200 paths each, shared.ts:67) and `space`. The sampler's `history` (60 numbers per key) shifts on every sample, so the loop's JSON signature (drive-activity.ts:200-201) changes every second and calls `emit()` (main.ts:982). The loop keeps running whenever the window is visible (`wanted`, main.ts:982), so even an idle app sends a full publish every second. While a job runs, `progressEmit` allows 4–10 publishes/s (main.ts:176), and governor changes add more (main.ts:956).
- Cost: assuming 30–150 KB per update (history, errorLog with a few hundred entries, two jobs with problem groups), that is about 30–150 KB/s idle and **120 KB–1.5 MB/s** during a copy. Each update is also a structured clone in the main process, a context-bridge copy, and a full React render of `RootApp` (every `state.*` reference is new). `emit` also recomputes `duplicateScopes()`, `errorCache.refresh`, `orderSources` and `queueOrder` on every call (main.ts:174).
- Fix (minimal): extend the reference diff that state-channel already does for inventories and review to the slow-moving top-level fields. Send `preferences`, `history`, `errorLog`, `organizationRecovery` and `duplicates` only when their reference changed (`previous !== current`, the same pattern as `review` at state-channel.ts:29), and let the receiver keep the last value (state-channel.ts:52). The main process must replace these objects on change rather than mutate them in place; that is mostly true already (`state.history=…slice`, `errorCache.refresh`). Separately, send the sparkline history once and then only the appended point, or simpler: compare the signature on `utilization/readBps/writeBps` rounded, without `history`, so an idle drive stops publishing.
- Risk: medium. A field mutated in place would go stale in the renderer. Mitigation: add a test that `JSON.stringify(receiver.snapshot())` equals the main-process state after random actions.

**S2. Two "republish when stalled" timers.** (low cost, pure deletion)
- Evidence: main.ts:171 emits every 5 s while a job runs. `refresh()` already runs every 5 s unconditionally (main.ts:981) and ends with `emit()` (main.ts:203).
- Fix: delete main.ts:171. If `refresh` should be allowed to be slow (`refreshing` guard at :189), move the stall emit into the `finally` of `refresh` instead. Risk: low; the time left can grow during a stall only on a 5 s cadence either way.

**S3. Renderer fallbacks that never fire** (dead code; it also hides that main is the one implementation).
- `remaining = state.etaTotal?.eta ?? Math.max(...)` (RootApp:736): the renderer computes this only when every active job has `eta`. In that case `overviewEta` returns a value: its only `undefined` cases are an empty list, a missing `eta`, or `stopping`, which deletes `eta` (eta.ts:326, :364). So the `Math.max` branch is unreachable.
- `state.queueOrder ?? queued.map(...)` (RootApp:1045): `emit` always sets `queueOrder` (main.ts:174).
- The planning-share guess in `importFraction` (RootApp:1328-1331), the step-share branch of `cardFraction` (:1257-1258), and the `organizationFraction` fallback for running jobs: `stampEstimates` sets `job.fraction` for every running job with progress, including legacy steps (`fractions.next(0)` returns 0, never `undefined`; eta.ts:255, eta-model.ts:262).
- Fix: delete these branches and make `job.fraction`, `etaTotal` and `queueOrder` the only source. Risk: low; tests that render jobs without stamping need `fraction` in their fixtures.

**S4. The job bar sits at 0% for the whole listing** (this also breaks the consistent-live-progress rule).
- Evidence: steps the model does not cover (`listing`, `downloading`, `scanning`, eta.ts:102-108) take the `legacy` path, which stamps `fraction = FractionHold.next(0)` and `cost {0,0}` (eta.ts:255). `cardFraction` and `importFraction` return `job.fraction` first (RootApp:1257, :1328), so the bar shows 0% even though `progress.share` is moving. Because `cost.total` is 0, `overviewFraction` also drops to its bytes-weighted fallback for every job (RootApp:1267) whenever one job is still listing.
- Fix: in `legacy()`, stamp `fraction` from the sample's share (`progress.share`, or `completed/total`) scaled into the job's first slice, or leave `fraction` unset so the renderer's step share is used. Pick one and delete the other (see S3). Risk: low. PE's stall-watch QA (`qa/stall-watch.ts`) checks counters, not the bar fraction, so it would not catch this; add an assertion on the fraction.

**S5. Two estimators and three stacked smoothers for one "time left".**
- Evidence: `EtaEstimator` (EWMA + bias correction + its own `EtaSmoother`, eta.ts:31-60) serves steps the model does not cover. `JobModel` serves the rest, followed by `stepSmoother`/`jobSmoother` (`EtaSmoother`), then `DisplayHold` (eta.ts:238-245), then bucket rounding in the renderer. Dead weight inside: `Legacy.smoother` is constructed (eta.ts:254) and never read; `JobState.known`/`Known` (eta.ts:112, :179) is never read; `listingTotal` (eta.ts:100) is never called; `dataStages` and `dataKeys` (eta.ts:90, :98) are two near-identical sets for "a data step", and PE adds `planning:index` only to `dataKeys`.
- Fix: delete `Legacy.smoother`, `Known`/`known` and `listingTotal` now (deletion test passes, nothing reads them). Merge `dataStages` into `dataKeys`. Longer term: give `JobModel` a `share` step kind for listing and scanning so `EtaEstimator` and `legacy()` can be deleted. That leaves one estimator and two smoothing layers (`EtaSmoother` + `DisplayHold`). Risk: the deletions are low risk; replacing the estimator is medium (time-left behaviour during listing; `docs/eta-estimates.md` would need updating).

**S6. `Progress.speed` has two owners.**
- Evidence: producers fill `speed` (18 sites write `speed:0`; `planningProgress`/`downloadProgress` at main.ts:312/314 always write 0). `speeds()` then overwrites it in place (eta.ts:300), and on main it uses the producer's value as a first-second fallback (eta.ts:299).
- **SA already fixes the fallback** ("drop the lifetime-average fallback", `speed=measured??0`), which makes the producer's field write-only. Fix after SA: drop `speed` from the producer contract (make it optional in `Progress`, or set it only in `stampEstimates`) and delete the `speed:0` literals. Risk: low (type-checked).

**S7. Overview derivations split between main and renderer, and SCB adds a third rule.**
- `overviewEta` (main) sums with drive sharing (eta.ts:363). `overviewFraction` (renderer, :1266) sums `cost`, and when any job is uncosted it falls back to a fraction weighted by `totalBytes`. **SCB adds `totalStageLayers`** (SCB RootApp:1219-1228), which weights the slowest stage by `totalBytes`. The percent shown (cost-based) and the top layer's width (bytes-based) can therefore disagree on the same bar.
- Fix: compute the overview once in main, next to `etaTotal`: `state.overview = {fraction, eta, low, high, stages}` from `tracker.view` costs. The renderer then only formats it. Delete `overviewFraction`'s fallback and derive SCB's layers from the same cost numbers. Risk: medium (SCB is unmerged; do this after it lands, or ask SCB to take its weights from `job.cost`).

**S8. Duplicate drive-activity entries cross IPC and are deduplicated in the renderer by JSON text.**
- Evidence: the sampler emits one `DriveActivity` per key (source id and destination path), even when two keys map to the same disk (drive-activity.ts:143-153). The renderer then deduplicates with `JSON.stringify(item)` per key on every render (RootApp:235).
- Fix: publish `driveActivity` keyed by whole disk plus a small `key → disk` map (or have the sampler return the deduplicated total itself). Delete the renderer's signature deduplication. Risk: low.

**S9. Layering: `platform/drive-activity` imports `RateMeter` from `eta.ts` (SA only).**
- SA adds `import { RateMeter } from '../eta'` in drive-activity.ts, so a platform adapter now depends on the app's estimator module, which pulls in `eta-model` and `eta-priors`. Fix: move `RateMeter` (pure, about 20 lines) into its own `rate-meter.ts` that both import. Risk: none.

**S10. Smaller items.**
- `throttled` (job-issues.ts:48) is leading-edge only, so the last progress value of a burst waits for the next event or the 5 s refresh. Add a trailing call so the final count shows within 250 ms. That supports the live-progress rule.
- `resourceUse()` reads `os.totalmem` and the host defaults on every emit (main.ts:139), yet they change only on a settings change or a governor tick. Cache it in the governor's `onChange`. Cost is negligible; this is cleanliness only.
- Keep-awake and `activityLoop.wake()` run as side effects inside `emit` (main.ts:174). This works because every phase change emits. Leave it, but document that `emit` is the lifecycle hook.
- threadpool.ts:3-12 sets the pool size three ways (saved limit, `THREADPOOL_SIZE` default, Info.plist). The plist value is a defence against module-order regressions, and the QA probe already guards that. Keep it; this is not a smell.
- Overlap, not analyzed: PE reshapes recovery and residue progress and adds a 2 s heartbeat (`tests/heartbeat.test.ts`) and a stall watch. That covers the "frozen counter" half of the live-progress rule, but not S4's frozen bar fraction.

## 3. Requirements check

| Req | Status | Evidence |
|---|---|---|
| UI-12 copy statistics (speed, number of drives copying, drive status) | **Implemented**, with one gap | Speed, active/queued, destinations ready and drive activity are shown in `ImportDashboard` (RootApp:752-757). There is no "drives copying" count as such: Active / queued counts jobs, and `totalDriveActivity.count` (:236) is computed but not shown. On main the speed rule is split in two places (:725 vs :762); SA unifies it (`combinedSpeed`). |
| UI-26 title-bar button for total progress | **Missing / regressed** | The desk title bar holds only Start/Pause/Stop/Automatic/Refresh/Errors (RootApp:594-606). The overview is now inline (:1068), and once hidden it can only come back through Settings (:859). `docs/user-requirements-verification.md:175` still cites a title-bar button that no longer exists. Fix: put an overview toggle (`showDashboard`) in `TitlebarControls`. |
| COPY-14 copy then verify as separate phases (progress side) | **Implemented** | Separate phases `copying` then `verifying` (shared.ts:58). The model plans both totals (`etaTotals` main.ts:166-169; `learn` eta.ts:197-202). SA labels the verify speed "Verify read" and feeds it from hashed bytes. |
| Standing rule: every long step shows a moving counter | **Partial** | Counters and speeds move (`speeds()` eta.ts:293). PE adds heartbeats every ≤2 s and a stall watch. Gaps: S4 (job and overview bar at 0% through the whole listing), S10 (a leading-edge throttle can hold the last count for up to 5 s), and `downloadProgress` (main.ts:314) has no bytes, so the camera download shows a count only. |
