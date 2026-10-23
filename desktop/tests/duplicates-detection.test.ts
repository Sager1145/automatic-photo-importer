import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { plan } from '../core/index';
import { overlappingLibraries, scanDuplicates, recordPlanDuplicates, duplicateStore, dropDuplicateStores, DUPLICATES_PREFIX } from '../core/duplicates';
import { destinationIndex, dropDestinationIndexes, indexTarget, provablySame, statRecord } from '../core/destination-index';
import type { BigIntStats } from 'node:fs';
import { identity } from '../core/paths';
import { ignoredName, inventory } from '../core/inventory';
import { buildGroups, candidates, classify, comparable, exifKey } from '../duplicate-rules';
import type { DuplicateExif, DuplicateFile, DuplicateGroup, Metadata } from '../shared';
/** The duplicate store of `root` as written (sealed), from the app's data folder. */
const storedRecord = async (root: string) => JSON.parse(await fs.readFile(await indexTarget(root, 'duplicates.json'), 'utf8'));
import {configureOrganizationRecovery} from '../core/index';
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');

const exif = (patch: Partial<DuplicateExif> = {}): DuplicateExif => ({ date: '2024-05-06T07:08:09.12', camera: 'Nikon Z f', serial: '3000123', shutterCount: '1001', width: 6048, height: 4032, lens: '24-70mm', ...patch });
const file = (name: string, patch: Partial<DuplicateFile> = {}): DuplicateFile => ({ path: name, size: 1000, kind: 'JPEG', edited: false, birth: 1, ctime: 1, ...patch });

async function library(t: test.TestContext) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'duplicates-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  dropDuplicateStores(); dropDestinationIndexes();
  return base;
}
/** A library file as an import leaves it: its modified time is the capture's, earlier than its ctime. A file just
 * written has ctime equal to mtime, which (as on exFAT) proves nothing, so no record would be reused for it. */
const captured = new Date('2024-05-06T07:08:09Z');
const write = async (root: string, relative: string, content: string | Buffer) => { const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content); await fs.utimes(target, captured, captured); return target; };
/** Metadata by file name; files not listed have no EXIF. */
const reader = (table: Record<string, DuplicateExif>, counter = { reads: 0 }) => async (target: string): Promise<Metadata> => {
  counter.reads++;
  const found = table[path.basename(target)];
  return { camera: found?.camera, date: found?.date, fields: {}, ...(found ? { fingerprint: found } : {}) };
};
const scan = async (root: string, table: Record<string, DuplicateExif> = {}, extra = {}) => scanDuplicates(root, { metadata: reader(table), index: await destinationIndex(root, await identity(root)) }, extra);

