# Drive formats on macOS, Windows and Linux

What each file system people bring can do on each system the app ships to, which open-source drivers fill the gaps, and how the app's copy, verify and organize code handles each format. Checked 2026-11-01. Every fact links to the project's or vendor's own page. Release dates come from the project's release page or the GitHub Releases API. Anything that could not be confirmed on an official page is marked *unverified*.

**Short answer for a drive that moves between a Mac and a PC: use exFAT.** macOS, Windows and Linux all read and write it with no extra software ([Apple](https://support.apple.com/en-us/101830), [Microsoft](https://learn.microsoft.com/en-us/windows/win32/fileio/filesystem-functionality-comparison), [Linux 5.7](https://kernelnewbies.org/Linux_5.7)). The A006 library drive is exFAT, so it needs no driver.

The app's own data for this page is in [`desktop/core/drive-formats.ts`](../desktop/core/drive-formats.ts): `nativeAccess` (the support matrix) and `DRIVER_OPTIONS` (the drivers below). Settings › Devices › Drive formats shows both for the connected drives. **The app never downloads, installs or enables a driver and never changes a security setting.** It shows the project link, which opens in the user's browser (`openDriverLink` allows only the listed links), the license, and the steps the user runs themselves.

## Support matrix

RW = read and write, R = read only, — = not readable without extra software. "Open-source option" is what Settings lists. Risk is how the project itself describes writing.

| Format | macOS arm64 | Windows x64 | Linux | Open-source option where native write is missing | Risk of writing with that option |
| --- | --- | --- | --- | --- | --- |
| exFAT | RW native | RW native | RW native (kernel 5.7+) | Not needed | — |
| FAT32 | RW native | RW native | RW native (vfat) | Not needed; **files up to 4 GB** | — |
| NTFS | **R** native | RW native | RW native (ntfs3, 5.15+) | macOS: anylinuxfs (GPL-3.0); ntfs-3g (GPL-2.0+) + macFUSE (not fully open source); MNtfs (GPL-2.0, early) | Medium; MNtfs high |
| APFS | RW native | — | — | Windows: 7-Zip extracts from images only (R). Linux: apfs-fuse (R, GPL-2.0); linux-apfs-rw (write experimental, GPL-2.0) | Linux write: high ("real risk of data corruption") |
| HFS+ (Mac OS Extended) | RW native | — | **R** for journaled volumes | Windows: HFSExplorer (R, GPL-3.0), 7-Zip (R). Linux: hfsplus writes once the journal is turned off on a Mac | Linux: medium; never `force` |
| ext4 | — | — | RW native | macOS: anylinuxfs (RW), ExtendFS (R, GPL-3.0+), ext4fuse (R, GPL-2.0, unmaintained). Windows: Ext4Fsd (RW, GPL-2.0); `wsl --mount` (not for USB) | Medium |
| Btrfs | — | — | RW native | macOS: anylinuxfs (RW). Windows: WinBtrfs (RW, LGPL) | Medium |
| ReFS | — | RW only as a Dev Drive, not on removable or USB disks | — | None | — |

## Format facts the app depends on

| Format | Largest file | Hard links | Names that differ by case | Modified-time step | Times stored as |
| --- | --- | --- | --- | --- | --- |
| exFAT | 2^64−1 bytes | No | One name (case-preserving) | 10 ms (2 s units plus a 10 ms field) | Local time plus a UTC offset in 15-minute steps |
| FAT32 | "4 GiB" ([Microsoft](https://learn.microsoft.com/en-us/windows/win32/fileio/filesystem-functionality-comparison)); the size field is 32 bits, so 4 GiB − 1 byte (derived, *unverified* as a quote) | No | One name | 2 s (create 10 ms, access date only) | Local time ([file times](https://learn.microsoft.com/en-us/windows/win32/sysinfo/file-times)) |
| NTFS | 2^64−1 bytes | Yes | One name by default; per-folder option | 100 ns | UTC |
| APFS | Effectively unlimited | Yes | One name by default; case-sensitive variant ([Disk Utility](https://support.apple.com/guide/disk-utility/file-system-formats-dsku19ed921c/mac)) | 1 ns | UTC ([APFS reference](https://developer.apple.com/support/downloads/Apple-File-System-Reference.pdf)) |
| HFS+ | Effectively unlimited | Files only | One name; HFSX can be case-sensitive ([TN1150](https://developer.apple.com/library/archive/technotes/tn/tn1150.html)) | 1 s | GMT; dates end in 2040 |
| ext4 | 16 TiB (4 KiB blocks) | Yes | Two names (optional per-folder casefold) ([ext4](https://docs.kernel.org/admin-guide/ext4.html)) | 1 ns | UTC |
| Btrfs | 16 EiB | Yes | Two names | 1 ns ([on-disk format](https://btrfs.readthedocs.io/en/latest/dev/On-disk-format.html)) | UTC |

## How the app handles each format

| Behavior | Where | What it does per format |
| --- | --- | --- |
| Accepting a destination | `validateDestination` (`desktop/platform/volumes.ts`), `probeDestination` (`desktop/core/destination-probe.ts`) | **Every destination**, whatever mounts it, gets a probe before it is accepted (when chosen, and again before each import, organization or resume). The probe writes a new 192 KB file (`wx`, so it never replaces anything), flushes it and its folder, reads it back and compares SHA-256, renames it, checks the old name is gone, reads it again, deletes it and checks it is gone. The first failing step is named in the refusal (`error.destinationProbe`). A write refused with EROFS, EACCES or EPERM reads as read-only. The probe's file is removed whatever happens. This catches a FUSE or third-party driver that mounts read-only, loses writes, or cannot rename, instead of failing an import midway. |
| A drive this computer only reads | `validateDestination` | A read-only NTFS drive on a Mac, or a journaled HFS+ drive on Linux, is refused with `error.destinationReadOnlyFormat`, which points to Settings › Devices › Drive formats. |
| Files over 4 GB on FAT32 | `checkFileSizes` (`desktop/core/drive-formats.ts`), called in `prepare` in `desktop/main.ts` | After planning and before anything is copied, an import is refused when a FAT32 destination (or its separate video folder) would get a file larger than 4 GiB − 1 byte. The message names the largest one. Files already in the backup are not counted. Organizing in place moves files within one drive, so it is not checked. |
| Publishing a verified copy | `linkRefused` (`desktop/core/paths.ts`), `EtaTracker.predictPublish` | Hard link where the format has them (APFS, HFS+, NTFS, ext4, Btrfs, ntfs-3g). exFAT and FAT have none: the link fails with EPERM/ENOTSUP and the copy is published by copying, then verified. A FUSE driver without links falls back the same way. On macOS exFAT, files are written directly and checked in place (`directCapable`). |
| File identity | `unreliableIno`, `sameStat` | exFAT's synthetic inodes for empty files are not trusted; birth time is compared instead. Identity across systems is a known gap (see [cross-platform.md](cross-platform.md#known-gaps)). |
| Timestamps | `applyFileTimestamps` (`desktop/platform/file-timestamps.ts`) | A set date is accepted within 2 s, which covers FAT's 2 s step, exFAT's 10 ms and HFS+'s 1 s. A date the format cannot store (exFAT 1980–2107, HFS+ until 2040) falls back to the source's own dates. Verification is by SHA-256, never by time. |
| FAT and exFAT local time | — | FAT keeps local time without a zone, so a drive read in another time zone shows shifted Modified dates. Nothing the app checks depends on it: verification is by SHA-256, and a stat identity is only used on the system that recorded it. |
| Case | `caseVariant` (`desktop/core/index.ts`), `pathKey` | A library never holds two names that differ only by case, so it stays valid on case-insensitive drives. On a case-sensitive volume (ext4, Btrfs, case-sensitive APFS, HFSX) a file already there under another case counts as that name. |
| Unicode names | `isOwnRealpath`, `unlinkEntry` (`desktop/core/paths.ts`) | HFS+ stores names decomposed (NFD), and macOS exFAT lists them decomposed. A difference of normalization alone is the same file only when both spellings are the same entry. |
| Names | `portableName` (`desktop/folder-template.ts`) | Characters Windows, FAT and exFAT refuse, trailing dots and spaces, and reserved names are replaced on every system. Names stay within 255 bytes, the tightest limit (ext4). |
| Folder flush | `syncDirectory` | Flushed on macOS and Linux; Windows cannot flush folders (`DIRECTORY_SYNC_SUPPORTED`). The probe flushes the probe file and its folder, so a driver that fails a flush is refused up front. |

## Drivers and tools, per system

### macOS (Apple silicon)

- **Native:** APFS and Mac OS Extended read/write; exFAT and MS-DOS (FAT) read/write; NTFS read only: "your Mac might be able to read from, but not write to" ([Apple](https://support.apple.com/en-us/101830)). There is no native ext4 or Btrfs. That comes from an independent survey ([Eclectic Light](https://eclecticlight.co/2025/11/18/which-local-file-systems-does-macos-26-support/)); Apple has no page saying so (*unverified* officially). FSKit, Apple's framework for file systems in user space, needs macOS 15.4+ ([FSKit](https://developer.apple.com/documentation/fskit)).
- **anylinuxfs:** read/write for ext4, Btrfs, XFS, NTFS, exFAT, ZFS and LUKS. It boots a small Linux VM (libkrun) per drive and shares the drive to the Mac over local NFS. No kernel extension; Apple silicon only. GPL-3.0. Latest v0.20.1, 2026-09-24. Install: `brew tap nohajc/anylinuxfs && brew install anylinuxfs`. The project warns that ntfs-3g can give intermittent I/O errors on long NFS copies and suggests ntfs3. [github.com/nohajc/anylinuxfs](https://github.com/nohajc/anylinuxfs)
- **ntfs-3g:** read/write NTFS. GPL-2.0-or-later. Releases started again in 2026: latest 2026.9.28 (published 2026-09-29); the one before was 2022.10.3. [github.com/tuxera/ntfs-3g](https://github.com/tuxera/ntfs-3g). On macOS it needs **macFUSE**, which is **not fully open source**. The kernel extension has been closed since 3.9 ([open-source status](https://github.com/macfuse/macfuse/wiki/Open-Source-Status)). Its BSD-style license bars bundling with commercial software ([LICENSE](https://github.com/macfuse/macfuse/blob/master/LICENSE.txt)). macFUSE 5.5.0 (2026-10-17) has an FSKit backend that runs without the kernel extension on macOS 26 ([macfuse.github.io](https://macfuse.github.io/)). Install: `brew install --cask macfuse`, then `brew install gromgit/fuse/ntfs-3g-mac` ([gromgit/homebrew-fuse](https://github.com/gromgit/homebrew-fuse)). The tap has no prebuilt bottles for macOS 14 after Jan 2026, so it builds from source there. A drive Windows left hibernated (Fast Startup) mounts read-only.
- **FUSE-T:** a FUSE implementation without a kernel extension (NFS, SMB or FSKit). **Not open source:** free for non-commercial use, and the server source is not published ([License](https://raw.githubusercontent.com/macos-fuse-t/fuse-t/main/License.txt)). Latest 1.2.9, 2026-10-06. Not listed in Settings for that reason.
- **MNtfs:** read/write NTFS on FSKit, with libntfs-3g. GPL-2.0. Early (about v0.1). It **deletes `hiberfil.sys`** to mount a drive Windows left hibernated. Listed as high risk. [github.com/maclifevn/mntfs](https://github.com/maclifevn/mntfs)
- **ExtendFS:** read-only ext2/3/4 on FSKit. GPL-3.0-or-later. macOS 15.6+. Latest v1.2.1, 2026-08-31. Free from GitHub, or paid on the App Store. [github.com/kthchew/ExtendFS](https://github.com/kthchew/ExtendFS)
- **ext4fuse:** read-only ext4. GPL-2.0. Last change 2021-04-11 (unmaintained). Install: `brew install gromgit/fuse/ext4fuse-mac` with macFUSE. [github.com/gerard/ext4fuse](https://github.com/gerard/ext4fuse)
- **fuse-ext2:** GPL-2.0. Its write support is experimental ("do not mount … with write support unless you have nothing to lose"), and there is no Homebrew formula. Not listed. [github.com/alperakcan/fuse-ext2](https://github.com/alperakcan/fuse-ext2)
- **Mounty:** since Ventura, Apple's hidden NTFS write mode is gone, so Mounty 2.4 (2023-12-29) is a front end for ntfs-3g + macFUSE. Its license is not stated (*unverified*), so it is not listed. [mounty.app](https://mounty.app/)

### Windows 11 x64

- **Native:** NTFS, exFAT, FAT32 read/write ([Microsoft](https://learn.microsoft.com/en-us/windows/win32/fileio/filesystem-functionality-comparison)). ReFS on Windows 11 works only as a Dev Drive: build 22621.2338+, at least 50 GB, not on removable or USB disks ([Dev Drive](https://learn.microsoft.com/en-us/windows/dev-drive/), [ReFS](https://learn.microsoft.com/en-us/windows-server/storage/refs/refs-overview)). No native APFS, HFS+, ext4 or Btrfs.
- **WinFsp:** a user-mode file system framework that FUSE ports build on. GPLv3 with a FLOSS exception, or a commercial license. Latest v2.1, 2025-06-05. `winget install WinFsp.WinFsp`. [github.com/winfsp/winfsp](https://github.com/winfsp/winfsp). No maintained WinFsp port of an APFS or ext4 driver was found.
- **WinBtrfs:** read/write Btrfs. LGPL. Latest v1.10, 2026-09-01 (the winget package is still at 1.9). Install: `winget install maharmstone.btrfs`, `choco install winbtrfs`, or right-click `btrfs.inf` › Install. The author: "use this software at your own risk", keep backups. Secure Boot or the Windows 11 driver allowlist can block it. [github.com/maharmstone/btrfs](https://github.com/maharmstone/btrfs)
- **Ext4Fsd (bobranten fork):** read/write ext4, with metadata_csum and 64-bit. Some ext4 features (bigalloc, quota…) make it mount read-only; others (inline data, encryption, casefold…) stop it from mounting. GPLv2. Latest v0.71, 2024-03-16, with a signed installer for Windows 10/11. [github.com/bobranten/Ext4Fsd](https://github.com/bobranten/Ext4Fsd)
- **Ext2Fsd (original):** abandoned; last release 0.69 (2017-11-02). Its site warns it "may crash your system and ruin your data". Versions up to 0.68 corrupt 64-bit ext4. Not listed; Settings warns against it. [ext2fsd.com](https://www.ext2fsd.com/)
- **`wsl --mount`:** built in on Windows 11 with WSL; needs an administrator. It attaches the whole disk, mounts only file systems built into the WSL kernel (ext4 by default), and **does not support USB drives, flash drives or SD card readers**. Files show under `\\wsl$`. [Microsoft](https://learn.microsoft.com/en-us/windows/wsl/wsl2-mount-disk)
- **apfs-fuse:** Linux only, read-only. No Windows port found.
- **7-Zip:** 26.05 (2026-10-21) *extracts* files from APFS, HFS, NTFS and ext images; it does not mount drives. Mostly LGPL. [7-zip.org](https://www.7-zip.org/)
- **HFSExplorer:** read-only HFS/HFS+/HFSX, Java. GPLv3. Latest 2026.4.9. [catacombae.org/hfsexplorer](https://www.catacombae.org/hfsexplorer/)

### Linux

- **ntfs3:** the kernel's read/write NTFS driver, from Paragon, since 5.15 ([5.15](https://kernelnewbies.org/Linux_5.15)). It replays the journal but does not keep one. The `force` option for dirty volumes is "not recommended" ([ntfs3](https://docs.kernel.org/filesystems/ntfs3.html)). ntfs-3g (above) also works.
- **exFAT:** Samsung's kernel driver, since 5.7 ([5.7](https://kernelnewbies.org/Linux_5.7)).
- **hfsplus:** journaled HFS+ mounts read-only: "write access to a journaled filesystem is not supported, use the force option at your own risk". A volume that was not unmounted cleanly also mounts read-only ([hfsplus](https://docs.kernel.org/filesystems/hfsplus.html)). To write, turn the journal off on a Mac (`diskutil disableJournal`). Never force it.
- **apfs-fuse:** read-only APFS. GPL-2.0. No T2 hardware encryption, no LZFSE. Last push 2024-08-13. [github.com/sgan81/apfs-fuse](https://github.com/sgan81/apfs-fuse)
- **linux-apfs-rw:** an out-of-tree kernel module, read-only by default. Writing is experimental: "there is a real risk of data corruption". GPL-2.0. Tag v0.3.22; last commit 2026-10-31. [github.com/linux-apfs/linux-apfs-rw](https://github.com/linux-apfs/linux-apfs-rw)
- **ext4, Btrfs:** native. Btrfs RAID5/6 is "unstable" ([Btrfs status](https://btrfs.readthedocs.io/en/latest/Status.html)).
- **FAT (vfat):** times are local unless mounted with `tz=UTC` ([vfat](https://docs.kernel.org/filesystems/vfat.html)).

## Known data-loss risks with third-party drivers

- Writing NTFS from macOS or Linux to a drive Windows left hibernated (Fast Startup) can lose the data Windows had in memory. ntfs-3g and Mounty mount it read-only; MNtfs deletes `hiberfil.sys`. Shut Windows down fully first.
- linux-apfs-rw writing, fuse-ext2 writing and MNtfs are experimental. Settings marks them high risk and not for backups.
- FUSE drivers can report success for writes they later lose. The destination probe catches a driver that fails outright, not one that fails later. A verified import still reads every copy back by SHA-256 (with "Verify each copy" on), and the originals are never changed.

## Unverified points

- FAT32 "4 GiB − 1 byte" comes from the 32-bit size field; Microsoft's table says "4 GiB".
- No official Apple statement that macOS has no native ext4 or Btrfs.
- Licenses of Ext2Fsd and Mounty; release dates of fuse-ext2, MNtfs and linux-apfs-rw v0.3.22.
- Btrfs case-sensitivity and hard links (standard POSIX behavior; no official quote fetched).
