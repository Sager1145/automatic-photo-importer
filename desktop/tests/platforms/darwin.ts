// macOS: `diskutil info -plist` output, /Volumes mounts, symbolic links, folders that can be flushed.
import { symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { parseMacVolume } from '../../platform/volumes';
import type { PlatformProfile } from '../platform-features';

export const darwin: PlatformProfile = {
  platform: 'darwin',
  volumes: () => [
    parseMacVolume({ MountPoint: '/Volumes/NIKON Z F', VolumeName: 'NIKON Z F', VolumeUUID: 'CARD-UUID', BusProtocol: 'Secure Digital', RemovableMedia: true, Internal: false, Writable: true, TotalSize: 124642131968, VolumeFreeSpace: 93033594880, FilesystemType: 'exfat', DeviceIdentifier: 'disk4s1', ParentWholeDisk: 'disk4' }, '/Volumes/NIKON Z F'),
    parseMacVolume({ MountPoint: '/Volumes/A006', VolumeName: 'A006', VolumeUUID: 'SSD-UUID', BusProtocol: 'USB', RemovableMedia: false, Internal: false, SolidState: true, Writable: true, TotalSize: 2000319152128, VolumeFreeSpace: 192869695488, FilesystemType: 'exfat', DeviceIdentifier: 'disk5s1', ParentWholeDisk: 'disk5' }, '/Volumes/A006'),
  ],
  driveNames: ['NIKON Z F', 'A006'],
  driveMedia: ['sd', 'external-disk'],
  // `diskutil info -plist` of each volume, with its whole disk's (which names the reader or medium).
  otherMedia: () => [
    parseMacVolume({ MountPoint: '/Volumes/CFEB', VolumeName: 'CFEB', BusProtocol: 'USB', RemovableMedia: true, Internal: false, ParentWholeDisk: 'disk8', DeviceIdentifier: 'disk8s1', FilesystemType: 'exfat', TotalSize: 512e9 }, '/Volumes/CFEB', { IORegistryEntryName: 'ProGrade Digital CFexpress Type B Media', MediaName: 'CFexpress Type B', BusProtocol: 'USB' }),
    parseMacVolume({ MountPoint: '/Volumes/MICRO', VolumeName: 'MICRO', BusProtocol: 'USB', RemovableMedia: true, Internal: false, ParentWholeDisk: 'disk9', DeviceIdentifier: 'disk9s1', FilesystemType: 'exfat', TotalSize: 128e9 }, '/Volumes/MICRO', { IORegistryEntryName: 'Generic- Micro SD/M2 Media', BusProtocol: 'USB' }),
    parseMacVolume({ MountPoint: '/Volumes/STICK', VolumeName: 'STICK', BusProtocol: 'USB', RemovableMedia: true, Internal: false, ParentWholeDisk: 'disk10', DeviceIdentifier: 'disk10s1', FilesystemType: 'exfat', TotalSize: 64e9 }, '/Volumes/STICK', { IORegistryEntryName: 'SanDisk Ultra Fit Media', BusProtocol: 'USB' }),
    parseMacVolume({ MountPoint: '/Volumes/HOLIDAY', VolumeName: 'HOLIDAY', BusProtocol: 'USB', RemovableMedia: true, Internal: false, Writable: false, ParentWholeDisk: 'disk11', DeviceIdentifier: 'disk11', FilesystemType: 'udf', TotalSize: 4.7e9 }, '/Volumes/HOLIDAY', { OpticalDeviceType: 'DVD-RW', OpticalMediaType: 'DVD-ROM' }),
    parseMacVolume({ MountPoint: '/Volumes/UNTITLED', VolumeName: 'UNTITLED', BusProtocol: 'USB', RemovableMedia: true, Internal: false, ParentWholeDisk: 'disk12', DeviceIdentifier: 'disk12', FilesystemType: 'msdos', TotalSize: 1474560 }, '/Volumes/UNTITLED', { IORegistryEntryName: 'TEAC FD-05PUW Media' }),
  ],
  link: (target, at) => symlink(target, at, 'dir'),
  navigatorPlatform: 'MacIntel',
  cameraPlace: 'USB/Z f',
  cameraFolder: '/.photo-importer-camera',
  systemDisk: 'apfs',
  formats: {
    // diskutil info -plist of an APFS, a Mac OS Extended, an exFAT, a FAT32 (MS-DOS) and an NTFS drive (macOS mounts NTFS read-only).
    volumes: () => ([['APFS-SSD', 'apfs', true], ['TimeMachine', 'hfs', true], ['A006', 'exfat', true], ['CARD', 'msdos', true], ['WINDOWS', 'ntfs', false]] as const).map(([name, type, writable], index) =>
      parseMacVolume({ MountPoint: `/Volumes/${name}`, VolumeName: name, VolumeUUID: `${name}-UUID`, BusProtocol: 'USB', Internal: false, Writable: writable, TotalSize: 1e12, VolumeFreeSpace: 5e11, FilesystemType: type, DeviceIdentifier: `disk${index + 6}s1`, ParentWholeDisk: `disk${index + 6}` }, `/Volumes/${name}`)),
    expect: [{ format: 'apfs', access: 'readwrite' }, { format: 'hfs', access: 'readwrite' }, { format: 'exfat', access: 'readwrite' }, { format: 'fat', access: 'readwrite' }, { format: 'ntfs', access: 'read', readOnly: true }],
  },
  exfatDirect: true,
  folderFlush: true,
  noHardLinkError: 'ENOTSUP',
  folderKeyProvesNames: true,
  // The A006 SSD's root as macOS reports it (its store.json from 0.3.0 recorded 16777241:18); the device number changes per mount.
  recordsDrive: { dev: 16777241n, ino: 18n, identity: '18' },
  otherFiles: { library: '/Volumes/A006/photobackup', beside: '/Volumes/A006/photobackup-otherfiles', top: '/Volumes/A006', inside: '/Volumes/A006/A006-otherfiles' },
  namesIgnoreCase: true,
  // Finder and Lightroom take POSIX paths: /Volumes/… with forward slashes.
  dropPath: /^\/(?!.*\\)/,
  heldOpen,
  previews: { photos: 'system', posters: true },
};

/** What any process has open under the root, as lsof lists it (exit 1: nothing). */
function heldOpen(root: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/lsof', ['-n', '-Fn', '+D', root], { timeout: 120000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && (error as { code?: unknown }).code !== 1) reject(new Error(`lsof failed: ${stderr || error.message}`));
      else resolve(stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1)));
    });
  });
}
