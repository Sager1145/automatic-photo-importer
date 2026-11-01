import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execute, plan, configureOrganizationRecovery } from '../core/index';
import { registerListedSource, sourceAware, LISTED_PARENT, type ListedFile } from '../core/source-fs';
import { posixRelative } from '../core/paths';
import { listedBytes } from '../platform/metadata';
import { cameraFiles, closeCameraBridge, listedFiles, prepareCamera } from '../platform/camera-bridge';
import type { Metadata } from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const fs = sourceAware(nodeFs);
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const day = Date.parse('2026-10-25T10:00:00Z');
const options = { backup: false as const, template: '{year}/{yyyymm}/{camera}', layout: 'flat' as const, unknownRules: {}, duplicates: true };
const metadata = async (): Promise<Metadata> => ({ fields: {}, camera: 'NIKON Z f', date: '2026-10-25T10:00:00' });
const filed = (library: string, name: string) => path.join(library, '2026', '202610', 'NIKON Z f', name);

/** A camera in memory, read through the same interface as the helper; every byte read is counted per file. */
function camera(t: test.TestContext, contents: Record<string, Buffer>, hooks: { read?: (file: ListedFile, offset: number, length: number) => void | Promise<void>; sizes?: Record<string, number> } = {}) {
  const read = new Map<string, number>();
  const registered = registerListedSource({
    id: `test-${Math.random()}`,
    files: Object.entries(contents).map(([relative, data]) => ({ relative, size: hooks.sizes?.[relative] ?? data.length, modifiedMs: day })),
    async read(file, offset, length) {
      await hooks.read?.(file, offset, length);
      const data = contents[file.relative]!.subarray(offset, offset + length);
      read.set(file.relative, (read.get(file.relative) ?? 0) + data.length);
      return Buffer.from(data);
    },
  });
  t.after(registered.unregister);
  return { root: registered.root, read };
}
async function library(t: test.TestContext) {
  const base = await nodeFs.realpath(await nodeFs.mkdtemp(path.join(os.tmpdir(), 'camera-direct-')));
  t.after(() => nodeFs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'photobackup');
  await nodeFs.mkdir(root);
  return root;
}
/** The system temporary folder's entries, to show a camera import adds none (the test's own library aside). */
const temporary = async () => new Set((await nodeFs.readdir(os.tmpdir())).filter(name => !name.startsWith('camera-direct-')));
const added = async (before: Set<string>) => [...await temporary()].filter(name => !before.has(name) && /photo-importer|camera/i.test(name));

test('a listed camera reads like a read-only folder that exists nowhere on disk', async t => {
  const { root } = camera(t, { 'Slot 1/DCIM/100NZ_F/DSC_0001.NEF': Buffer.from('raw'), 'Slot 2/DCIM/100NZ_F/DSC_0002.JPG': Buffer.from('jpeg') });
  assert.ok(root.startsWith(LISTED_PARENT + path.sep));
  assert.deepEqual((await fs.readdir(root)).sort(), ['Slot 1', 'Slot 2']);
  const file = path.join(root, 'Slot 1', 'DCIM', '100NZ_F', 'DSC_0001.NEF'), stat = await fs.lstat(file, { bigint: true });
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.size, 3n);
  assert.equal(stat.mtimeMs, BigInt(day));
  assert.ok((await fs.stat(path.join(root, 'Slot 1', 'DCIM'))).isDirectory());
  assert.equal(await fs.realpath(file), file);
  await assert.rejects(fs.open(file, 'wx'), { code: 'EROFS' });
  await assert.rejects(fs.lstat(path.join(root, 'missing.jpg')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(LISTED_PARENT, 'not-registered', 'a.jpg')), { code: 'ENOENT' });
  const handle = await fs.open(file, 'r'), buffer = Buffer.alloc(8);
  assert.equal((await handle.read(buffer, 0, 8, null)).bytesRead, 3);
  assert.equal(buffer.subarray(0, 3).toString(), 'raw');
  await handle.close();
});

test('a camera file that grew or shrank since it was listed fails as changed', async t => {
  const { root } = camera(t, { 'A/grew.jpg': Buffer.from('0123456789'), 'A/shrank.jpg': Buffer.from('0123') }, { sizes: { 'A/grew.jpg': 5, 'A/shrank.jpg': 8 } });
  const readAll = async (file: string) => { const handle = await fs.open(path.join(root, 'A', file), 'r'), buffer = Buffer.alloc(64); let total = 0; try { for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) return total; total += bytesRead; } } finally { await handle.close(); } };
  await assert.rejects(readAll('grew.jpg'), /changed/);
  assert.equal(await readAll('shrank.jpg'), 4, 'fewer bytes than listed: the copy sees a short source and fails it');
});

