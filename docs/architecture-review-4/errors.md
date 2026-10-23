# Architecture review 4 — errors, warnings, skip, history, messages, translation

Snapshot: committed `daaabd8`; all `file:line` refer to that commit (the worktree has uncommitted edits to `RootApp.tsx`, `state-channel.ts`, `source-cameras.ts` that may shift lines). Read-only analysis. Vocabulary: module, interface, depth, seam, adapter, deletion test.
Overlap not re-analysed: hashing/verify-once and records-v5 (`core/recovery.ts`), progress shapes (`claude/progress-everywhere`), ETA (`claude/speed-accuracy`), logging (`claude/detailed-logging`).

## 1. Interface table

| Capability | Entry (interface) | The one implementation | Count |
|---|---|---|---|
| Message catalog (backend → user) | `Message {key,params}` | `backendMessages` + `formatMessage` `desktop/messages.ts:5,153` | 1 |
| Typed thrown error | `MessageError` | `desktop/messages.ts:161`; `toMessage` `:174` | 1 |
| UI catalog (4 languages) | `t(english \| Message)` | `createTranslator` `desktop/renderer/i18n.tsx:1081` (delegates `Message` to `formatMessage`) | 1 |
| Severity of a message | `severityOf` | `desktop/error-log.ts:11` | **2** — also `explainError().severity` `RootApp.tsx:517-529` (test-only, see S5) |
| Stable code | `codeOf` | `desktop/error-log.ts:19` | 1 |
| Path a message names | `pathOf` / `errorPath` / `filePath` | `error-log.ts:21`, `messages.ts:170`, `messages.ts:165` | **3** (S6) |
| Record a structured issue | `recordIssue(s)` | `desktop/job-issues.ts:14,25` | 1 (+ dead `createIssueSink` `:29`, S4) |
| "Is this code skipped for the job" | `isAcknowledged` | `desktop/acknowledge.ts:15` | **3** — inline copies `error-log.ts:47`, `job-issues.ts:35` (S3) |
| Job problem count (fails a job) | `errorTotal` | `desktop/job-issues.ts:33` | 1 (but parallel `jobProblems` `acknowledge.ts:7` walks the same data, S3) |
| Every shown error, with stable id | `gatherErrors(state)` | `desktop/error-log.ts:36` (run in main **and** renderer, S7) | 1 + renderer-only extras `collectErrors` `RootApp.tsx:531-543` (S8) |
| First-seen time, cleared ids | `ErrorLog.update/clear` | `desktop/error-log.ts:73`; cached by `createErrorLogCache` `:120`, published in `emit` `main.ts:174` | 1 |
| Clear errors | actions `clearError` / `clearErrorIds` / `clearErrors` | `clearErrors` `error-log.ts:100`, `clearErrorIds` `:93`; dispatch `main.ts:849,860,861` | **3 actions, 2 functions** (S1) |
| Group rows | `buildRows` | `desktop/error-groups.ts:12` | 1 |
| Badge / counts | `rowCounts` | `error-groups.ts:36` | **6 count sites** (S2) |
| Copy all paths | IPC `importer:errorPaths` → `issuePaths` | `main.ts:979`, `job-issues.ts:27`, `preload.ts:19`, caller `RootApp.tsx:642` | 1 |
| Group title/explanation | `groupInfo` | `RootApp.tsx:607` | 1 |
| Explain a single error | `explainError` | `RootApp.tsx:517` (regex on English text, S5) | 1 |
| Skip / Skip all (acknowledge) | action `acknowledgeErrors` | `acknowledgeJob` + `acknowledgeSummary` `acknowledge.ts:18,34`; `main.ts:850-858` | 1 (2 UI entries: card `RootApp.tsx:1433`, panel `:692,652` — fine) |
| Skip file / skip and continue | `skipFile` / `skipAndContinue` | one case `main.ts:893-903` | 1 |
| Retry | `retryJob` | `main.ts:885-891` | 1 (card `RootApp.tsx:1434`, panel `:650,701`) |
| History | `addHistory(title,detail)` | `main.ts:186` | 1 |
| Toast | `ErrorToast` | `RootApp.tsx:546` | 1 |
| Sidebar badge | `SidebarErrors` | `RootApp.tsx:507` | 1 |
| Panel | `ActivityPanel` / `MergedRow` | `RootApp.tsx:672,635` | 1 (with a dead clear fallback, S1) |

