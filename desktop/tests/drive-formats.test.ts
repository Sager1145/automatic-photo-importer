import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { checkFileSizes, DRIVER_OPTIONS, driveFormat, driverLinks, driverOptions, FAT32_MAX_FILE_BYTES, filesTooLarge, nativeAccess } from '../core/drive-formats';
import { probeDestination, type ProbeOps } from '../core/destination-probe';
import { validateDestination } from '../platform/volumes';
import { MessageError, formatMessage, message } from '../messages';
import { I18nProvider, languages, translationCatalogs } from '../renderer/i18n';
import { DriveFormats } from '../renderer/DriveFormats';
import type { AppState, PlanEntry } from '../shared';
import { defaultPreferences } from '../preferences';
import { freshOrganizeOptions } from '../run-policy';

const entry = (name: string, size: number, skip = false): PlanEntry => ({ id: name, source: join(tmpdir(), 'card', 'PRIVATE', 'M4ROOT', 'CLIP', name), destination: name, size, kind: 'Videos', skip, family: name });
const keyOf = (error: unknown) => error instanceof MessageError ? error.key : undefined;

test('FAT32 refuses a file over 4 GiB - 1 byte before copying, naming the largest; exFAT, NTFS and the rest take it', () => {
  const plan = { root: '/Volumes/CARD/photobackup', entries: [entry('C0001.MP4', FAT32_MAX_FILE_BYTES), entry('C0002.MP4', FAT32_MAX_FILE_BYTES + 1), entry('C0003.MP4', 9e9), entry('C0004.MP4', 7e9, true)] };
  assert.deepEqual(filesTooLarge(plan, 'fat').map(item => item.id), ['C0002.MP4', 'C0003.MP4'], 'files already there (skip) are not written');
  for (const format of ['exfat', 'ntfs', 'apfs', 'hfs', 'ext', 'btrfs', undefined] as const) assert.deepEqual(filesTooLarge(plan, format), [], String(format));
  for (const fsType of ['msdos', 'FAT32', 'vfat']) {
    assert.throws(() => checkFileSizes([plan], () => fsType), (error: unknown) => {
      assert.equal(keyOf(error), 'error.fileTooLargeForFormat');
      const params = (error as MessageError).params!;
      assert.deepEqual([params.index, params.format, params.count, params.name], [1, 'FAT32', 2, 'C0003.MP4']);
      assert.match((error as MessageError).message, /Destination 1 is FAT32, which cannot hold a file larger than 4 GB\. 2 files are larger, such as C0003\.MP4 \(9\.0 GB\)\. Nothing was copied\./);
      return true;
    });
  }
  checkFileSizes([plan], () => 'exfat');
  // A separate video folder is checked on its own drive.
  const photos = { root: 'I:\\photobackup', entries: [entry('A.JPG', 1)], videos: { root: 'J:\\videobackup', entries: [entry('C0005.MP4', 5e9)] } };
  assert.throws(() => checkFileSizes([{ root: 'X', entries: [] }, photos], root => root.startsWith('J') ? 'FAT32' : 'NTFS'), (error: unknown) => (error as MessageError).params?.index === 2);
  checkFileSizes([photos], root => root.startsWith('J') ? 'exFAT' : 'FAT32');
});

test('every adapter name maps to its format, and native access matches each system', () => {
  const names: Record<string, string | undefined> = { apfs: 'apfs', hfs: 'hfs', hfsplus: 'hfs', msdos: 'fat', vfat: 'fat', FAT32: 'fat', exFAT: 'exfat', NTFS: 'ntfs', ntfs3: 'ntfs', ext4: 'ext', btrfs: 'btrfs', ReFS: 'refs', fuseblk: 'fuse', macfuse: 'fuse', zfs: 'other', '': undefined };
  for (const [name, format] of Object.entries(names)) assert.equal(driveFormat(name), format, name);
  for (const platform of ['darwin', 'win32', 'linux']) for (const format of ['exfat', 'fat'] as const) assert.equal(nativeAccess(format, platform), 'readwrite', `${format} on ${platform}`);
  assert.equal(nativeAccess('ntfs', 'darwin'), 'read');
  assert.equal(nativeAccess('apfs', 'win32'), 'none');
  assert.equal(nativeAccess('hfs', 'linux'), 'read');
  assert.equal(nativeAccess('fuse', 'linux'), 'none');
});