test('bursts, RAW+JPG pairs, Live Photo pairs and edited versions are never duplicates of each other', () => {
  // A burst: the same second, different sub-seconds and shutter counts.
  const burst = [file('b1.jpg', { exif: exif({ date: '2024-05-06T07:08:09.10', shutterCount: '1' }), sha256: 'a'.repeat(64) }), file('b2.jpg', { exif: exif({ date: '2024-05-06T07:08:09.20', shutterCount: '2' }), sha256: 'b'.repeat(64) })];
  assert.deepEqual(buildGroups(burst), []);
  assert.deepEqual(candidates(burst), []);
  // RAW+JPG: one capture, two formats.
  const pair = [file('DSC_1.NEF', { kind: 'RAW', exif: exif() }), file('DSC_1.JPG', { exif: exif() })];
  assert.equal(comparable(pair[0]!, pair[1]!), false);
  assert.deepEqual(buildGroups(pair), []);
  // Live Photo: HEIC still and MOV clip with the same EXIF identity.
  const live = [file('IMG_1.HEIC', { kind: 'HEIF', exif: exif() }), file('IMG_1.MOV', { kind: 'Videos', exif: exif() })];
  assert.deepEqual(buildGroups(live), []);
  // An original and its edited version, even with identical bytes.
  const edited = [file('2024/05/IMG_2.jpg', { exif: exif(), sha256: 'c'.repeat(64) }), file('2024/05/editied/IMG_2.jpg', { exif: exif(), sha256: 'c'.repeat(64), edited: true })];
  assert.deepEqual(buildGroups(edited), []);
  // jpg and jpeg are one format.
  assert.equal(comparable(file('a.jpeg'), file('b.JPG')), true);
});
test('an EXIF key needs a discriminator: a time and a camera alone are not trusted', () => {
  assert.equal(exifKey(exif({ date: '2024-05-06T07:08:09', shutterCount: undefined })), undefined);
  assert.ok(exifKey(exif({ date: '2024-05-06T07:08:09', shutterCount: '7' })));
  assert.ok(exifKey(exif({ shutterCount: undefined })), 'sub-seconds are enough');
  assert.equal(exifKey(exif({ camera: undefined, serial: undefined })), undefined);
});
test('empty files are never duplicates', () => {
  assert.deepEqual(buildGroups([file('a.jpg', { size: 0, sha256: 'e'.repeat(64) }), file('b.jpg', { size: 0, sha256: 'e'.repeat(64) })]), []);
});
test('group strength: SHA, EXIF with one size, EXIF with sizes that differ', () => {
  const same = 'f'.repeat(64);
  assert.equal(classify([file('a.jpg', { sha256: same }), file('b.jpg', { sha256: same })]), 'sha');
  assert.equal(classify([file('a.jpg', { exif: exif(), sha256: '1'.repeat(64) }), file('b.jpg', { exif: exif(), sha256: '2'.repeat(64) })]), 'exif');
  assert.equal(classify([file('a.jpg', { exif: exif() }), file('b.jpg', { exif: exif(), size: 2000 })]), 'exif-size');
  const groups = buildGroups([file('a.jpg', { exif: exif(), sha256: '1'.repeat(64) }), file('b.jpg', { exif: exif(), sha256: '2'.repeat(64), size: 999 })]);
  assert.equal(groups.length, 1); assert.equal(groups[0]!.strength, 'exif-size');
});
test('the same name and capture time alone is only a hint for the user', () => {
  const groups = buildGroups([file('x/IMG_9.jpg', { exif: { date: '2024-01-01T10:00:00' }, sha256: '1'.repeat(64) }), file('y/IMG_9.jpg', { exif: { date: '2024-01-01T10:00:00' }, sha256: '2'.repeat(64) })]);
  assert.deepEqual(groups.map(group => group.strength), ['similar']);
});

