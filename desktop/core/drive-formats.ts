// Drive formats: what each file system can hold and how this computer can use it. Pure data and functions (no Node
// built-ins), shared by the main process (destination checks, the FAT32 size check) and Settings › Devices.
// Facts and sources: docs/drive-formats.md.
import type { PlanEntry, TransferPlan } from '../shared';
import { MessageError } from '../messages';

export type DriveFormat = 'apfs' | 'hfs' | 'ntfs' | 'exfat' | 'fat' | 'ext' | 'btrfs' | 'refs' | 'fuse' | 'other';
export type Platform = 'darwin' | 'win32' | 'linux';
export type Access = 'readwrite' | 'read' | 'none';

/** One file system name as each adapter reports it (diskutil FilesystemType, Get-Volume FileSystem, lsblk FSTYPE), lowercase. */
export function driveFormat(fsType: string | undefined): DriveFormat | undefined {
  const name = (fsType ?? '').trim().toLowerCase();
  if (!name) return undefined;
  if (name === 'apfs') return 'apfs';
  if (name === 'hfs' || name === 'hfsplus' || name === 'hfs+' || name === 'hfsx') return 'hfs';
  if (name === 'ntfs' || name === 'ntfs3' || name === 'ntfs-3g' || name === 'ufsd_ntfs' || name === 'tuxera_ntfs') return 'ntfs';
  if (name === 'exfat') return 'exfat';
  if (['msdos', 'fat', 'fat12', 'fat16', 'fat32', 'vfat'].includes(name)) return 'fat';
  if (['ext2', 'ext3', 'ext4'].includes(name)) return 'ext';
  if (name === 'btrfs') return 'btrfs';
  if (name === 'refs') return 'refs';
  // A FUSE mount names its driver, not the format underneath (macFUSE, FUSE-T, fuseblk, WinFsp).
  if (/^(fuse|fuseblk|macfuse|osxfuse|fusefs|fuse-t|fuse\..*|winfsp.*)$/.test(name)) return 'fuse';
  return 'other';
}

export interface FormatTraits {
  /** How people know it. */
  label: string;
  /** Largest file it can hold, in bytes, when that is small enough to matter for photos and videos. */
  maxFileBytes?: number;
  /** maxFileBytes as people know it (FAT32: "4 GB", decimal-looking but meaning 4 GiB). */
  maxFileLabel?: string;
  /** Hard links: a verified copy is published by linking; without them it is published by copying. */
  hardLinks: boolean;
  /** Whether names that differ by case alone are two files: no, yes, or chosen when formatted. */
  caseSensitive: 'no' | 'yes' | 'either';
  /** Finest modified-time step it stores, in nanoseconds. */
  mtimeStepNs: number;
}
/** FAT32 keeps a file's size in 32 bits: the largest file is 4 GiB minus one byte. */
export const FAT32_MAX_FILE_BYTES = 2 ** 32 - 1;
export const FORMAT_TRAITS: Record<DriveFormat, FormatTraits> = {
  apfs: { label: 'APFS', hardLinks: true, caseSensitive: 'either', mtimeStepNs: 1 },
  hfs: { label: 'Mac OS Extended (HFS+)', hardLinks: true, caseSensitive: 'either', mtimeStepNs: 1_000_000_000 },
  ntfs: { label: 'NTFS', hardLinks: true, caseSensitive: 'no', mtimeStepNs: 100 },
  exfat: { label: 'exFAT', hardLinks: false, caseSensitive: 'no', mtimeStepNs: 10_000_000 },
  fat: { label: 'FAT32', maxFileBytes: FAT32_MAX_FILE_BYTES, maxFileLabel: '4 GB', hardLinks: false, caseSensitive: 'no', mtimeStepNs: 2_000_000_000 },
  ext: { label: 'ext4', hardLinks: true, caseSensitive: 'yes', mtimeStepNs: 1 },
  btrfs: { label: 'Btrfs', hardLinks: true, caseSensitive: 'yes', mtimeStepNs: 1 },
  refs: { label: 'ReFS', hardLinks: true, caseSensitive: 'no', mtimeStepNs: 100 },
  fuse: { label: 'FUSE', hardLinks: false, caseSensitive: 'either', mtimeStepNs: 1_000_000_000 },
  other: { label: 'Other', hardLinks: false, caseSensitive: 'either', mtimeStepNs: 1_000_000_000 },
};
export const formatLabel = (format: DriveFormat | undefined, fsType?: string): string => format && format !== 'other' ? FORMAT_TRAITS[format].label : fsType || 'Unknown';

