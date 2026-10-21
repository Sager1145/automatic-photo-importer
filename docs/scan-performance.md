# Source inventory, verified planning, and folder backups

## Two separate stages

`ImportEngine.inventory` recursively enumerates regular-file attributes (type, symlink flag, size), classifies filename extensions, and associates companions within their source directory. It returns counts, included bytes, unknown extension counts, and entry inclusion decisions. It never opens a media file, computes a content hash, invokes the metadata provider, or writes to source/destination. Discovery progress is emitted initially and every 256 regular files, then classification and finished events. These counts are a preview, not duplicate detection or a guarantee that bytes have been backed up.

`plan` freshly inventories the source, validates source/destination containment, reads metadata for included recognized media, SHA-256 hashes included files, and verifies existing destination contents. Inventory is not accepted as a trusted transfer plan. Execution retains source rehashing, staged-copy hashing, exclusive publication, destination identity/containment checks and final digest verification. Copy mode retains originals. Destination files are never removed because they vanished from the source. The existing separate reorganization workflow retains its reviewed move semantics; folder backup cannot use that mode.

## File policy

Normal camera import includes recognized photo/video extensions and associated sidecars. `NIKON001.DSC`, unrelated files, and orphan sidecars default to excluded unknown files. RAW/JPEG/HEIF metadata disagreement and ambiguous RAW companions retain the previous conservative treatment. Same-stem videos retain independent identities. A sidecar with multiple possible video originals remains unknown unless explicitly routed.

Sony `PRIVATE/M4ROOT/CLIP` is reached through ordinary recursive traversal. XML names matching `C<digits>M<two digits>.XML` associate with exactly one same-directory `C<digits>` video. The XML inherits the video's capture metadata and video destination folder, including media-separated layouts. A collision retains association: `C0001-<digest>.MP4` / `C0001-<digest>M01.XML`. No Sony XML contents need to be read for inventory.

`UnknownFileRules` is Codable and Sendable. Initial and decoded keys normalize case and surrounding dots/whitespace; its public subscript applies the same normalization for updates. `.ignore` is the default. `.customFolder("Camera Extras/Settings")` explicitly includes unknown files with that extension beneath the selected destination, independent of camera/date template. The core validates rules at inventory/planning boundaries, including decoded rules. Empty, absolute, traversal, dot/empty components, backslash, colon, control characters and ambiguous surrounding component whitespace are rejected. Destination containment and symlink checks still apply. Rules do not override recognized-media classification.

The distinct drive-backup configuration is `preserveSourceStructure: true` with `.copy`. It includes every enumerated regular user file, including unknown extensions, extensionless files, and hidden user files, preserving source-relative folders. Templates and media separation are ignored, and no camera metadata provider is invoked. Each backup file has an independent allocation family. Existing different destination contents receive a collision-safe sibling; neither those contents nor destination extras are deleted. Identical contents are verified and skipped. Empty directories and filesystem metadata beyond the existing copied file dates are not replicated; this is a file backup, not a disk image.

Both workflows skip symbolic links (files and directories, without traversal), non-regular entries, AppleDouble names beginning `._`, and these case-insensitive filesystem artifacts at any level: `.fseventsd`, `.Spotlight-V100`, `.Trashes`, `.TemporaryItems`, `.DS_Store`. Hidden user files otherwise remain available to camera rules and are included in folder backup. Reorganization retains its existing hidden-file exclusion. Hard-linked regular files are copied as independent paths; hard-link topology and extended filesystem attributes are not reconstructed.

## Primary-source research

Sources inspected 2026-10-20; no external implementation code was copied.

- [Rapid Photo Downloader scan.py](https://github.com/damonlynch/rapid-photo-downloader/blob/main/raphodo/scan.py): `process_file` lowercases the extension and classifies it with `fileformats.file_type`; filesystem candidates use `os.stat` for size/mtime. Its scan also extracts representative metadata for timezone/sample needs. This supports extension/attribute discovery as a separate concern; it does not mean Rapid Photo Downloader never reads metadata during a scan.
- [darktable import.c](https://github.com/darktable-org/darktable/blob/master/src/libs/import.c#L730-L871): import enumeration requests name/display name, modification time, hidden flag and file type asynchronously with `G_FILE_QUERY_INFO_NOFOLLOW_SYMLINKS`. The callback handles recursive folders and applies `dt_supported_image` before adding candidates. Library duplicate hints and thumbnail handling are separate operations. This informed lightweight enumeration and delayed expensive work.
- [Adobe Lightroom Classic camera/card import workflow](https://helpx.adobe.com/lightroom-classic/desktop/import-photos/importing-photos-lightroom-basic-workflow.html): documents a preview/selection stage, photo/video sorting, copy including sidecars, and suspected-duplicate filtering. Adobe does not expose its scanner algorithm, hashing strategy, or concurrency in that page. We infer a useful product separation between discovery and import; we do not claim implementation equivalence or comparative Lightroom speed.

## Local read-only measurements

Measured 2026-10-20 on this arm64 Mac, with the current core compiled using `swiftc` default optimization (no `-O`). Three sequential inventory calls per mounted camera-card root, followed by SHA-256 of the first three included files smaller than 64 MiB. Output contains aggregate counts only. No source or destination files were created, renamed, moved, or deleted; no app was stopped. The older app may have been copying concurrently. OS/filesystem caches were not flushed, so the first call is **not** a guaranteed cold-cache result. No full-card hash was run.

| Camera card | Regular files | Media | Unknown | Included bytes | Inventory seconds, runs 1 / 2 / 3 |
| --- | ---: | ---: | ---: | ---: | --- |
| Nikon card 1 | 969 | 967 | 2 | 29,826,638,774 | 3.4275 / 0.1435 / 0.2427 |
| Nikon card 2 | 6,778 | 6,773 | 5 | 44,241,505,036 | 0.5989 / 0.2530 / 0.2354 |
| Other mounted camera card | 134 | 132 | 2 | 7,453,896,873 | 0.0404 / 0.0069 / 0.0066 |

No associated sidecars occurred in these card inventories; Sony behavior is covered by disposable fixtures. Bounded hash samples were respectively 88,500,490 bytes / 0.3879 s, 16,464,787 bytes / 0.1022 s, and 55,262,402 bytes / 0.3549 s (three files each). Those samples illustrate content-I/O cost only; they are not full-plan timings or a claimed speedup ratio. Initial discovery now avoids reading tens of gigabytes simply to show counts. Complete plans and verified copies still incur their necessary content reads.

Reproduction: compile the core with an async Swift `@main` executable in a scratch directory, time three calls to `try await ImportEngine().inventory(source: URL(fileURLWithPath: selectedCardPath))`, and report `entries.count`, `mediaCount`, `sidecarCount`, `unknownCount`, `includedCount`, and `totalBytes`. Use only read-only inventory/digest APIs on real cards. The measured scratch executable and aggregate output were `/private/tmp/scan-benchmark` and `/private/tmp/scan-benchmark-results.txt`.
