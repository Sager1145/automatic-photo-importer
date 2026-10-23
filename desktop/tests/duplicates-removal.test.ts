import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { configureOrganizationRecovery, placedByEarlierJournals, getOrganizationRecovery, finalizeOrganization, undoOrganization, deleteOrganizationRecovery } from '../core/recovery';
import { scanDuplicates, dropDuplicateStores } from '../core/duplicates';
import { removeDuplicates, afterRemoval, companionTarget } from '../core/duplicate-removal';
import { destinationIndex, dropDestinationIndexes } from '../core/destination-index';
import { identity } from '../core/paths';
import { chooseKeeper, organizedPath, resolveGroups, summarize } from '../duplicate-rules';
import type { DuplicateExif, DuplicateFile, DuplicateGroup, Metadata } from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const exif = (patch: Partial<DuplicateExif> = {}): DuplicateExif => ({ date: '2024-05-06T07:08:09.12', camera: 'Nikon Z f', serial: '3000123', shutterCount: '1001', width: 6048, height: 4032, ...patch });
const file = (name: string, patch: Partial<DuplicateFile> = {}): DuplicateFile => ({ path: name, size: 1000, kind: 'JPEG', edited: false, birth: 1, ctime: 1, ...patch });
const group = (strength: DuplicateGroup['strength'], id: string, ...files: DuplicateFile[]): DuplicateGroup => ({ id, strength, files });

test('the kept copy is the one in the organized structure, then the earliest imported', () => {
  assert.equal(organizedPath('2024/202405/Nikon Z f/DSC_1.NEF'), true);
  assert.equal(organizedPath('photobackup/2024/202405/Nikon Z f/DSC_1.NEF'), true);
  assert.equal(organizedPath('Imported/DSC_1.NEF'), false);
  assert.equal(organizedPath('2024/202405/DSC_1.NEF'), false, 'a camera folder is part of the structure');
  assert.equal(organizedPath('2024/202405/editied/cam/DSC_1.NEF'), false);
  const stray = file('Imported/old.jpg', { birth: 1 });
  const early = file('2024/202405/Z/a.jpg', { birth: 50, ctime: 5 });
  const late = file('2024/202405/Z/b.jpg', { birth: 90, ctime: 1 });
  assert.equal(chooseKeeper([stray, late, early]).path, early.path, 'organized wins over older strays; then the earliest birth');
  assert.equal(chooseKeeper([file('a/x.jpg', { birth: 5, ctime: 9 }), file('b/y.jpg', { birth: 5, ctime: 3 })]).path, 'b/y.jpg', 'ctime breaks a birth tie');
  assert.equal(chooseKeeper([file('long/path/x.jpg'), file('s.jpg')]).path, 's.jpg');
});
test('each level splits groups into automatic and manual ones; the same EXIF with another size is always manual', () => {
  const groups = [
    group('sha', 'sha', file('a.jpg'), file('b.jpg')),
    group('exif', 'exif', file('c.jpg'), file('d.jpg')),
    group('exif-size', 'size', file('e.jpg'), file('f.jpg', { size: 2000 })),
    group('similar', 'name', file('g.jpg'), file('h.jpg')),
  ];
  const split = (level: 1 | 2 | 3) => Object.fromEntries(resolveGroups(groups, level).map(item => [item.group.id, item.auto]));
  assert.deepEqual(split(1), { sha: false, exif: false, size: false, name: false });
  assert.deepEqual(split(2), { sha: true, exif: false, size: false, name: false });
  assert.deepEqual(split(3), { sha: true, exif: false, size: false, name: false }, 'level 3 removes only proven-identical files by itself');
  const three = resolveGroups(groups, 3);
  assert.deepEqual(three.filter(item => item.needsDecision).map(item => item.group.id), ['exif', 'size', 'name']);
  assert.deepEqual(summarize(three), { groups: 1, files: 1, bytes: 1000, undecided: 3, automatic: 1, manual: 3 });
  assert.deepEqual(three.map(item => item.decided), [false, false, false, false]);
  // The user's choice wins: another keeper, or keep everything; a path outside the group is ignored.
  const chosen = resolveGroups(groups, 3, { sha: 'b.jpg', exif: 'all', size: 'f.jpg', name: 'nowhere.jpg' });
  assert.deepEqual(chosen.map(item => [item.keep, item.remove.map(removed => removed.path)]), [['b.jpg', ['a.jpg']], ['all', []], ['f.jpg', ['e.jpg']], [undefined, []]]);
  assert.deepEqual(chosen.map(item => item.decided), [true, true, true, false]);
});