/** What this computer can do with a format without anything installed. Linux mounts journaled HFS+ read-only, so HFS+ counts as read there. */
const NATIVE: Record<Platform, Partial<Record<DriveFormat, Access>>> = {
  darwin: { apfs: 'readwrite', hfs: 'readwrite', exfat: 'readwrite', fat: 'readwrite', ntfs: 'read' },
  win32: { ntfs: 'readwrite', exfat: 'readwrite', fat: 'readwrite', refs: 'readwrite' },
  linux: { ext: 'readwrite', btrfs: 'readwrite', exfat: 'readwrite', fat: 'readwrite', ntfs: 'readwrite', hfs: 'read' },
};
export function nativeAccess(format: DriveFormat | undefined, platform: string): Access {
  if (!format || format === 'fuse' || format === 'other') return 'none';
  return NATIVE[platform as Platform]?.[format] ?? 'none';
}

/** An open-source driver or tool someone can install themselves. The app never downloads, installs or enables one. */
export interface DriverOption {
  id: string;
  name: string;
  format: DriveFormat;
  platform: Platform;
  access: 'read' | 'readwrite';
  license: string;
  url: string;
  /** Commands or steps, run by the user (untranslated: they are typed as written). */
  install: string[];
  /** How safe it is for a backup destination, as the project itself describes it. */
  risk: 'low' | 'medium' | 'high';
  /** Translated note, by English key (desktop/renderer/drive-format-translations.ts). */
  note: string;
}

// Checked 2026-11-01 against each project's own page, license and latest release (docs/drive-formats.md has the sources).
const VIA_LINUX = "Runs a small Linux system for the drive and shares it with the Mac over the network: no kernel extension, Apple silicon only. Writes through Linux's own drivers.";
const EXTRACT = 'Extracts files from an APFS or Mac OS Extended disk image; it does not mount the drive. No open-source driver writes APFS on Windows.';
const anylinuxfs = (format: DriveFormat): DriverOption => ({ id: `anylinuxfs-${format}`, name: 'anylinuxfs', format, platform: 'darwin', access: 'readwrite', license: 'GPL-3.0', url: 'https://github.com/nohajc/anylinuxfs', install: ['brew tap nohajc/anylinuxfs', 'brew install anylinuxfs', 'anylinuxfs mount /dev/diskNsM'], risk: 'medium', note: VIA_LINUX });
const sevenZip = (format: DriveFormat): DriverOption => ({ id: `7zip-${format}`, name: '7-Zip', format, platform: 'win32', access: 'read', license: 'LGPL-2.1 (parts BSD)', url: 'https://www.7-zip.org/', install: ['winget install 7zip.7zip'], risk: 'low', note: EXTRACT });
export const DRIVER_OPTIONS: DriverOption[] = [
  // macOS
  anylinuxfs('ntfs'),
  { id: 'ntfs-3g-mac', name: 'ntfs-3g + macFUSE', format: 'ntfs', platform: 'darwin', access: 'readwrite', license: 'GPL-2.0-or-later (macFUSE is not fully open source)', url: 'https://github.com/tuxera/ntfs-3g', install: ['brew install --cask macfuse', 'brew install gromgit/fuse/ntfs-3g-mac'], risk: 'medium',
    note: 'The long-standing NTFS driver. It needs macFUSE, whose kernel extension is closed source and must be allowed in System Settings by you. A drive Windows left hibernated (Fast Startup) mounts read-only.' },
  { id: 'mntfs', name: 'MNtfs', format: 'ntfs', platform: 'darwin', access: 'readwrite', license: 'GPL-2.0', url: 'https://github.com/maclifevn/mntfs', install: [], risk: 'high',
    note: 'An early FSKit driver. It deletes hiberfil.sys to mount a drive Windows left hibernated. Not for a backup drive yet.' },
  anylinuxfs('ext'),
  { id: 'extendfs', name: 'ExtendFS', format: 'ext', platform: 'darwin', access: 'read', license: 'GPL-3.0-or-later', url: 'https://github.com/kthchew/ExtendFS', install: [], risk: 'low',
    note: 'An FSKit extension for macOS 15.6 and later. Enable it in System Settings after installing.' },
  { id: 'ext4fuse', name: 'ext4fuse', format: 'ext', platform: 'darwin', access: 'read', license: 'GPL-2.0', url: 'https://github.com/gerard/ext4fuse', install: ['brew install --cask macfuse', 'brew install gromgit/fuse/ext4fuse-mac'], risk: 'low',
    note: 'Read only, and no longer updated (last change 2021). Needs macFUSE.' },
  anylinuxfs('btrfs'),
  // Windows
  { id: 'ext4fsd', name: 'Ext4Fsd', format: 'ext', platform: 'win32', access: 'readwrite', license: 'GPL-2.0', url: 'https://github.com/bobranten/Ext4Fsd', install: ['Ext2Fsd-0.71-setup.exe'], risk: 'medium',
    note: 'A maintained fork of Ext2Fsd for Windows 10 and 11. Some ext4 features make it mount read-only or not at all. Do not use the original Ext2Fsd: it is abandoned and can damage ext4 drives.' },
  { id: 'wsl-mount', name: 'wsl --mount', format: 'ext', platform: 'win32', access: 'readwrite', license: 'Part of Windows (WSL)', url: 'https://learn.microsoft.com/en-us/windows/wsl/wsl2-mount-disk', install: ['wsl --mount \\\\.\\PHYSICALDRIVEn --partition 1'], risk: 'low',
    note: 'Built into Windows 11 with WSL; needs an administrator. It does not support USB drives or card readers, and the drive shows as a network location, not a drive letter.' },
  { id: 'winbtrfs', name: 'WinBtrfs', format: 'btrfs', platform: 'win32', access: 'readwrite', license: 'LGPL', url: 'https://github.com/maharmstone/btrfs', install: ['winget install maharmstone.btrfs'], risk: 'medium',
    note: 'A Windows driver for Btrfs. Its author says to use it at your own risk and keep backups. Secure Boot can stop it from loading.' },
  { id: 'hfsexplorer', name: 'HFSExplorer', format: 'hfs', platform: 'win32', access: 'read', license: 'GPL-3.0', url: 'https://www.catacombae.org/hfsexplorer/', install: [], risk: 'low',
    note: 'Copies files off a Mac OS Extended drive; it cannot write or show the drive as a drive letter. Needs Java.' },
  sevenZip('hfs'),
  sevenZip('apfs'),
  // Linux
  { id: 'apfs-fuse', name: 'apfs-fuse', format: 'apfs', platform: 'linux', access: 'read', license: 'GPL-2.0', url: 'https://github.com/sgan81/apfs-fuse', install: ['apfs-fuse /dev/sdX2 /mnt/apfs'], risk: 'low',
    note: 'Read only. Encrypted volumes of Macs with a T2 chip are not supported.' },
  { id: 'linux-apfs-rw', name: 'linux-apfs-rw', format: 'apfs', platform: 'linux', access: 'readwrite', license: 'GPL-2.0', url: 'https://github.com/linux-apfs/linux-apfs-rw', install: ['make && sudo insmod apfs.ko', 'sudo mount -t apfs -o readwrite /dev/sdX2 /mnt/apfs'], risk: 'high',
    note: 'A kernel module that reads APFS. Writing (the readwrite option) is experimental: its authors warn of a real risk of corrupting the drive.' },
  { id: 'hfsplus-nojournal', name: 'hfsplus (journal off)', format: 'hfs', platform: 'linux', access: 'readwrite', license: 'GPL-2.0 (Linux)', url: 'https://docs.kernel.org/filesystems/hfsplus.html', install: ['diskutil disableJournal /Volumes/NAME   (on a Mac)', 'sudo mount -t hfsplus -o rw /dev/sdX2 /mnt/hfs'], risk: 'medium',
    note: 'Linux writes Mac OS Extended only when its journal is off, which a Mac can do. Never use the force option on a journaled drive.' },
];