test('stage 1 hashes only candidates during planning and records bursts, pairs and Live Photos as nothing', async t => {
  const base = await library(t), source = path.join(base, 'card'), root = path.join(base, 'backup');
  await fs.mkdir(root);
  const same = Buffer.from('same pixels '.repeat(500));
  // Two copies under different names with one capture; a burst; a RAW+JPG pair; a Live Photo.
  await write(source, 'DCIM/A_0001.JPG', same); await write(source, 'DCIM/B_9999.JPG', same);
  await write(source, 'DCIM/BURST1.JPG', 'burst one'); await write(source, 'DCIM/BURST2.JPG', 'burst two');
  await write(source, 'DCIM/PAIR.NEF', 'raw bytes'); await write(source, 'DCIM/PAIR.JPG', 'jpg bytes');
  await write(source, 'DCIM/LIVE.HEIC', 'heic bytes'); await write(source, 'DCIM/LIVE.MOV', 'mov bytes');
  await write(source, 'DCIM/LONELY.JPG', 'only one');
  const table = {
    'A_0001.JPG': exif(), 'B_9999.JPG': exif(),
    'BURST1.JPG': exif({ date: '2024-05-06T07:08:10.10', shutterCount: '5' }), 'BURST2.JPG': exif({ date: '2024-05-06T07:08:10.20', shutterCount: '6' }),
    'PAIR.NEF': exif({ date: '2024-05-06T07:09:00.50', shutterCount: '7' }), 'PAIR.JPG': exif({ date: '2024-05-06T07:09:00.50', shutterCount: '7' }),
    'LIVE.HEIC': exif({ date: '2024-05-06T07:10:00.50', shutterCount: '8' }), 'LIVE.MOV': exif({ date: '2024-05-06T07:10:00.50', shutterCount: '8' }),
    'LONELY.JPG': exif({ date: '2024-05-06T07:11:00.50', shutterCount: '9' }),
  };
  const steps: string[] = [];
  const planned = await plan(source, [root], { backup: false, template: '{year}/{yyyymm}/{camera}', layout: 'flat', unknownRules: {}, duplicates: true }, reader(table), undefined, (_count, _file, detail) => { if (detail?.step === 'candidates') steps.push(detail.step); });
  const found = planned.duplicates!;
  assert.deepEqual(found.groups.map(group => [group.strength, group.files.map(item => path.basename(item.path)).sort()]), [['sha', ['A_0001.JPG', 'B_9999.JPG']]]);
  assert.deepEqual(found.files.filter(item => item.sha256).map(item => path.basename(item.path)).sort(), ['A_0001.JPG', 'B_9999.JPG'], 'only the candidates were hashed');
  assert.ok(steps.length > 0, 'progress names the candidates step');
  assert.equal(found.files.length, 9, 'every examined media file carries its EXIF');
  // Recording is explicit: planning alone wrote nothing.
  assert.deepEqual(await fs.readdir(root), []);
});

test('stage 2 finds a renamed SHA duplicate that stage 1 could not match, and records the index file', async t => {
  const base = await library(t), root = path.join(base, 'library');
  const bytes = Buffer.from('renamed copy '.repeat(400));
  await write(root, '2024/202405/Nikon Z f/DSC_0001.NEF', bytes);
  await write(root, 'Imported/holiday.nef', bytes);
  await write(root, '2024/202405/Nikon Z f/DSC_0002.NEF', 'different');
  const result = await scan(root);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]!.strength, 'sha');
  assert.deepEqual(result.groups[0]!.files.map(item => item.path).sort(), ['2024/202405/Nikon Z f/DSC_0001.NEF', 'Imported/holiday.nef']);
  const saved = await storedRecord(root);
  assert.equal(saved.v, 5); assert.equal(saved.kind, 'duplicates'); assert.match(saved.seal, /^[a-f0-9]{64}$/);
  assert.equal(ignoredName(`${DUPLICATES_PREFIX}.json`), true);
  assert.equal(ignoredName(`${DUPLICATES_PREFIX}-11111111-1111-4111-8111-111111111111.tmp`), true);
  assert.equal((await inventory(root, { backup: true })).files.some(item => item.path.includes(DUPLICATES_PREFIX)), false);
});
test('stage 2 records EXIF-identical files of the same size and of different sizes', async t => {
  const base = await library(t), root = path.join(base, 'library');
  await write(root, 'a/X1.JPG', 'aaaaaaaaaa'); await write(root, 'b/X2.JPG', 'bbbbbbbbbb');
  await write(root, 'a/Y1.JPG', 'cccccccccc'); await write(root, 'b/Y2.JPG', 'dddddddddddddddd');
  const table = { 'X1.JPG': exif(), 'X2.JPG': exif(), 'Y1.JPG': exif({ date: '2024-06-06T01:01:01.30', shutterCount: '40' }), 'Y2.JPG': exif({ date: '2024-06-06T01:01:01.30', shutterCount: '40' }) };
  const result = await scan(root, table);
  assert.deepEqual(result.groups.map(group => group.strength).sort(), ['exif', 'exif-size']);
});
test('a second scan reads no metadata and no file again, and a changed file is read again', async t => {
  const base = await library(t), root = path.join(base, 'library');
  await write(root, 'a/one.JPG', 'identical one'); await write(root, 'b/two.JPG', 'identical one');
  const counter = { reads: 0 };
  const deps = async () => ({ metadata: reader({}, counter), index: await destinationIndex(root, await identity(root)) });
  await scanDuplicates(root, await deps());
  assert.equal(counter.reads, 2);
  dropDuplicateStores(); dropDestinationIndexes(); // a new session loads the index file
  const again = await scanDuplicates(root, await deps());
  assert.equal(counter.reads, 2, 'no metadata read again');
  assert.equal(again.groups.length, 1);
  await write(root, 'b/two.JPG', 'now different!');
  const changed = await scanDuplicates(root, await deps());
  assert.equal(counter.reads, 3); assert.equal(changed.groups.length, 0);
});
test('a failed metadata read is not remembered: the next full scan reads that file again', async t => {
  const base = await library(t), root = path.join(base, 'library');
  await write(root, 'a/one.JPG', 'one'); await write(root, 'b/two.JPG', 'two');
  const reads: string[] = []; let fail = true;
  const deps = async () => ({ metadata: async (target: string): Promise<Metadata> => { reads.push(path.basename(target)); if (fail && path.basename(target) === 'one.JPG') throw new Error('EIO'); return { fields: {} }; }, index: await destinationIndex(root, await identity(root)) });
  await scanDuplicates(root, await deps());
  assert.deepEqual(reads.slice().sort(), ['one.JPG', 'two.JPG']);
  fail = false; reads.length = 0;
  await scanDuplicates(root, await deps());
  assert.deepEqual(reads, ['one.JPG'], 'only the file whose read failed is read again');
});

