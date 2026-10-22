# Organization and recovery

Organization changes the layout of files already on a backup destination. It first shows a review, writes and verifies the proposed new files, then retains the originals in a hidden recovery store. Normal imports continue to leave camera and source-drive originals in place.

## Organize existing files

1. Choose the first backup destination on the Import desk. This can be a supported drive or folder.
2. Open **Organization** and set the backup folder, folder template and media separation options.
3. Select **Organize existing files…**. The app scans recognized photos, videos and companions across the **whole first selected destination**, including files under older backup folders.
4. Compare **Existing path** and **New path** in the review. The new paths use the current backup folder and folder settings.
5. Select **Apply reviewed organization**, or discard the review to leave the files unchanged.

Only the first selected destination is organized. The operation captures a single-destination plan without changing the import copy policy. For example, **Mirror to both** remains selected for later imports, but organization does not also reorganize the second disk.

An organization needs free space for verified new files while the originals remain retained. Recognized media and associated companions are included; unrelated files are left in place. The recovery store itself is excluded from future source inventories.

## What happens to originals

The app saves an authenticated journal before publishing new files or relocating originals. It verifies new file contents using SHA-256 and synchronizes the file and containing directories before relocating an original. It rechecks source contents, destination contents and filesystem identities before proceeding.

After verification, each original is renamed into a private slot in the recovery store on the **same filesystem**. The original file's contents are retained. A completed operation does not delete these retained originals, and there is no automatic cleanup or cleanup button.

The store is beneath the operation's organization root: the first selected destination plus the backup folder used by that review. For example:

```text
Selected destination: /Volumes/Backup
Backup folder:        photobackup
Organization root:    /Volumes/Backup/photobackup

photobackup/
  .photo-importer-recovery/
    <operation-uuid>/
      manifest.json
      event-<uuid>.json
      originals/
        <entry-index>/
          <random-slot>/
            <original-basename>
```

If the backup folder was empty, the store is directly inside the selected destination. `manifest.json` records the saved source and destination paths, checksums and identities. Signed event files record the operation's progress. The store can also contain temporary stages or preserved incomplete publications; retained originals are specifically under `originals/`.

## Stop, reconnect and resume

A stop or abrupt process exit can leave some files at their original paths and others in the recovery store. Keep the store and its journal together. Reconnect and select the original destination, then open **Organization recovery**.

| Control | What it does |
| --- | --- |
| **Refresh list** | Updates saved-operation rows using cached filesystem checks, without hashing all media contents. |
| **Resume & recheck** on an operation | Authenticates the saved journal, checks full file contents and identities, then continues that operation. |
| **Recheck** on a previously completed operation | Runs the same full validation and resumes any work needed for its saved paths. |

**Last completed** and **Last verified** describe the listed saved state. They are not a fresh full-content verification from a list refresh. Use the operation's own recheck action for that verification.

Resume uses the paths saved in that operation, even if the current folder settings have changed. To apply another backup folder or template, start a **new organization review**. A later layout can change a path expected by an older completed operation, so the older row may then report pending work or an error. Rechecking the older operation is a request to validate and continue its older layout.

The app stops rather than proceeding when a source changes, a target has unexpected contents, an authenticated journal fails validation, a root or parent directory changes identity, or a path passes through a symbolic link. Existing source or recovery bytes remain available for inspection. Resolve the reported condition before attempting to resume.

## Separate photo and video backup folders

With **A separate video backup folder**, one organization keeps a journal in each backup folder it changes. Before anything moves, it also leaves a small signed pointer, `journal-<id>.json`, in the recovery folder of every other folder its manifest lists or its files come from. A later organization reads these pointers, the signed folder lists of the journals it finds, and the folder named by any later journal that replaced one. So it refuses to move a file that an unfinished organization in another folder still owns. Instead it reports **Finish organization …**: resume or undo that organization first. Each pointer is removed when its journal finishes, is undone, or has its kept originals released. An undo or release in progress writes them again first. In backup folders, leftover-file cleanup (automatic when nothing is running, or **Leftover files → Clean up**) removes pointers left behind by a crash, pointers whose organization is gone, and their temporary `.tmp` files. A pointer a crash leaves in a folder the files came from, such as a card folder, is removed the next time that organization is rechecked. Until then that folder is kept.

- A damaged pointer is repaired by the next organization when its journal is found next to it. If its journal can't be found, the error names the file; delete it only if that organization is finished or no longer needed.
- If a backup folder is renamed only by case (`videobackup` to `VideoBackup`) while an organization in it is unfinished, organizing stops until it is renamed back. Once everything there has finished, the rename doesn't matter.
- **Limit:** an organization stopped part-way by a version from before 22 October 2026 left no pointers. If no journal in the other folder lists its folder, a later organization can't find it. Before organizing, resume each pending organization once (Organization recovery → **Resume & recheck**). That writes its pointers.

## The private host key

The Electron app keeps a private 32-byte authentication key at:

```text
<app userData>/organization-recovery.key
```

The key authenticates recovery manifests and events. It is kept in the app's private user-data directory and is not stored with the destination's journals. The app also saves known organization-root locations in its settings so it can find operations after the backup folder changes.

