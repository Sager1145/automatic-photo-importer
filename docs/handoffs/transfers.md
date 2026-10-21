# Transfers & destinations — READY, ownership released

Final status, 2026-10-20: **READY for parent/UI integration and packaging.** Transfer chat has finished editing its owned files. No remaining dependency or blocker. The parent may review/integrate these files. No commits, pushes, packaging, real imports, old-app relaunches, or real-media changes were performed.

## Owned changes

- `Sources/PhotoImporter/ImportModel.swift`, `DriveJob.swift`
- `Sources/CameraAdapters/DestinationRouting.swift`
- `DeviceDiscovery.swift`: multiple destination exclusion only; preserved existing adapter work.
- `Tests/CameraAdaptersTests/DestinationRoutingTests.swift`
- `Tests/TransferModelChecks.swift`: standalone preference compatibility checks, to avoid changing the shared package graph.

Core/scanner and UI files were not edited. The parent subsequently added `IntegrationTests` in Package.swift independently; the final full test run includes those tests.

## Exact UI contract

Preferences: `destinationMode: DestinationMode` (`.single`, `.mirror`, `.sequential`), `maxConcurrentSources: Int` (default 2, clamped 1...5), `secondaryDriveLabel`, `unknownFileRules`.

Destinations: `secondaryDriveURL`, `secondaryDestination`, `chooseSecondaryDrive()`, `removeSecondaryDrive()`; existing primary APIs remain. Both selected volumes are excluded from automatic source discovery, including when the second destination is currently unused.

Scheduling: `startImports()`, `cancel()` (Stop), `setAutomatic(Bool)`, `updateConcurrency()`, `queuedSources: [ImportSource]`. Start explicitly queues connected/manual folder sources with Automatic off. Manual requests promote already queued automatic entries. Automatic off removes only automatic queue entries and keeps active work. Stop clears the entire queue, cancels active work, and marks connected sources seen, preventing immediate auto restart. A real disconnect/reconnect or Start permits another attempt. Lowering concurrency does not cancel active work.

Preview: `previewPlans: [ImportPlan]` exposes **all destination plans**. `previewTransferCount`, `previewVerifiedCount`, `previewCopyBytes` aggregate them. Legacy `plan` remains the first target for compatibility. **Use `previewPlans.allSatisfy { $0.entries.isEmpty }` or aggregate counts when enabling copy / reporting empty results**: sequential mode can validly have an empty first plan and nonempty second plan. Manual model status now handles this correctly.

Discovery: `inventory: SourceInventory?`, `scanProgress: SourceScanProgress?`, `DriveJob.inventory`. Inventory runs before metadata/digest work; subsequent planning status explicitly labels verification separately.

Unknown rules: `setUnknownRule(extension: String, folder: String?, remember: Bool)`. nil folder means ignore. The normalized core rule subscript is used. Remember persists only the selected extension, preserving other session-only choices in memory. Updating a rule invalidates the verified preview and retains the lightweight inventory; rescan to review the changed plan. Core validates routing paths before import.

Backup: `chooseBackupSource()` / `startDriveBackup()` open the dedicated all-file folder chooser. `scan(source:automatic:mode:preserveSourceStructure:)` remains source compatible; new final argument defaults false. Backup uses `.copy` + `ImportConfiguration.preserveSourceStructure = true` through inventory and both target plans. `isDriveBackup` exposes current manual intent. Backup selection is deliberately not added to the ordinary media-import folder queue. It never reorganizes or propagates deletion. Scanner policy includes regular hidden/unknown user files, excludes source symlinks and explicit OS/AppleDouble artifacts; see scanning handoff.

## Routing and integrity

Each target is independently planned and content-verified by ImportEngine. For multiple targets, source IDs and digests must agree between plans; changed contents fail before any copying. Mirror completes only after both full plans succeed. Individual target/family failures retain destination context in `ImportResult.failures`; successful copies remain present, originals remain intact, and retry verifies existing copies. Manual/job status explicitly reports incomplete mirrors instead of successful completion.

