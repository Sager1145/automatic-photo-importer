// One list of app features, tested on every platform. Each platform's test file runs all of them with its own
// profile: that system's real tool output, paths and ways to build a fixture. The assertions live here once, so
// macOS, Windows and Linux are held to the same behavior. A new feature goes in FEATURES and every platform
// profile must supply what it needs; TypeScript and platform-parity.test.ts refuse a platform that skips one.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyVolume, validateDestination, type MountedVolume } from '../platform/volumes';
import { cameraCapacity } from '../platform/camera-bridge';
import { DIRECTORY_SYNC_SUPPORTED, posixRelative, syncDirectory, syncFile } from '../core/paths';
import { appleDoubleCleaner } from '../core/index';
import { inventory } from '../core/inventory';

export type Platform = 'darwin' | 'win32' | 'linux';
export interface PlatformProfile {
  platform: Platform;
  /** This system's drive tool output, parsed by its adapter: [an SD card, an external SSD destination]. */
  volumes(): MountedVolume[];
  /** Names people should see for those two drives. */
  driveNames: [card: string, ssd: string];
  /** This system's kind of folder link: a symbolic link, or a junction on Windows (no Developer Mode needed). */
  link(target: string, at: string): Promise<void>;
  /** navigator.platform in this system's app window, and how a USB camera named "Z f" reads there. */
  navigatorPlatform: string;
  cameraPlace: string;
  /** Whether the system can flush a folder's entries to disk. */
  folderFlush: boolean;
  /** Whether file names match whatever their case (".ds_store" is ".DS_Store"). */
  namesIgnoreCase: boolean;
}

/** Features that need this system's real filesystem run only there (elsewhere they skip, saying why); the rest
 * use recorded tool output and run on any system. */
const onNative = (profile: PlatformProfile, t: TestContext) => {
  if (process.platform === profile.platform) return true;
  t.skip(`needs a ${profile.platform} filesystem`); return false;
};

