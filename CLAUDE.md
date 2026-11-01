# Automatic Photo Importer

This app is one codebase for macOS, Windows and Linux. Releases today are macOS arm64 and Windows x64; Windows arm64 and Linux x64/arm64 are planned (`release-targets.json`). Every change must reach all three platforms. Read and follow [docs/cross-platform.md](docs/cross-platform.md) before changing code, and use its checklist when you finish:

- Shared behavior stays in `desktop/core` and `desktop/renderer`; only OS adapters in `desktop/platform/` differ.
- Any `process.platform` branch handles `darwin`, `win32` and `linux`.
- OS-dependent behavior is tested as a feature in `desktop/tests/platform-features.ts`, run by each platform's own test file with that platform's real data.
- Paths written to disk use `/` (`posixRelative`); tests must not hard-code a separator.
- New user-facing text needs all four languages in `desktop/renderer/i18n.tsx`.
- If a change cannot reach an OS yet, add it to the doc's "Known gaps" table.

Build and test commands for each OS are in the doc.
