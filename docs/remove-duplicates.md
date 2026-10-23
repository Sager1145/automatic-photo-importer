# Remove duplicates

Two parts. **A** records duplicates while the app already reads files (organization and import planning, verification hashing). **B** is a separate page, **Remove duplicates**, that reviews those records and removes the copies the user does not want, into the recovery area, with undo. Nothing is deleted until the user explicitly releases the recovered copies.

## Decisions

- Removed duplicates go to the organization recovery store (`Photo Importer Recovery/<journal>/originals/…`) first, with undo, exactly like organization stashes. Space is freed only by an explicit **Release** (the existing finalize). The journal, stash, finalize and undo code in `desktop/core/recovery.ts` is reused.
- Default copy to keep in a group: the one inside the organized structure (`{year}/{yyyymm}/{camera}/…` under the library root); if several are, the earliest imported (oldest file birth time, then ctime); then the shorter path, then alphabetical. The user can override per group.
- Auto-removal (level 3) applies only to SHA-256-identical files, or to files whose EXIF (capture time with sub-seconds, camera model and serial number, shutter count / image number, lens, dimensions) and size are all identical. Same EXIF but different size, same name only, or same time only: the user decides.
- RAW previews use macOS ImageIO through `sips` (reliable, no native rebuild). Thumbnails are cached in `userData/thumbnails`. If the system cannot decode a RAW (a new camera), a clear message suggests a macOS update or Adobe DNG Converter and the embedded preview from exiftool (`PreviewImage`, `JpgFromRaw`, `ThumbnailImage`) is shown instead.
- Copies on different destinations are never paired: every scan, index file and journal belongs to one library root.
- Organization and import never delete because of duplicates; they only record.

## A. Two-stage detection

Files are never compared across kinds the user keeps on purpose. Two files are **comparable** only if they have the same extension class (`jpg` = `jpeg`) and the same edited state (inside the edited folder or with editor provenance). So RAW+JPG pairs, Live Photo HEIC+MOV, bursts (different sub-second time, shutter count, image number or name) and edited versions are never duplicates of each other.

