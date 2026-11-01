// Windows: the app's Get-Volume/Get-Disk JSON (DriveType by name), drive letters, junctions (no Developer Mode
// needed), and no folder flush.
import { symlink } from 'node:fs/promises';
import { parseWindowsVolumes } from '../../platform/volumes';
import type { PlatformProfile } from '../platform-features';

export const win32: PlatformProfile = {
  platform: 'win32',
  volumes: () => parseWindowsVolumes([
    { Path: 'D:\\', Label: '', VolumeId: '\\\\?\\Volume{card}\\', DriveType: 'Removable', Size: 239990210560, SizeRemaining: 213800000000, DiskNumber: 2, UniqueId: 'CFB16014C07D', BusType: 'USB', FriendlyName: 'Sony DSC USB Device', FileSystem: 'exFAT', IsReadOnly: false },
    { Path: 'I:\\', Label: 'A006', VolumeId: '\\\\?\\Volume{ssd}\\', DriveType: 'Fixed', Size: 2000319152128, SizeRemaining: 192869695488, DiskNumber: 1, UniqueId: '5000000000000001', BusType: 'USB', FriendlyName: 'Micron CT2000X9PROSSD9', FileSystem: 'exFAT', IsReadOnly: false },
  ]),
  driveNames: ['Sony DSC (D:)', 'A006'],
  link: (target, at) => symlink(target, at, 'junction'),
  navigatorPlatform: 'Win32',
  cameraPlace: 'USB\\Z f',
  systemDisk: 'NTFS',
  exfatDirect: false,
  folderFlush: false,
};