test('every format a system cannot write lists an open-source option with a license and an https link, translated in every language', () => {
  const gaps = { darwin: ['ntfs', 'ext', 'btrfs'], win32: ['ext', 'btrfs', 'hfs', 'apfs'], linux: ['apfs', 'hfs'] } as const;
  for (const [platform, formats] of Object.entries(gaps)) for (const format of formats) {
    assert.notEqual(nativeAccess(format, platform), 'readwrite');
    assert.ok(driverOptions(format, platform).length > 0, `${format} on ${platform}`);
  }
  assert.deepEqual(driverOptions('ntfs', 'darwin').map(option => option.access).indexOf('read'), -1);
  for (const option of DRIVER_OPTIONS) {
    assert.match(option.url, /^https:\/\//, option.id);
    assert.ok(option.license, option.id);
    for (const language of languages.filter(language => language !== 'en')) assert.ok(translationCatalogs[language as Exclude<typeof language, 'en'>][option.note], `${option.id} note in ${language}`);
  }
  assert.ok(driverLinks().has('https://github.com/tuxera/ntfs-3g'));
  assert.ok(!driverLinks().has('https://example.com/'));
});

test('Settings › Drive formats shows each drive with its format and access, and drivers only where this computer cannot write', () => {
  const state: AppState = { preferences: defaultPreferences, sources: [], jobs: [], history: [], platform: 'darwin', organizeOptions: freshOrganizeOptions(),
    driveFormats: [{ path: '/Volumes/A006', name: 'A006', fsType: 'exfat' }, { path: '/Volumes/WIN', name: 'WIN', fsType: 'ntfs', readOnly: true }, { path: '/', name: 'Macintosh HD', fsType: 'apfs', system: true }] };
  const html = renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(DriveFormats, { state, act: () => {} }) }));
  assert.match(html, /A006.*exFAT.*Reads and writes here/s);
  assert.match(html, /WIN.*NTFS.*Read only here/s);
  assert.match(html, /ntfs-3g \+ macFUSE/);
  assert.match(html, /brew install gromgit\/fuse\/ntfs-3g-mac/);
  assert.match(html, /never downloads or installs drivers/);
  assert.equal((html.match(/data-testid="drive-format-connected"/g) ?? []).length, 3);
  const ja = renderToStaticMarkup(createElement(I18nProvider, { language: 'ja', children: createElement(DriveFormats, { state, act: () => {} }) }));
  assert.match(ja, /ドライブのフォーマット/);
});

async function tempFolder() { return realpath(await mkdtemp(join(tmpdir(), 'probe-'))); }

test('the destination probe writes, flushes, reads back, renames and deletes, and leaves nothing', async () => {
  const root = await tempFolder();
  try {
    const seen: string[] = [];
    const real: ProbeOps = await import('node:fs/promises').then(fs => ({
      write: async (file, data) => { seen.push('write'); await fs.writeFile(file, data, { flag: 'wx' }); },
      flush: async () => { seen.push('flush'); },
      read: async file => { seen.push('read'); return fs.readFile(file); },
      rename: async (a, b) => { seen.push('rename'); await fs.rename(a, b); },
      remove: async file => { seen.push('remove'); await fs.unlink(file); },
      exists: file => fs.lstat(file).then(() => true, () => false),
    }));
    await probeDestination(root, real);
    assert.deepEqual(seen.slice(0, 6), ['write', 'flush', 'read', 'rename', 'read', 'remove']);
    await probeDestination(root);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the destination probe refuses a drive at the step that fails, and removes its file', async () => {
  const root = await tempFolder();
  try {
    const memory = new Map<string, Buffer>();
    const ops = (patch: Partial<ProbeOps>): ProbeOps => ({
      write: async (file, data) => { memory.set(file, Buffer.from(data)); },
      flush: async () => {},
      read: async file => { const data = memory.get(file); if (!data) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return data; },
      rename: async (a, b) => { memory.set(b, memory.get(a)!); memory.delete(a); },
      remove: async file => { memory.delete(file); },
      exists: async file => memory.has(file),
      ...patch,
    });
    const stepOf = async (patch: Partial<ProbeOps>) => {
      memory.clear();
      try { await probeDestination(root, ops(patch)); return 'accepted'; }
      catch (error) { assert.equal(memory.size, 0, 'the probe file is removed'); return error instanceof MessageError ? (error.key === 'error.destinationProbe' ? formatMessage(error.params!.step as any, 'en') : error.key) : String(error); }
    };
    assert.equal(await stepOf({}), 'accepted');
    assert.equal(await stepOf({ write: async () => { throw Object.assign(new Error('read-only file system'), { code: 'EROFS' }); } }), 'error.destinationReadOnly');
    assert.equal(await stepOf({ write: async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); } }), 'write');
    assert.equal(await stepOf({ flush: async () => { throw Object.assign(new Error('fsync failed'), { code: 'EIO' }); } }), formatMessage(message('probe.flush'), 'en'));
    // A driver that hands back other bytes than it was given.
    assert.equal(await stepOf({ read: async file => { const data = Buffer.from(memory.get(file)!); data[100] ^= 1; return data; } }), 'read back');
    assert.equal(await stepOf({ rename: async () => { throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' }); } }), 'rename');
    // A rename that copies but keeps the old name.
    assert.equal(await stepOf({ rename: async (a, b) => { memory.set(b, memory.get(a)!); } }), 'rename');
    // A delete that reports success but leaves the file.
    let removals = 0;
    assert.equal(await stepOf({ remove: async file => { if (removals++ > 0) memory.delete(file); } }), 'delete');
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('validateDestination runs the probe on every destination and refuses one that fails it', async () => {
  const root = await tempFolder();
  try {
    let probed = '';
    await validateDestination(join(root, 'photobackup'), [], { volumes: [], probe: async folder => { probed = folder; } });
    assert.equal(probed, root, 'the deepest existing folder is probed; nothing is created');
    await assert.rejects(validateDestination(root, [], { volumes: [], probe: async () => { throw new MessageError('error.destinationProbe', { step: message('probe.rename'), detail: message('text', { text: 'x' }) }); } }), (error: unknown) => keyOf(error) === 'error.destinationProbe');
    // A format this computer only reads names where the drivers are listed.
    await assert.rejects(validateDestination(root, [], { volumes: [{ path: root, name: 'WIN', fsType: process.platform === 'darwin' ? 'ntfs' : process.platform === 'linux' ? 'hfsplus' : 'ntfs', readOnly: true, external: true }] }), (error: unknown) => keyOf(error) === (process.platform === 'win32' ? 'error.destinationReadOnly' : 'error.destinationReadOnlyFormat'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
