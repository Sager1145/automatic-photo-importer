# Codex testing

Use the Electron fixture harness for integration checks without connecting a camera or choosing a real backup drive. Run commands from the repository root after `npm ci`.

## Choose a test mode

```sh
npm run codex:test
npm run codex:test -- --organization-only
npm run codex:test -- --ui-only
```

| Mode | Coverage |
| --- | --- |
| Default full run | UI checks, read-only source scanning, bulk-copy queue and Stop/retry, duplicate verification, organization and recovery, and fixture-byte preservation. |
| `--organization-only` | UI and language checks, read-only source scanning, organization with changed folder settings, recovery recheck, and repeated Apply/Resume requests. Skips the bulk-copy queue/retry scenario. |
| `--ui-only` | UI, language, read-only scan and fixture-preservation checks. Skips both organization/recovery and bulk-copy scenarios. |

The command builds the app, creates a unique temporary fixture root and isolated Electron user data, runs the selected self-test, and exits. Automated runs have a three-minute deadline and report launch failures. The full transfer scenario uses six folder sources, five concurrent transfers and a queued sixth source.

For a repeat against an already built app, add `--no-build`:

```sh
npm run codex:test -- --no-build --organization-only
```

Omit `--no-build` after changing source code. Otherwise the run tests the existing build rather than the current source.

## What the checks exercise

The UI checks cover System as the default appearance, live OS theme changes, explicit Light/Dark controls, the dashboard's source and destination counts, Settings, live and persisted text size, and native macOS traffic-light controls. Text size ranges from 100% to 150% and defaults to 125%. All four language choices switch live and persist: English (`en`), 简体中文 (`zh-Hans`), 繁體中文 (`zh-Hant`) and 日本語 (`ja`).

Read-only scanning checks that a fixture's actual PNG and MP4 formats appear with media-only totals and that scanning does not create a copy job. Other files and companions are excluded from these media totals. The app publishes the fast inventory before its separate read-only metadata analysis. Focused backend tests cover multiple camera models on one source, normalized names, unknown metadata, cancellation, and the separation of drive/format/layout hints from confirmed models.

Organization checks scan the whole first selected destination, change the backup folder, compare the saved source and target roots, apply the review, and recheck its recovery journal. Concurrent repeated Apply and Resume requests must create only one corresponding job. This scenario uses only disposable fixture media. See [Organization and recovery](organization-recovery.md) for the storage and resume contract.

The default full run also exercises queue limits, Stop/retry, actual copies and duplicate verification. Source hashes and an existing destination marker are checked to confirm their bytes remain intact.

## Retained evidence

The harness prints its temporary root and retains results in its `artifacts/` subfolder:

| File | Purpose |
| --- | --- |
| `report.json` | Selected suite, individual check results and overall result. |
| `state.json` | Captured app state for diagnosis. |
| `light.png`, `dark.png`, `system.png` | Appearance screenshots. |
| `dashboard.png` | Source and destination dashboard. |
| `drive-details.png` | Scanned source details. |
| `settings.png` | Settings page. |
| `language-en.png`, `language-zh-Hans.png`, `language-zh-Hant.png`, `language-ja.png` | Language screenshots. |
| `queue.json` | Queue-state evidence from the full transfer scenario. |

The 2026-10-20 integrated build passed 125 backend tests and all 13 full Electron checks. The current report is:

```text
/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-Tajup8/artifacts/report.json
```

Logs are retained in `build/hardware-a006/unit-tests-final.log` and `build/hardware-a006/electron-final.log`. The focused organization run also passed; the backend suite includes interruption during organization finalization. Use `npm test`, `npm run build` and the selected Electron run after later changes. Real-card import results, A006 maintenance and the separate Sony empty-marker identity exception are recorded in [hardware verification](hardware-a006-20261020.md).