## 2. Smells, ranked

### S1. Three clear actions that differ only by id / ids / none — CONFIRMED
- Evidence: `clearErrors(log,state,id?,severity?)` `error-log.ts:100-104` and `clearErrorIds(log,state,ids,severity?)` `:93-97` do the same thing (gather, filter, `log.clear`, reset `state.error` if the app error is in the set). Actions `main.ts:849` (`clearError`: one id, **or** with no id just `state.error=undefined`), `:860` (`clearErrorIds`), `:861` (`clearErrors`).
- Callers: the app sends only `clearErrorIds`/`clearErrors` via `clearErrorItems` `RootApp.tsx:377-383`. `clearError` is sent only by the dead fallback `ActivityPanel` `clear = onClear ?? …` `RootApp.tsx:681` (the only real call site passes `onClear`, `RootApp.tsx:406`; the fallback runs only in tests `tests/error-log.test.ts:83`, `error-severity.test.ts:79`, `i18n.test.ts:189`) and by QA `qa/codex-smoke.ts:307`.
- Cost: 3 Action variants in `shared.ts:97`, 3 switch cases, 2 functions, 1 fallback path; deletion test: deleting `clearError` and `clearErrorIds` loses nothing.
- Fix: one function `clearErrors(log,state,{ids?,severity?})` (ids absent = all of that severity) and one action `{type:'clearErrors';ids?:string[];severity?}`. Make `onClear` required on `ActivityPanel` and delete the fallback at `:681`. QA step `codex-smoke.ts:307` → `{type:'clearErrors'}`.
- Risk: low; update `tests/error-log.test.ts:49-63,96,124`, `error-groups.test.ts:111`, `error-severity.test.ts`.

### S2. Error counts computed in six renderer places, with three different units — CONFIRMED (one is a bug)
- Titlebar badge: rows, `rowCounts(buildRows(errors))` `RootApp.tsx:375`.
- Section heading: rows, `rows.length` `RootApp.tsx:684,690`.
- Source group heading `{count} issues`: entries, `list.length` `RootApp.tsx:692`.
- Sidebar badge: entries, `all.filter(...)` `RootApp.tsx:509-513`.
- Toast `{count} new issues`: entries `RootApp.tsx:568-570`.
- Dashboard `{warnings} warnings`: `gatherErrors(state)` again `RootApp.tsx:732`, which **ignores `errorLog.cleared`, local errors and the format warning** — cleared warnings stay counted on the Import overview (`:756`). Bug.
- Example divergence: a job with 3 `error.fileSkipped` entries (grouped code `file-skipped`, `error-log.ts:17,23`) shows titlebar **1**, sidebar **3**.
- Cost: inconsistent numbers for one fact; `buildRows` runs 2 + (sources) times per render and `gatherErrors` twice per render, none memoised (`RootApp.tsx:373-375` sit in the render body).
- Fix: compute once in `RootApp`: `const rows = useMemo(() => buildRows(errors), [errors])`; pass `rows` (or per-target slices) to titlebar, sidebar, dashboard and panel; count rows everywhere. Delete `RootApp.tsx:732` and use the shared count.
- Risk: low; sidebar/group heading numbers change from entries to rows (intended single definition). Tests asserting sidebar counts need updating.

