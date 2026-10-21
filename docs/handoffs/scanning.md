# Media discovery and core import handoff — 2026-10-20

## Status: READY for integration

Scanner/core ownership is released. Implementation is in `Sources/ImporterCore/{Models,SourceInventory,ImportEngine,ImportPublication}.swift`; regression coverage is in `Tests/ImporterCoreTests`. Research, measured real-card inventory timings, backup exclusions and safety policy are in `docs/scan-performance.md`.

No UI, application model, adapters, package graph, installed application or real-media files were edited by this chat. No commits, pushes, app restarts, real copies/moves/deletes, or nested workers were performed. Grok was not retried after its recorded balance failure. Preserve other chats' concurrent changes.

## Implemented public contracts

```swift
public enum UnknownFileRule: Codable, Sendable, Equatable {
    case ignore
    case customFolder(String)
}
public struct UnknownFileRules: Codable, Sendable, Equatable {
    public private(set) var rules: [String: UnknownFileRule]
    public init(rules: [String: UnknownFileRule] = [:])
    public static func normalizedExtension(_ value: String) -> String
    public subscript(_ extensionName: String) -> UnknownFileRule { get set }
}
ImportConfiguration(root: URL, template: String, separateMedia: Bool,
                    unknownFileRules: UnknownFileRules = .init(),
                    preserveSourceStructure: Bool = false)

public enum SourceInventoryCategory: String, Sendable { case media, sidecar, unknown }
public struct SourceInventoryEntry: Sendable {
    public let source: URL
    public let bytes: Int64
    public let kind: MediaKind
    public let category: SourceInventoryCategory
    public let included: Bool
}
public struct SourceInventory: Sendable {
    public let entries: [SourceInventoryEntry]
    public var mediaCounts: [MediaKind: Int]
    public var mediaCount: Int
    public var sidecarCount: Int
    public var unknownCount: Int
    public var includedCount: Int
    public var totalBytes: Int64 // included entries only
    public var unknownExtensions: [String: Int] // all unknowns, normalized extension; "" means extensionless
}
public struct SourceScanProgress: Sendable {
    public enum Stage: Sendable { case discovering, classifying, finished }
    public let stage: Stage
    public let discoveredFiles: Int
    public let currentFile: String
}
ImportEngine.inventory(source: URL, mode: ImportMode = .copy,
    unknownFileRules: UnknownFileRules = .init(),
    preserveSourceStructure: Bool = false,
    progress: @Sendable (SourceScanProgress) async -> Void = { _ in }) async throws -> SourceInventory

ImportEngine.plan(source: URL, configuration: ImportConfiguration, mode: ImportMode,
    metadata: MetadataProvider,
    discoveryProgress: @Sendable (SourceScanProgress) async -> Void = { _ in },
    progress: @Sendable (Int, String) async -> Void = { _, _ in }) async throws -> ImportPlan
```

Inventory is read-only attributes/extension classification, with no file content reads, hashes, or metadata provider. It emits discovering initially/every 256 regular files, then classifying and finished. It does not verify duplicate content or confer permission to copy. Planning repeats discovery and retains full hashing and destination verification; execute retains the existing strong verification/publication checks.

`ImportEntry.familyID` is public and stable across independently planned roots. `ImportPlan.selectingSources(_ sourceIDs: Set<String>) -> ImportPlan` retains source, configuration, mode, destination identity and collision data. **Selection expands to the complete family when any member's entry.id is selected**; selecting an empty set returns an empty plan. Callers should use actual `entry.id`, not synthesize IDs from an unresolved source URL (macOS `/var`/`/private/var` aliases can differ). The routing implementation selecting complete families is compatible. Unknown IDs select nothing. Folder backups use independent per-file families.

Unknown rules update through `rules[fileExtension] = .ignore/.customFolder(...)`; keys normalize on initialization, decoding and subscript access. No separate `set` method is needed. Lexical folder validation runs again at inventory/planning, including decoded data; actual destination symlinks/containment are checked during planning and execution. Unknowns default to ignore. Rules only apply to unknown entries, never override recognized photo/video types. To apply edits to the preview, rescan using updated rules.

## Behavior and policy

- Camera import includes recognized photos/videos and associated companions; DSC/unrelated files and orphan sidecars are unknown/excluded by default.
- Recursive Sony video/XML discovery supports `C<digits>M<two digits>.XML` next to exactly one matching video. XML inherits video's capture/camera and video folder. Collision suffix goes before `M01`: `C0001-<digest>.MP4` plus `C0001-<digest>M01.XML`. Multiple possible video originals leave companions unknown.
- Existing contradictory RAW/JPEG/HEIF metadata, ambiguous RAW sidecars, same-stem independent videos, concurrent collision handling, interruption journal and exclusive-publication fallback remain covered.
- `preserveSourceStructure=true` requires `.copy`; includes every enumerated regular user file including unknown/hidden/extensionless files, preserves original relative folders, ignores template/media sorting, skips camera metadata reads. No destination deletion when a source disappears. Existing different content receives a safe sibling filename, identical content is verified/skipped.
- Both inventory modes skip symlinks/non-regular files, AppleDouble `._*`, `.fseventsd`, `.Spotlight-V100`, `.Trashes`, `.TemporaryItems`, `.DS_Store` (case-insensitive service names, at any level). Backup otherwise includes hidden user files. Empty directories, hard-link topology and all filesystem attributes are not disk-image replicated. See performance doc for exact limits.

## Verification

Initial handoff regression tests failed for default unknown inclusion and missing Sony association; this chat first confirmed missing public API compilation, then observed/fixed Sony pairing and source-path alias regressions. Existing tests expecting camera index copying were updated to the intentional default exclusion; source preservation assertions remain. Hidden-user-file preservation now tests the explicit folder-backup workflow.

Full repository command (unique scratch path; no shared build-directory contention):

```sh
CLANG_MODULE_CACHE_PATH=/tmp/photo-importer-clang-cache \
SWIFTPM_MODULECACHE_OVERRIDE=/tmp/photo-importer-swift-cache \
swift test --disable-sandbox --scratch-path /private/tmp/photo-importer-scanning2-build
```

The first full attempt was blocked by the transfer chat's then-missing `makePlans`/`executeTransfers`. A temporary core-only harness independently passed all 32 core tests. Once the transfer implementation was available the full repository built and passed 32 core tests and 53 adapter/routing tests. The final expanded run passed **33 core tests + 53 adapter/routing tests (86 total)**, including Sony collision execution and rejection of unsafe decoded rules. SwiftPM printed cache-access warnings from the managed sandbox; no code compiler warnings were present in the full build.

Read-only real-card measurements: 969 regular files → 967 media; 6,778 → 6,773 media; 134 → 132 media. All other entries were unknown. Largest card inventory took 0.5989 / 0.2530 / 0.2354 s over three calls. Full table, included byte totals, bounded read-only hash samples, caching/concurrent-load limitations and exact primary sources are in `docs/scan-performance.md`. No full-card hash or real copy was run. Scratch evidence: `/private/tmp/scan-benchmark.swift`, `/private/tmp/scan-benchmark-results.txt`, `/private/tmp/scanning-full-final.log` and `/private/tmp/scanning-full-final2.log`. No personal filenames/metadata appear in the public benchmark doc.

UI/transfers owners can integrate now. Final packaging remains the UI chat's responsibility, after checking the other handoff. Do not relaunch the older app against real media.
