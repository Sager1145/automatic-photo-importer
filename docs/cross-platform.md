# Cross-platform policy

Automatic Photo Importer is one codebase for **macOS, Windows and Linux**. Every change (a feature, a fix, a setting, a string, a release) goes to all of them. A change that works on one system and is unknown on the others is not finished.

## Platforms and architectures

[`release-targets.json`](../release-targets.json) is the one list of what ships. The build scripts read it, and `desktop/tests/platform-parity.test.ts` fails if a build disagrees with it.

| Platform | Released now | Planned |
| --- | --- | --- |
| macOS | arm64 (Apple silicon) only | — (Intel Macs are not supported) |
| Windows | x64 | arm64 |
| Linux | — | x64, arm64 |

To release a planned target, move it from `planned` to `release`, make the packaging build it, and run the hardware checks below on that machine.

This document is the contract. [Shared desktop implementation](multiplatform-migration.md) describes the architecture; this page says how to keep the versions together.

## The rules

1. **One shared implementation.** Product behavior lives in `desktop/core`, `desktop/renderer` and the shared parts of `desktop/main.ts`. Do not fork logic per OS. Only the code that talks to the operating system differs, and it lives in `desktop/platform/` behind one function that every OS implements.
2. **Each platform-specific branch names all three systems.** When code checks `process.platform`, it handles `darwin`, `win32` and `linux` explicitly, or says in a comment why one case covers the others. A Mac-only branch with no Windows/Linux answer is a bug.
3. **Ship to every platform at once.** A new capability that needs an OS adapter (cameras, ejecting, timestamps, durability) gets its adapter on every OS in the same change. If one OS truly cannot do it yet, the UI says so on that OS, and the gap goes in [Known gaps](#known-gaps) below with an owner.
4. **Same records everywhere.** Anything written to disk (records, journals, indexes, receipts) must mean the same thing on every OS. Store relative paths with `/` (use `posixRelative` in `desktop/core/paths.ts`), and never store a drive letter or `/Volumes/…` as identity.
5. **Every string in every language.** User-facing text goes through `i18n.tsx` with all four languages (`en`, `zh-Hans`, `zh-Hant`, `ja`), on every OS.
6. **Every platform tests the same features.** Behavior that touches the operating system is tested per platform, but always as the same app feature. See [Platform tests](#platform-tests).
7. **Shared tests pass on every OS.** Use `path.join`/`path.sep` or `posixRelative` instead of literal `/` in expected paths, and `pathToFileURL(file).href` when importing a module by path. A test that needs a capability one OS lacks skips itself there with a reason; it never fails silently.

## Platform tests

Each platform has its own test file, and all of them check the same app features:

- `desktop/tests/platform-features.ts` is the one list of features (`FEATURES`), each with its assertions written once: drive detection, refusing a camera card reached through a folder link, durable writes, `/` in stored paths, a records folder made on another system, how a USB camera's location reads, and a camera's card slots and capacity.
- `desktop/tests/platforms/darwin.ts`, `win32.ts` and `linux.ts` are the profiles. Each supplies that system's real data and setup: `diskutil` output, `/Volumes` and symbolic links on macOS; `Get-Volume` JSON, `D:\` and junctions on Windows; `lsblk` output, `/media` and symbolic links on Linux.
- `platform-darwin.test.ts`, `platform-win32.test.ts` and `platform-linux.test.ts` each run the whole list with their profile. Features that use recorded tool output run on any machine; features that need the real filesystem run on their own system and skip elsewhere, saying why.
- `platform-parity.test.ts` checks that all three files run the shared list, and that the builds match `release-targets.json`.

To add an OS-dependent feature: add it to `FEATURES`, give every profile what it needs (TypeScript refuses a profile that is missing a field), and run the tests on each released platform.

## Platform differences to design for

| Area | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Drives | `diskutil`, `/Volumes/<name>` | PowerShell `Get-Volume`, `D:\`; no label → "Sony DSC (D:)" | `lsblk`, `/proc/self/mountinfo` |
| USB camera without a drive (MTP/PTP) | ImageCaptureCore helper (`Sources/CameraBridge`) | Portable Devices bridge (`desktop/platform/windows-camera.ts`) | Not yet: see Known gaps |
| Camera shown as | `USB/<name>` | `USB\<name>`, with each card slot and its capacity | — |
| Folder durability | `fsync` on the folder | Folders cannot be flushed; file contents are flushed before publishing (`DIRECTORY_SYNC_SUPPORTED`) | `fsync` on the folder |
| Flushing a file | Any handle | Needs a handle that may write (`syncFile` reopens with `O_RDWR`) | Any handle |
| Paths | `/`, case-insensitive by default (APFS) | `\`, case-insensitive, reserved names (`CON`, `NUL` …), no `<>:"/\|?*` | `/`, case-sensitive |
| Symbolic links | Allowed | Need Developer Mode or admin | Allowed |
| Release build | arm64 DMG | x64 MSI with branded dialogs, plus an x64 portable exe | Not released yet |
| Record seal key | Per computer, listed in each drive's `store.json` ([shared-records.md](shared-records.md)) | Same | Same |
| Records folder identity | Inode (device numbers change per mount) | Volume serial `:` file id (a volume root's file id is 0) | Inode |

## Checklist for every change

Copy this into the pull request description:

```
- [ ] Shared logic is in desktop/core or desktop/renderer, not duplicated per OS
- [ ] Any process.platform branch handles darwin, win32 and linux
- [ ] New OS adapter exists for all three systems, or the gap is in docs/cross-platform.md
- [ ] Paths stored on disk use '/' (posixRelative); no drive letters or mount points as identity
- [ ] New strings in all four languages
- [ ] OS-dependent behavior is a feature in platform-features.ts, covered by every platform profile
- [ ] Tests pass on macOS arm64 and Windows x64; expected paths are separator-safe
- [ ] Built and smoke-tested on each released target: npm run package:mac:release (arm64) and npm run package:win:release (x64)
```

## Building and testing each platform

| Platform | Unit tests | Package |
| --- | --- | --- |
| macOS (arm64) | `npm test` | `npm run package:mac:release` → `Automatic-Photo-Importer-<version>-arm64.dmg` |
| Windows (x64) | `npm test` (per-file run is faster to read: `node --import tsx --test desktop/tests/<name>.test.ts`) | `npm run package:win:release` → `build/desktop/Automatic-Photo-Importer-<version>-x64.msi` and `…-x64-portable.exe` |
| Linux (planned) | `npm test` | `npm run package:linux` (development build only) |

The Windows installer's artwork and wording live in `Assets/Installer/`; regenerate the artwork with `python Scripts/make-installer-art.py` after changing the icon.

Hardware checks on each released target before a release: a card reader or mass-storage camera, a USB camera in MTP/PTP mode, an external destination drive, and Stop/resume during a copy.

## Known gaps

Keep this list current. Remove a line when the gap closes; add one, with the reason, when a change cannot reach every OS yet.

| Gap | Platforms | Notes |
| --- | --- | --- |
| Records written on another system are history only | All | Seals are shared ([shared-records.md](shared-records.md)), but journals, receipts and indexes name absolute paths (`/Volumes/A006/…` against `I:…`) and that system's file identities (exFAT inodes differ between macOS and Windows). Organizations started on one system are listed, never resumed or undone, on another; indexes are rebuilt by scanning when the drive changes system. Needs paths relative to the store base and per-system identities in records. |
| Windows drive letter changes | Windows | Records name the drive letter, so a drive that comes back as another letter (or on a PC that gives it another) does not match its journals; same cause as the line above. |
| Records folder identity on Linux exFAT | Linux | The kernel exFAT driver numbers inodes afresh on each mount, so a store's inode check (`storeIdentity`) would read a remounted exFAT drive as a copied folder. Needs a Linux identity that survives remounts before Linux is released. |
| USB cameras in MTP/PTP mode | Linux | No adapter yet (gphoto2 or `/run/user/*/gvfs` are candidates). Mass-storage cameras and card readers work. |
| macOS "Created" date on copies | Windows, Linux | The Mac sets Created through its helper; other systems keep the modified time only. |
| Tests that expect `/` in relative paths | Windows | About 25 test files compare against literal `a/b/c` paths while the code (correctly) builds native paths. Convert the expectations with `path.join` or `posixRelative`. |
| Tests that create symbolic links | Windows | Fail with `EPERM` unless Developer Mode is on; they should skip with a reason instead. |
| Tests that use Unix permissions (`chmod 0o500` to make a folder unwritable) | Windows | Windows ignores those bits; such tests need a Windows way to deny writes, or a skip. |
| Source card after a failed import | All | Can show "N of N files verified" for files that all failed; Activity shows the true counts. |