async function library(t: test.TestContext) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dup-removal-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  dropDuplicateStores(); dropDestinationIndexes();
  return path.join(base, 'library');
}
const write = async (root: string, relative: string, content: string) => { const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content); };
const exists = (target: string) => fs.lstat(target).then(() => true, () => false);
const scan = async (root: string, table: Record<string, DuplicateExif> = {}) => {
  await fs.mkdir(root, { recursive: true });
  return scanDuplicates(root, { metadata: async (target): Promise<Metadata> => { const found = table[path.basename(target)]; return { fields: {}, ...(found ? { camera: found.camera, date: found.date, fingerprint: found } : {}) }; }, index: await destinationIndex(await fs.realpath(root), await identity(root)) });
};
const kept = path.join('Photo Importer Data', 'Organizations');

test('a SHA duplicate is set aside into the recovery store, can be undone, and is released only on request', async t => {
  const root = await library(t);
  await write(root, '2024/202405/Nikon Z f/DSC_0001.JPG', 'the same photo'); await write(root, 'Imported/copy of DSC_0001.JPG', 'the same photo');
  await write(root, '2024/202405/Nikon Z f/DSC_0002.JPG', 'another photo');
  const { groups, companions } = await scan(root);
  const resolved = resolveGroups(groups, 2);
  assert.equal(resolved[0]!.keep, '2024/202405/Nikon Z f/DSC_0001.JPG');
  const steps = new Set<string>();
  const removal = await removeDuplicates(root, resolved, companions, { onProgress: progress => { if (progress.step) steps.add(progress.step); } });
  assert.deepEqual(removal.result!.errors, []);
  assert.equal(removal.removed, 1); assert.equal(removal.groups, 1);
  assert.equal(await exists(path.join(root, 'Imported/copy of DSC_0001.JPG')), false, 'set aside, not at its place');
  assert.equal(await fs.readFile(path.join(root, '2024/202405/Nikon Z f/DSC_0001.JPG'), 'utf8'), 'the same photo');
  assert.ok(await exists(path.join(root, kept, removal.id!, 'journal.jsonl')));
  assert.ok(steps.has('stashing'));
  // Nothing is deleted: the bytes are in the recovery store.
  const listed = (await getOrganizationRecovery(root)).find(job => job.id === removal.id)!;
  assert.equal(listed.kind, 'duplicates'); assert.equal(listed.status, 'complete'); assert.equal(listed.retainedFiles, 1); assert.equal(listed.undoable, true);
  // Undo puts it back where it was.
  assert.equal((await undoOrganization(root, removal.id!)).restored, 1);
  assert.equal(await fs.readFile(path.join(root, 'Imported/copy of DSC_0001.JPG'), 'utf8'), 'the same photo');
  // Remove again, then release: the space is freed and undo is refused.
  dropDuplicateStores();
  const second = await scan(root);
  const again = await removeDuplicates(root, resolveGroups(second.groups, 2), second.companions);
  assert.deepEqual(again.result!.errors, []);
  const released = await finalizeOrganization(root, again.id!);
  assert.equal(released.removed, 1); assert.equal(released.bytes, 14);
  const left = (await fs.readdir(path.join(root, kept, again.id!, 'originals'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
  assert.deepEqual(left, [], 'the released copy is gone from the recovery store');
  await assert.rejects(undoOrganization(root, again.id!), /released/);
  assert.equal(await fs.readFile(path.join(root, '2024/202405/Nikon Z f/DSC_0001.JPG'), 'utf8'), 'the same photo', 'the kept copy is untouched');
  assert.ok((await deleteOrganizationRecovery(root, again.id!)).files >= 0);
});
test('level 3 leaves an EXIF group with other bytes: nothing is removed without a decision', async t => {
  const root = await library(t);
  await write(root, '2024/202405/Nikon Z f/DSC_0003.JPG', 'AAAAAAAAAA'); await write(root, 'Imported/DSC_0003.JPG', 'BBBBBBBBBB');
  const { groups, companions } = await scan(root, { 'DSC_0003.JPG': exif() });
  assert.equal(groups[0]!.strength, 'exif');
  assert.equal((await removeDuplicates(root, resolveGroups(groups, 3), companions)).id, undefined);
  // A group handed over as automatic (no user decision) is still proven by content before anything moves.
  const [undecided] = resolveGroups(groups, 3, { [groups[0]!.id]: '2024/202405/Nikon Z f/DSC_0003.JPG' });
  const removal = await removeDuplicates(root, [{ ...undecided!, auto: true, decided: false }], companions);
  assert.equal(removal.removed, 0); assert.equal(removal.report[0]!.reason, 'it no longer matches the copy to keep');
  assert.equal(await fs.readFile(path.join(root, 'Imported/DSC_0003.JPG'), 'utf8'), 'BBBBBBBBBB');
});
test('an EXIF duplicate with another SHA is set aside on the user\'s decision and released through the same journal', async t => {
  const root = await library(t);
  await write(root, '2024/202405/Nikon Z f/DSC_0003.JPG', 'AAAAAAAAAA'); await write(root, 'Imported/DSC_0003.JPG', 'BBBBBBBBBB');
  const { groups, companions } = await scan(root, { 'DSC_0003.JPG': exif() });
  assert.equal(groups[0]!.strength, 'exif');
  const keep = (list: DuplicateGroup[]) => ({ [list[0]!.id]: '2024/202405/Nikon Z f/DSC_0003.JPG' });
  const removal = await removeDuplicates(root, resolveGroups(groups, 3, keep(groups)), companions);
  assert.deepEqual(removal.result!.errors, []); assert.equal(removal.removed, 1);
  assert.equal(await exists(path.join(root, 'Imported/DSC_0003.JPG')), false);
  assert.equal(await fs.readFile(path.join(root, '2024/202405/Nikon Z f/DSC_0003.JPG'), 'utf8'), 'AAAAAAAAAA');
  const listed = (await getOrganizationRecovery(root)).find(job => job.id === removal.id)!;
  assert.equal(listed.status, 'complete', String(listed.error));
  assert.equal((await undoOrganization(root, removal.id!)).restored, 1);
  assert.equal(await fs.readFile(path.join(root, 'Imported/DSC_0003.JPG'), 'utf8'), 'BBBBBBBBBB');
  dropDuplicateStores();
  const next = await scan(root, { 'DSC_0003.JPG': exif() });
  const second = await removeDuplicates(root, resolveGroups(next.groups, 3, keep(next.groups)), next.companions);
  assert.equal((await finalizeOrganization(root, second.id!)).removed, 1);
});
test('a lost kept copy stops the removal: a duplicate is never the last copy', async t => {
  const root = await library(t);
  await write(root, '2024/202405/Nikon Z f/DSC_0004.JPG', 'photo bytes'); await write(root, 'Imported/DSC_0004.JPG', 'photo bytes');
  const { groups, companions } = await scan(root);
  await fs.rm(path.join(root, '2024/202405/Nikon Z f/DSC_0004.JPG'));
  const removal = await removeDuplicates(root, resolveGroups(groups, 2), companions);
  assert.equal(removal.removed, 0); assert.equal(removal.left, 1);
  assert.equal(await fs.readFile(path.join(root, 'Imported/DSC_0004.JPG'), 'utf8'), 'photo bytes');
  // The kept copy changing after the scan stops the journal too.
  await write(root, '2024/202405/Nikon Z f/DSC_0004.JPG', 'photo bytes');
  const next = await scan(root); const resolved = resolveGroups(next.groups, 2);
  await write(root, '2024/202405/Nikon Z f/DSC_0004.JPG', 'someone edited this');
  const changed = await removeDuplicates(root, resolved, next.companions);
  assert.equal(changed.removed, 0);
  assert.equal(await exists(path.join(root, 'Imported/DSC_0004.JPG')), true);
});
test('a file changed since the scan stays; the user can choose the file to keep', async t => {
  const root = await library(t);
  await write(root, 'a/one.JPG', 'identical bytes'); await write(root, 'b/two.JPG', 'identical bytes');
  const { groups, companions } = await scan(root);
  const resolved = resolveGroups(groups, 1, { [groups[0]!.id]: 'b/two.JPG' });
  await write(root, 'a/one.JPG', 'edited meanwhile');
  const removal = await removeDuplicates(root, resolved, companions);
  assert.equal(removal.removed, 0); assert.match(removal.report[0]!.reason!, /changed/);
  await write(root, 'a/one.JPG', 'identical bytes');
  const next = await scan(root);
  const done = await removeDuplicates(root, resolveGroups(next.groups, 1, { [next.groups[0]!.id]: 'b/two.JPG' }), next.companions);
  assert.equal(done.removed, 1); assert.equal(await exists(path.join(root, 'a/one.JPG')), false); assert.equal(await exists(path.join(root, 'b/two.JPG')), true);
});
test('companions follow their primary: identical ones go with it, a missing one is carried, a different one stays', async t => {
  const root = await library(t);
  assert.equal(companionTarget('b/IMG_1.NEF', 'b/IMG_1.xmp', 'a/IMG_9.NEF'), path.join('a', 'IMG_9.xmp'));
  assert.equal(companionTarget('b/IMG_1.NEF', 'b/IMG_1.NEF.xmp', 'a/IMG_9.NEF'), path.join('a', 'IMG_9.NEF.xmp'));
  for (const [name, side, kept] of [['one', 'sidecar one', 'sidecar one'], ['two', 'sidecar two', undefined], ['three', 'sidecar three', 'other edits']] as const) {
    await write(root, `2024/202405/Nikon Z f/${name}.NEF`, `raw ${name}`); await write(root, `Imported/${name}.NEF`, `raw ${name}`);
    await write(root, `Imported/${name}.xmp`, side);
    if (kept) await write(root, `2024/202405/Nikon Z f/${name}.xmp`, kept);
  }
  const { groups, companions } = await scan(root);
  assert.equal(groups.length, 3);
  const removal = await removeDuplicates(root, resolveGroups(groups, 2), companions);
  assert.deepEqual(removal.result!.errors, []);
  assert.equal(removal.removed, 3);
  const byFile = Object.fromEntries(removal.report.filter(line => line.role === 'companion').map(line => [line.file, line.result]));
  assert.deepEqual(byFile, { 'Imported/one.xmp': 'removed', 'Imported/two.xmp': 'carried', 'Imported/three.xmp': 'left' });
  assert.equal(await exists(path.join(root, 'Imported/one.xmp')), false);
  assert.equal(await fs.readFile(path.join(root, '2024/202405/Nikon Z f/two.xmp'), 'utf8'), 'sidecar two');
  assert.equal(await fs.readFile(path.join(root, 'Imported/three.xmp'), 'utf8'), 'sidecar three');
  assert.equal(await fs.readFile(path.join(root, '2024/202405/Nikon Z f/three.xmp'), 'utf8'), 'other edits');
  // Undo brings everything back, and removes only the companion it carried.
  await undoOrganization(root, removal.id!);
  assert.equal(await exists(path.join(root, 'Imported/two.xmp')), true); assert.equal(await exists(path.join(root, '2024/202405/Nikon Z f/two.xmp')), false);
  assert.equal(await exists(path.join(root, 'Imported/two.NEF')), true);
});
test('copies on different destinations are never paired by a removal', async t => {
  const root = await library(t), other = path.join(path.dirname(root), 'library2');
  await write(root, '2024/202405/cam/a.JPG', 'same'); await write(other, '2024/202405/cam/a.JPG', 'same');
  const first = await scan(root), second = await scan(other);
  assert.equal(first.groups.length + second.groups.length, 0);
  assert.equal((await removeDuplicates(root, resolveGroups(first.groups, 3), first.companions)).id, undefined);
  assert.equal(await exists(path.join(other, '2024/202405/cam/a.JPG')), true);
});

test('a sidecar shared by the kept and the removed copy (IMG_1.JPG and IMG_1.jpeg beside one IMG_1.xmp) stays, and the removal releases', async t => {
  const root = await library(t);
  await write(root, 'a/IMG_1.JPG', 'the same photo'); await write(root, 'a/IMG_1.jpeg', 'the same photo'); await write(root, 'a/IMG_1.xmp', 'edits');
  const { groups, companions } = await scan(root);
  assert.equal(groups.length, 1);
  const removal = await removeDuplicates(root, resolveGroups(groups, 2), companions);
  assert.deepEqual(removal.result!.errors, []);
  assert.equal(removal.removed, 1);
  assert.equal(await fs.readFile(path.join(root, 'a/IMG_1.xmp'), 'utf8'), 'edits', 'the kept photo keeps its only sidecar');
  assert.ok(removal.report.filter(line => line.role === 'companion').every(line => line.result === 'left'));
  assert.equal((await finalizeOrganization(root, removal.id!)).removed, 1);
  assert.equal(await fs.readFile(path.join(root, 'a/IMG_1.xmp'), 'utf8'), 'edits');
});

test('a file kept in one group is never removed by another group (hand-built overlapping groups)', async t => {
  const root = await library(t);
  for (const name of ['a', 'b', 'c']) await write(root, `x/${name}.JPG`, 'identical bytes');
  const { groups, companions } = await scan(root);
  const files = new Map(groups.flatMap(item => item.files).map(item => [path.basename(item.path), item]));
  const first = group('sha', 'g1', files.get('a.JPG')!, files.get('b.JPG')!), second = group('sha', 'g2', files.get('b.JPG')!, files.get('c.JPG')!);
  const resolved = resolveGroups([first, second], 1, { g1: 'x/a.JPG', g2: 'x/b.JPG' });
  const removal = await removeDuplicates(root, resolved, companions);
  assert.deepEqual(removal.result?.errors ?? [], []);
  assert.equal(await exists(path.join(root, 'x/b.JPG')), true, 'b is kept by the second group, so the first cannot remove it');
  assert.equal(await exists(path.join(root, 'x/c.JPG')), false);
  assert.match(removal.report.find(line => line.file === 'x/b.JPG')!.reason!, /another group/);
});
test('a file hard-linked to the copy to keep is refused', async t => {
  const root = await library(t);
  await write(root, 'a/one.JPG', 'identical bytes'); await fs.link(path.join(root, 'a/one.JPG'), path.join(root, 'a/two.JPG'));
  const { groups, companions } = await scan(root);
  assert.equal(groups.length, 1);
  const removal = await removeDuplicates(root, resolveGroups(groups, 2), companions);
  assert.equal(removal.removed, 0); assert.match(removal.report[0]!.reason!, /link/);
  assert.equal(await exists(path.join(root, 'a/one.JPG')), true); assert.equal(await exists(path.join(root, 'a/two.JPG')), true);
});
test('a lookalike (EXIF) group is removed only while the inode and modified time of the scan still hold', async t => {
  const root = await library(t);
  await write(root, 'a/one.JPG', 'bytes one'); await write(root, 'b/two.JPG', 'bytes two!');
  const same = exif({ date: '2024-05-06T07:08:09.12' });
  const { groups, companions } = await scan(root, { 'one.JPG': same, 'two.JPG': same });
  assert.equal(groups[0]!.strength, 'exif-size');
  const choice = { [groups[0]!.id]: 'a/one.JPG' };
  // Same size and bytes replaced in place with another modified time: the size check alone would pass.
  await write(root, 'b/two.JPG', 'bytes TWO!');
  const later = new Date(Date.now() + 60000); await fs.utimes(path.join(root, 'b/two.JPG'), later, later);
  const refused = await removeDuplicates(root, resolveGroups(groups, 1, choice), companions);
  assert.equal(refused.removed, 0); assert.equal(refused.report[0]!.reason, 'changed since scan');
  assert.equal(await exists(path.join(root, 'b/two.JPG')), true);
  const next = await scan(root, { 'one.JPG': same, 'two.JPG': same });
  const done = await removeDuplicates(root, resolveGroups(next.groups, 1, { [next.groups[0]!.id]: 'a/one.JPG' }), next.companions);
  assert.equal(done.removed, 1);
});

test('the summary counts files an earlier journal placed, and drops them again after an undo', async t => {
  const root = await library(t);
  await write(root, 'a/one.JPG', 'identical bytes'); await write(root, 'b/two.JPG', 'identical bytes');
  const first = await scan(root);
  const removal = await removeDuplicates(root, resolveGroups(first.groups, 1, { [first.groups[0]!.id]: 'a/one.JPG' }), first.companions);
  assert.equal(removal.removed, 1);
  const placed = await placedByEarlierJournals(root);
  assert.deepEqual([...placed], ['a/one.JPG'], 'the kept file belongs to the journal');
  // A later pair whose copy to remove is that file would supersede the journal.
  const later = [group('sha', 'later', file('a/one.JPG'), file('c/three.JPG'))];
  const resolved = resolveGroups(later, 1, { later: 'c/three.JPG' });
  assert.equal(summarize(resolved).earlier, undefined, 'only reported when asked');
  assert.equal(summarize(resolved, placed).earlier, 1);
  assert.equal(summarize(resolveGroups(later, 1, { later: 'a/one.JPG' }), placed).earlier, 0);
  await undoOrganization(root, removal.id!);
  assert.equal((await placedByEarlierJournals(root)).size, 0, 'an undone journal supersedes nothing');
});
test('after a removal the groups are updated in memory exactly as a new scan would find them', async t => {
  const root = await library(t);
  await write(root, 'a/one.JPG', 'identical bytes'); await write(root, 'b/two.JPG', 'identical bytes'); await write(root, 'c/three.JPG', 'identical bytes');
  await write(root, 'd/x.JPG', 'other photo'); await write(root, 'e/y.JPG', 'other photo');
  const before = await scan(root);
  assert.equal(before.groups.length, 2);
  const keepOne = before.groups.find(item => item.files.length === 3)!;
  const removal = await removeDuplicates(root, resolveGroups(before.groups, 1, { [keepOne.id]: 'a/one.JPG' }), before.companions);
  assert.equal(removal.removed, 2);
  const memory = afterRemoval(before.groups, before.companions, removal);
  dropDuplicateStores();
  const again = await scan(root);
  const shape = (list: DuplicateGroup[]) => list.map(item => [item.strength, item.files.map(f => f.path)]);
  assert.deepEqual(shape(memory.groups), shape(again.groups));
  assert.deepEqual(memory.groups.map(item => item.id), again.groups.map(item => item.id));
});
