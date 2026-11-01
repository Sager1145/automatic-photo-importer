// Linux: `lsblk --json --bytes` output, /media mounts, symbolic links, folders that can be flushed.
import { readdir, readlink, symlink } from 'node:fs/promises';
import { sep } from 'node:path';
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
  cameraFolder: '/.photo-importer-camera',
  systemDisk: 'ext4',
  formats: {
    // lsblk FSTYPE (the format on the disk, whichever driver mounts it): ext4, Btrfs, FAT32 (vfat), exFAT, NTFS (ntfs3), HFS+ and APFS (apfs-fuse).
    volumes: () => parseLinuxVolumes({ blockdevices: (['ext4', 'btrfs', 'vfat', 'exfat', 'ntfs', 'hfsplus', 'apfs'] as const).map((type, index) => ({ name: `sd${'cdefghi'[index]}`, path: `/dev/sd${'cdefghi'[index]}`, type: 'disk', rm: false, rota: false, hotplug: true, tran: 'usb', children: [{ name: `sd${'cdefghi'[index]}1`, path: `/dev/sd${'cdefghi'[index]}1`, mountpoints: [`/media/user/${type}`], uuid: `${type}-UUID`, label: type, size: 1e12, fsavail: 5e11, fstype: type, ro: type === 'hfsplus' || type === 'apfs' }] })) }),
    expect: [{ format: 'ext', access: 'readwrite' }, { format: 'btrfs', access: 'readwrite' }, { format: 'fat', access: 'readwrite' }, { format: 'exfat', access: 'readwrite' }, { format: 'ntfs', access: 'readwrite' }, { format: 'hfs', access: 'read', readOnly: true }, { format: 'apfs', access: 'none', readOnly: true }],
  },
  exfatDirect: false,
  folderFlush: true,
  noHardLinkError: 'EPERM',
  folderKeyProvesNames: true,
  // An exFAT root under /media as Linux reports it (illustrative: no Linux reading of A006 yet); the device number changes per mount.
  recordsDrive: { dev: 2065n, ino: 1n, identity: '1' },
  otherFiles: { library: '/media/sager/A006/photobackup', beside: '/media/sager/A006/photobackup-otherfiles', top: '/media/sager/A006', inside: '/media/sager/A006/A006-otherfiles' },
  namesIgnoreCase: false,
  // File managers take POSIX paths with forward slashes.
  dropPath: /^\/(?!.*\\)/,
  heldOpen,
  previews: { photos: 'image', posters: false },
};

/** What this process has open under the root: its descriptors in /proc (lsof is not on every distribution). */
async function heldOpen(root: string): Promise<string[]> {
  const held: string[] = [];
  for (const fd of await readdir('/proc/self/fd')) {
    const target = await readlink(`/proc/self/fd/${fd}`).catch(() => '');
    if (target === root || target.startsWith(root + sep)) held.push(target);
  }
  return held;
}
