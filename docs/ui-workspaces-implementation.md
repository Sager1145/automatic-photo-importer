# Workspace implementation — 2026-10-23

Implemented in branch `codex/ui-workspaces`, worktree `/Users/sager/.codex/worktrees/ui-workspaces/automatic-photo-importer`. No commits, pushes, installs, or primary-checkout edits.

## Final integration refinements

The combined branch preserves the user's original visible information. It restores direct overview and destination activity, visible SourceSteps/capacity, backup Scan media and complete Activity job context with working inventory/metadata. Density comes from horizontal arrangement and smaller whitespace. It also adds explicit snapshot ordering, grouped destination actions, and visible duplicate recovery roots. The initial worker behavior and integration handoff below describe this worker's scoped delivery; [the consolidated audit](ui-audit-2026-10-23.md#next-phases-implementation) records the final result and verification.

## Behavior

- Primary navigation is Import, Library tools and Activity; Settings is a separate bottom anchor. Devices remain in Settings; the old exported DrivesPage is retained for compatibility but is not a primary destination.
- Import has Media and Files & folders tabs. Each chooses the existing engine's appropriate folder-picker mode; navigation dispatches no filesystem actions or preference changes. Published source mode describes the next run; `job.backup` and `review.backup` remain authoritative for existing work. Global Start explicitly says **Start all selected**, since its existing backend scope includes both media and backup sources.
- Library tools has Organize and Duplicates tabs. Organization destination, affected photo/video roots, selected folders and move consequences precede one Review/Organize action area. Folder organization also states its consequences before its picker. Duplicate Scan/Stop lives only under its content scope; the titlebar no longer duplicates Library execution controls.
- A pending review renders only in its owning Import mode or Library Organize tab. Other contexts show an Open pending review link. Review loading derives its owner from the engine's review source ID; prepared reviews derive ownership from their immutable kind/backup fields.
- Activity has Jobs, History, Issues and Recovery tabs. Jobs retains controls for mixed media, backup and organization jobs. Issues embeds the complete existing resolution view and supports source/destination filtering. Recovery reuses organization controls and duplicate-specific RemovedDuplicates controls with original IDs/actions; maintenance reuses LeftoverFiles. History remains text-based with no invented operation IDs.
- Add folder is in the source heading. Overview totals and repeated destination utilization are under Details; source stage telemetry is in its existing Details disclosure. Destination readiness, path, free space and copy policy remain visible. Parallel-source preference editing is left to Settings.
- Change destinations requests Settings storage; Edit folder rules requests folders. Requests carry a monotonically increasing key. Tab keyboards support arrows, Home and End with ARIA tabs/panels. Deep links apply mode/category/page changes within the existing guarded View Transition helper.
- Existing manual-only folder checks, review Apply footer, Mirror/fill-first exclusion, per-run organization choices, problem-file review override, paused/queued job controls and destructive confirmations are retained. The saved collectProblemFiles default is removed from Organization because the Settings worker owns its Files-category home.

## Exact files changed relative to the captured common baseline

Changed:

- `desktop/renderer/RootApp.tsx`
- `desktop/renderer/DuplicatesPage.tsx`
- `desktop/renderer/styles.css` — appended workspace rules only
- `desktop/tests/titlebar-pages.test.ts`
- `desktop/tests/consistent-progress.test.ts` — only added OrganizationRecoveryPanel import and switched its recovery-listing rendering case to that component

New:

- `desktop/renderer/workspace-state.ts`
- `desktop/renderer/workspace-translations.ts`
- `desktop/tests/workspace-state.test.ts`
- `desktop/tests/workspace-translations.test.ts`
- `desktop/tests/workspaces-ui.test.ts`
- `docs/ui-workspaces-implementation.md`

The Settings category helpers/SettingsPage block, `desktop/renderer/i18n.tsx` and `desktop/tests/i18n.test.ts` were verified byte-identical to `/private/tmp/ui-next-phases-baseline-files`. Existing dirty files outside this list are copied baseline work, not this worker's changes.

## Verification

- `npm run typecheck`: passed after the final code changes.
- Focused command below: **37 passed, 0 failed** after the final code changes. Tests cover mode ownership, mixed jobs, scope/action ordering, embedded Issues, recovery controls, all four translation columns/placeholders, manual folder checks and motion guards.

```sh
node --import tsx --test desktop/tests/workspace-state.test.ts desktop/tests/workspace-translations.test.ts desktop/tests/workspaces-ui.test.ts desktop/tests/titlebar-pages.test.ts desktop/tests/motion.test.ts desktop/tests/organization-card.test.ts desktop/tests/dashboard-organization-file.test.ts desktop/tests/misplaced-results.test.ts desktop/tests/check-folder-layout.test.ts
```

- An earlier broader focused run including consistent-progress finished **204 passed, 1 failed**: its native filesystem case requires the macOS helper to preserve Created dates, which this isolated worktree does not contain. No helper was installed/built.
- An earlier duplicates-ui run had its catalog completeness assertion fail for **Space held for undo**, as expected before the parent's integration of dedicated translation rows. Other duplicate rendering cases passed. The assertion was not weakened.
- No full suite or Electron QA run by this worker; parent owns integrated verification.

## Integration contracts and QA migrations

- Merge source metadata from the safety worker: optional `Source.backup` must describe registered folder mode during choose/refresh. Unset storage/camera sources default to Media. Existing job/review flags win for those operations.
- Replace temporary `RequestedSettingsPage` adapter and local `WorkspaceSettingsCategory` alias with the Settings worker's exported SettingsCategory/direct component after merging its requestedCategory/requestKey props.
- Add **Stop imports** with `{type:'stop',scope:'imports'}` only alongside the safety backend change; preserve Stop all. This isolated shell does not dispatch the new scope against an old backend that would silently treat it as Stop all.
- Route cleanResidue through the safety worker's confirmation on final integration. This branch deliberately reuses existing LeftoverFiles/actions; it does not introduce a second confirmation implementation.
- Integrate `workspaceTranslationRows` from `desktop/renderer/workspace-translations.ts` into i18n's catalog. It exports pipe-delimited English / zh-Hans / zh-Hant / Japanese rows (29 keys). This preserves source ownership and avoids concurrent edits to i18n.tsx.
- Navigation IDs: `.nav-item[data-page="desk|library|activity|settings"]`. Subtabs: `library-organize`, `library-duplicates`; `activity-jobs`, `activity-history`, `activity-issues`, `activity-recovery`; `import-mode-media`, `import-mode-files`. Tabs use IDs `tab-${testId}` and shared `*-workspace-panel` ARIA panels.
- Migrate shared QA from six pages to the IDs above, from titlebar Organization/Duplicates actions to their content actions, from Organization recovery to Activity Recovery, and from visible overview metrics/source step telemetry to their Details disclosures. Existing source-disclosure-toggle selectors remain.
- Parent may preserve the global quick All errors modal while retaining Activity Issues; this is compatible with the workspace implementation and keeps nested-layer verification available.
