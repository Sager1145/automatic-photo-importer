// One list of app features, tested on every platform. Each platform's test file runs all of them with its own
// profile: that system's real tool output, paths and ways to build a fixture. The assertions live here once, so
// macOS, Windows and Linux are held to the same behavior. A new feature goes in FEATURES and every platform
// profile must supply what it needs; TypeScript and platform-parity.test.ts refuse a platform that skips one.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { classifyVolume, validateDestination, type MountedVolume } from '../platform/volumes';
import { cameraCapacity } from '../platform/camera-bridge';
import { DIRECTORY_SYNC_SUPPORTED, pathKey, posixRelative, syncDirectory, syncFile } from '../core/paths';
import { evaluateRoutes } from '../core/folder-rules';
import { configureOrganizationRecovery, execute, plan } from '../core/index';
import { portableName, portablePath } from '../folder-template';
import type { InventoryFile } from '../shared';

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
  'library names: every name a library writes is valid on macOS, Windows and Linux, so the drive can move between them': async (profile, t) => {
    // A name another system refuses is changed; a valid one, whatever its Unicode form, never is.
    const fixed: Record<string, string> = { 'CON.txt': '_CON.txt', 'aux': '_aux', 'nul.tar.gz': '_nul.tar.gz', 'COM1.JPG': '_COM1.JPG', 'a:b?.zip': 'a-b-.zip', 'notes. ': 'notes', 'pipe|star*.txt': 'pipe-star-.txt', '...': '_' };
    for (const [name, portable] of Object.entries(fixed)) assert.equal(portableName(name), portable, name);
    for (const name of ['DSC_0001.NEF', 'JPG的替身', 'Café.jpg', 'Café.jpg', 'CONSOLE.txt', '.hidden']) assert.equal(portableName(name), name);
    const native = profile.platform === 'win32' ? '\\' : '/';
    assert.equal(portablePath(['Unknown files', 'old.', 'CON.txt'].join(native), native), ['Unknown files', 'old', '_CON.txt'].join(native));
    // On macOS and Linux a "\" is part of a name, which Windows would read as a folder: it is replaced.
    if (profile.platform !== 'win32') assert.equal(portablePath('Unknown files/a\\b.txt', '/'), 'Unknown files/a-b.txt');
    // Routing applies it to every file it files, photos and other files alike, with "/" in what is stored.
    const card = join(tmpdir(), 'card'), when = new Date(2026, 9, 25, 12);
    const listed: InventoryFile[] = ['CON.ARW', 'a:b.zip', 'trailing. '].map(name => ({ path: join(card, name), relative: name, size: 1, kind: name.endsWith('.ARW') ? 'RAW' : 'Other', included: true }));
    const routes = evaluateRoutes({ sourceRoot: card, files: listed, metadata: new Map([[listed[0]!.path, { fields: {}, camera: 'ILCE-7M4', date: '2026-10-25T10:00:00' }]]), mtimes: new Map(listed.map(file => [file.path, when])), options: { template: '{year}/{yyyymm}/{camera}', layout: 'flat', unknownRules: {} } });
    assert.deepEqual(routes.map(route => route.relative!.split(sep).join('/')), ['2026/202610/ILCE-7M4/_CON.ARW', '2026/202610/Unknown files/a-b.zip', '2026/202610/Unknown files/trailing']);
    if (!onNative(profile, t)) return;
    // Names that differ only by case are one name on macOS and Windows: a library never holds both, on any system.
    configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'feature-names-')));
    try {
      const source = join(root, 'card'), library = join(root, 'photobackup'), put = async (file: string, text: string) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); await utimes(file, when, when); };
      await put(join(library, '2026', '202610', 'ILCE-7M4', 'DSC00003.JPG'), 'same');
      await put(join(source, 'A', 'dsc00003.jpg'), 'same'); await put(join(source, 'B', 'IMG_0001.JPG'), 'first'); await put(join(source, 'C', 'img_0001.jpg'), 'second');
      const metadata = async () => ({ fields: {}, camera: 'ILCE-7M4', date: '2026-10-25T10:00:00' });
      const { plans } = await plan(source, [library], { backup: false, everyFile: true, template: '{year}/{yyyymm}/{camera}', layout: 'flat', unknownRules: {} }, metadata);
      assert.deepEqual((await execute(plans[0]!)).errors, []);
      const written = (await readdir(library, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile() && !entry.parentPath.includes('Photo Importer Data')).map(entry => posixRelative(library, join(entry.parentPath, entry.name)));
      const folders = Map.groupBy(written, file => pathKey(file));
      assert.ok([...folders.values()].every(group => group.length === 1), `no two names differ by case alone: ${written.join(', ')}`);
      assert.ok(written.includes('2026/202610/ILCE-7M4/DSC00003.JPG') && !written.some(file => file.endsWith('dsc00003.jpg')), 'the same photo under another case is already there');
      const copies = await Promise.all(written.filter(file => /img_0001\.jpg$/i.test(file)).map(file => readFile(join(library, file), 'utf8')));
      assert.deepEqual(copies.sort(), ['first', 'second'], 'both photos are kept, one as a conflict');
      assert.ok(written.every(file => !file.includes('\\') && file === relative(library, join(library, file)).split(sep).join('/')));
    } finally { await rm(root, { recursive: true, force: true }); }
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