### S3. "Skipped for this job" predicate copied three times; two walkers over the same job data — CONFIRMED
- `isAcknowledged` `acknowledge.ts:15`; identical inline lambdas `error-log.ts:47` and `job-issues.ts:35`.
- `jobProblems` `acknowledge.ts:7-13` and `errorTotal` `job-issues.ts:33-39` both fold `job.errors` + `job.groups` by `codeOf/severityOf`; `errorTotal` = sum of `jobProblems` filtered to errors and not acknowledged.
- Fix: keep `isAcknowledged` (move it next to `errorTotal` in `job-issues.ts`, the module `error-log.ts` already imports from neighbours) and import it in `error-log.ts:47`; define `errorTotal(job)=jobProblems(job).filter(p=>p.severity==='error'&&!isAcknowledged(job,p.code)).reduce(...)`, moving `jobProblems` beside it. One module owns "job problems".
- Risk: very low; pure functions with tests (`tests/acknowledge.test.ts`, `error-groups.test.ts`).

### S4. Test-only code in production modules — CONFIRMED
- `createIssueSink` `job-issues.ts:29-31`: only `tests/error-groups.test.ts:5,51`. Production records via `recordIssues` directly.
- `migrateLoggedError` `error-log.ts:67-70`: only `tests/error-severity.test.ts:59-61`. Nothing persists logged errors.
- `ErrorLog` constructor `saved` parameter `error-log.ts:75-79`: production is `new ErrorLog()` `main.ts:157`; only `error-severity.test.ts:55` passes a saved state. The comment "keep working across versions" describes persistence that does not exist.
- `explainError(...).severity` (see S5) is read only by `tests/i18n.test.ts:578,580`.
- Fix: delete all four; rewrite the two tests against `recordIssue`+`throttled` and against `ErrorLog` without restore. Risk: none at runtime.

### S5. `explainError` classifies by English regex though codes exist — CONFIRMED
- `RootApp.tsx:518` formats the message **in English** then matches `/enospc|…/`, `/source changed|scan again/`, `/verification failed|…/` (`:520-527`). The backend already has keys for some of these (`error.sourceChanged`, `error.mirrorReview` — the latter is matched by key at `:524`, the others not). `severity` returned here duplicates `severityOf` and is unused in production (`:569,697` read only `title`/`hint`).
- Cost: classification depends on English wording of `backendMessages` and OS strings; a reworded catalog row silently changes UI titles. Two severity sources.
- Fix (minimal): match keys/codes first (`error.sourceChanged` → "Files on the drive changed…", `codeOf` for `copy-failed`/`unreadable`), keep regex only for `key==='text'` raw OS errors (ENOSPC/EACCES/EIO are errno strings, legitimately text). Drop `severity` from `ErrorExplanation`. Better: move `explainError` beside `severityOf` in `error-log.ts` so the classification lives in one module.
- Risk: low; `tests/i18n.test.ts:576-580` cover it.

### S6. Three path extractors with subtly different rules — CONFIRMED
- `pathOf` (any key incl. `text`) `error-log.ts:21`; `errorPath` (any key **except** `text`) `messages.ts:170`; `filePath` (only `error.sourceChanged`/`error.fileFailed`) `messages.ts:165`.
- Consequence: inventory issues are built as `key:'text'` with a `path` (`error-log.ts:43`), so a single such row gets **no Show in Finder** (`errorPath`, `RootApp.tsx:698`) while the same entry in a group row does (`pathOf`, `error-groups.ts:19`, `RootApp.tsx:641`).
- Fix: keep `pathOf` (move to `messages.ts`), delete `errorPath` and use `pathOf` at `RootApp.tsx:698`; keep `filePath` but implement it as `SKIPPABLE.has(key) ? pathOf(m) : undefined`. Risk: low; update `tests/skip-errors.test.ts:154-156` (the `text` without path case still returns undefined).