test('planning from a camera listing: new files are never read, possible duplicates are compared by content', async t => {
  const root = await library(t);
  const same = Buffer.alloc(50_000, 7), lookalike = Buffer.alloc(40_000, 8), fresh = Buffer.alloc(30_000, 9);
  await nodeFs.mkdir(path.dirname(filed(root, 'x')), { recursive: true });
  await nodeFs.writeFile(filed(root, 'DSC_0001.NEF'), same);
  // Same name and size as a camera file, other bytes: a possible duplicate the content check rules out.
  await nodeFs.writeFile(filed(root, 'DSC_0002.NEF'), Buffer.alloc(40_000, 1));
  const { root: source, read } = camera(t, { 'Slot 1/DCIM/100NZ_F/DSC_0001.NEF': same, 'Slot 1/DCIM/100NZ_F/DSC_0002.NEF': lookalike, 'Slot 2/DCIM/100NZ_F/DSC_0003.NEF': fresh });
  const looked: string[] = [];
  const { plans } = await plan(source, [root], options, async file => { looked.push(posixRelative(source, file)); return metadata(); });
  const entries = plans[0]!.entries, at = (name: string) => entries.find(entry => entry.source.endsWith(name))!;
  assert.equal(at('DSC_0001.NEF').skip, true, 'confirmed duplicate: already in the library');
  assert.equal(at('DSC_0001.NEF').destination, filed(root, 'DSC_0001.NEF'));
  assert.equal(at('DSC_0001.NEF').digest, sha(same));
  assert.equal(at('DSC_0002.NEF').skip, false, 'same name and size, other content: copied');
  assert.notEqual(at('DSC_0002.NEF').destination, filed(root, 'DSC_0002.NEF'), 'beside the other file, never over it');
  assert.equal(at('DSC_0003.NEF').skip, false);
  assert.deepEqual(looked.sort(), ['Slot 1/DCIM/100NZ_F/DSC_0002.NEF', 'Slot 2/DCIM/100NZ_F/DSC_0003.NEF'], 'metadata only for files that are not already there');
  assert.equal(read.get('Slot 1/DCIM/100NZ_F/DSC_0001.NEF'), same.length, 'hashed once from the camera');
  // Hashed once (the plan reuses that checksum); looking for it elsewhere in the library reads its first 64 KB once more.
  assert.ok(read.get('Slot 1/DCIM/100NZ_F/DSC_0002.NEF')! <= lookalike.length + 64 * 1024);
  assert.equal(read.get('Slot 2/DCIM/100NZ_F/DSC_0003.NEF'), undefined, 'a new file is not read to plan it');
  // A remembered checksum for an unchanged camera file stands in for reading it.
  read.clear();
  const again = await plan(source, [root], { ...options, sourceDigest: file => file.endsWith('DSC_0001.NEF') ? sha(same) : undefined }, metadata);
  assert.equal(again.plans[0]!.entries.find(entry => entry.source.endsWith('DSC_0001.NEF'))!.skip, true);
  assert.equal(read.get('Slot 1/DCIM/100NZ_F/DSC_0001.NEF'), undefined);
});

test('a family is settled from the listing only when all of it is already there', async t => {
  const root = await library(t);
  const raw = Buffer.alloc(20_000, 1), jpeg = Buffer.alloc(10_000, 2);
  await nodeFs.mkdir(path.dirname(filed(root, 'x')), { recursive: true });
  await nodeFs.writeFile(filed(root, 'DSC_0001.NEF'), raw);
  const { root: source } = camera(t, { 'Slot 1/DCIM/100NZ_F/DSC_0001.NEF': raw, 'Slot 1/DCIM/100NZ_F/DSC_0001.JPG': jpeg });
  const looked: string[] = [];
  const { plans } = await plan(source, [root], options, async file => { looked.push(path.basename(file)); return metadata(); });
  assert.deepEqual(looked.sort(), ['DSC_0001.JPG', 'DSC_0001.NEF'], 'the RAW is routed with its JPEG');
  assert.equal(plans[0]!.entries.find(entry => entry.source.endsWith('.NEF'))!.skip, true, 'and still found already there');
  assert.equal(plans[0]!.entries.find(entry => entry.source.endsWith('.JPG'))!.skip, false);
});