Sequential mode allocates ordered whole file families across the two plans, first disk until the next complete family will not fit, then second disk. Only non-skip bytes consume capacity. `selectingSources` uses actual entry IDs and preserves the scanner's complete-family safety. It is file/family overflow, not whole-source routing.

Capacity is reserved per destination volume across concurrent jobs on MainActor without suspension during allocation. A separate tested ledger deducts other jobs' pending bytes. As writes progress, their bytes are removed from reservations because measured free space already reflects them; this avoids false-full errors from double counting. Reservations release after completion, failure, cancellation, preview discard/replacement, or invalidation. Other applications may still change free space; safe core write failures remain authoritative.

Dual destinations require both different volume UUIDs and disjoint physical disk sets. Read-only `diskutil info -plist` resolves APFS physical stores to their whole disks, rejecting two APFS volumes/partitions on the same physical storage. Uninspectable/network/virtual disk identities fail explicitly. Destination camera/card protection runs at selection/configuration and immediately before execution. Core also revalidates saved destination identity and safe contained paths.

Directory-picker setup containment regression is **fixed and green**. Foundation canonicalizes existing `/private/tmp/` to `/tmp/` but may leave an as-yet nonexistent child at `/private/tmp/photobackup`; even a naive component comparison fails. `DestinationRouting.containsDestination(_:within:)` now uses POSIX realpath on the nearest existing ancestor and appends missing components. Tests cover trailing-slash directory URLs, /tmp aliases, equality, and similarly prefixed sibling rejection. The parent's earlier failing observation was the red/intermediate version; final evidence below passes.

Copy workflows never delete source originals or destination extras. Cleanup in the model is limited to its uniquely generated temporary camera staging directories. Existing real files, including the previously misclassified DSC copy, remain untouched.

## Final verification

Final full repository command exited 0 and built the app:

```sh
CLANG_MODULE_CACHE_PATH=/private/tmp/photo-transfers-clang \
SWIFTPM_MODULECACHE_OVERRIDE=/private/tmp/photo-transfers-swift \
swift test --disable-sandbox --scratch-path /private/tmp/photo-transfers-build
```

Evidence: `/private/tmp/photo-transfers-final-tests.log`: **3 integration + 33 core + 55 adapter tests = 91 passing tests**, zero failures. This includes the final setup containment fix, scheduler policy, physical-disk set validation, whole-family allocation, and concurrent capacity accounting. Manifest cache warnings are sandbox/cache availability warnings, not build/test failures. No production code was changed after this successful run.

Standalone app-owned preference checks were freshly compiled against the final model and the resulting binary exited 0. They verify legacy bookmarks/template/base-path/Automatic settings survive missing new keys; default concurrency is 2; out-of-range decode clamps 1...5; and dual-destination bookmarks/mode/rules round-trip. These checks instantiate no ImportModel/discovery and launch no app.

```sh
swiftc -swift-version 6 -parse-as-library \
-I /private/tmp/photo-transfers-build/out/Products/Debug \
-module-cache-path /private/tmp/photo-transfers-swift \
-o /private/tmp/photo-transfer-model-checks \
Sources/PhotoImporter/ImportModel.swift Sources/PhotoImporter/DriveJob.swift \
Tests/TransferModelChecks.swift \
/private/tmp/photo-transfers-build/out/Products/Debug/ImporterCore.o \
/private/tmp/photo-transfers-build/out/Products/Debug/CameraAdapters.o
/private/tmp/photo-transfer-model-checks
```

Direct swiftc compilation required managed escalation for the Swift Observation macro plugin's nested sandbox; normal scratch SwiftPM build/test succeeded without that escalation. Grok was not retried after the documented 402 exhausted-balance failure. No nested agents/chats were created.

Physical unplug/full-volume behavior was not exercised against real disks. Routing/capacity/failure safety uses disposable fixtures and the core verification tests; parent owns final UI smoke tests and packaging.