### S7. `gatherErrors` runs in both processes; main discards the list it builds — PARTIAL (by design, but wasteful)
- Main: `errorCache.refresh` → `log.update(gatherErrors(state))` `error-log.ts:125`, keeps only `{at, cleared}`; `clearErrors`/`clearErrorIds` call `gatherErrors` again (`:94,101`).
- Renderer: `collectErrors` → `gatherErrors(state)` per render `RootApp.tsx:535`, plus `RootApp.tsx:732`. Ids are FNV hashes computed "alike" in both (`error-log.ts:32`) — an implicit cross-process contract (if the two builds drift, cleared ids silently stop matching).
- `ErrorLogState.at` already omits cleared ids (`error-log.ts:85`) and `cleared` is also sent; renderer uses `cleared` (`RootApp.tsx:534`). One of the two is redundant on the wire.
- Fix (minimal, no new payload): memoise `collectErrors` on `state` in the renderer (S2) and stop sending `cleared` — filter on "has `at`" is not enough (new errors lack `at` until next emit), so instead drop the `.filter` at `error-log.ts:85` and keep `cleared`. Larger option (not recommended now): publish the gathered list from main and delete renderer gathering; it duplicates `job.errors` in every state message.
- Risk: low.

### S8. Renderer invents an error source ("Unknown file formats") — CONFIRMED, wrong layer
- `collectErrors` adds `kind:'format'` warnings from preferences + inventories `RootApp.tsx:537-541`; `explainError` special-cases `kind==='format'` `:519`; `ActivityPanel` special-cases `formatSourceId` `:696`. These entries have no `id`, so they cannot be cleared, have no first-seen time and are invisible to main's log. `ErrorKind` in `error-log.ts:4` does not even include `'format'` (renderer widens it).
- Fix: emit it from `gatherErrors` (state already holds `preferences`, `sessionUnknownRules`, `sourceInventories`) with code `unknown-format`; the panel keeps rendering `UnknownFilesPrompt` by code. Also stops translating at collection time (`text(t("Unknown file formats"))` `:539`, a pre-translated string inside a `Message`).
- Risk: medium-low (the prompt row UI moves from `formatSourceId` to `code`); covered by `tests/i18n.test.ts` unknown-format cases.

### S9. User-visible English assembled outside the catalogs (LOC gap) — CONFIRMED
- `recordIssue` detail `` `Destination ${…}: ${…}` `` `job-issues.ts:20`; AppleDouble details `job-issues.ts:57-58`; history detail for Skip `text(record.groups.map(g=>`${g.code}: ${g.count}`))` `main.ts:857` shows raw codes like `copy-failed: 3` in every language.
- Fix: history detail → `joined(...record.groups.map(g=>message('issue.group',{code,count})))` or a new key; `detail` strings are "Technical detail" (`RootApp.tsx:661`) and may stay English by policy, but the "Destination" prefix should be a param, not text.
- Risk: low.

### S10. i18n catalog dead rows — CONFIRMED (≈138 → 136 + 9 + 1)
Method: each English key searched as a `'…'`, `"…"` or `` `…` `` literal across `desktop/**` and `Sources/**` (catalog block excluded), then every non-literal `t(x)` call site checked (`RootApp.tsx:1035` builds `Coral/Ocean/Forest accent` dynamically, so rows 140-142 are **used**; `t(kind)` `:1637` uses `MediaKind` values `shared.ts:10`). Every `t("…")` literal in the renderer has a catalog row (0 missing). Full list with English text: `side-session-notes/…/errors-i18n-unused-rows.md`.
- **Safe to delete (no production or test reference), 136 rows of `desktop/renderer/i18n.tsx`:**
  80, 86, 101, 103, 104, 105, 106, 111, 113, 114, 115, 118, 119, 121, 122, 123, 125, 126, 127, 129, 131, 132, 152, 182, 183, 184, 196, 198, 202, 235, 236, 237, 255, 256, 261, 283, 284, 286, 296, 297, 298, 299, 301, 302, 303, 305, 337, 361, 362, 363, 364, 365, 366, 367, 368, 370, 376, 378, 379, 380, 381, 382, 383, 384, 385, 387, 391, 392, 395, 396, 409, 413, 417, 418, 419, 434, 435, 437, 439, 441, 443, 446, 457, 461, 462, 463, 464, 465, 467, 468, 470, 479, 480, 481, 482, 483, 488, 489, 501, 502, 503, 508, 512, 515, 517, 530, 538, 554, 557, 644, 665, 765, 774, 779, 780, 783, 790, 797, 798, 799, 811, 812, 821, 822, 824, 829, 833, 834, 836, 842, 858, 860, 870, 871, 880, 881.
