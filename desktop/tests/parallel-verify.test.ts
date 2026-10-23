import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { streams, STREAMS, mapPool, type DeviceKind } from '../core/devices';
import { deleteOriginals, type VerifiedOriginal } from '../core/originals';
import { configureOrganizationRecovery } from '../core/recovery';
import { scanDuplicates, dropDuplicateStores } from '../core/duplicates';
import { removeDuplicates } from '../core/duplicate-removal';
import { destinationIndex, dropDestinationIndexes } from '../core/destination-index';
import { identity } from '../core/paths';
import { resolveGroups } from '../duplicate-rules';
import type { Metadata } from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function folder(t: test.TestContext) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-verify-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}
/** Pretend the temp volume is `kind` and count the whole-file streams running at once. */
async function measure(t: test.TestContext, kind: DeviceKind, probe: string) {
  const internals = streams as unknown as { kinds: Map<bigint, Promise<DeviceKind>>; known: Map<bigint, DeviceKind>; slots: Map<bigint, unknown> };
  const dev = (await fs.stat(probe, { bigint: true })).dev;
  internals.kinds.set(dev, Promise.resolve(kind)); internals.known.set(dev, kind); internals.slots.delete(dev);
  const original = streams.run;
  const seen = { active: 0, peak: 0, runs: 0 };
  streams.run = ((files: string[], work: (chunk: number) => Promise<unknown>, signal?: AbortSignal) => original.call(streams, files, async chunk => {
    seen.active++; seen.runs++; seen.peak = Math.max(seen.peak, seen.active);
    try { await sleep(15); return await work(chunk); } finally { seen.active--; }
  }, signal)) as typeof streams.run;
  t.after(() => { streams.run = original; internals.kinds.delete(dev); internals.known.delete(dev); internals.slots.delete(dev); });
  return seen;
}

async function originals(base: string, count: number) {
  const source = path.join(base, 'source'), backup = path.join(base, 'backup');
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(backup, { recursive: true });
  const files: VerifiedOriginal[] = [];
  for (let i = 0; i < count; i++) {
    const text = `photo ${i} `.repeat(20 + i);
    const name = `IMG_${String(i).padStart(3, '0')}.JPG`;
    await fs.writeFile(path.join(source, name), text); await fs.writeFile(path.join(backup, name), text);
    files.push({ source: path.join(source, name), size: Buffer.byteLength(text), sha256: sha(text), destinations: [path.join(backup, name)] });
  }
  return { source, backup, files };
}

test('mapPool keeps results in input order and never runs more than the limit', async () => {
  let active = 0, peak = 0;
  const out = await mapPool([30, 1, 20, 2, 10, 3, 5, 4], 3, async (ms, index) => { active++; peak = Math.max(peak, active); await sleep(ms); active--; return index; });
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(peak, 3);
  await assert.rejects(mapPool([1, 2, 3], 2, async item => { if (item === 2) throw new Error('boom'); return item; }), /boom/);
});

for (const kind of ['hdd', 'card', 'ssd'] as const) test(`Delete originals reads at most ${STREAMS[kind]} files at once on a ${kind}`, async t => {
  const base = await folder(t), { source, files } = await originals(base, 12);
  const seen = await measure(t, kind, base);
  const result = await deleteOriginals(source, files);
  assert.equal(result.deleted.length, 12);
  assert.equal(seen.runs, 24, 'every source and backup copy is still read');
  assert.ok(seen.peak <= STREAMS[kind], `peak ${seen.peak} > ${STREAMS[kind]}`);
  if (kind === 'ssd') assert.ok(seen.peak > 1, 'the fast device is read in parallel');
});

test('Delete originals reports in input order whatever order the checks finish in', async t => {
  const base = await folder(t), { source, files } = await originals(base, 10);
  await measure(t, 'ssd', base);
  // Files 2 and 7 are kept; the first files are the slowest (biggest) to finish.
  await fs.writeFile(files[2]!.source, 'X'.repeat(files[2]!.size));
  await fs.rm(files[7]!.destinations[0]!);
  const completed: string[] = [];
  const result = await deleteOriginals(source, files, { onProgress: (_done, _total, file) => { if (file) completed.push(file); } });
  assert.deepEqual(result.deleted.map(item => item.source), files.filter((_, i) => i !== 2 && i !== 7).map(file => file.source));
  assert.deepEqual(result.kept.map(item => [path.basename(item.source), item.reason]), [['IMG_002.JPG', 'changed'], ['IMG_007.JPG', 'destination-missing']]);
  assert.equal(result.bytes, result.deleted.reduce((sum, item) => sum + item.size, 0));
  assert.equal(new Set(completed).size, completed.length);
});