test('new camera files are written straight into the destination and verified there; nothing goes to the temporary folder', async t => {
  const root = await library(t), before = await temporary();
  const contents = { 'Slot 1/DCIM/100NZ_F/DSC_0010.NEF': Buffer.alloc(3 * 1024 * 1024 + 17, 4), 'Slot 1/DCIM/100NZ_F/DSC_0011.JPG': Buffer.alloc(200_000, 5) };
  const { root: source, read } = camera(t, contents);
  const { plans } = await plan(source, [root], options, metadata);
  const result = await execute(plans[0]!);
  assert.deepEqual(result.errors, []);
  assert.equal(result.copied, 2);
  assert.equal(sha(await nodeFs.readFile(filed(root, 'DSC_0010.NEF'))), sha(contents['Slot 1/DCIM/100NZ_F/DSC_0010.NEF']));
  assert.equal(sha(await nodeFs.readFile(filed(root, 'DSC_0011.JPG'))), sha(contents['Slot 1/DCIM/100NZ_F/DSC_0011.JPG']));
  assert.equal(read.get('Slot 1/DCIM/100NZ_F/DSC_0010.NEF'), contents['Slot 1/DCIM/100NZ_F/DSC_0010.NEF'].length, 'read from the camera once: the check reads the destination');
  assert.deepEqual(await added(before), []);
});

test('Stop in the middle of a camera file, then import again: the copy resumes and completes, nothing in the temporary folder', async t => {
  const root = await library(t), before = await temporary(), big = Buffer.alloc(40 * 1024 * 1024 + 5, 6);
  for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xff;
  const stop = new AbortController();let served = 0;
  const { root: source } = camera(t, { 'Slot 1/DCIM/100NZ_F/DSC_0020.MOV': big }, { read: (_file, _offset, length) => { served += length; if (served > 20 * 1024 * 1024) stop.abort(); } });
  const first = await plan(source, [root], options, metadata);
  await assert.rejects(execute(first.plans[0]!, stop.signal), { name: 'AbortError' });
  await assert.rejects(nodeFs.stat(filed(root, 'DSC_0020.MOV')).then(stat => { if (stat.size === big.length) throw new Error('complete'); throw Object.assign(new Error('partial'), { code: 'PARTIAL' }); }), (error: NodeJS.ErrnoException) => error.code === 'ENOENT' || error.code === 'PARTIAL', 'never a complete-looking file after Stop');
  const second = await plan(source, [root], options, metadata);
  const result = await execute(second.plans[0]!);
  assert.deepEqual(result.errors, []);
  assert.equal(sha(await nodeFs.readFile(filed(root, 'DSC_0020.MOV'))), sha(big));
  assert.deepEqual(await added(before), []);
});

test('a camera unplugged mid-file fails that file and leaves no copy that looks complete', async t => {
  const root = await library(t), before = await temporary(), big = Buffer.alloc(36 * 1024 * 1024, 3);
  const { root: source } = camera(t, { 'Slot 1/DCIM/100NZ_F/DSC_0030.MOV': big, 'Slot 1/DCIM/100NZ_F/DSC_0031.JPG': Buffer.alloc(1000, 1) }, { read: (file, offset) => { if (file.relative.endsWith('.MOV') && offset >= 16 * 1024 * 1024) throw new Error('The camera is no longer connected.'); } });
  const { plans } = await plan(source, [root], options, metadata);
  const result = await execute(plans[0]!);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /no longer connected/);
  const left = await nodeFs.stat(filed(root, 'DSC_0030.MOV')).catch(() => undefined);
  assert.ok(!left || left.size < big.length, 'at most the destination\'s partial, which recovery cleans or resumes');
  assert.deepEqual(await added(before), []);
});

test('a movie\'s metadata is read from its boxes, not its media data', async t => {
  const box = (type: string, body: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length); head.write(type, 4, 'latin1'); return Buffer.concat([head, body]); };
  const ftyp = box('ftyp', Buffer.from('qt  \0\0\0\0qt  ', 'latin1')), mdat = box('mdat', Buffer.alloc(3 * 1024 * 1024, 0xaa)), moov = box('moov', box('udta', Buffer.from('metadata')));
  const { root, read } = camera(t, { 'DCIM/NZF_0001.MOV': Buffer.concat([ftyp, mdat, moov]) });
  const bytes = await listedBytes(path.join(root, 'DCIM', 'NZF_0001.MOV'));
  assert.deepEqual(bytes, Buffer.concat([ftyp, moov]));
  assert.ok(read.get('DCIM/NZF_0001.MOV')! < 1024 * 1024 + 64, 'the first megabyte and the movie box, never the media data behind them');
});

