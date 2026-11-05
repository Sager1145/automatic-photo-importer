// Windows: the app's Get-Volume/Get-Disk JSON (DriveType by name), drive letters, junctions (no Developer Mode
// needed), and no folder flush.
import { symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { parseWindowsVolumes } from '../../platform/volumes';
import { createDriveSampler, parseWindowsDiskCounters } from '../../platform/drive-activity';
import type { PlatformProfile } from '../platform-features';

export const win32: PlatformProfile = {
  platform: 'win32',
  volumes: () => parseWindowsVolumes([
    { Path: 'D:\\', Label: '', VolumeId: '\\\\?\\Volume{card}\\', DriveType: 'Removable', Size: 239990210560, SizeRemaining: 213800000000, DiskNumber: 2, UniqueId: 'CFB16014C07D', BusType: 'USB', FriendlyName: 'Sony DSC USB Device', FileSystem: 'exFAT', IsReadOnly: false },
    { Path: 'I:\\', Label: 'A006', VolumeId: '\\\\?\\Volume{ssd}\\', DriveType: 'Fixed', Size: 2000319152128, SizeRemaining: 192869695488, DiskNumber: 1, UniqueId: '5000000000000001', BusType: 'USB', FriendlyName: 'Micron CT2000X9PROSSD9', FileSystem: 'exFAT', IsReadOnly: false },
  ]),
  driveNames: ['Sony DSC (D:)', 'A006'],
  driveMedia: ['camera', 'external-disk'],
  // Get-Volume/Get-Disk: a disc is DriveType CD-ROM; a reader's model names its card; a floppy is 1.44 MB FAT.
  otherMedia: () => parseWindowsVolumes([
    { Path: 'E:\\', Label: 'CFEB', DriveType: 'Removable', Size: 512e9, SizeRemaining: 4e11, DiskNumber: 3, BusType: 'USB', FriendlyName: 'ProGrade CFexpress Type B USB Device', FileSystem: 'exFAT', IsReadOnly: false },
    { Path: 'F:\\', Label: 'MICRO', DriveType: 'Removable', Size: 128e9, SizeRemaining: 1e11, DiskNumber: 4, BusType: 'USB', FriendlyName: 'Generic- Micro SD/M2 USB Device', FileSystem: 'exFAT', IsReadOnly: false },
    { Path: 'G:\\', Label: 'STICK', DriveType: 'Removable', Size: 64e9, SizeRemaining: 6e10, DiskNumber: 5, BusType: 'USB', FriendlyName: 'SanDisk Ultra Fit USB Device', FileSystem: 'exFAT', IsReadOnly: false },
    { Path: 'H:\\', Label: 'HOLIDAY', DriveType: 'CD-ROM', Size: 4.7e9, SizeRemaining: 0, FileSystem: 'UDF', IsReadOnly: true },
    { Path: 'A:\\', Label: '', DriveType: 'Removable', Size: 1457664, SizeRemaining: 1e6, DiskNumber: 6, BusType: 'USB', FriendlyName: 'TEAC USB UF000x USB Device', FileSystem: 'FAT', IsReadOnly: false },
  ]),
  link: (target, at) => symlink(target, at, 'junction'),
  navigatorPlatform: 'Win32',
  cameraPlace: 'USB\\Z f',
  cameraFolder: '\\\\?\\photo-importer-camera',
  systemDisk: 'NTFS',
  formats: {
    // Get-Volume FileSystem as Windows names it: NTFS, exFAT, FAT32 and ReFS get drive letters; APFS, HFS+ and ext4 do not.
    volumes: () => parseWindowsVolumes((['NTFS', 'exFAT', 'FAT32', 'ReFS'] as const).map((type, index) => ({ Path: `${'EFGH'[index]}:\\`, Label: type, VolumeId: `\\\\?\\Volume{${type}}\\`, DriveType: 'Fixed', Size: 1e12, SizeRemaining: 5e11, DiskNumber: index + 3, UniqueId: `disk-${type}`, BusType: 'USB', FriendlyName: `${type} USB Device`, FileSystem: type, IsReadOnly: false }))),
    expect: [{ format: 'ntfs', access: 'readwrite' }, { format: 'exfat', access: 'readwrite' }, { format: 'fat', access: 'readwrite' }, { format: 'refs', access: 'readwrite' }],
  },
  exfatDirect: false,
  folderFlush: false,
  noHardLinkError: 'EISDIR',
  folderKeyProvesNames: false,
  // The A006 SSD's root (I:\) as Windows reports it: the volume serial 0xA04AA04E, and file id 0 for a volume root.
  recordsDrive: { dev: 2689245262n, ino: 0n, identity: '2689245262:0' },
  otherFiles: { library: 'I:\\photobackup', beside: 'I:\\photobackup-otherfiles', top: 'I:\\', inside: 'I:\\library-otherfiles' },
  namesIgnoreCase: true,
  // Explorer and Lightroom take drive-letter paths with backslashes (C:\…).
  dropPath: /^[A-Za-z]:\\(?!.*\/)/,
  heldOpen,
  previews: { photos: 'shell', posters: true },
  // Win32_PerfRawData_PerfDisk_PhysicalDisk as the app's reader prints it: instances by disk number and drive letters.
  driveActivity: { disks: [['D:'], ['I:']], sampler: now => {
    let next = 0;
    return createDriveSampler({ now, counters: async wanted => new Map([...parseWindowsDiskCounters(JSON.stringify(physicalDisks[Math.min(next++, 1)]))].filter(([disk]) => wanted.has(disk))) });
  } },
};

// Two readings on this PC; the card (disk 2, D:) was read between them.
const physicalDisks = [
  [
    { Name: '0 C:', DiskReadBytesPersec: 91503005184, DiskWriteBytesPersec: 120117067264, DiskReadsPersec: 3712040, DiskWritesPersec: 5260112, PercentDiskReadTime: 5143911050, PercentDiskWriteTime: 2871601030 },
    { Name: '1 I:', DiskReadBytesPersec: 1043332608, DiskWriteBytesPersec: 40517177344, DiskReadsPersec: 20113, DiskWritesPersec: 310221, PercentDiskReadTime: 63112050, PercentDiskWriteTime: 1830117020 },
    { Name: '2 D:', DiskReadBytesPersec: 21331116032, DiskWriteBytesPersec: 1048576, DiskReadsPersec: 162740, DiskWritesPersec: 16, PercentDiskReadTime: 2101180400, PercentDiskWriteTime: 1200 },
    { Name: '_Total', DiskReadBytesPersec: 113877453824, DiskWriteBytesPersec: 160635293184, DiskReadsPersec: 3894893, DiskWritesPersec: 5570349, PercentDiskReadTime: 7308203500, PercentDiskWriteTime: 4701719250 },
  ],
  [
    { Name: '0 C:', DiskReadBytesPersec: 91503267328, DiskWriteBytesPersec: 120118640128, DiskReadsPersec: 3712052, DiskWritesPersec: 5260190, PercentDiskReadTime: 5143941050, PercentDiskWriteTime: 2871801030 },
    { Name: '1 I:', DiskReadBytesPersec: 1043332608, DiskWriteBytesPersec: 40613646336, DiskReadsPersec: 20113, DiskWritesPersec: 310590, PercentDiskReadTime: 63112050, PercentDiskWriteTime: 1836117020 },
    { Name: '2 D:', DiskReadBytesPersec: 21427585024, DiskWriteBytesPersec: 1048576, DiskReadsPersec: 163108, DiskWritesPersec: 16, PercentDiskReadTime: 2108680400, PercentDiskWriteTime: 1200 },
    { Name: '_Total', DiskReadBytesPersec: 113974185024, DiskWriteBytesPersec: 160733335040, DiskReadsPersec: 3895273, DiskWritesPersec: 5570796, PercentDiskReadTime: 7315733500, PercentDiskWriteTime: 4707919250 },
  ],
];

// Every file and folder under the root opened as another program would to have it alone: CreateFileW with no sharing
// (folders with backup semantics). A sharing violation means something holds it; one that lasts past three tries half
// a second apart is a real hold, not Defender or the indexer glancing at a new file.
const probe = String.raw`
$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class Exclusive {
 [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static bool Held(string name) { var handle = CreateFileW(name, 0x80000000, 0, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero); if (handle == new IntPtr(-1)) return Marshal.GetLastWin32Error() == 32; CloseHandle(handle); return false; }
}
"@
$held=@(@($env:PROBE_ROOT)+@(Get-ChildItem -LiteralPath $env:PROBE_ROOT -Recurse -Force|ForEach-Object{$_.FullName})|Where-Object{[Exclusive]::Held($_)})
for($try=0;$try -lt 2 -and $held.Count;$try++){Start-Sleep -Milliseconds 500;$held=@($held|Where-Object{[Exclusive]::Held($_)})}
$held|ForEach-Object{[Console]::Out.WriteLine($_)}
`;
function heldOpen(root: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(probe, 'utf16le').toString('base64')], { env: { ...process.env, PROBE_ROOT: root }, windowsHide: true, timeout: 120000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`exclusive-open probe failed: ${stderr || error?.message}`));
      else resolve(stdout.split(/\r?\n/).filter(Boolean));
    });
  });
}
