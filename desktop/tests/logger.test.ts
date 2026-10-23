import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Logger, byAge, configureLogger, resetLogger, log, logEnabled, withJob, type LogSink} from '../logger';

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'logger-test-'));
const files = async (dir: string) => (await fs.readdir(dir)).filter(name => name.endsWith('.jsonl')).sort(byAge);
const open: Logger[] = [];
const make = (options: ConstructorParameters<typeof Logger>[0]) => { const logger = new Logger(options); open.push(logger); return logger; };
afterEach(async () => { await Promise.all(open.splice(0).map(logger => logger.close())); });
const lines = async (dir: string) => (await Promise.all((await files(dir)).map(name => fs.readFile(path.join(dir, name), 'utf8')))).join('').split('\n').filter(Boolean).map(line => JSON.parse(line));

test('lines are JSON with ISO millisecond time, level, area, event and fields, in importer-YYYYMMDD-HHMMSS.jsonl', async () => {
  const dir = await temp(), logger = make({ dir, level: 'trace' });
  logger.log('normal', 'app', 'start', { version: '1.0', nested: { a: 1 } }, 'job-1');
  await logger.flush();
  const [name] = await files(dir);
  assert.match(name!, /^importer-\d{8}-\d{6}\.jsonl$/);
  const [line] = await lines(dir);
  assert.match(line.t, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const { t: _t, ...rest } = line;
  assert.deepEqual(rest, { level: 'normal', area: 'app', event: 'start', jobId: 'job-1', version: '1.0', nested: { a: 1 } });
});

test('levels filter: off records nothing, normal omits detailed and trace, detailed omits trace', async () => {
  for (const [level, expected] of [['off', []], ['normal', ['n']], ['detailed', ['n', 'd']], ['trace', ['n', 'd', 't']]] as const) {
    const dir = await temp(), logger = make({ dir, level });
    logger.log('normal', 'x', 'n'); logger.log('detailed', 'x', 'd'); logger.log('trace', 'x', 't');
    await logger.flush();
    assert.deepEqual((await lines(dir)).map(line => line.event), expected, level);
  }
  const logger = make({ dir: await temp(), level: 'normal' });
  let built = false;
  logger.log('detailed', 'x', 'd', () => { built = true; return {}; });
  assert.equal(built, false, 'fields are not built for a level that is not recorded');
  logger.setLevel('trace'); assert.equal(logger.enabled('trace'), true);
});

test('the level can change while running and the next lines follow it', async () => {
  const dir = await temp(), logger = make({ dir, level: 'normal' });
  logger.log('detailed', 'x', 'before'); logger.setLevel('detailed'); logger.log('detailed', 'x', 'after');
  await logger.flush();
  assert.deepEqual((await lines(dir)).map(line => line.event), ['after']);
});

test('secrets and file contents are never written', async () => {
  const dir = await temp(), logger = make({ dir, level: 'trace' });
  logger.log('normal', 'x', 'e', { hmac: 'abc', seal: 'def', key: Buffer.alloc(32, 7), contents: 'photo bytes', data: new Uint8Array(1000), nested: { seals: ['x'], ok: 'visible' }, error: Object.assign(new Error('boom'), { code: 'EIO' }) });
  await logger.flush();
  const [line] = await lines(dir);
  assert.equal(line.hmac, '[redacted]'); assert.equal(line.seal, '[redacted]'); assert.equal(line.contents, '[redacted]');
  assert.equal(line.key, '[32 bytes]'); assert.equal(line.data, '[1000 bytes]');
  assert.deepEqual(line.nested, { seals: '[redacted]', ok: 'visible' });
  assert.deepEqual(line.error, { name: 'Error', message: 'boom', code: 'EIO' });
});

test('rotation: a file stops at the size limit and the next line starts a new one, nothing lost or split', async () => {
  const dir = await temp(), logger = make({ dir, level: 'normal', maxFileBytes: 2000, maxFiles: 100, maxTotalBytes: 1e9 });
  for (let i = 0; i < 100; i++) logger.log('normal', 'x', 'line', { i, pad: 'p'.repeat(40) });
  await logger.flush();
  const names = await files(dir);
  assert.ok(names.length > 3, `${names.length} files`);
  for (const name of names) assert.ok((await fs.stat(path.join(dir, name))).size <= 2000, name);
  assert.deepEqual((await lines(dir)).map(line => line.i), Array.from({ length: 100 }, (_, i) => i));
  assert.deepEqual(names, [...names].sort(byAge), 'names sort in creation order');
});

test('retention keeps the newest N files', async () => {
  const dir = await temp(), logger = make({ dir, level: 'normal', maxFileBytes: 8000, maxFiles: 2, maxTotalBytes: 1e9 });
  for (let i = 0; i < 300; i++) logger.log('normal', 'x', 'line', { i, pad: 'p'.repeat(60) });
  await logger.flush(); await logger.flush();
  const names = await files(dir);
  assert.equal(names.length, 2);
  const kept = (await lines(dir)).filter(line => line.event === 'line');
  assert.equal(kept.at(-1).i, 299, 'the newest line survives ');
  assert.ok(kept.every(line => line.i > 100), 'old files are gone');
});

test('retention keeps the total under the byte limit but never deletes the file in use', async () => {
  const dir = await temp(), logger = make({ dir, level: 'normal', maxFileBytes: 1000, maxFiles: 100, maxTotalBytes: 2500 });
  for (let i = 0; i < 80; i++) logger.log('normal', 'x', 'line', { i, pad: 'p'.repeat(60) });
  await logger.flush(); await logger.flush();
  let total = 0; for (const name of await files(dir)) total += (await fs.stat(path.join(dir, name))).size;
  assert.ok(total <= 2500 + 1000, `${total}`);
  assert.ok((await files(dir)).length >= 1);
  const deletions = (await lines(dir)).filter(line => line.event === 'file-deleted');
  for (const item of deletions) assert.ok(item.reason && item.proof && item.path);
});

test('a new run keeps earlier files and starts its own', async () => {
  const dir = await temp();
  const first = make({ dir, level: 'normal', now: () => new Date(2026, 0, 1, 10, 0, 0) }); first.log('normal', 'x', 'one'); await first.flush();
  const second = make({ dir, level: 'normal', now: () => new Date(2026, 0, 1, 10, 0, 0) }); second.log('normal', 'x', 'two'); await second.flush();
  assert.deepEqual(await files(dir), ['importer-20260101-100000.jsonl', 'importer-20260101-100000-0001.jsonl']);
  assert.deepEqual((await lines(dir)).map(line => line.event).sort(), ['one', 'two']);
});

test('the writer never throws: a refused or full disk drops the lines and recovers when it works again', async () => {
  const dir = await temp(); let failing = true; const written: string[] = [];
  const open = async (): Promise<LogSink> => ({ write: async (data: string) => { if (failing) throw Object.assign(new Error('no space left'), { code: 'EACCES' }); written.push(data); }, close: async () => {} });
  const logger = make({ dir, level: 'normal', open });
  logger.log('normal', 'x', 'lost');
  await assert.doesNotReject(logger.flush());
  assert.ok(logger.stats().failures >= 1);
  failing = false; logger.log('normal', 'x', 'kept'); await logger.flush();
  assert.match(written.join(''), /"event":"kept"/);
  const blocked = make({ dir: path.join(await temp(), 'a', 'b'), level: 'normal', open: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
  blocked.log('normal', 'x', 'y'); await assert.doesNotReject(blocked.flush()); await assert.doesNotReject(blocked.close());
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.doesNotThrow(() => logger.log('normal', 'x', 'circular', { circular }));
});

test('an unwritable folder (read-only) never throws into callers', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('permissions are not enforced');
  const dir = await temp(); await fs.chmod(dir, 0o500);
  const logger = make({ dir: path.join(dir, 'logs'), level: 'normal' });
  logger.log('normal', 'x', 'y'); await assert.doesNotReject(logger.flush());
  await fs.chmod(dir, 0o700);
});

test('too many queued lines are dropped, counted and reported once the disk is back', async () => {
  const dir = await temp(), logger = make({ dir, level: 'normal', maxPendingBytes: 500 });
  for (let i = 0; i < 20; i++) logger.log('normal', 'x', 'line', { i });
  assert.ok(logger.stats().dropped > 0);
  await logger.flush();
  assert.ok((await lines(dir)).some(line => line.event === 'dropped' && line.count > 0));
});

test('logging 100k buffered lines does not block the main thread', async () => {
  const dir = await temp(), logger = make({ dir, level: 'detailed', maxPendingBytes: 1e9 });
  const cpu = process.cpuUsage(), start = performance.now();
  for (let i = 0; i < 100_000; i++) logger.log('detailed', 'exec', 'file-verified', { path: `/Volumes/A/DCIM/100MEDIA/DSC_${i}.JPG`, bytes: 4_000_000 + i, ms: 12, sha256: 'a'.repeat(64) });
  const used = process.cpuUsage(cpu), elapsed = performance.now() - start;
  // Queueing is memory only: nothing touched the disk while the lines were logged.
  assert.deepEqual(await fs.readdir(dir), [], 'no file I/O happens in log()');
  // CPU time, not wall time, so a busy machine does not fail this: well under 40 microseconds per line.
  assert.ok((used.user + used.system) / 1000 < 4000, `100k lines took ${((used.user + used.system) / 1000).toFixed(0)} ms of CPU (${elapsed.toFixed(0)} ms elapsed)`);
  await logger.flush();
  assert.equal((await lines(dir)).length, 100_000);
});

test('the global log() is a no-op until configured and follows the job in scope', async () => {
  resetLogger();
  assert.doesNotThrow(() => log('normal', 'x', 'nobody')); assert.equal(logEnabled('normal'), false);
  const dir = await temp(), logger = configureLogger({ dir, level: 'detailed' });
  assert.equal(logEnabled('detailed'), true); assert.equal(logEnabled('trace'), false);
  await withJob('job-7', async () => { await new Promise(resolve => setTimeout(resolve, 1)); log('detailed', 'exec', 'inside'); });
  log('normal', 'exec', 'outside');
  await logger.flush();
  const found = await lines(dir);
  assert.equal(found.find(line => line.event === 'inside').jobId, 'job-7');
  assert.equal(found.find(line => line.event === 'outside').jobId, undefined);
  await logger.close(); resetLogger();
});

test('an excerpt holds one job\'s lines, capped, in order', async () => {
  const dir = await temp(), logger = make({ dir, level: 'normal', maxFileBytes: 3000 });
  for (let i = 0; i < 50; i++) { logger.log('normal', 'x', 'mine', { i }, 'job-a'); logger.log('normal', 'x', 'other', { i }, 'job-b'); }
  const out = path.join(await temp(), 'log-excerpt.jsonl');
  const result = await logger.excerpt('job-a', out);
  const found = (await fs.readFile(out, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(result.lines, 50); assert.ok(found.every(line => line.jobId === 'job-a'));
  assert.deepEqual(found.map(line => line.i), Array.from({ length: 50 }, (_, i) => i));
  const capped = path.join(await temp(), 'capped.jsonl');
  const small = await logger.excerpt('job-a', capped, { cap: 500 });
  assert.equal(small.truncated, true); assert.ok(small.bytes <= 500);
  assert.match(await fs.readFile(capped, 'utf8'), /excerpt-truncated/);
});
