# Shared desktop implementation

The active frontend is React + TypeScript, rendered by Electron's bundled Chromium on macOS, Windows and Linux. It is implemented in `desktop/renderer` and uses one CSS/token system, local Inter font files and Lucide SVG icons. The workbench layout is shared. macOS uses native close, minimize and fullscreen traffic-light buttons in a draggable title bar; Windows/Linux retain shared window controls. Filesystem dialogs and system-level menus remain OS adapters.

The shared Node filesystem backend implements discovery and verified copies on all three platforms. Mounted-volume enumeration has macOS diskutil, Linux lsblk/mountinfo and Windows PowerShell adapters. Detailed metadata and previews use bundled ExifTool through exiftool-vendored. Native camera protocols remain platform capabilities; the existing ImageCaptureCore implementation is retained through a macOS helper. Linux/Windows camera-protocol integrations are not claimed merely because the frontend can run there.

Current validation host is macOS arm64. The repository includes Windows/Linux build targets but those binaries have not been built or hardware-tested in this session; UI parity on those systems is a shared implementation property, not a claim of completed OS test coverage.

The previous SwiftUI app and its Swift core were removed after the migration (see [historical implementation](legacy-implementation.md)); only the macOS ImageCaptureCore camera bridge remains native. The older running real-media importer must not be quit or relaunched during development. Shared-app QA uses `--qa` with isolated user data, Automatic off and disposable fixture destinations only. Real drives are read-only for integration checks.

## Design references

- Lightroom Classic: left source, central review and right destination information hierarchy, [Adobe import workflow](https://helpx.adobe.com/lightroom-classic/desktop/import-photos/import-photos-video-catalog.html).
- darktable: a clear places/file-list/preview hierarchy, [import documentation](https://darktable-org.github.io/dtdocs/en/module-reference/utility-modules/lighttable/import/).
- digiKam: distinct camera, mass-storage, reader and folder sources, [import interface overview](https://docs.digikam.org/en/import_tools/import_overview.html).

The implementation reuses these established interaction patterns, with original controls, layout, color tokens and assets. It does not copy another app's brand artwork.

## Codex integration and readability

`npm run codex:test` runs a bounded Electron integration suite on unique temporary fixtures and retains JSON reports, state snapshots and theme/Settings screenshots. `-- --no-build --ui-only` provides a shorter UI check; `npm run codex:qa` opens an interactive fixture app. Normal launches continue to enumerate real camera volumes. See [Codex testing](codex-testing.md).

Settings provides a live 100–150% text-size slider with a 125% default, persisted System/Light/Dark appearance, accent, Automatic and source concurrency controls. Native macOS chrome follows the chosen appearance.