test('the camera helper protocol: files are listed and read by range, and nothing is staged', { timeout: 60000 }, async t => {
  const scratch = await nodeFs.realpath(await nodeFs.mkdtemp(path.join(os.tmpdir(), 'camera-direct-helper-')));
  t.after(() => nodeFs.rm(scratch, { recursive: true, force: true }));
  const helper = path.join(scratch, 'fake-camera.cjs'), data = Buffer.from('0123456789abcdef');
  await nodeFs.writeFile(helper, `const rl=require('node:readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');const data=Buffer.from(${JSON.stringify(data.toString())});
rl.on('line',line=>{const c=JSON.parse(line);
 if(c.command==='list')send({id:c.id,result:[{cameraID:'fixture',name:'Fixture Camera',storages:[{name:'Slot 1'}]}]});
 else if(c.command==='files'){send({id:c.id,progress:{completed:1,total:0}});send({id:c.id,result:[{storage:'Slot 1',folder:['DCIM','100NZ_F'],name:'DSC_0001.JPG',size:data.length,modified:${day},objectID:'o1'},{storage:'Slot 1',folder:['DCIM','100NZ_F'],name:'DSC_0001.JPG',size:data.length,modified:${day},objectID:'o2'},{storage:'Slot 1',folder:['..'],name:'escape.jpg',size:1,objectID:'o3'}]});}
 else if(c.command==='read'){const part=data.subarray(c.offset,c.offset+c.length);send({id:c.id,result:{bytes:part.length,data:part.toString('base64')}});}
 else if(c.command==='release')send({id:c.id,result:true});
 else send({id:c.id,error:'Unknown native camera command.'});});`);
  const prior = process.env.IMPORTER_NATIVE_BRIDGE; process.env.IMPORTER_NATIVE_BRIDGE = helper;
  t.after(async () => { await closeCameraBridge(); if (prior === undefined) delete process.env.IMPORTER_NATIVE_BRIDGE; else process.env.IMPORTER_NATIVE_BRIDGE = prior; });
  const before = await temporary();
  const listed: number[] = [];
  const stage = await prepareCamera({ id: 'camera:fixture', name: 'Fixture Camera', path: 'camera://fixture', transport: 'camera' }, undefined, count => listed.push(count));
  assert.deepEqual(listed, [1]);
  assert.ok(stage.path.startsWith(LISTED_PARENT));
  const files = (await fs.readdir(path.join(stage.path, 'Slot 1', 'DCIM', '100NZ_F'), { withFileTypes: true })).map(entry => entry.name).sort();
  assert.deepEqual(files, ['DSC_0001.JPG', 'duplicate-o2'], 'a name the camera repeats is kept apart; an unsafe one is left out');
  const handle = await fs.open(path.join(stage.path, 'Slot 1', 'DCIM', '100NZ_F', 'DSC_0001.JPG'), 'r'), buffer = Buffer.alloc(6);
  assert.equal((await handle.read(buffer, 0, 6, 5)).bytesRead, 6);
  assert.equal(buffer.toString(), '56789a');
  await handle.close();
  await stage.cleanup();
  await assert.rejects(fs.lstat(path.join(stage.path, 'Slot 1')), { code: 'ENOENT' });
  assert.deepEqual(await added(before), []);
});

test('helper file lists are checked before use', () => {
  const { files, invalid } = cameraFiles([{ storage: 'Slot 1', folder: ['DCIM'], name: 'a.jpg', size: 1, objectID: 'o1', modified: day }, { storage: 'Slot 1', folder: ['DCIM'], name: '../b.jpg', size: 1, objectID: 'o2' }, { storage: 'Slot 1', folder: ['DCIM'], name: 'c.jpg', size: -1, objectID: 'o3' }]);
  assert.equal(invalid, 2);
  assert.deepEqual(listedFiles(files).map(file => file.relative), ['Slot 1/DCIM/a.jpg']);
  assert.throws(() => cameraFiles({}), /invalid file list/);
});