1. **Stage 1, during the name + EXIF check** (planning reads each file's EXIF anyway). Candidates are files with the same file name, or the same *EXIF key*: capture time with sub-seconds, camera serial or model, shutter count, image number, lens and dimensions. An EXIF key is trusted only with a discriminator (sub-seconds, shutter count or image number). Only candidates are hashed right away (targeted SHA-256, through the shared hashing pool) to confirm or reject them.
2. **Stage 2, during full verification hashing.** Every SHA collision in the library is recorded from the destination hash cache (`photo-importer-index.json`) plus any file still unhashed, including renamed files stage 1 missed, and EXIF-identical files whose size differs.

Both stages report through the shared `ProgressDisplay` with named steps: `fingerprinting` (reading metadata), `candidates` (confirming possible duplicates), `collisions` (looking for identical files).

### Group strength

| strength | meaning | level 1 | level 2 | level 3 |
| --- | --- | --- | --- | --- |
| `sha` | all members have the same SHA-256 | user | auto | auto |
| `exif` | same EXIF key and same size, different SHA | user | user | auto |
| `exif-size` | same EXIF key, sizes differ (or a mixed group) | user | user | user |
| `similar` | same name and capture time only | user | user | user |

### Duplicate index

`photo-importer-duplicates.json` at the library root (visible, ignored by inventory and by the leftover cleanup like `photo-importer-index.json`; temporary `photo-importer-duplicates-<uuid>.tmp`):

```json
{ "version": 1, "rootIdentity": "dev:ino", "updated": "ISO", "complete": true,
  "files": { "rel/path.NEF": { "size": 1, "mtimeNs": "…", "ino": "…", "kind": "RAW", "birth": 0, "ctime": 0, "edited": false, "exif": { "date": "…", "camera": "…" } } },
  "groups": [ { "strength": "sha", "files": ["rel/a.NEF", "rel/b.NEF"] } ] }
```

Records are trusted only while the file's size, mtime and inode are unchanged. The page lists the library and compares; if a media file is new, changed or gone the index is stale and an incremental rescan reuses every still-valid record.

## B. Remove duplicates

1. **Scope**: a destination library (the backup folder of destination 1 or 2) or any chosen folder, optionally restricted to sub-folders. One root at a time.
2. **Levels**: 1 the user decides every group; 2 SHA groups are auto-resolved; 3 SHA and EXIF+size groups are auto-resolved (see the table).
3. **Review**: per group, side-by-side previews, a radio per file for the file to keep ("Keep all" is also offered), and badges: *SHA identical*, *EXIF identical*, *Size differs*, *In organized structure*. **Basic** shows camera, lens, date/time, exposure, aperture, ISO, focal length, dimensions, file size, SHA match and path. **Full** shows grouped, readable EXIF from a curated category map (Exposure, Camera & Lens, Date & Time, Location, Image, Maker Notes, File) built from exiftool `-G1` groups and the documented tag names (exiftool.org/TagNames). Binary, thumbnail, duplicate and internal tags are hidden; labels and units are friendly.
4. **Confirm**: a summary (groups, files to remove, space to free) and a confirmation.
5. **Execute** = stash into recovery with undo. A removal is a journal in the library root's recovery store with `kind: "duplicates"`; each removed file is an entry whose *destination* is the kept file. Because the kept file of an `exif` group has a different SHA, entries carry `kept: { digest, size }`; the journal's destination check uses it, so run, recheck, undo and finalize all verify the kept copy. A missing kept copy stops the run; nothing is copied.
6. **Release** (finalize) frees the space and **Undo** puts everything back, both from the Remove duplicates page (and the Organization recovery list).
7. **Companions** (`.xmp`, `.lrf`, `.wav`, `.thm`, …) follow their primary file: a companion identical to one beside the kept file is removed with it; one the kept file lacks is carried next to the kept file (published by the journal, verified, with undo); one that differs from the kept file's companion stays where it is and is reported.
8. A per-file report is written to `operation-reports/<job>/duplicates.json`, and a history entry is added. Text is in the four languages. Scan, hashing, stash and release use the shared `ProgressDisplay`.

Known limits: removing a file that an earlier organization placed supersedes that organization (the same rule as organizing twice), so its retained originals can only be deleted through **Delete recovery files**.

## API

- `desktop/duplicate-rules.ts` (pure, shared with the renderer): `comparable`, `exifKey`, `organizedPath`, `chooseKeeper`, `classify`, `resolveGroups(groups, level, decisions)`, `summarize`.
- `desktop/core/duplicates.ts`: `buildGroups`, `stageOneCandidates`, `scanDuplicates`, `DuplicateStore` (index file), `recordPlanDuplicates`.
- `desktop/core/duplicate-removal.ts`: `planRemoval`, `removeDuplicates` (journal), companions.
- `desktop/core/recovery.ts`: `beginDuplicateRemoval`, entry `kept`, manifest `kind`.
- `desktop/platform/thumbnails.ts`: `thumbnail(path)` with the `sips` decoder, the embedded-preview fallback and a cache.
- `desktop/renderer/exif-categories.ts`: `categorize(tags)`.
- Actions: `duplicatesScope`, `duplicatesScan`, `duplicatesRemove`, plus the existing `finalizeOrganization` / `undoOrganization` for Release and Undo. IPC: `importer:thumbnail`.

## Tests

`desktop/tests/duplicates-*.test.ts`: stage 1 and 2 detection (bursts, RAW+JPG, Live Photo, edited versions are never duplicates; renamed SHA duplicates found in stage 2), keep rule, each level's split (same EXIF but different size is manual), stash/undo/release through the journal, different destinations never paired, curated EXIF categories, thumbnail fallback, and renderer tests for the group view and level selector.