test('Delete originals never deletes a file whose digest did not match, in either copy', async t => {
  const base = await folder(t), { source, files } = await originals(base, 8);
  await measure(t, 'ssd', base);
  const wrongSource = files[1]!, wrongBackup = files[4]!;
  await fs.writeFile(wrongSource.source, 'Q'.repeat(wrongSource.size));
  await fs.writeFile(wrongBackup.destinations[0]!, 'Q'.repeat(wrongBackup.size));
  const result = await deleteOriginals(source, files);
  for (const bad of [wrongSource, wrongBackup]) await fs.stat(bad.source);
  assert.deepEqual(result.deleted.map(item => item.source).sort(), files.filter(file => file !== wrongSource && file !== wrongBackup).map(file => file.source).sort());
  assert.deepEqual(result.kept.map(item => item.reason), ['changed', 'destination-differs']);
});

test('Remove duplicates reads ahead in parallel but never beyond the device limit, and decides the same', async t => {
  const base = await folder(t), root = path.join(base, 'library');
  dropDuplicateStores(); dropDestinationIndexes();
  for (let i = 0; i < 10; i++) {
    await fs.mkdir(path.join(root, '2024/202405/Cam'), { recursive: true }); await fs.mkdir(path.join(root, 'Imported'), { recursive: true });
    await fs.writeFile(path.join(root, `2024/202405/Cam/DSC_${i}.JPG`), `photo number ${i}`); await fs.writeFile(path.join(root, `Imported/copy ${i}.JPG`), `photo number ${i}`);
  }
  const real = await fs.realpath(root);
  const { groups, companions } = await scanDuplicates(root, { metadata: async (): Promise<Metadata> => ({ fields: {} }), index: await destinationIndex(real, await identity(real)) });
  const seen = await measure(t, 'ssd', base);
  const removal = await removeDuplicates(root, resolveGroups(groups, 2), companions);
  assert.equal(removal.removed, 10);
  assert.ok(seen.peak <= STREAMS.ssd && seen.peak > 1, `peak ${seen.peak}`);
  assert.deepEqual(removal.report.map(line => line.file), groups.flatMap(group => group.files.map(item => item.path)).filter(item => item.startsWith('Imported/')).sort((a, b) => groups.findIndex(g => g.files.some(f => f.path === a)) - groups.findIndex(g => g.files.some(f => f.path === b))), 'decisions follow the group order');
  for (let i = 0; i < 10; i++) { await fs.stat(path.join(root, `2024/202405/Cam/DSC_${i}.JPG`)); await assert.rejects(fs.stat(path.join(root, `Imported/copy ${i}.JPG`))); }
});

test('Remove duplicates leaves a file whose bytes changed after the read-ahead', async t => {
  const base = await folder(t), root = path.join(base, 'library');
  dropDuplicateStores(); dropDestinationIndexes();
  await fs.mkdir(path.join(root, '2024/202405/Cam'), { recursive: true }); await fs.mkdir(path.join(root, 'Imported'), { recursive: true });
  await fs.writeFile(path.join(root, '2024/202405/Cam/DSC_1.JPG'), 'same photo'); await fs.writeFile(path.join(root, 'Imported/copy.JPG'), 'same photo');
  const real = await fs.realpath(root);
  const { groups, companions } = await scanDuplicates(root, { metadata: async (): Promise<Metadata> => ({ fields: {} }), index: await destinationIndex(real, await identity(real)) });
  // The copy is rewritten (same size) right after the read-ahead digested it: the stat no longer matches.
  const original = streams.run;
  let rewritten = false;
  streams.run = ((files: string[], work: (chunk: number) => Promise<unknown>, signal?: AbortSignal) => original.call(streams, files, work, signal).then(async value => {
    if (!rewritten && files[0]!.endsWith('copy.JPG')) { rewritten = true; await sleep(20); await fs.writeFile(files[0]!, 'diff photo'); }
    return value;
  })) as typeof streams.run;
  t.after(() => { streams.run = original; });
  const removal = await removeDuplicates(root, resolveGroups(groups, 2), companions);
  assert.equal(await fs.readFile(path.join(root, 'Imported/copy.JPG'), 'utf8'), 'diff photo', 'the changed file stays');
  assert.equal(removal.removed, 0);
});