/** The drivers listed for a format on a system, read/write first. */
export function driverOptions(format: DriveFormat | undefined, platform: string): DriverOption[] {
  return DRIVER_OPTIONS.filter(option => option.format === format && option.platform === platform).sort((a, b) => (a.access === b.access ? 0 : a.access === 'readwrite' ? -1 : 1));
}
/** Only these links open, in the user's own browser. */
export const driverLinks = (): Set<string> => new Set(DRIVER_OPTIONS.map(option => option.url));

/** The files a plan would write that the destination's format cannot hold: nothing is copied when there is one. */
export function filesTooLarge(plan: Pick<TransferPlan, 'entries'>, format: DriveFormat | undefined): PlanEntry[] {
  const limit = format ? FORMAT_TRAITS[format].maxFileBytes : undefined;
  return limit === undefined ? [] : plan.entries.filter(entry => !entry.skip && entry.size > limit);
}
/** Refuses an import before anything is copied when a destination's format cannot hold one of its files (FAT32 and
 * 4 GiB): `fsTypeOf` names the file system a plan's root is on. Each plan's video folder is checked with its own drive. */
export function checkFileSizes(plans: readonly (Pick<TransferPlan, 'root' | 'entries'> & { videos?: Pick<TransferPlan, 'root' | 'entries'>; other?: Pick<TransferPlan, 'root' | 'entries'> })[], fsTypeOf: (root: string) => string | undefined): void {
  for (const [index, plan] of plans.entries()) for (const part of [plan, ...(plan.videos ? [plan.videos] : []), ...(plan.other ? [plan.other] : [])]) {
    const fsType = fsTypeOf(part.root), format = driveFormat(fsType), large = filesTooLarge(part, format);
    if (!large.length) continue;
    const largest = large.reduce((a, b) => b.size > a.size ? b : a), name = largest.source.split(/[\\/]/).pop() ?? largest.source;
    throw new MessageError('error.fileTooLargeForFormat', { index: index + 1, format: formatLabel(format, fsType), limit: FORMAT_TRAITS[format!].maxFileLabel!, count: large.length, name, size: { bytes: largest.size } });
  }
}
