// macOS: `diskutil info -plist` output, /Volumes mounts, symbolic links, folders that can be flushed.
import { symlink } from 'node:fs/promises';
import { parseMacVolume } from '../../platform/volumes';
import type { PlatformProfile } from '../platform-features';

export const darwin: PlatformProfile = {
  platform: 'darwin',
  volumes: () => [
    parseMacVolume({ MountPoint: '/Volumes/NIKON Z F', VolumeName: 'NIKON Z F', VolumeUUID: 'CARD-UUID', BusProtocol: 'Secure Digital', RemovableMedia: true, Internal: false, Writable: true, TotalSize: 124642131968, VolumeFreeSpace: 93033594880, FilesystemType: 'exfat', DeviceIdentifier: 'disk4s1', ParentWholeDisk: 'disk4' }, '/Volumes/NIKON Z F'),
    parseMacVolume({ MountPoint: '/Volumes/A006', VolumeName: 'A006', VolumeUUID: 'SSD-UUID', BusProtocol: 'USB', RemovableMedia: false, Internal: false, SolidState: true, Writable: true, TotalSize: 2000319152128, VolumeFreeSpace: 192869695488, FilesystemType: 'exfat', DeviceIdentifier: 'disk5s1', ParentWholeDisk: 'disk5' }, '/Volumes/A006'),
  ],
  driveNames: ['NIKON Z F', 'A006'],
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
};
