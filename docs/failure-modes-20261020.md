# Failure-mode verification — 2026-10-20

## Scope and evidence

This audit tests preservation of source bytes, preservation of pre-existing destination bytes, rejection of unverified output, and safe retries/recovery. Tests use temporary fixtures. No physical SD card was modified or unplugged, no A006 device was disconnected, and the computer was not powered off. A006's separately authorized organization continues independently.

The [ChatGPT Pro consultation](https://chatgpt.com/c/6ad78c6c-012c-83ea-b3cc-1b3bb34d4db2) supplied a generic independent test matrix. Only a generic testing question was submitted: automatic review rejected a draft containing project architecture and maintenance details, which was removed before the generic question was sent. ChatGPT did not run or validate this application. Its recommendations were checked against local code and actual test results. The captured review is `build/failure-modes/chatgpt-review.txt`.

## Executed failure classes

| Failure | Technique | Verified behavior |
|---|---|---|
| Source read disconnect/error | Inject EIO/ENODEV after copying starts | No incomplete file is published; original and destination sentinel bytes remain unchanged; retry succeeds |
| Destination disconnect/error | Inject EIO/ENODEV during writing | Failure is reported; no incomplete output is counted as complete; retry succeeds |
| Permission denial | Inject source/destination EACCES | Failure is reported without changing source permissions or existing data |
| Disk full | Inject ENOSPC during writing | No collateral deletion, no partial publication, clean retry |
| Short/zero writes | Transfer actual short prefixes; separately return zero progress | Short writes are completed exactly; zero progress fails without an infinite loop |
| File synchronization failure | Inject EIO at fsync | Failure, preserved originals and successful retry |
| Staged corruption | Change a byte before staged verification | Hash mismatch prevents publication |
| Published exclusive-copy corruption | Change a byte after exclusive copy | Verification fails; damaged output and intent are preserved; retry selects a separate safe name |
| One of two destinations fails | ENOSPC on one independently prepared destination | Healthy copy is preserved; a new plan verifies/skips it and copies only unresolved work |
| Five sources create a missing base directory concurrently | Electron test holds all five missing-directory checks at a barrier | All sources must complete; expected EEXIST races cannot fail the import or weaken path checks |
| Malformed source media | Truncated JPEG plus metadata-reader failure | Byte copy can still verify; this is not reported as a format-health diagnosis |
| Process killed during import | Parent sends real SIGKILL during staging and partial exclusive publication | No finally block runs; a fresh process retries without changing stale/foreign output |
| Process killed during organization | SIGKILL during partial target publication, after target publication, after original relocation | A fresh process resumes the authenticated journal, retaining full original bytes |
| Process killed during finalization | SIGKILL after durable deletion intent and after retained duplicate unlink | A fresh process finishes only the authorized journal; foreign files remain untouched |
| Source volume disappears | Force-detach a disposable mounted exFAT image after a streaming checkpoint | Actual read EIO, zero completed copies; remount preserves source and sentinel hashes; retry succeeds |
| Destination volume disappears | Force-detach a disposable mounted exFAT image during writing | Actual write EIO, zero completed copies; remount preserves existing bytes; retry succeeds |
| Actual filesystem capacity exhaustion | Write a 72 MiB fixture to a roughly 60 MB exFAT volume | Actual ENOSPC; no published partial; original and sentinel preserved; larger destination succeeds |

The original collision, changed-source, replaced-root, path/symlink, cancellation, tampered-journal, damaged-target and finalization-recheck tests remain part of the complete backend suite.

New repeatable tests live in `desktop/tests/transfer-failures.test.ts`, `desktop/tests/process-crash.test.ts` and its isolated subprocess worker. These are application-level failures, not substitutes for controller power-loss qualification.

The OS volume runner is `Scripts/test-failure-volumes.mts`. This host rejected CLI disk-image creation, so a new blank 64 MB exFAT image was created in `/private/tmp/photo-importer-fault-ui-20261020/fault-fixture.dmg` using Apple's Disk Utility. The image was unmounted, copied into unique temporary test directories, and only those image attachments were force-detached. The runner verifies image/device/mount ownership before detaching; it never selects a physical disk by name. All three OS tests passed and all their image copies were detached afterward. Results, exact errors, hashes and retry counts: `build/failure-modes/virtual-volumes-2026-10-20T19-17-57-905Z.json`.

## Durability finding

The audit identified a distinction between byte verification and durable publication: ordinary imports synchronized file data but did not synchronize the directory entries for newly published files and folders. The exclusive-copy intent was also removed without ensuring its directory entry had first reached persistent storage. This could acknowledge a copy whose name disappears after an OS/storage power failure; ordinary import still preserves the source.

File fsync alone does not establish directory-entry durability. [Linux fsync documentation](https://man7.org/linux/man-pages/man2/fsync.2.html) explicitly requires synchronization of the containing directory. Windows has different native handle requirements; a POSIX directory-flush technique is not a Windows power-loss certification. [Microsoft FlushFileBuffers documentation](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)

The correction reuses one strict synchronization implementation for imports and organization recovery. New and already-existing verified targets are flushed together with their parent chain before counting completion. Exclusive-copy intents and every new ancestor are synchronized before copying; intent removal follows durable target publication and is synchronized afterward. New base-folder bindings are also flushed up to the selected destination. A failed or unsupported synchronization reports an error instead of being ignored.

Four regressions were observed failing before this correction and passing afterward. They check directory synchronization failure, unsupported synchronization, nested directory durability, and intent/target/removal ordering. A premature-source-EOF test also confirms that an unchanged source identity/size cannot disguise an incomplete read. `desktop/tests/transfer-failures.test.ts` now contains 19 checks; the subprocess SIGKILL suite contains seven. The combined backend/unit suite passed **159 tests, zero failed** (`build/failure-modes/unit-tests-final.log`).

After the correction, all three OS exFAT tests passed again: `build/failure-modes/virtual-volumes-2026-10-20T19-23-55-366Z.json`. The source/destination detach cases produced actual EIO read/write errors; the capacity test produced actual ENOSPC. Each reported zero copied files during the failure and exactly one successful copy after recovery.

## Concurrent folder-creation finding

A normal integration run initially hid a timing-sensitive first-launch issue. A deterministic five-source barrier reproduced four EEXIST failures while creating the same missing backup base (`build/failure-modes/electron-directory-race-red.log`). The main process used a separate lstat-then-mkdir loop. It now reuses the core's existing race-safe parent creation, preserving its symlink/path checks, followed by strict synchronization of the new base bindings. No second creation implementation or retry loop was added.

The 19 transfer fault tests also pass with position-dependent source bytes, so short-write verification can detect incorrect offsets and repeated segments rather than merely compare constant-filled files. See `build/failure-modes/transfer-failures-final.log`.

## Final integrated result

- **159 backend/unit tests passed**, including 19 transfer faults and seven real SIGKILL subprocess cases.
- **15 full Electron checks passed**, including the deterministic five-source missing-folder race, queue/Stop, repeat-copy verification, both organization destinations, authenticated recovery, four languages, appearance and metadata disclosure.
- **Three OS exFAT virtual-volume checks passed**, using actual EIO/ENOSPC conditions and verified reattachment/retry.
- The application build and type checking passed; the signed updated macOS application was installed as `/Users/sager/Applications/Automatic Photo Importer Desktop.app`, and `build/AutomaticPhotoImporter-Desktop.zip` was refreshed.

Electron evidence: `build/failure-modes/electron-final.log` and `/private/var/folders/5f/_slhpsk50450j1rbjsrf3dxw0000gn/T/photo-importer-codex-UI4oiS/artifacts/report.json`. Build evidence: `build/failure-modes/build-final.log`. The original red directory-race report is retained separately. All failure-test disk-image attachments were removed; fixture files and reference reports remain in their isolated temporary/report directories.

The active A006 organization is separate and is not marked complete by these results. Its current process keeps its already-loaded implementation; no code test restarted or interfered with it.

To repeat application-level tests:

```sh
npm test
npm run codex:test
```

On a Mac that permits CLI disk-image creation, `node --import tsx Scripts/test-failure-volumes.mts` creates its own disposable images. On this host, the verified invocation instead used the unmounted Disk Utility fixture template:

```sh
node --import tsx Scripts/test-failure-volumes.mts \
  --image-template=/private/tmp/photo-importer-fault-ui-20261020/fault-fixture.dmg
```

This runner never accepts a physical device argument. Do not replace its temporary template with an existing user disk image.

## What these results do not prove

- SIGKILL removes process execution and memory; kernel and device caches remain powered. It is not an electrical power cut.
- Forced image detach exercises real filesystem disappearance and I/O failure, but not all USB controllers, physical media, cable failures, torn sectors, or firmware cache behavior.
- SHA-256 equality checks the bytes copied. It cannot establish that a photo/video was healthy before import; a trusted earlier hash or format-aware decoder is a separate check. Thumbnail availability is not full media validation.
- Directory/fsync success is bounded by the OS/filesystem/device contract. Unsupported or failed synchronization must not be silently treated as durable success. Windows/Linux builds and physical hardware have not been qualified by these macOS tests.
- New imports use authenticated ownership receipts for staging and exclusive publication. A fresh process verifies mount, source, parent and file identities plus the existing byte prefix before resuming the same inode. Unowned, legacy, changed, symlinked or non-prefix partials stay untouched; incoming content uses the camera’s deterministic `Conflicts` folder instead. SIGKILL tests cover process interruption; physical power loss and device-cache persistence are not qualified by those tests.
- Finalizing organization releases verified retained duplicates. After that release, loss of the remaining target requires an independent backup; the journal cannot recreate bytes that no longer exist.

Actual power-loss qualification still requires expendable media and a dedicated machine/power-switch setup, with an independent reference manifest and cold-remount verification. Existing camera cards and the active A006 maintenance disk were deliberately excluded from such destructive experiments.