Automatic resume requires the original key. A different installation or a lost user-data directory may not be able to authenticate an older journal. Losing the key does **not** delete or encrypt the retained originals: their file contents remain in `originals/`, and the manifest still records the original and proposed paths.

For manual recovery, stop organization work, show hidden files in the file manager, and locate the operation's store. Copy the required originals into a separate recovery folder, using the manifest to identify their original paths. Check those copies before making further changes. Manual recovery does not require editing a signed manifest or deleting the store. There is no automatic restore-to-old-layout action in the current interface.

## Durability and verification limits

File and directory synchronization is required before original relocation. If the filesystem does not support the required directory synchronization, organization aborts and retains originals. This protocol cannot guarantee survival of failed hardware or a controller/filesystem that reports successful synchronization without making the data durable.

Tests exercise cancellation, abrupt process death, resume, changed sources and targets, journal authentication, unsafe paths and repeated apply/resume requests using disposable fixtures. These tests do not establish real power-loss or failed-controller behavior. The desktop build is a local development build and is not notarized.

See [Codex testing](codex-testing.md) for the isolated organization integration mode and evidence files.

## Verify the post-reset desktop-app run on A006

> **Historical.** This one-off audit script was removed in the 2026-10-20 architecture review once the A006 run finished; it is kept in `build/architecture-review-2/pre-review-backup.tar.gz`. The description below records what was verified.

`Scripts/verify-a006-app-reset.mts` is a read-only audit of the installed desktop app’s own operation receipts. It writes only a new repository-local `build/media-organization-audit/app-final-audit-<UUID>` report. It never changes card files, the backup library, recovery journals, or app settings. Its temporary-file self-test is:

```sh
node --import tsx Scripts/verify-a006-app-reset.mts --self-test
```

After the real app has queued its imports and organization, run:

```sh
node --import tsx Scripts/verify-a006-app-reset.mts --wait \
  --edited-mapping=build/media-organization-audit/reset-edited-path-mapping.json
```

The audit uses `reset-ready-for-app.json.finished` as the cutoff for app operations, accepting either Unix seconds or an ISO timestamp. It reads receipts exclusively from the installed app’s `~/Library/Application Support/automatic-photo-importer/operation-reports`. It requires successful `desktop-app` import receipts for the five recorded media-card UUIDs and PMHOME, followed by successful retained-original organization of exactly `2024`, `2025`, and `2026`. A relevant failed app receipt stops the audit. An incomplete batch waits only when `--wait` is present.

Before any media content is read, `reset-complete.json` must also report success and identify the same permanently deleted old tree recorded by `reset-pending-deletion.json`. The new library at `/Volumes/A006/photobackup` is expected to exist. The deleted pre-reset recovery stashes are deliberately outside this audit’s requirements.

The audit pins A006 and all six source volumes by UUID and filesystem identity, then checks the actual app plans, an HMAC-authenticated current organization manifest and its events, every canonical output, and every per-index retained original. A durable `stash-intent` slot is checked even when no later `stashed` event exists. The actual manifest destinations are authoritative when collision allocation changed a reviewed destination. Historical and preserved-export source provenance must match the app plan; `reset-edited-path-mapping.json` accepts `{ "mappings": [{ "from": "absolute old prefix", "to": "absolute new prefix" }] }` for the explicit preserved-export folder rename.

All 7,954 recorded card originals are hashed again against their original size/SHA-256 expectations. Canonical content must cover all 7,954 imports, 19,227 restored historical expectations, and 786 preserved edited exports. Preserved exports are inspected through an already-open read-only descriptor; recognized editor provenance must appear under `year/month/editied/camera`. The metadata subprocess never opens a media pathname. Symlinks, changing files, changed mounts, new app operations, missing originals, and mismatched hashes stop the audit.

Progress records report checked files and bytes every 30 seconds. `verified-files.jsonl` records actual verified paths, `edited-provenance.jsonl` records export classification, `app-jobs.json` identifies the real app jobs and journal, and `summary.json` gives the result. Input receipts and authenticated journals are bound by SHA-256 in `final-bindings.json`; `output-sha256.json` binds the resulting report files. The private host authentication key is never written to reports.


## Ordinary import interruption and filename conflicts

Import staging and exclusive destination copies now write host-authenticated receipts before copying bytes. Recovery checks the signed receipt, source stat, source/destination mount identity, parent identity, partial inode/birthtime and existing source prefix. The file is opened without truncation; remaining bytes are written and the entire finished result is SHA-256 verified before the receipt is retired. A per-operation receipt index avoids repeatedly listing large camera folders. App-generated receipt/partial filenames are excluded from inventory.

This permission applies only to authenticated, unchanged app-owned partials. Older unsigned partials, unrelated files, changed sources, corrupt prefixes, replaced files and linked paths never grant overwrite permission. Identical complete contents are skipped. Different contents with the same filename use `camera/Conflicts/<family-content-id>/original-name`; optional media-type folders and RAW/XMP/video companions remain together. The content-based family ID makes reimport idempotent and survives serialized plans. Existing copies remain in place; the incoming copy is the version placed in Conflicts.
