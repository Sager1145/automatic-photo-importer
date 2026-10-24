# Consolidated Settings implementation

Implemented in `codex/ui-settings`, using the captured manual-only folder-check baseline.

## Changed files relative to captured baseline

- `desktop/renderer/RootApp.tsx`: only category helpers and SettingsPage. Seven categories in order: general, storage, folders, defaults, files, devices, performance. Exported SettingsCategory/settingsCategories; requestedCategory/requestKey select and focus via the existing category transition path. General opens without a saved/requested selection. Legacy importing/destinations/organization/drives map to defaults/storage/files/devices, and unknown IDs safely use General (including inherited object-property names).
- `desktop/renderer/styles.css`: scoped category-name wrapping for long translations and larger text.
- `desktop/renderer/settings-translations.ts`: four-locale pipe rows exported as settingsTranslationRows for parent integration.
- `desktop/tests/settings-categories.test.ts`: category ownership, initial requests, persisted-category migration/fallback, no cleanup or automatic layout policy, and live versus locked grouping.
- `docs/ui-settings-implementation.md`: this report.

## Control ownership

General retains language, text scale, appearance/accent, and import overview. Storage retains replication/destination paths. Folders retains builders, templates, edited exports, and conflict naming. Defaults contains automatic import, verification, file-error continuation, and backup behavior. Files contains metadata, unknown-file rules, saved problem-file collection, and AppleDouble handling. Devices retains remembered and ignored devices. Performance contains live import parallelism, locked CPU/memory limits, and live diagnostics.

All existing preference values, dispatches, range limits, fieldset locks, visible lock notices, keyboard navigation, tab/panel IDs, and category transition kinds are preserved. No manual cleanup remains in Settings. No Off/Ask/Automatic folder-layout preference is introduced. Per-run organization/review options remain outside Settings.

## Integration

1. Append settingsTranslationRows to the central i18n rows before catalog parsing; i18n.tsx was deliberately not edited here. Until this wiring, new category labels use the existing English fallback in other locales.
2. Remove the duplicate saved collect-problem-files-setting control from OrganizationPage in the workspace branch. Keep the per-review collect-problem-files-review control.
3. Wire requestedCategory and increment requestKey for each new category-navigation request. The effect handles a repeated same-category request after local tab changes while Settings is mounted; initial render prioritizes a request over storage.
4. Update the old i18n category/location assertions and cleanup tests to the new ownership. Existing diagnostics-settings.test.ts has a source assertion expecting Diagnostics under General; check-folder-layout.test.ts expects a settings-panel-organization that no longer exists. These were left to parent integration under the file ownership contract.

## Verification

- Regression tests were written first and failed against the previous six-category implementation; the problem-file default and inherited-property fallback also failed before implementation/fix.
- `npm run typecheck`: passed.
- Focused 22 tests: all passed in settings-categories, settings-lock-notice, settings-lock, performance-settings, conflict-naming-settings, no-metadata-settings, folder-source-gate.
- A broader 33-test selection: 31 passed; the two failures are the moved-location assertions described above. Remaining diagnostics and manual folder-check behavioral tests passed.
- `git diff --check`: passed.
- Full npm test intentionally deferred to parent. No commits, pushes, installs, primary checkout edits, or filesystem operations started through the application.
- Mounted request focus/keyboard behavior, translated new labels, and responsive/animation rendering require the integrated Electron QA. The unit tests verify static initial requests and migration, not browser focus after an update.