- **Also deletable, referenced only as test data or absence checks (9):** 102 and 110 (`qa/codex-smoke.ts:90,101` assert they are *absent*), 190 (fixture `tests/i18n.test.ts:48` — delete that fixture line too), 116 `Language`, 280 `Video`, 281 `Companion`, 398 `EXIF metadata`, 428 `Move`, 444 `Pictures` (appear in tests only as folder names/other strings).
- **Duplicate key:** row 832 repeats row 560 (`{completed} of {total} files verified`) with different spacing in zh/ja; the later row silently wins (`i18n.tsx:1074-1078`). Delete 560 or 832 (keep one spelling).
- **Near-duplicates:** `Try again` (85, connection screen reload `RootApp.tsx:371`) vs `Retry` (615, rerun job `:701,1434`): identical in all 3 translations — merge to `Retry` (1 row). `Close` (98, window control `:385`) vs `Dismiss` (688, toast `:570`): different meanings, identical translations — keep (keys are English, not a smell). Other same-translation pairs (`Group/Groups`, `Source/Sources`, `Video/Videos` …) are singular/plural English and must stay.
- Backend catalog: all 132 `messages.ts` keys are referenced in production except `job.destinationFile` (`messages.ts`, tests only) — verify before deleting.
- Risk: none at runtime (fallback is the English key, `i18n.tsx:1084`); run `tests/i18n.test.ts`.

### S11. Paired `1 X` / `{count} X` keys — REFUTED as a smell (keep)
11 pairs (`i18n.tsx:20,23,26,29,32,35,36,39,54,719,768`), 8 of them centralised in `groupInfo` `RootApp.tsx:607-618`, plus `SkipFileNotice` `:1431`. English needs both forms; zh/ja rows are trivially parallel. Replacing them with `Intl.PluralRules` machinery adds a module for 11 rows. Only inconsistency: `{count} errors`/`{count} warnings` aria-labels read "1 errors" (`RootApp.tsx:513,581`) — cosmetic.

## 3. Requirements check

| ID | Status | Evidence |
|---|---|---|
| FMT-12 format errors in the error menu, not inline | Implemented | Unknown-format prompt rendered only inside the panel `RootApp.tsx:696` (`UnknownFilesPrompt` has no other call site); but sourced in the wrong layer (S8). |
| UI-27 title-bar button for all errors | Implemented | `errorsButton` on every page `RootApp.tsx` `TitlebarControls` (~`:581`, `data-testid="show-errors"`). Count unit inconsistent with sidebar (S2). |
| UI-28 errors in a separate section, not main UI | Partial | Panel `ActivityPanel` `:672`; toast `:546`. The source card still shows "This job ended with errors" / "{file} stopped this job" with Retry/Skip `SkipFileNotice` `RootApp.tsx:1429-1437` — action affordances, arguably allowed; flag for the user. |
| LOC-01/02 four languages | Implemented | `localeNames` `i18n.tsx:5`; placeholder parity test `tests/i18n.test.ts:10-20`; backend parity `tests/backend-messages.test.ts:12-13`. |
| LOC-03 later features translated too | Partial | Every renderer `t("…")` literal has a row (0 missing); gaps: raw English details and code strings in history (S9), `explainError` fallback title is the first sentence of the message (`RootApp.tsx:529`). No test enforces "every literal has a row" — add one (cheap, prevents regressions). |
| SAFE-09 inspect running app's errors and prevent them | Implemented as process | Errors are logged with first-seen time and reports (`acknowledgeSummary` keeps `execution.json`, `acknowledge.ts:33-42`); QA smoke `qa/codex-smoke.ts`; `docs/failure-modes-20261020.md`. Not a product feature. |

Data-safety redundancy (summary.json rewrite, reports kept on Skip, `errorTotal` gating `DeleteOriginals` `RootApp.tsx:1410`) is required and is not counted as software redundancy.