test('copies on different destinations are never paired: each root is scanned alone', async t => {
  const base = await library(t), one = path.join(base, 'disk1'), two = path.join(base, 'disk2');
  for (const root of [one, two]) await write(root, '2024/202405/cam/IMG_1.JPG', 'the same photo');
  const first = await scan(one), second = await scan(two);
  assert.equal(first.groups.length, 0); assert.equal(second.groups.length, 0);
  // Each root's record names only its own files.
  for (const root of [one, two]) assert.deepEqual(Object.keys((await storedRecord(root)).files), ['2024/202405/cam/IMG_1.JPG']);
});
test('companions follow their primary and are not groups of their own', async t => {
  const base = await library(t), root = path.join(base, 'library');
  await write(root, 'a/IMG_1.NEF', 'raw'); await write(root, 'a/IMG_1.xmp', 'sidecar');
  await write(root, 'b/IMG_1.NEF', 'raw'); await write(root, 'b/IMG_1.xmp', 'sidecar');
  const result = await scan(root);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.companions.get('a/IMG_1.NEF'), ['a/IMG_1.xmp']);
});
test('recordPlanDuplicates keeps what planning found per library and never deletes', async t => {
  const base = await library(t), source = path.join(base, 'card'), root = path.join(base, 'backup'), other = path.join(base, 'backup2');
  await fs.mkdir(root); await fs.mkdir(other);
  const bytes = 'same bytes';
  await write(source, 'A.JPG', bytes); await write(source, 'B.JPG', bytes);
  const table = { 'A.JPG': exif(), 'B.JPG': exif() };
  const planned = await plan(source, [root], { backup: false, template: '{year}/{yyyymm}/{camera}', layout: 'flat', unknownRules: {}, duplicates: true }, reader(table));
  const entries = planned.plans[0]!.entries;
  await write(root, '2024/202405/Nikon Z f/A.JPG', bytes); await write(root, '2024/202405/Nikon Z f/B.JPG', bytes);
  const destinationOf = (from: string) => entries.find(entry => entry.source === from)?.destination;
  await recordPlanDuplicates(root, planned.duplicates!, destinationOf);
  const store = await duplicateStore(await fs.realpath(root), await identity(root));
  assert.deepEqual([...store.files.keys()].sort(), ['2024/202405/Nikon Z f/A.JPG', '2024/202405/Nikon Z f/B.JPG']);
  assert.ok([...store.files.values()].every(record => record.exif && !('sha256' in record)), 'EXIF is recorded; digests belong to the destination index');
  assert.equal((await fs.readdir(path.join(root, '2024/202405/Nikon Z f'))).length, 2, 'nothing was removed');
  // A second library gets nothing from the first.
  await recordPlanDuplicates(other, planned.duplicates!, () => undefined);
  assert.equal((await duplicateStore(await fs.realpath(other), await identity(other))).files.size, 0);
});

