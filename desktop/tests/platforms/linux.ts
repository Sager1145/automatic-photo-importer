// Linux: `lsblk --json --bytes` output, /media mounts, symbolic links, folders that can be flushed.
import { symlink } from 'node:fs/promises';
import { parseLinuxVolumes } from '../../platform/volumes';
import type { PlatformProfile } from '../platform-features';

export const linux: PlatformProfile = {
  platform: 'linux',
  volumes: () => parseLinuxVolumes({ blockdevices: [
    { name: 'mmcblk0', path: '/dev/mmcblk0', type: 'disk', rm: true, tran: 'mmc', children: [{ name: 'mmcblk0p1', path: '/dev/mmcblk0p1', mountpoints: ['/media/user/NIKON Z F'], uuid: 'CARD-UUID', label: 'NIKON Z F', size: 124642131968, fsavail: 93033594880, fstype: 'exfat' }] },
    { name: 'sdb', path: '/dev/sdb', type: 'disk', rm: false, rota: false, hotplug: true, tran: 'usb', children: [{ name: 'sdb1', path: '/dev/sdb1', mountpoints: ['/media/user/A006'], uuid: 'SSD-UUID', label: 'A006', size: 2000319152128, fsavail: 192869695488, fstype: 'exfat' }] },
  ] }),
  driveNames: ['NIKON Z F', 'A006'],
  link: (target, at) => symlink(target, at, 'dir'),
  navigatorPlatform: 'Linux x86_64',
  cameraPlace: 'USB/Z f',
  systemDisk: 'ext4',
  exfatDirect: false,
  folderFlush: true,
};
