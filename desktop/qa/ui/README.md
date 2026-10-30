# UI QA sequence

`npm run codex:test` builds the app, makes temporary fixtures (six folder sources, two destinations) and launches
Electron with `--qa --codex-test`. `desktop/qa/codex-smoke.ts` then runs the checks in `desktop/qa/ui/checks` in
stages, writes a report and exits. Nothing outside the temporary fixture folder is read or written.

```
npm run codex:test                     # full: every stage, with real imports and organizations
npm run codex:test -- --ui-only        # no real copies or organizations
npm run codex:test -- --ui-only --reduced-motion
npm run codex:test -- --organization-only
npm run codex:test -- --only='^rules'  # checks whose id matches (the final checks always run)
```

Set `IMPORTER_NATIVE_BRIDGE` to the built `NativeCameraBridge` when the checkout has no `build/native` (worktrees):
imports need it to preserve Created dates.

## Output

In `<fixture root>/artifacts`:

- `report.md`: every check by stage, its outcome, time and what it covers. `report.json` has the same, plus the run time,
  the load average and the heartbeat summary.
- `failures/<check>.png` and `failures/<check>.state.json`: the window and the app state when a check failed.
- `gallery/{light,dark}/*.png` and `gallery/index.html`: every page, Settings category, the busy desk and the
  grouped errors panel in both themes. `scale-200-*.png`: every page at 200% text in three window sizes.
  `locales/*.png`: the desk in each language.
- `button-widths.json`, `clipped-controls.json`, `locale-problems.json`, `contrast.json`, `heartbeat.json`,
  `stress.json`: the raw measurements behind the rule checks.

## How a check runs

Each check is a named entry (`id`, `stage`, `title`, `covers`) and runs on its own:

- **Baseline first.** Synthetic state and media emulation are removed, sheets and toasts closed, a review discarded,
  the window restored, English at 125%, System appearance, the Import desk. A check never depends on what an earlier
  one left behind.
- **Condition waits only.** `waitFor`/`until` poll a condition; failures say what was awaited and what was last seen.
  Timeouts and budgets stretch with the load average (1 to 3 times). Every renderer call has a 30 s timeout, so a hung
  renderer fails a check instead of the run.
- **Budgets and the deadline.** Each check has a time budget, capped by the time left before the run's deadline
  (`--codex-deadline`, 45 s before `Scripts/codex-test.mjs` kills the app). Checks that no longer fit are reported as
  not run; the report is always written.
- **Failures don't stop the run.** The failure is recorded with a screenshot and the state, the baseline is restored
  and the next check runs.
- **Features not on this build skip themselves** (`skip`, or `SkipCheck` when only the page can tell): detailed logging
  today. It starts checking as soon as the feature is merged. Paused bar colour and layered bars are on `main` and are
  hard checks.

## Stages and standing rules

| Stage | What runs |
|---|---|
| boot | first paint, thread pool, fresh launch, native controls, boot splash gone, logo at every text size |
| navigation | every page and its title-bar buttons, dashboard, page and category transitions, layers during transitions, reduced motion |
| imports | scanning, storage strips, grid/list, metadata sheet, review footer; real runs: Stop, import and re-import, nested folder |
| organization | review progress, apply, one-click, second destination |
| duplicates | scan and group with previews |
| settings | appearance (OS and explicit), text size, languages, edited exports folder, locked settings, detailed logging |
| errors | unknown files, toast on top at 200%, toast above animations and sheets, grouped errors with skip |
| recovery | recovery journal recheck, leftover files counter, window reload |
| rules | sweep of buttons and clipping, dashboard file name, stable stats, paused colours, stage colours, layered bars, live counters, locales, themes and gallery |
| stress | 50,000 grouped errors, 60 running jobs, long file names: navigation under 500 ms |
| final | heartbeat, stall watch, originals untouched |

| Standing rule | Checks |
|---|---|
| No super-wide buttons, at text sizes 1, 1.25, 1.5, 1.6, 1.75, 2 | `rules-sweep` (3 viewports × 6 sizes × 6 pages and 6 categories) |
| Bars shrink and never clip | `rules-sweep`, `rules-locales`, `import-storage-strips`, `import-review-footer`, `rules-layered-bars` |
| Animations stay below popovers and `[data-error-layer]`; errors always on top | `boot-splash-gone`, `nav-transition-layers`, `nav-transition-containment`, `nav-rapid-timing`, `errors-on-top-200`, `errors-above-sheets-and-animations` |
| Every long step shows a live, moving counter | `final-heartbeat` (samples the main process every 250 ms and fails a real step frozen for more than 10 s; a gap between samples is a blocked main thread and counts as frozen time), `final-stall-watch` (`desktop/qa/stall-watch.ts`, fed every state the window receives, polled each second), `recovery-leftovers-counter`, `organization-review-progress` |
| Everything updates (no frozen counters) | `rules-live-counters` (each update must reach the card, the overview total and files, the organization and the sidebar) |
| No file name in the overall dashboard | `rules-dashboard-no-file-name` |
| The file-name row never moves the stats | `rules-file-row-stable` |
| Locked settings greyed out with a tooltip, no error | `settings-locked` |
| Paused bars turn yellow | `rules-paused-steps`, `rules-paused-bar` |
| Stage-coloured (layered) bars | `rules-stage-colours` (an organization stepped through all eight stages: one layer per stage, the top in its colour), `rules-layered-bars` |
| Light and dark mode | `settings-system-appearance`, `settings-explicit-appearance`, `rules-stage-colours`, `rules-themes-gallery` |
| Reduced motion | `nav-reduced-motion-emulated` (every run), `nav-transitions` and `nav-motion-preference` with `--reduced-motion` |
| Four locales without missing keys or overflow | `rules-locales`, `settings-languages`, `import-scan`, `import-metadata` |