export const FEATURES: Record<string, (profile: PlatformProfile, t: TestContext) => void | Promise<void>> = {
  'drive detection: a camera card is a source, an external SSD is a destination': profile => {
    const [card, ssd] = profile.volumes();
    assert.equal(classifyVolume(card!, ['DCIM']).source, true, 'card is a source');
    assert.equal(classifyVolume(ssd!, []).source, false, 'SSD is not a source');
    assert.equal(card!.removable, true);
    assert.deepEqual([card!.name, ssd!.name], profile.driveNames);
    for (const volume of [card!, ssd!]) { assert.ok((volume.total ?? 0) > 0, 'capacity'); assert.ok((volume.free ?? -1) >= 0, 'free space'); }
  },
  'destination: a camera card reached through a folder link is refused': async (profile, t) => {
    if (!onNative(profile, t)) return;
    {
      const root = await mkdtemp(join(tmpdir(), 'feature-link-'));
      try {
        const card = join(root, 'card'); await mkdir(join(card, 'DCIM'), { recursive: true });
        await profile.link(card, join(root, 'alias'));
        await assert.rejects(validateDestination(join(root, 'alias', 'nested'), [{ id: 'card', name: 'Card', path: card, transport: 'storage', camera: true }]), /source|camera|card/i);
        await validateDestination(join(root, 'backup'), []);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  },
  'durable writes: copies and folders are flushed the way the system allows': async (profile, t) => {
    if (!onNative(profile, t)) return;
    assert.equal(DIRECTORY_SYNC_SUPPORTED, profile.folderFlush);
    {
      const root = await mkdtemp(join(tmpdir(), 'feature-sync-'));
      try {
        const file = join(root, 'A.JPG'); await writeFile(file, 'jpeg');
        await syncFile(file);
        await syncDirectory(root);
        await assert.rejects(syncDirectory(file), /Directory synchronization failed/);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  },
  'records: relative paths are stored with "/" on every system': () => {
    const root = join(tmpdir(), 'library');
    assert.equal(posixRelative(root, join(root, '2026', '202610', 'NIKON Z f', 'DSC_0001.NEF')), '2026/202610/NIKON Z f/DSC_0001.NEF');
  },
  'USB camera without a drive letter reads as a short path': async profile => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { platform: profile.navigatorPlatform }, configurable: true });
    try {
      const { sourcePlace } = await import('../renderer/RootApp');
      assert.equal(sourcePlace({ name: 'Z f', path: 'camera://%3A%3A%7B20D04FE0%7D', transport: 'camera' }), profile.cameraPlace);
      assert.equal(sourcePlace({ name: 'Card', path: profile.volumes()[0]!.path, transport: 'storage' }), profile.volumes()[0]!.path);
    } finally { if (saved) Object.defineProperty(globalThis, 'navigator', saved); }
  },
  'Mac system files: skipped on sources, and .DS_Store removed only as a plain file the system names .DS_Store': async (profile, t) => {
    if (!onNative(profile, t)) return;
    const root = await realpath(await mkdtemp(join(tmpdir(), 'feature-mac-files-')));
    try {
      const finder = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from('Bud1'), Buffer.alloc(56)]);
      const has = (file: string) => lstat(file).then(() => true, () => false);
      // Source: on, a card's Finder files are not listed; off, they are (as system files).
      const card = join(root, 'card', 'DCIM'); await mkdir(card, { recursive: true });
      await writeFile(join(card, 'A.JPG'), 'jpeg'); await writeFile(join(card, '.DS_Store'), finder); await writeFile(join(card, '._A.JPG'), 'apple double');
      assert.equal((await inventory(join(root, 'card'))).files.length, 1);
      assert.equal((await inventory(join(root, 'card'), { keepMacFiles: true })).files.filter(file => file.system?.id === 'macos-system').length, 2);
      // Destination: a lower-case name is the same file where names ignore case.
      const library = join(root, 'library'), cleaner = appleDoubleCleaner(), placed = () => true;
      const lower = join(library, 'lower'); await mkdir(lower, { recursive: true });
      await writeFile(join(lower, 'A.JPG'), 'jpeg'); await writeFile(join(lower, '.ds_store'), finder);
      await cleaner.besideFile(join(lower, 'A.JPG'), library, placed);
      assert.equal(await has(join(lower, '.ds_store')), !profile.namesIgnoreCase, 'case rule');
      const exact = join(library, 'exact'); await mkdir(exact);
      await writeFile(join(exact, 'A.JPG'), 'jpeg'); await writeFile(join(exact, '.DS_Store'), finder);
      await cleaner.besideFile(join(exact, 'A.JPG'), library, placed);
      assert.equal(await has(join(exact, '.DS_Store')), false);
      // This system's folder link named .DS_Store is never removed or entered.
      const linked = join(library, 'linked'), target = join(root, 'target'); await mkdir(linked); await mkdir(target);
      await writeFile(join(target, 'keep.txt'), 'keep'); await writeFile(join(linked, 'A.JPG'), 'jpeg');
      await profile.link(target, join(linked, '.DS_Store'));
      await cleaner.besideFile(join(linked, 'A.JPG'), library, placed);
      assert.ok((await lstat(join(linked, '.DS_Store'))).isSymbolicLink(), 'the link stays');
      assert.deepEqual(await readdir(target), ['keep.txt']);
      // The app's own folders keep theirs.
      const records = join(library, 'Photo Importer Data'); await mkdir(records);
      await writeFile(join(records, 'A.JPG'), 'jpeg'); await writeFile(join(records, '.DS_Store'), finder);
      await cleaner.besideFile(join(records, 'A.JPG'), library, placed);
      assert.ok(await has(join(records, '.DS_Store')));
      assert.equal(cleaner.report.dsStore, profile.namesIgnoreCase ? 2 : 1);
      assert.ok(await has(join(card, '.DS_Store')), 'the source is never touched');
    } finally { await rm(root, { recursive: true, force: true }); }
  },
  'USB camera: each card slot and the total capacity are shown': () => {
    assert.deepEqual(cameraCapacity([{ name: 'Slot 1', total: 128, free: 64 }, { name: 'Slot 2', total: 128, free: 32 }]),
      { storages: [{ name: 'Slot 1', total: 128, free: 64 }, { name: 'Slot 2', total: 128, free: 32 }], total: 256, free: 96 });
  },
};

/** Registers every feature for one platform. */
export function testFeatures(profile: PlatformProfile) {
  for (const [name, check] of Object.entries(FEATURES)) test(`${profile.platform}: ${name}`, t => check(profile, t));
}
