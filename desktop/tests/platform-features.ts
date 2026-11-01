// One list of app features, tested on every platform. Each platform's test file runs all of them with its own
// profile: that system's real tool output, paths and ways to build a fixture. The assertions live here once, so
// macOS, Windows and Linux are held to the same behavior. A new feature goes in FEATURES and every platform
// profile must supply what it needs; TypeScript and platform-parity.test.ts refuse a platform that skips one.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyVolume, validateDestination, type MountedVolume } from '../platform/volumes';
import { cameraCapacity } from '../platform/camera-bridge';
import { DIRECTORY_SYNC_SUPPORTED, posixRelative, syncDirectory, syncFile } from '../core/paths';

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
  'USB camera: each card slot and the total capacity are shown': () => {
    assert.deepEqual(cameraCapacity([{ name: 'Slot 1', total: 128, free: 64 }, { name: 'Slot 2', total: 128, free: 32 }]),
      { storages: [{ name: 'Slot 1', total: 128, free: 64 }, { name: 'Slot 2', total: 128, free: 32 }], total: 256, free: 96 });
  },
};

/** Registers every feature for one platform. */
export function testFeatures(profile: PlatformProfile) {
  for (const [name, check] of Object.entries(FEATURES)) test(`${profile.platform}: ${name}`, t => check(profile, t));
}
