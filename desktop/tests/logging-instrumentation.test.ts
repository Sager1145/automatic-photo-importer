import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { plan, execute, executeReorganization, finalizeOrganization, undoOrganization, getOrganizationRecovery, configureOrganizationRecovery } from '../core/index';
import { AppleDoubleCleaner } from '../core/appledouble';
import { deleteOriginals } from '../core/originals';
import { findResidue, cleanResidue } from '../core/residue';
import { configureLogger, resetLogger, withJob, type Logger, type LogLevel } from '../logger';
import { PhaseLog } from '../job-log';
import type { Job, Metadata } from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const metadata = async (): Promise<Metadata> => ({ camera: 'Nikon Z f', date: '2024-02-03T12:00:00Z', fields: {} });
const options = { backup: false, template: '{year}/{yyyymm}/{camera}', layout: 'flat' as const, unknownRules: {} };
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

let logger: Logger | undefined;
async function start(level: LogLevel) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'instrument-logs-')); logger = configureLogger({ dir, level }); return dir; }
async function read(dir: string) { await logger!.flush(); return (await Promise.all((await fs.readdir(dir)).sort().map(name => fs.readFile(path.join(dir, name), 'utf8')))).join('').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
afterEach(async () => { await logger?.close(); logger = undefined; resetLogger(); });
async function folder(t: test.TestContext, name: string) { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), name))); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
const deletions = (lines: { event: string }[]) => lines.filter(line => line.event === 'file-deleted') as unknown as { level: string; area: string; path: string; reason: string; proof: string }[];
function assertLogged(lines: ReturnType<typeof deletions>, area: string, file?: string) {
  const found = lines.filter(line => line.area === area && (!file || line.path === file));
  assert.ok(found.length > 0, `a ${area} deletion is logged${file ? ' for ' + file : ''}`);
  for (const line of found) { assert.equal(line.level, 'normal'); assert.ok(line.reason.length > 5, 'has a reason'); assert.ok(line.proof.length > 5, 'has a proof'); }
}

test('an import of a temp folder at detailed logs phases and every file\'s steps', async (t) => {
  const dir = await start('detailed'), base = await folder(t, 'log-import-');
  const source = path.join(base, 'source'), root = path.join(base, 'destination');
  await fs.mkdir(source); await fs.mkdir(root);
  const names = Array.from({ length: 12 }, (_, i) => `IMG_${String(i).padStart(4, '0')}.JPG`);
  for (const [index, name] of names.entries()) await fs.writeFile(path.join(source, name), Buffer.alloc(2048, index + 1));
  const job = { id: 'job-import', source: { id: 's', name: 'Card', path: source, transport: 'folder' }, phase: 'queued', detail: { key: 'job.waiting' }, errors: [], backup: false } as unknown as Job;
  const phases = new PhaseLog();
  await withJob(job.id, async () => {
    phases.observe([job], Date.now()); job.phase = 'discovering'; phases.observe([job], Date.now());
    const { plans: [transfer] } = await plan(source, [root], options, metadata);
    job.phase = 'copying'; phases.observe([job], Date.now());
    const result = await execute(transfer!, undefined, undefined, { removeAppleDouble: true });
    assert.equal(result.copied, 12);
    job.phase = 'complete'; phases.observe([job], Date.now());
  });
  const lines = await read(dir), count = (event: string) => lines.filter(line => line.event === event).length;
  assert.deepEqual(lines.filter(line => line.area === 'job').map(line => line.event), ['queued', 'phase-start', 'phase-end', 'phase-start', 'phase-end', 'job-end']);
  for (const event of ['preflight', 'stage-open', 'staged', 'verified', 'published']) assert.equal(count(event), 12, event);
  assert.equal(count('inventory'), 1); assert.equal(count('plan-done'), 1);
  assert.ok(lines.every(line => line.jobId === 'job-import'), 'every line carries the job');
  const published = lines.find(line => line.event === 'published');
  assert.equal(published.method, 'link'); assert.equal(published.sha256.length, 64); assert.equal(published.bytes, 2048);
  assert.ok(lines.find(line => line.event === 'staged').syncMs >= 0);
  assert.ok(lines.filter(line => line.event === 'route').length === 0, 'routing decisions are trace only');
  assertLogged(deletions(lines), 'staging');
  assert.ok(!JSON.stringify(lines).includes('"contents"'), 'no file contents');
});