The later compact metadata update passed **133 backend/unit tests and 14 full Electron checks**. Logs: `build/hardware-a006/unit-tests-metadata-ui.log`, `build-metadata-ui.log`, and `electron-metadata-ui-final.log`; JSON report: `/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-rXaNR4/artifacts/report.json`. The new check covers readable wall-clock date/time, separate timezone, exposure units, initially hidden technical fields, visible disclosure, click-to-expand, per-file reset and video shutter-counter suppression in all four languages. The existing double-resume check exposed and verified the fix for overlapping recovery requests.

The subsequent [failure-mode audit](failure-modes-20261020.md) passed **159 backend/unit tests, 15 full Electron checks and three actual exFAT disk-image failure checks**. It adds deterministic filesystem errors, real parent-issued SIGKILL and force-detach/retry tests on disposable mounted images. Ordinary import publication now flushes directory bindings before acknowledging completion, and concurrent base-folder creation uses the core's existing safe creation path. Latest app report: `/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-UI4oiS/artifacts/report.json`; logs are in `build/failure-modes/`. These checks do not certify electrical power-loss behavior of a physical drive/controller.

Fixture mode uses temporary inputs, destinations, preferences and history. It does not use real volumes as copy targets or use the regular app's user data. The harness calls Electron integration directly, with no network test server or broad control port.

## Visible app for Codex UI inspection

```sh
npm run codex:qa
```

This command builds and opens a visible app with its own fixtures and user data. It prints the fixture root and stays open without the automated deadline. Inspect the source scan details, queue, import controls, organization review/recovery and Settings, including languages and text size. Close the fixture window or stop its terminal process when finished. Temporary output remains available.

Do not substitute real sources or destinations when repeating fixture QA. Folder-fixture checks do not establish USB camera hardware support, real power-loss durability, or Windows/Linux binary coverage. The content UI is shared, while window chrome follows the host platform.

## Architecture regression checks (2026-10-20)

`npm test` now includes multi-destination allocation and execution regressions: first-disk identity/publication failure still attempts the healthy destination, global Stop prevents the next disk, actual progress excludes failed work, and restoring a reviewed duplicate increases the work total. It also covers linear sequential allocation, recovery entry indices and unchanged camera/date routing with compact metadata normalization.

Run `node Scripts/test-inventory-render.mjs` to mount the real inventory component in a disposable Electron fixture. It verifies 500 rows do not rerender for ten progress-only parent updates, while language changes, inventory replacement and search still update. The counter exists only in that fixture. Reports stay under `build/inventory-render-*`.

Reproduce copy read counts with `Scripts/measure-transfer-io.mts`; it uses generated temporary content and counts actual file reads, rather than claiming physical-device speed. The consolidated interface/feature audit and current validation evidence are in [architecture and features](architecture-and-features.md).


Compact-card UI verification: 12 focused UI/localization checks, production build, and 10 Electron UI checks passed. Six source cards begin collapsed; each detail menu opens independently, collapsing preserves scan results, and controls fit at125%/150% text. Default125% collapsed fixture rows measure117.56px. Report: `/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-Rwxsq3/artifacts/report.json`; measurements and compact/expanded screenshots are in that artifact folder. Tests used temporary fixtures and did not modify hardware media.


Use `npm run codex:test -- --ui-only --reduced-motion` to launch isolated fixture QA with Chromium’s reduced-motion preference. The suite verifies motion preference, grid/list persistence and narrow-window adaptation, per-format capacity segmentation and pie-chart removal, dedicated format decisions, dialogs and unchanged fixture originals.

## Requirement audit and transfer update (2026-10-20)

The [complete requirements audit](user-requirements-verification.md) covers all 243 current requirement IDs, including the later DJI LRF, filesystem capture-date and copy-phase requests. The integrated backend suite passes 268 tests and the production build passes. New regression files are `dji-lrf.test.ts`, `file-timestamps.test.ts` and `copy-phases.test.ts`; allocation/destination tests cover publication workspace.

The fresh full Electron fixture run has 13 passing checks and one failing edited-export Settings persistence/restoration check; it stops before later scenarios. Older successful runs above remain historical evidence. Logs and reproduction receipts are in `build/requirements-verification/`. No real A006 or camera-card files were changed by this audit.
