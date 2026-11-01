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
  folderFlush: true,
  // The A006 SSD's root as macOS reports it (its store.json from 0.3.0 recorded 16777241:18); the device number changes per mount.
  recordsDrive: { dev: 16777241n, ino: 18n, identity: '18' },
};
