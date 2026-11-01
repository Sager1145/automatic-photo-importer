// One list of app features, tested on every platform. Each platform's test file runs all of them with its own
// profile: that system's real tool output, paths and ways to build a fixture. The assertions live here once, so
// macOS, Windows and Linux are held to the same behavior. A new feature goes in FEATURES and every platform
// profile must supply what it needs; TypeScript and platform-parity.test.ts refuse a platform that skips one.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { link, lstat, mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { classifyVolume, validateDestination, type MountedVolume } from '../platform/volumes';
import { cameraCapacity } from '../platform/camera-bridge';
import { DIRECTORY_SYNC_SUPPORTED, pathKey, posixRelative, syncDirectory, syncFile } from '../core/paths';
import { EtaTracker, localDrives } from '../eta';
import { configureHostKey, ensureStore, hostKeyConfigured, openV5, storeIdentity, storesFor } from '../core/app-store';
import { otherComputer } from './fixtures/other-computer';
import { getOrganizationRecovery } from '../core/recovery';
import { randomUUID } from 'node:crypto';
import { evaluateRoutes } from '../core/folder-rules';
import { appleDoubleCleaner, configureOrganizationRecovery, execute, executeReorganization, plan } from '../core/index';
import { portableName, portablePath } from '../folder-template';
import type { InventoryFile } from '../shared';
import { checkFileSizes, driveFormat, FAT32_MAX_FILE_BYTES, nativeAccess, type Access, type DriveFormat } from '../core/drive-formats';
import { probeDestination } from '../core/destination-probe';
import { denyWrite, allowWrite, unixPermissions } from './fixtures/os';
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
  /** The file system of the computer's own disk as the adapter names it (NTFS, APFS, ext4): it has hard links, so files publish by linking. */
  systemDisk: string;
  /** exFAT destinations are written directly, each file checked in place (macOS, core/paths directCapable); elsewhere staged, then published by copying. */
  exfatDirect: boolean;
  /** A drive's root as this system reports it (the base of its records), and the identity a store keeps for it. */
  recordsDrive: { dev: bigint; ino: bigint; identity: string };
  /** This system's drive tool output for drives in each format people bring, and what this system can do with each one. */
  formats: { volumes(): MountedVolume[]; expect: { format: DriveFormat; access: Access; readOnly?: boolean }[] };
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
  'records: a store made on another system opens here, and each system keeps its own identity of the drive': async profile => {
    // docs/shared-records.md: the same drive is /Volumes/A006 on a Mac and I:\ on a PC, with different file identities.
    if (!hostKeyConfigured()) configureHostKey('fixture-only-host-recovery-secret-32bytes');
    assert.equal(storeIdentity(profile.recordsDrive, profile.platform), profile.recordsDrive.identity);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'feature-records-')));
    try {
      const here = await lstat(root, { bigint: true }), other = otherComputer(profile.platform);
      // As that system wrote it: the drive under its own path, and its own identity of the folder (this folder's, when it is this system).
      const identity = profile.platform === process.platform ? storeIdentity(here) : profile.recordsDrive.identity;
      await mkdir(join(root, 'Photo Importer Data'));
      await writeFile(join(root, 'Photo Importer Data', 'store.json'), JSON.stringify(other.storeRecord(profile.volumes()[1]!.path, identity)));
      assert.deepEqual((await storesFor(root)).map(store => store.verified), [true]);
      assert.equal(openV5('receipt', other.seal('receipt', { op: 'close', rid: 'written-there' })).op, 'close', 'its records verify here');
      assert.equal((await ensureStore(root)).joined, true);
      const record = JSON.parse(await readFile(join(root, 'Photo Importer Data', 'store.json'), 'utf8'));
      assert.equal(record.identities[profile.platform], identity, 'that system keeps its identity');
      assert.equal(record.identities[process.platform], storeIdentity(here));
      assert.equal(record.base, root);
      assert.deepEqual((await storesFor(root)).map(store => [store.verified, store.joined]), [[true, true]]);
      // Its journal names the library under its own path for the drive: listed here as recorded there, never acted on.
      const library = join(root, 'photobackup'), id = randomUUID();
      const recordedRoot = profile.volumes()[1]!.path.replace(/[\\/]+$/, '') + (profile.platform === 'win32' ? '\\' : '/') + 'photobackup';
      await mkdir(library); await mkdir(join(root, 'Photo Importer Data', 'Organizations', id), { recursive: true });
      await writeFile(join(root, 'Photo Importer Data', 'Organizations', id, 'journal.jsonl'), other.line('organization', { id, root: recordedRoot }) + '\n');
      const jobs = await getOrganizationRecovery(library);
      assert.deepEqual(jobs.map(job => [job.id, job.recordedElsewhere, job.undoable, job.finalizable]), [[id, recordedRoot, false, false]]);
    } finally { await rm(root, { recursive: true, force: true }); }
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
  'Mac system files: organizing a library a Mac wrote removes its bookkeeping "._" files in the folders touched, on any system': async (profile, t) => {
    if (!onNative(profile, t)) return;
    configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'feature-mac-sidecars-')));
    try {
      const has = (file: string) => lstat(file).then(() => true, () => false);
      // Bookkeeping only (what macOS writes for every entry on exFAT), and one holding a Finder colour label.
      const header = () => { const b = Buffer.alloc(4096); b.writeUInt32BE(0x00051607, 0); b.writeUInt32BE(0x00020000, 4); return b; };
      const labelled = () => { const b = header(); b.writeUInt16BE(1, 24); b.writeUInt32BE(9, 26); b.writeUInt32BE(50, 30); b.writeUInt32BE(32, 34); b[50 + 9] = 0x0c; return b; };
      const library = join(root, 'photobackup'), incoming = join(library, 'incoming'), other = join(library, 'other'), linked = join(library, 'linked');
      await mkdir(incoming, { recursive: true }); await mkdir(join(library, '2019'), { recursive: true }); await mkdir(other);
      await writeFile(join(incoming, 'M.JPG'), Buffer.alloc(5000, 3)); await writeFile(join(incoming, 'notes.txt'), 'keep');
      await writeFile(join(other, 'notes.txt'), 'o');
      // This system's folder link: its "._" is not a folder's, so it stays.
      await profile.link(other, linked);
      const mac = { root: join(root, '._photobackup'), folder: join(library, '._incoming'), year: join(library, '._2019'), photo: join(incoming, '._M.JPG'), tagged: join(incoming, '._TAGGED.JPG'), link: join(library, '._linked') };
      for (const [name, file] of Object.entries(mac)) await writeFile(file, name === 'tagged' ? labelled() : header());
      const metadata = async () => ({ fields: {}, camera: 'Nikon Z f', date: '2024-02-03T12:00:00Z' });
      const review = (await plan(library, [library], { backup: false, reorganize: true, template: '{year}/{yyyymm}/{camera}', layout: 'flat' }, metadata)).plans[0]!;
      const result = await executeReorganization(review, undefined, undefined, { removeAppleDouble: true });
      assert.deepEqual(result.errors, []);
      for (const name of ['root', 'folder', 'year', 'photo'] as const) assert.equal(await has(mac[name]), false, name);
      assert.ok(await has(mac.tagged), 'a "._" holding a label stays');
      assert.ok(await has(mac.link), 'the "._" of a folder link is not a folder\'s');
      assert.ok(result.appleDouble!.kept >= 1 && result.appleDouble!.removed + result.appleDouble!.orphans >= 4);
    } finally { await rm(root, { recursive: true, force: true }); }
  },
  'time left: publishing is priced as this system publishes on each file system': async (profile, t) => {
    const tracker = new EtaTracker(), [card, ssd] = profile.volumes(), drive = (fsType?: string, external = false) => ({ id: fsType, transport: 'storage', fsType, external });
    // The adapter's own names: an exFAT card or SSD (no hard links) publishes by copying, or is written directly where the system does that.
    for (const volume of [card!, ssd!]) {
      assert.equal(tracker.predictPublish([drive(volume.fsType, true)]), 'copy', `${volume.name}: ${volume.fsType}`);
      assert.equal(tracker.predictDirect([drive(volume.fsType, true)], profile.platform), profile.exfatDirect ? 1 : 0, `${volume.name} written directly`);
    }
    // The system's own disk links, and a job between two of its internal disks starts from disk rates, not a card's.
    assert.equal(tracker.predictPublish([drive(profile.systemDisk)]), 'link', profile.systemDisk);
    assert.equal(tracker.predictDirect([drive(profile.systemDisk)], profile.platform), 0);
    assert.ok(localDrives({ source: drive(profile.systemDisk), destinations: [drive(profile.systemDisk)] }));
    assert.ok(!localDrives({ source: drive(card!.fsType, true), destinations: [drive(profile.systemDisk)] }), 'a card is not an internal disk');
    if (!onNative(profile, t)) return;
    const root = await mkdtemp(join(tmpdir(), 'feature-publish-'));
    try {
      // What 'link' assumes: a staged copy is published as a hard link on this system's own disk.
      const staged = join(root, 'A.JPG.partial'), published = join(root, 'A.JPG'); await writeFile(staged, 'jpeg');
      await link(staged, published);
      assert.equal((await stat(published)).nlink, 2);
    } finally { await rm(root, { recursive: true, force: true }); }
  },
  'drive formats: each format the system reports is recognized, with what it reads and writes, and FAT32 refuses files over 4 GB before copying': async (profile, t) => {
    // docs/drive-formats.md: the adapter's own names for each format, and this system's native access to it.
    const volumes = profile.formats.volumes();
    assert.deepEqual(volumes.map(volume => ({ format: driveFormat(volume.fsType), access: nativeAccess(driveFormat(volume.fsType), profile.platform), ...(volume.readOnly ? { readOnly: true } : {}) })), profile.formats.expect);
    // exFAT is read and written everywhere: the format for a drive that moves between systems.
    assert.equal(nativeAccess(driveFormat(profile.volumes()[1]!.fsType), profile.platform), 'readwrite');
    // FAT32 holds files up to 4 GiB - 1 byte: a larger one stops the import at planning, naming the file; other formats take it.
    const fat = volumes.find(volume => driveFormat(volume.fsType) === 'fat')!, others = volumes.filter(volume => driveFormat(volume.fsType) !== 'fat');
    const entry = (name: string, size: number, skip = false) => ({ id: name, source: join(tmpdir(), 'card', name), destination: join(fat.path, name), size, kind: 'Videos' as const, skip, family: name });
    const plans = [{ root: join(fat.path, 'photobackup'), entries: [entry('C0001.MP4', FAT32_MAX_FILE_BYTES), entry('C0002.MP4', FAT32_MAX_FILE_BYTES + 1), entry('C0003.MP4', 6e9, true)] }];
    assert.throws(() => checkFileSizes(plans, () => fat.fsType), (error: any) => error.key === 'error.fileTooLargeForFormat' && error.params.count === 1 && error.params.name === 'C0002.MP4' && error.params.format === 'FAT32');
    for (const volume of others) checkFileSizes(plans, () => volume.fsType);
    if (!onNative(profile, t)) return;
    // Every destination proves it can write, flush, read back, rename and delete; nothing of the probe is left.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'feature-probe-')));
    try {
      await probeDestination(root);
      assert.deepEqual(await readdir(root), []);
      // A write-denied folder (an ACL entry on Windows, mode bits elsewhere) is refused as read-only. Root ignores mode bits.
      if (process.platform !== 'win32' && !unixPermissions) return t.diagnostic('root ignores permission bits');
      const locked = join(root, 'locked'); await mkdir(locked); await denyWrite(locked);
      try { await assert.rejects(probeDestination(locked), (error: any) => error.key === 'error.destinationReadOnly'); }
      finally { await allowWrite(locked); }
      assert.deepEqual(await readdir(locked), []);
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