test('trace adds a routing decision per file with camera, date, kind and reason; normal omits per-file steps but keeps deletions', async (t) => {
  for (const level of ['trace', 'normal'] as const) {
    const dir = await start(level), base = await folder(t, 'log-route-');
    const source = path.join(base, 'source'), root = path.join(base, 'destination');
    await fs.mkdir(source); await fs.mkdir(root); await fs.writeFile(path.join(source, 'A.JPG'), 'a');
    const { plans: [transfer] } = await plan(source, [root], options, metadata);
    await execute(transfer!);
    const lines = await read(dir);
    if (level === 'trace') {
      const route = lines.find(line => line.event === 'route');
      assert.match(route.camera, /Nikon Z f/); assert.match(route.date, /2024-02-03/); assert.ok(route.kind); assert.match(route.reason, /camera and capture date/); assert.match(route.destination, /A\.JPG$/);
    } else {
      assert.equal(lines.filter(line => ['route', 'staged', 'published', 'preflight'].includes(line.event)).length, 0);
      assertLogged(deletions(lines), 'staging');
    }
    await logger!.close(); resetLogger();
  }
});

test('a duplicate already at the destination is logged as a skip with the matching path, a new file as a copy', async (t) => {
  const dir = await start('detailed'), base = await folder(t, 'log-dup-');
  const source = path.join(base, 'source'), root = path.join(base, 'destination');
  await fs.mkdir(source); await fs.mkdir(root); await fs.writeFile(path.join(source, 'A.JPG'), 'same'); await fs.writeFile(path.join(source, 'B.JPG'), 'new!');
  const first = await plan(source, [root], options, metadata); await execute(first.plans[0]!);
  await fs.writeFile(path.join(source, 'C.JPG'), 'third');
  const second = await plan(source, [root], options, metadata);
  const checks = (await read(dir)).filter(line => line.event === 'destination-check');
  const skip = checks.filter(line => line.decision === 'skip'), copy = checks.filter(line => line.decision === 'copy');
  assert.ok(skip.some(line => /same SHA at path .*A\.JPG/.test(line.reason)), JSON.stringify(skip));
  assert.ok(copy.some(line => /no match/.test(line.reason) && line.source.endsWith('C.JPG')));
  assert.equal(second.plans[0]!.entries.filter(entry => entry.skip).length, 2);
});

test('AppleDouble removal is logged at normal with its reason and proof', async (t) => {
  const dir = await start('normal'), base = await folder(t, 'log-appledouble-');
  await fs.writeFile(path.join(base, 'A.JPG'), 'photo');
  const buffer = Buffer.alloc(4096);
  buffer.writeUInt32BE(0x00051607, 0); buffer.writeUInt32BE(0x00020000, 4); buffer.write('Mac OS X', 8); buffer.writeUInt16BE(2, 24);
  const name = Buffer.from('com.apple.provenance\0'), table = (11 + name.length + 3) & ~3, data = Buffer.from([1, 2, 0, 0x4c, 0x91, 0xe1, 0x96, 0x9e, 0xb2, 0x6f, 0xd8]), finder = 32 + 2 + 36 + table + data.length;
  buffer.writeUInt32BE(9, 26); buffer.writeUInt32BE(50, 30); buffer.writeUInt32BE(finder, 34); buffer.writeUInt32BE(2, 38); buffer.writeUInt32BE(50 + finder, 42); buffer.writeUInt32BE(4096 - 50 - finder, 46);
  buffer.write('ATTR', 84); buffer.writeUInt16BE(1, 84 + 34); buffer.writeUInt32BE(84 + 36 + table, 84 + 36); buffer.writeUInt32BE(data.length, 84 + 40); buffer[84 + 36 + 10] = name.length; name.copy(buffer, 84 + 36 + 11); data.copy(buffer, 84 + 36 + table);
  const sidecar = path.join(base, '._A.JPG'); await fs.writeFile(sidecar, buffer);
  const cleaner = new AppleDoubleCleaner();
  await cleaner.besideFile(path.join(base, 'A.JPG'), base, () => true);
  const lines = await read(dir);
  assert.equal(cleaner.report.removed, 1); await assert.rejects(fs.lstat(sidecar));
  assertLogged(deletions(lines), 'appledouble', sidecar);
});