## The injection hook

`desktop/qa/hooks.ts` exists only in an unpackaged `--codex-test` launch (`main.ts` creates it there, never exposes it
to the renderer). Checks use it to:

- add synthetic jobs (ids start with `qa:`) in any phase: running, paused, finished with grouped errors;
- set top-level fields (an app error, leftover-files progress) and restore them;
- hold new imports at the start of their discovering phase until released or stopped, so the Stop check always meets
  running and queued jobs (`import-stop`);
- read the live state for the heartbeat without a renderer round trip.

## Flaky checks made deterministic

| Check | Root cause | Now |
|---|---|---|
| Format issues in the error panel; toast in the top layer | `unknownDefault` is a job setting: the main process drops it silently while a read-only scan runs | `Harness.prefs` waits for idle (stopping scans) and resends until the state shows the setting |
| Edited exports folder | the save runs on blur; without OS focus Chromium sends no focus or blur events | the field gets `focusin`, `input`, `focusout` directly, as React listens for them |
| Theme light | every settings change makes the main process reapply the saved appearance to `nativeTheme`, undoing the test's OS theme | the wanted OS theme is reasserted on every poll |
| Stop timing | fixture copies end in milliseconds, so Stop could find nothing running | imports wait at the QA gate; all seven jobs must end Stopped |
| 1920×1200 sweep | a window cannot grow past the screen, so the old sweep silently measured a smaller window | larger viewports are emulated with device metrics |
| Stale screenshots | `capturePage` may return the last composited frame | every capture waits two frames |

## Findings (open)

- **"Existing library"** is named in English by `main.ts` (`previewOrganization`) and shows untranslated.
- **Show in Finder in a locked Destinations fieldset** greys out with its own tooltip instead of the lock reason.
- **A stopped queued organization** keeps an indeterminate bar segment with "Starting…" in the overview.
- **`.inventory-open`** (“4 included files · 8.4 MB ›”) spans its card by design and is exempt from the wide-button
  rule as a list row; worth a look if it reads as a bar.
- **A review can run for over 10 s with no counter at all** on a heavily loaded machine (first preview, before the
  planner reports); seen once in the heartbeat at load ~150.

## Layer and timing regression additions

The containment check reads the generated transition group stacking and finite durations (maximum 300 ms). Rapid navigation checks the final selected page after callbacks finish and opens a sheet mid-transition. The toast-over-sheet check uses real mouse input for Dismiss and View in both opening orders, and closes the sheet while the toast remains alive. Theme contrast now uses 4.5:1 for normal text and 3:1 for large text without the old warning-badge exception. See `docs/ui-audit-2026-10-23.md`.

## Real library browser checks

```sh
npm run codex:test -- --ui-only --only='^browser'
# after an already verified build:
npm run codex:test -- --no-build --ui-only --only='^browser'
```

The `browser` selection automatically enables `--browser-fixtures`. Fixture setup copies 24 genuine PNG/JPEG images into the temporary destination photo root and writes camera/date/exposure tags with ExifTool **before** Electron launches. JPEG generation uses macOS `sips`; these checks currently require macOS. The application scans those files through `catalogRefresh` and real catalog IPC. No UI catalog rows are inserted directly into SQLite.

The checks exercise native trusted drag/drop events, keyboard composition, repeated fields, exact/range/bucket selections, custom preset save/rename/delete and renderer reload persistence, real thumbnails, independent organization navigation, real folders, long paths, light/dark themes at 1000px and 125%/200% text. `browser-media-before.json`, `browser-media-after.json` and `browser-read-only.json` compare the six sources and both destinations (paths, bytes, size, mtime/ctime and organization preferences). Atime is excluded because ordinary reads may update it. Browser-only runs do not apply an organization.

`browser-*.png` and `browser-layout.json` record screenshots, active option rows, mounted hierarchy blocks/columns and available renderer heap metrics. Renderer reload persistence does not prove a packaged-app restart; package verification is recorded separately.

For final-source packaged macOS verification, the same checks can run the actual executable and reuse the first disposable profile on a second launch:

```sh
npm run codex:test -- --no-build --ui-only --only='^browser' --app='/absolute/path/Automatic Photo Importer.app/Contents/MacOS/Automatic Photo Importer'
# Use the fixture root printed by the first run. Preserve its first artifacts before rerunning.
npm run codex:test -- --no-build --ui-only --only='^browser' --app='/absolute/path/Automatic Photo Importer.app/Contents/MacOS/Automatic Photo Importer' --reuse-fixtures='/absolute/temporary/fixture-root'
```

The follow-up browser check first asserts new aperture/ISO/shutter photographic bucket defaults and labels, then explicitly switches to exact mode. Fixture 023 includes genuine f/1.8, ISO 125 and 1/60-second tags before the read-only snapshot. `browser-photographic-defaults.json`, `browser-native-drags.jsonl` and `browser-locales.json` record these observations. Four-locale screenshots are `browser-locale-{en,zh-Hans,zh-Hant,ja}.png`.
