import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { deleteOriginals, type VerifiedOriginal } from '../core/originals';
import { createTranslator } from '../renderer/i18n';
import { formatMessage, message } from '../messages';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const exists = (file: string) => fs.lstat(file).then(() => true, () => false);

/** A source tree and a backup holding the same files; `names` are relative source paths. */
async function fixture(t: test.TestContext, names: string[]) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'originals-folders-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'), backup = path.join(base, 'backup');
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(backup, { recursive: true });
  const files: VerifiedOriginal[] = [];
  for (const [index, name] of names.entries()) {
    const body = `photo ${index} `.repeat(10), file = path.join(source, name), copy = path.join(backup, `${index}.jpg`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body); await fs.writeFile(copy, body);
    files.push({ source: file, size: Buffer.byteLength(body), sha256: sha(body), destinations: [copy] });
  }
  return { base, source, backup, files };
}
/** A minimal AppleDouble header with no entries: bookkeeping only. */
const blankSidecar = () => { const b = Buffer.alloc(26); b.writeUInt32BE(0x00051607, 0); b.writeUInt32BE(0x00020000, 4); return b; };
/** One Finder info entry with a colour label set: real user data. */
const taggedSidecar = () => {
  const b = Buffer.alloc(26 + 12 + 32); b.writeUInt32BE(0x00051607, 0); b.writeUInt32BE(0x00020000, 4); b.writeUInt16BE(1, 24);
  b.writeUInt32BE(9, 26); b.writeUInt32BE(38, 30); b.writeUInt32BE(32, 34); b[38 + 9] = 0x0c;
  return b;
};

test('emptied nested folders are removed bottom-up and the source root stays', async t => {
  const { source, files } = await fixture(t, ['a/b/c/one.jpg', 'a/b/two.jpg']);
  const progress: [number, number][] = [];
  const result = await deleteOriginals(source, files, { onFolders: (done, total) => progress.push([done, total]) });
  assert.equal(result.folders, 3);
  assert.equal(await exists(path.join(source, 'a')), false);
  assert.equal(await exists(source), true);
  assert.deepEqual(progress.at(-1), [3, 3]);
  assert.deepEqual(progress.map(item => item[0]), [0, 1, 2, 3]);
});

test('a folder with a kept original stays, with its ancestors', async t => {
  const { source, files } = await fixture(t, ['a/b/one.jpg', 'a/b/two.jpg', 'x/y/three.jpg']);
  await fs.writeFile(files[1]!.source, 'changed since the import');
  const result = await deleteOriginals(source, files);
  assert.equal(result.kept.length, 1);
  assert.equal(await exists(files[1]!.source), true);
  assert.equal(await exists(path.join(source, 'a/b')), true);
  assert.equal(await exists(path.join(source, 'x')), false);
  assert.equal(result.folders, 2);
});

test('a folder holding a hidden user file stays', async t => {
  const { source, files } = await fixture(t, ['a/one.jpg']);
  await fs.writeFile(path.join(source, 'a/.notes'), 'mine');
  const result = await deleteOriginals(source, files);
  assert.equal(result.folders, 0);
  assert.equal(await exists(path.join(source, 'a/.notes')), true);
});

test('only .DS_Store and a bookkeeping sidecar of a deleted file: the folder goes', async t => {
  const { source, files } = await fixture(t, ['a/x.jpg']);
  await fs.writeFile(path.join(source, 'a/.DS_Store'), 'finder');
  await fs.writeFile(path.join(source, 'a/._x.jpg'), blankSidecar());
  const result = await deleteOriginals(source, files);
  assert.equal(result.folders, 1);
  assert.equal(await exists(path.join(source, 'a')), false);
});

test('a sidecar holding Finder tags keeps its folder and itself', async t => {
  const { source, files } = await fixture(t, ['a/x.jpg']);
  await fs.writeFile(path.join(source, 'a/._x.jpg'), taggedSidecar());
  await fs.writeFile(path.join(source, 'a/.DS_Store'), 'finder');
  const result = await deleteOriginals(source, files);
  assert.equal(result.folders, 0);
  assert.equal(await exists(path.join(source, 'a/._x.jpg')), true);
  assert.equal(await exists(path.join(source, 'a/.DS_Store')), true, 'nothing is removed from a folder that stays');
});