test('Delete originals logs each removed original with the checksums that proved it, and why a file was kept', async (t) => {
  const dir = await start('normal'), base = await folder(t, 'log-originals-');
  const source = path.join(base, 'source'), backup = path.join(base, 'backup'); await fs.mkdir(source); await fs.mkdir(backup);
  await fs.writeFile(path.join(source, 'A.JPG'), 'aaaa'); await fs.writeFile(path.join(backup, 'A.JPG'), 'aaaa'); await fs.writeFile(path.join(source, 'B.JPG'), 'bbbb'); await fs.writeFile(path.join(backup, 'B.JPG'), 'DIFF');
  const result = await withJob('job-originals', () => deleteOriginals(source, [{ source: path.join(source, 'A.JPG'), size: 4, sha256: sha('aaaa'), destinations: [path.join(backup, 'A.JPG')] }, { source: path.join(source, 'B.JPG'), size: 4, sha256: sha('bbbb'), destinations: [path.join(backup, 'B.JPG')] }]));
  assert.equal(result.deleted.length, 1);
  const lines = await read(dir), found = deletions(lines);
  assertLogged(found, 'originals', path.join(source, 'A.JPG'));
  assert.match(found[0]!.proof, new RegExp(sha('aaaa')));
  assert.equal(found.filter(line => line.path.endsWith('B.JPG')).length, 0);
  assert.equal(lines[0].jobId, 'job-originals');
});

test('residue cleanup logs each removal with its kind, reason and proof', async (t) => {
  const dir = await start('normal'), temporary = await folder(t, 'log-residue-');
  const leftover = path.join(temporary, 'photo-importer-preview-abc123'); await fs.mkdir(leftover); await fs.writeFile(path.join(leftover, 'x.jpg'), 'x');
  const removed = await cleanResidue(await findResidue([], { temporary }));
  assert.equal(removed.removed.files, 1);
  assertLogged(deletions(await read(dir)), 'residue', leftover);
});

test('finalizing releases a retained original and undo removes a published copy, both logged with reason and proof', async (t) => {
  const dir = await start('normal'), root = await folder(t, 'log-organize-');
  const put = async (relative: string, contents: string) => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, contents); return file; };
  await put('2024/202402/Sony/JPEG/A.JPG', 'same bytes'); await put('old card/A.JPG', 'same bytes');
  const organizing = { backup: false, template: '{year}/{yyyymm}/{camera}', layout: 'format' as const, unknownRules: {}, reorganize: true };
  const sony = async () => ({ camera: 'Sony', date: '2024-02-03', fields: {} });
  const reviewed = (await plan(root, [root], organizing, sony)).plans[0]!;
  await executeReorganization(reviewed, undefined, undefined, { strategy: 'rename' });
  const [job] = await getOrganizationRecovery(root);
  assert.ok(job!.finalizable);
  await finalizeOrganization(root, job!.id);
  assertLogged(deletions(await read(dir)), 'release');

  const second = await folder(t, 'log-undo-'), copy = async (relative: string, contents: string) => { const file = path.join(second, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, contents); };
  await copy('incoming/B.JPG', 'bbbb');
  const toCopy = (await plan(second, [second], organizing, sony)).plans[0]!;
  await executeReorganization(toCopy, undefined, undefined, { strategy: 'copy' });
  const [undoJob] = await getOrganizationRecovery(second);
  await undoOrganization(second, undoJob!.id);
  const lines = await read(dir);
  assertLogged(deletions(lines), 'undo');
  assert.ok(lines.some(line => line.event === 'entry-undone') === false, 'per-entry undo steps are trace only');
});