test('stage 1 runs for imports only, and reuses a hash remembered for the source file', async t => {
  const base = await library(t), source = path.join(base, 'card'), root = path.join(base, 'backup');
  await fs.mkdir(root);
  await write(source, 'DCIM/A_0001.JPG', 'one'); await write(source, 'DCIM/B_9999.JPG', 'two');
  const table = { 'A_0001.JPG': exif(), 'B_9999.JPG': exif() };
  const options = { backup: false, template: '{year}/{yyyymm}/{camera}', layout: 'flat' as const, unknownRules: {}, duplicates: true };
  // Remembered hashes are used as they are (the files differ, the memory says they do not): nothing was read again.
  const asked: string[] = [];
  const imported = await plan(source, [root], { ...options, sourceDigest: file => { asked.push(path.basename(file)); return 'a'.repeat(64); } }, reader(table));
  assert.deepEqual(imported.duplicates!.groups.map(group => group.strength), ['sha']);
  assert.ok(asked.includes('A_0001.JPG') && asked.includes('B_9999.JPG'));
  // An organization of a library never hashes name or EXIF candidates.
  await fs.cp(source, root, { recursive: true });
  const organized = await plan(root, [root], { ...options, reorganize: true }, reader(table));
  assert.equal(organized.duplicates, undefined);
});

test('an all-zero sub-second is no discriminator, and exposure tells bracket and burst frames apart', () => {
  const bare = { date: '2024-05-06T07:08:09.00', camera: 'Nikon Z f', width: 6048, height: 4032 };
  assert.equal(exifKey(bare), undefined, 'a body that records .00 for every frame proves nothing');
  assert.equal(exifKey({ ...bare, date: '2024-05-06T07:08:09.000' }), undefined);
  assert.ok(exifKey({ ...bare, date: '2024-05-06T07:08:09.05' }), 'a real fraction still counts');
  assert.ok(exifKey({ ...bare, shutterCount: '12' }), 'a shutter count still counts');
  // A constant sub-second: frames that differ in exposure never share a key.
  const frame = (patch: Partial<DuplicateExif>) => exifKey({ ...bare, date: '2024-05-06T07:08:09.50', ...patch });
  assert.notEqual(frame({ exposureTime: '0.004' }), frame({ exposureTime: '0.008' }));
  assert.notEqual(frame({ aperture: '2.8' }), frame({ aperture: '4' }));
  assert.notEqual(frame({ iso: '100' }), frame({ iso: '400' }));
  assert.notEqual(frame({ exposureCompensation: '0' }), frame({ exposureCompensation: '-2' }));
  assert.equal(frame({ exposureTime: '0.004', iso: '100' }), frame({ exposureTime: '0.004', iso: '100' }));
  const bracket = [file('b1.jpg', { exif: { ...bare, date: '2024-05-06T07:08:09.50', exposureCompensation: '-2' } }), file('b2.jpg', { exif: { ...bare, date: '2024-05-06T07:08:09.50', exposureCompensation: '0' } })];
  assert.deepEqual(candidates(bracket), [], 'a bracket is not a candidate set');
});