test('a symlinked folder is never entered or removed, and a separately chosen source stays', async t => {
  const { base, source, files } = await fixture(t, ['a/one.jpg', 'b/two.jpg']);
  const outside = path.join(base, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(source, 'a/link'));
  const result = await deleteOriginals(source, files, { protect: [path.join(source, 'b')] });
  assert.equal(await exists(path.join(source, 'a/link')), true);
  assert.equal(await exists(outside), true);
  assert.equal(await exists(path.join(source, 'a')), true);
  assert.equal(await exists(path.join(source, 'b')), true);
  assert.equal(result.folders, 0);
});

/** Six files, each alone in its own folder: the pool of four has finished one file when the fifth starts. */
const stoppedMidRun = async (t: test.TestContext) => {
  const { source, files } = await fixture(t, ['a/1.jpg', 'b/2.jpg', 'c/3.jpg', 'd/4.jpg', 'e/5.jpg', 'f/6.jpg']);
  const control = new AbortController();
  const result = await deleteOriginals(source, files, { signal: control.signal, onProgress: completed => { if (completed === 4) control.abort(); } });
  return { source, files, result };
};

test('a stop mid-run returns every file already deleted, with stopped set', async t => {
  const { files, result } = await stoppedMidRun(t);
  assert.equal(result.stopped, true);
  assert.ok(result.deleted.length >= 1, 'at least the file that finished before the stop is reported');
  assert.equal(result.deleted.length + result.kept.length, files.length, 'every file is accounted for');
  assert.equal(result.bytes, result.deleted.reduce((sum, item) => sum + item.size, 0));
  for (const item of result.deleted) assert.equal(await exists(item.source), false, 'reported deleted, so it is gone');
  for (const item of result.kept) { assert.equal(item.reason, 'stopped'); assert.equal(await exists(item.source), true); }
});

test('a stop leaves every folder alone, even those its deletions emptied', async t => {
  const { source, files, result } = await stoppedMidRun(t);
  assert.equal(result.stopped, true);
  assert.ok(result.deleted.length >= 1);
  assert.equal(result.folders, 0);
  for (const folder of ['a', 'b', 'c', 'd', 'e', 'f']) assert.equal(await exists(path.join(source, folder)), true, `${folder} stays`);
  assert.equal(files.length, 6);
});

test('a stop during the stat pass before the first read ends the run as stopped with nothing deleted', async t => {
  const { source, files } = await fixture(t, ['a/one.jpg', 'b/two.jpg']);
  const control = new AbortController(); control.abort();
  const result = await deleteOriginals(source, files.map(file => ({ ...file, identity: 'known' })), { signal: control.signal, changeTimes: true });
  assert.equal(result.stopped, true);
  assert.equal(result.deleted.length, 0);
  assert.equal(result.folders, 0);
  assert.deepEqual(result.kept.map(item => item.reason), ['stopped', 'stopped']);
  for (const file of files) assert.equal(await exists(file.source), true);
});

test('the summary line and the history message count the removed folders in every language', () => {
  for (const language of ['en', 'zh-Hans', 'zh-Hant', 'ja'] as const) {
    const t = createTranslator(language);
    const line = t('{count} originals deleted ({size}); {kept} left in place; {folders} empty folders removed', { count: 4, size: '1 MB', kept: 1, folders: 7 });
    assert.ok(line.includes('7') && !line.includes('{'), `${language}: ${line}`);
    assert.ok(!t('Removing empty folders: {completed} of {total}', { completed: 2, total: 5 }).includes('{'));
    assert.ok(formatMessage(message('job.originalsDeleted', { count: 4, size: '1 GB', kept: 1, folders: 7 }), language).includes('7'), `${language}: history`);
  }
  assert.equal(createTranslator('en')('Removing empty folders: {completed} of {total}', { completed: 2, total: 5 }), 'Removing empty folders: 2 of 5');
});
