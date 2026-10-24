# UI operation safety implementation

Worktree: `/Users/sager/.codex/worktrees/ui-operation-safety/automatic-photo-importer`  
Branch: `codex/ui-operation-safety`  
Baseline: `/private/tmp/ui-next-phases-baseline-files` (includes the manual-only folder-check work).

## Stop contract

- `{type:'stop'}` retains global Stop all: cancel open review and source scans, abort originals cleanup and every active job, remove queued/paused jobs, and mark connected sources seen so automatic import does not immediately restart them.
- `{type:'stop',scope:'imports'}` stops queued, paused and running media imports and file/folder backup imports. Both `Job.organization` and the main process `organizationJobIds` registry exclude library work. Directly applied organization reviews can use the registry without setting the public job flag.
- Imports-only leaves independent source scans, duplicate scans/removal, organization/recovery jobs, open/in-progress reviews, originals cleanup, unrelated queue state and scan counters alone. Source scans are independent inspection operations, so this scope never cancels them.
- `{type:'stop',jobId}` targets that job and that job's originals cleanup; it does not discard a review, cancel independent scans, or mark unrelated sources seen.
- Unknown scope values, empty/non-string job IDs and combined `jobId` + `scope` are rejected before side effects. Job IDs resembling scope names remain job IDs.

`desktop/stop-scope.ts` exports the pure `planStop` selector and the real `stopOperations` dispatch used by main and behavior tests. No destructive file-operation semantics changed.

## Published source mode

`Source.backup?:boolean` exposes an explicitly chosen source mode. True means files/folders backup; false means media import; absent means no explicit mode was chosen for that source. `publishSourceModes` applies only main's registered source modes in `emit()`, covering initial selection, subsequent refresh and a chosen folder replaced by a discovered storage source. IDs and selection are preserved. Existing `Job.backup` / `Review.backup` always describe their own run and must win over a source's later changed mode.

## Cleanup integration in RootApp

1. Import `CleanupConfirmation` from `./CleanupConfirmation`.
2. Keep a global cleanup-open UI state and intercept every renderer dispatch of `cleanResidue` to open it. This includes maintenance and the `staging-left` issue group's cleanup button.
3. Mount `<CleanupConfirmation residue={state.residue} busy={busy} act={rawAct} onCancel={() => setCleanupOpen(false)} />` while open. `rawAct` must be the actual backend dispatcher, bypassing that interception. `busy` must preserve the existing paused/queued jobs, review, organization and duplicate locks.
4. The component dispatches exactly `{type:'cleanResidue'}` on explicit confirmation only, then calls `onCancel` to close. Busy/checking/not-yet-checked state disables confirmation, and the dispatch guard checks those values too. Cancel receives initial focus through the existing shared confirmation sheet.
5. Keep the existing maintenance diagnostic body if preferred; its ordinary `act` should remain intercepted. The optional `ResidueMaintenance` export provides a preview/control surface, receipt actions and progress, but is not required for integration.
6. Append exported `safetyTranslationRows` from `./safety-translations` to the shared pipe-separated i18n rows before catalog parsing. All new category/consequence/Stop strings have Simplified Chinese, Traditional Chinese and Japanese translations.
7. Import-specific controls send `{type:'stop',scope:'imports'}`. Existing global Stop all retains `{type:'stop'}`, and job cards keep `{type:'stop',jobId}`. Tooltip: “Stops queued, paused and running media imports and file backups. Scans, reviews and library tools continue.”

The cleanup preview separately shows ordinary leftovers, resumable staging, kept staging, old receipts and retained complete recovery copies. Estimated removable counts exclude both receipt-only entries and retained copies. Estimated removable bytes exclude retained copies; unbound receipts carry zero bytes in the existing backend. Receipt rows never claim that referenced files or their bytes are removed. Counts are the latest scan's estimate; the existing backend rescans and checks each candidate when cleanup runs. No cleanup engine changes were made.

The component reuses the shared Button/ConfirmSheet/progress implementation and the existing organization-paths layout class; no RootApp, i18n or CSS edits are part of this worker's delta.

## Validation

- New safety tests: 13/13 passed after the registry and locale checks.
- Broader focused run before those final additive tests: 59/59 passed across stop-scope, source-modes, cleanup-confirmation, residue, residue-unbound, stopping-state, folder-sources, check-folder-layout and folder-check-label. This includes actual filesystem assertions that unbound named files remain untouched and complete recoverable copies survive both cleanup paths.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- Parent runs the integrated full suite, build and Electron UI/keyboard/narrow-window QA. This worker did not run the full suite, launch real transfers, commit, push, install or change the primary checkout.

## Changed paths relative to the captured baseline

- desktop/main.ts
- desktop/shared.ts
- desktop/stop-scope.ts (new)
- desktop/source-modes.ts (new)
- desktop/renderer/CleanupConfirmation.tsx (new)
- desktop/renderer/safety-translations.ts (new)
- desktop/tests/stop-scope.test.ts (new)
- desktop/tests/source-modes.test.ts (new)
- desktop/tests/cleanup-confirmation.test.ts (new)
- docs/ui-safety-implementation.md (new)