test('a chosen folder that holds, overlaps or sits inside more than one library is refused', () => {
  const libraries = ['/Volumes/A/photos', '/Volumes/B/photos'];
  assert.deepEqual(overlappingLibraries('/Users/me', libraries), [], 'unrelated paths are not overlaps');
  assert.equal(overlappingLibraries('/Volumes/A', [...libraries, '/Volumes/A/photos']).length, 1, 'a parent of one library is fine');
  assert.equal(overlappingLibraries('/Volumes/A/photos/2024', libraries).length, 1, 'inside one library is fine');
  assert.equal(overlappingLibraries('/Volumes/A/photos', libraries).length, 1, 'the library itself');
  assert.equal(overlappingLibraries('/Volumes', ['/Volumes/A', '/Volumes/B']).length, 2, 'a parent of two libraries');
  assert.equal(overlappingLibraries('/Volumes/A/photos/2024', ['/Volumes/A/photos', '/Volumes/A/photos/2024/x']).length, 2, 'inside one and holding another');
});
test('app folders are skipped at any depth: a parent of one library never pairs its drive mirrors, recovery or problem files', async t => {
  const base = await library(t), parent = path.join(base, 'parent');
  const same = 'the same photo bytes';
  await write(parent, 'lib/2024/202405/Nikon Z f/A.JPG', same);
  await write(parent, 'lib/Drive backups/Mirror/2024/202405/Nikon Z f/A.JPG', same);
  await write(parent, 'lib/Photo Importer Recovery/job/originals/A.JPG', same);
  await write(parent, 'lib/Problem files/unreadable/A.JPG', same);
  await write(parent, 'other/Drive backups/B.JPG', same);
  await write(parent, 'other/Photo Importer Recovery/C.JPG', same);
  const result = await scan(parent);
  assert.equal(result.files, 1, 'only the library photo is looked at');
  assert.deepEqual(result.groups, []);
});

test('a duplicate store that fails authentication is ignored and its files are read again; the store is written sealed again', async t => {
  const base = await library(t), root = path.join(base, 'library');
  await write(root, 'a/one.JPG', 'identical one'); await write(root, 'b/two.JPG', 'identical one');
  const counter = { reads: 0 };
  const deps = async () => ({ metadata: reader({}, counter), index: await destinationIndex(root, await identity(root)) });
  await scanDuplicates(root, await deps());
  const storeFile = await indexTarget(root, 'duplicates.json');
  const saved = JSON.parse(await fs.readFile(storeFile, 'utf8'));
  assert.equal(saved.v, 5);
  assert.equal(counter.reads, 2);
  await fs.writeFile(storeFile, JSON.stringify({ ...saved, files: {} }));
  dropDuplicateStores(); dropDestinationIndexes();
  const again = await scanDuplicates(root, await deps());
  assert.equal(counter.reads, 4, 'records that fail authentication are re-read, not trusted');
  assert.equal(again.groups.length, 1);
  assert.equal((await storedRecord(root)).v, 5); assert.equal(Object.keys((await storedRecord(root)).files).length, 2);
});

test('duplicate MOVs of two copies of one Live Photo are found at import time', async t => {
  const base = await library(t), source = path.join(base, 'card'), root = path.join(base, 'library');
  await fs.mkdir(root, { recursive: true });
  for (const folder of ['100APPLE', '101APPLE']) { await write(source, `DCIM/${folder}/IMG_0001.HEIC`, 'live still bytes'); await write(source, `DCIM/${folder}/IMG_0001.MOV`, 'live movie bytes'); }
  const live = exif({ camera: 'Apple iPhone 15', date: '2024-05-06T07:10:00.50' });
  const apple = async (target: string): Promise<Metadata> => ({ camera: 'Apple iPhone 15', make: 'Apple', date: live.date, contentId: 'LIVE-1', fields: {}, fingerprint: live });
  const planned = await plan(source, [root], { backup: false, template: '{year}/{yyyymm}/{camera}', layout: 'flat', unknownRules: {}, duplicates: true }, apple);
  const groups = planned.duplicates!.groups.map(group => [group.strength, group.files.map(item => path.relative(source, item.path)).sort()]);
  assert.ok(groups.some(([, names]) => (names as string[]).every(name => name.endsWith('.MOV')) && (names as string[]).length === 2), `MOV pair grouped: ${JSON.stringify(groups)}`);
  assert.ok(groups.some(([, names]) => (names as string[]).every(name => name.endsWith('.HEIC')) && (names as string[]).length === 2), `HEIC pair grouped: ${JSON.stringify(groups)}`);
  assert.equal(groups.length, 2, 'a still and its own movie are never grouped together');
});

