# UI information preservation — 2026-10-23

Comparison baseline: `7eee02c` plus the captured manual-folder-check working changes in `/private/tmp/ui-next-phases-baseline-files`. The primary checkout remained untouched. This comparison checks data and working capabilities, including where context moved between tasks; it does not treat a shorter card or a moved tab as permission to omit information.

| Before the reorganization | Final integration | Evidence |
| --- | --- | --- |
| Source name, selection, transport, status, backup/import mode, queue order | Retained on task cards; Activity gets the same context and real queue positions | `information-parity.test.ts`, `workspaces-ui.test.ts` |
| Scan/copy/verify steps; active progress, counts, %, rate, elapsed time, ETA, current file and failures | Retained; stage telemetry and source capacity remain visible when Details is closed | `stage-bars`, `consistent-progress`, live counter and stage/color UI checks |
| Total/used/free capacity, format segments and legend | Retained in the visible source summary and destination card; arranged horizontally when it fits | Information parity and compact-layout checks |
| Utilization, sparkline, read/write rates | Retained in source/destination contexts; destination activity is not behind a new disclosure | Full card props comparison; live UI gallery |
| Source path, drive/shared-capacity context, same-drive and backup-exclusion notices | Retained; Activity restores these props as well | Activity comparison and shared SourceRow implementation |
| Camera/lens names, scanned media types/counts/bytes, known file rules | Retained in the existing source details; Activity receives the complete context | Four-language information-parity and existing media/camera tests |
| Included-file list and per-file metadata | Working in Import and Activity; selecting another job changes the inventory; metadata opens for its selected file | `import-activity-inventory` live Electron check |
| Completed job inventory versus a later scan | Activity displays the job snapshot; it does not substitute a later source inventory | Independent-rescan regression in `information-parity.test.ts` |
| Scan media on folder-backup sources; Scan all | Retained in Files & folders as well as Media | Workspace rendering and import scan UI checks |
| Overview source/active/queued counts, limit, speed, processed files, completed/errors/warnings, ready destinations/free space, activity/read/write, total progress and timing | Visible by default when the user's existing Show overview preference is on; no new collapsed wrapper. Summary notes wrap instead of disappearing | Live counters, density probe, locale/theme matrix |
| Parallel limit slider and current value | Editing lives in Settings → Performance; current value/max remains visible beside the source heading with a direct link | Category tests, visible-summary check, exact Settings link QA |
| Organization roots, selected folders, consequences and review/apply | Retained and placed before execution; reviews stay in their owning workflow | Scope/action ordering and review-ownership tests |
| Duplicate groups, keeper choices, previews, bytes retained, Undo/Release | Retained; recovery cards additionally name their library root | Duplicates regressions and recovery information test |
| Job controls, errors/warnings, filtered paths, recovery and maintenance | Retained in Activity with complete card context. Quick All errors remains available from titlebar/sidebar/toast | Job/control tests, error layers, cleanup UI and recovery tests |
| Saved preferences and devices | Every setting retained across seven named categories; live preferences and busy locks preserved | Independent Settings review, category tests, lock/localization UI checks |
| Existing history text | Retained as text; no operation IDs or durable links invented | History rendering and audit scope |

The shared ProgressDisplay, ProgressSpeed, SourceSpace, SourceSteps, ScanProgress, SourceCameraInformation, SourceMediaSummary, CapacityBar, DriveActivityMeter, OrganizationProgress, OrganizationCard and InventoryPanel implementations were compared with the captured baseline. The major gaps were missing Activity props/callbacks and newly collapsed wrappers; those were corrected. Backup source mode and Stop labels now describe the actual operation explicitly.

User-initiated disclosures and the user's existing Hide overview preference still work. Paths and long file names retain their existing details/title access. Policy controls may remain disabled while work is active. These behaviors are preserved intentionally; density is achieved through layout rather than removing fields.

### Full-width capacity follow-up

The capacity analysis bar spans the full source-card content width, matching destination cards. The full-width bar is followed by one wrapping summary row containing capacity numbers and the complete format legend; activity remains below. The summary wraps only when needed, without truncating values. The compact horizontal capacity/activity split was removed; no values or controls were hidden.

### Responsive verification

A dedicated Electron matrix checks 144 combinations across the supported minimum 1000×720, 1120×800 and 1440×940; 100/150/200% text; all four locales; Import list/grid, Activity Jobs and Settings Storage. Twelve format labels, capacity numbers, Used/Other and Free remain present. Text-fragment geometry checks found zero clipping/overlap failures. The full-width track is also asserted. See the consolidated [evidence](ui-audit-evidence-2026-10-23/README.md#responsive-capacity-matrix-and-handoff).
