# Automatic Photo Importer — macOS implementation

Approved scope: build directly from the user's requirements (2026-10-20).

Native SwiftUI app, macOS 14+, standard visual profile. A split view exposes Import, Organization, and History. A single main-actor model owns setup, discovery, preview, transfer, cancellation, and completion. Heavy filesystem and hashing work belongs to a separate actor. Native controls provide keyboard and accessibility behavior; no custom motion is needed.

First run selects an existing drive/folder using an open panel and stores its security-scoped bookmark. The user chooses a relative backup path, default photobackup. Templates default to {year}/{yyyymm}/{camera}; presets include camera-first and daily layouts, with a custom token option. Optional media subfolders: RAW, JPEG, HEIF, Videos, Other. Camera metadata is derived from RAW first for matching basenames, then each file, then an unambiguous folder model; missing metadata produces visible warnings. Common camera directory structures identify media; import traversal includes all non-hidden regular files on the selected source.

Discovery combines mounted media lifecycle notifications and ImageCaptureCore camera catalogs. Protocol cameras stage originals locally, then enter the same metadata/verification pipeline as cards. No source originals are deleted by importing. Camera-protocol support is bounded by macOS and actual device capabilities; proprietary wireless/network protocols are outside this version.

A scan produces an immutable preview containing hashes, planned destination paths, actions and warnings. Imports verify existing destination contents and copied contents with SHA-256. A different file with the same name receives a deterministic hash suffix. Reorganization scans only the selected backup library; the user reviews the preview and explicitly applies moves. Copies are verified and finalized before old library entries are removed. Identical duplicates in wrong folders are retained and identified as already verified, avoiding surprise deletions. Cancel leaves completed files intact; a fresh scan resumes by content checks. Interrupted hidden staging files are not interpreted as complete imports.

Verification seam: plan and execute operations against real temporary filesystem fixtures with an injected metadata provider, testing visible destination contents and preserved originals. Cover repeat imports, collisions, stale previews, traversal, symlinks, sidecars, content changes, and reorganization. Adapter metadata tests use real ImageIO-created fixtures where feasible. Physical hardware checks remain explicitly documented when no camera is available.

Build a SwiftPM executable and ad-hoc signed .app bundle. Do not commit, push, or publish without task-specific authorization.