test('buildGroups scales linearly: 100k files in one class group in under 2 s with a stable order', () => {
  const files: DuplicateFile[] = [];
  for (let i = 0; i < 100_000; i++) files.push(file(`/lib/d${i % 500}/IMG_${String(i >> 1).padStart(6, '0')}.jpg`, { sha256: `sha${i >> 1}` }));
  // CPU time of this process, best of three: wall time is noisy on a busy machine, and the old quadratic code took minutes.
  let elapsed = Infinity, groups: DuplicateGroup[] = [];
  for (let run = 0; run < 3 && elapsed >= 2000; run++) { const started = process.cpuUsage(); groups = buildGroups(files); const used = process.cpuUsage(started); elapsed = Math.min(elapsed, (used.user + used.system) / 1000); }
  assert.equal(groups.length, 50_000);
  assert.ok(groups.every(group => group.files.length === 2));
  assert.deepEqual(groups[0]!.files.map(f => f.sha256), ['sha0', 'sha0']);
  assert.ok(elapsed < 2000, `buildGroups took ${Math.round(elapsed)} ms`);
});

/** A stat as FAT/exFAT reports it (ctime equal to mtime) or as APFS does. */
const fakeStat = (patch: Partial<Record<'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs' | 'birthtimeNs', bigint>> = {}) => ({ dev: 1n, ino: 42n, size: 10n, mtimeNs: 1_000n, ctimeNs: 2_000n, birthtimeNs: 500n, ...patch, isFile: () => true }) as unknown as BigIntStats;
test('one provable-stat rule: an exFAT-shaped stat (ctime equal to mtime) never reuses a record, in the index or the duplicate store', async t => {
  const apfs = fakeStat(), exfat = fakeStat({ ctimeNs: 1_000n });
  assert.equal(provablySame(statRecord(apfs), apfs), true);
  assert.equal(provablySame(statRecord(apfs), fakeStat({ ctimeNs: 3_000n })), false, 'a changed ctime is another file');
  assert.equal(provablySame(statRecord(exfat), exfat), false, 'an unchanged exFAT stat proves nothing');
  const base = await library(t), root = path.join(base, 'library');
  await write(root, 'a/one.JPG', 'one');
  const store = await duplicateStore(root, await identity(root));
  store.files.set('a/one.JPG', { stat: statRecord(exfat), kind: 'JPEG', edited: false, exif: exif() });
  assert.equal(store.known('a/one.JPG', exfat), undefined, 'the metadata record is read again');
  store.files.set('a/one.JPG', { stat: statRecord(apfs), kind: 'JPEG', edited: false, exif: exif() });
  assert.ok(store.known('a/one.JPG', apfs));
});
test('the duplicate store keeps no content digest: SHA-256 values come only from the destination index', async t => {
  const base = await library(t), root = path.join(base, 'library');
  await write(root, 'a/one.JPG', 'identical one'); await write(root, 'b/one.JPG', 'identical one');
  const result = await scan(root);
  assert.equal(result.groups.length, 1);
  const saved = await storedRecord(root);
  assert.ok(Object.values(saved.files as Record<string, object>).every(record => !('sha256' in record)), JSON.stringify(saved.files));
  assert.equal('groups' in saved, false); assert.equal('complete' in saved, false); assert.equal('updated' in saved, false);
});
test('a file whose hash fails is left out of this scan\'s groups, reported, and not hashed again in the same scan', async t => {
  const base = await library(t), root = path.join(base, 'library');
  // The same name and EXIF: a candidate pair that EXIF alone would join.
  await write(root, 'a/X.JPG', 'xxxxxxxxxx'); await write(root, 'b/X.JPG', 'xxxxxxxxxx'); await write(root, 'c/lonely.JPG', 'other');
  const index = await destinationIndex(root, await identity(root)), asked: string[] = [];
  const failing = { cached: index.cached.bind(index), flush: index.flush.bind(index), digestOf: async (file: string, signal?: AbortSignal) => { asked.push(path.relative(root, file)); if (file.endsWith(path.join('b', 'X.JPG'))) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); return index.digestOf(file, signal); } };
  const result = await scanDuplicates(root, { metadata: reader({ 'X.JPG': exif() }), index: failing });
  assert.deepEqual(result.groups, [], 'no fallback to the EXIF join');
  assert.deepEqual(result.failures.map(item => [item.path, item.step]), [['b/X.JPG', 'hash']]);
  assert.match(JSON.stringify(result.failures[0]!.error), /EIO/);
  assert.equal(asked.filter(item => item === path.join('b', 'X.JPG')).length, 1, 'one attempt per scan');
  assert.equal(result.files, 3);
});
test('a failed metadata read is reported, and the file is still grouped by its content', async t => {
  const base = await library(t), root = path.join(base, 'library');
  await write(root, 'a/one.JPG', 'identical'); await write(root, 'b/two.JPG', 'identical');
  const result = await scanDuplicates(root, { metadata: async target => { if (target.endsWith('one.JPG')) throw new Error('exiftool crashed'); return { fields: {} }; }, index: await destinationIndex(root, await identity(root)) });
  assert.deepEqual(result.failures.map(item => [item.path, item.step]), [['a/one.JPG', 'metadata']]);
  assert.equal(result.groups.length, 1); assert.equal(result.groups[0]!.strength, 'sha');
});
test('a file that fails both its metadata and its hash is one unread file, reported by the hash step', async t => {
  const base = await library(t), root = path.join(base, 'library');
  await write(root, 'a/X.JPG', 'xxxxxxxxxx'); await write(root, 'b/X.JPG', 'xxxxxxxxxx');
  const index = await destinationIndex(root, await identity(root));
  const broken = (file: string) => file.endsWith(path.join('b', 'X.JPG'));
  const failing = { cached: index.cached.bind(index), flush: index.flush.bind(index), digestOf: async (file: string, signal?: AbortSignal) => { if (broken(file)) throw new Error('EACCES'); return index.digestOf(file, signal); } };
  const result = await scanDuplicates(root, { metadata: async target => { if (broken(target)) throw new Error('EACCES'); return { fields: {} }; }, index: failing });
  assert.deepEqual(result.failures.map(item => [item.path, item.step]), [['b/X.JPG', 'hash']]);
});
test('a freshly written file (ctime equal to mtime, as on exFAT) has its metadata read again by every scan', async t => {
  const base = await library(t), root = path.join(base, 'library');
  await fs.mkdir(path.join(root, 'a'), { recursive: true }); await fs.writeFile(path.join(root, 'a/fresh.JPG'), 'fresh');
  const stat = await fs.lstat(path.join(root, 'a/fresh.JPG'), { bigint: true });
  if (stat.ctimeNs !== stat.mtimeNs) { t.skip('this filesystem gives a new file a ctime other than its mtime'); return; }
  const counter = { reads: 0 };
  for (let run = 0; run < 2; run++) await scanDuplicates(root, { metadata: reader({}, counter), index: await destinationIndex(root, await identity(root)) });
  assert.equal(counter.reads, 2);
});
