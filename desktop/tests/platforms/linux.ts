// Linux: `lsblk --json --bytes` output, /media mounts, symbolic links, folders that can be flushed.
import { readdir, readlink, symlink } from 'node:fs/promises';
import { sep } from 'node:path';
import { parseLinuxVolumes } from '../../platform/volumes';
import { createDriveSampler, parseLinuxDiskstats } from '../../platform/drive-activity';
import type { PlatformProfile } from '../platform-features';

export const linux: PlatformProfile = {
  platform: 'linux',
  volumes: () => parseLinuxVolumes({ blockdevices: [
    { name: 'mmcblk0', path: '/dev/mmcblk0', type: 'disk', rm: true, tran: 'mmc', children: [{ name: 'mmcblk0p1', path: '/dev/mmcblk0p1', mountpoints: ['/media/user/NIKON Z F'], uuid: 'CARD-UUID', label: 'NIKON Z F', size: 124642131968, fsavail: 93033594880, fstype: 'exfat' }] },
    { name: 'sdb', path: '/dev/sdb', type: 'disk', rm: false, rota: false, hotplug: true, tran: 'usb', children: [{ name: 'sdb1', path: '/dev/sdb1', mountpoints: ['/media/user/A006'], uuid: 'SSD-UUID', label: 'A006', size: 2000319152128, fsavail: 192869695488, fstype: 'exfat' }] },
  ] }),
  driveNames: ['NIKON Z F', 'A006'],
  driveMedia: ['sd', 'external-disk'],
  // `lsblk` with MODEL and VENDOR: a reader's model names its card; a disc is TYPE rom, a floppy is fd0.
  otherMedia: () => parseLinuxVolumes({ blockdevices: [
    { name: 'sdc', path: '/dev/sdc', type: 'disk', rm: true, hotplug: true, tran: 'usb', vendor: 'ProGrade', model: 'CFexpress Type B Reader', children: [{ name: 'sdc1', path: '/dev/sdc1', mountpoints: ['/media/user/CFEB'], label: 'CFEB', size: 512e9, fstype: 'exfat' }] },
    { name: 'sdd', path: '/dev/sdd', type: 'disk', rm: true, hotplug: true, tran: 'usb', vendor: 'Generic-', model: 'Micro SD/M2', children: [{ name: 'sdd1', path: '/dev/sdd1', mountpoints: ['/media/user/MICRO'], label: 'MICRO', size: 128e9, fstype: 'exfat' }] },
    { name: 'sde', path: '/dev/sde', type: 'disk', rm: true, hotplug: true, tran: 'usb', vendor: 'SanDisk', model: 'Ultra Fit', children: [{ name: 'sde1', path: '/dev/sde1', mountpoints: ['/media/user/STICK'], label: 'STICK', size: 64e9, fstype: 'exfat' }] },
    { name: 'sr0', path: '/dev/sr0', type: 'rom', rm: true, hotplug: true, tran: 'usb', vendor: 'HL-DT-ST', model: 'DVDRAM GP65NB60', mountpoints: ['/media/user/HOLIDAY'], label: 'HOLIDAY', size: 4.7e9, fstype: 'udf', ro: true },
    { name: 'fd0', path: '/dev/fd0', type: 'disk', rm: true, mountpoints: ['/media/user/FLOPPY'], label: 'FLOPPY', size: 1474560, fstype: 'vfat' },
  ] }),
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
  previews: { photos: 'image', posters: false, measured: { skip: 'the decoder is Electron\'s nativeImage, which exists only inside the app' } },
  // Two readings of /proc/diskstats (whole disks and partitions); the card (mmcblk0) was read between them.
  driveActivity: { disks: [['mmcblk0'], ['sdb']], sampler: now => {
    let next = 0;
    return createDriveSampler({ now, counters: async wanted => new Map([...parseLinuxDiskstats(diskstats[Math.min(next++, 1)]!)].filter(([disk]) => wanted.has(disk))) });
  } },
};

const diskstats = [
  [
    '   8       0 sda 412337 10112 30117234 210334 501231 90233 81223114 993221 0 612331 1203555 0 0 0 0 20111 1112',
    '   8      16 sdb 2011 0 160112 1203 310221 0 79135112 3574133 0 401220 3575336 0 0 0 0 0 0',
    '   8      17 sdb1 1990 0 159800 1200 310221 0 79135112 3574133 0 401220 3575333 0 0 0 0 0 0',
    ' 179       0 mmcblk0 162740 0 41662336 210118 16 0 2048 12 0 180113 210130 0 0 0 0 0 0',
    ' 179       1 mmcblk0p1 162700 0 41660000 210100 16 0 2048 12 0 180100 210112 0 0 0 0 0 0',
  ].join('\n'),
  [
    '   8       0 sda 412349 10112 30117746 210337 501309 90233 81226186 993241 0 612351 1203578 0 0 0 0 20111 1112',
    '   8      16 sdb 2011 0 160112 1203 310590 0 79323528 3580133 0 401820 3581336 0 0 0 0 0 0',
    '   8      17 sdb1 1990 0 159800 1200 310590 0 79323528 3580133 0 401820 3581333 0 0 0 0 0 0',
    ' 179       0 mmcblk0 163108 0 41850752 210868 16 0 2048 12 0 180863 210880 0 0 0 0 0 0',
    ' 179       1 mmcblk0p1 163068 0 41848416 210850 16 0 2048 12 0 180850 210862 0 0 0 0 0 0',
  ].join('\n'),
];

/** What this process has open under the root: its descriptors in /proc (lsof is not on every distribution). */
async function heldOpen(root: string): Promise<string[]> {
  const held: string[] = [];
  for (const fd of await readdir('/proc/self/fd')) {
    const target = await readlink(`/proc/self/fd/${fd}`).catch(() => '');
    if (target === root || target.startsWith(root + sep)) held.push(target);
  }
  return held;
}
