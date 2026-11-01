import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureLogger, resetLogger, type Logger } from '../logger';
import { ActivityLog, PhaseLog, TopologyLog, logProgress } from '../job-log';
import type { Job } from '../shared';

let logger: Logger | undefined;
const start = async (level: 'normal' | 'detailed' | 'trace' = 'detailed') => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-log-')); logger = configureLogger({ dir, level }); return dir; };
const read = async (dir: string) => { await logger!.flush(); return (await Promise.all((await fs.readdir(dir)).sort().map(name => fs.readFile(path.join(dir, name), 'utf8')))).join('').split('\n').filter(Boolean).map(line => JSON.parse(line)); };
afterEach(async () => { await logger?.close(); logger = undefined; resetLogger(); });
const job = (patch: Partial<Job> = {}): Job => ({ id: 'j1', source: { id: 's', name: 'Card A', path: '/Volumes/A', transport: 'storage' }, phase: 'queued', detail: { key: 'job.waiting' }, errors: [], backup: false, ...patch } as Job);

test('every phase start and end is logged at normal with counts, bytes, duration and rate', async () => {
  const dir = await start('normal'), phases = new PhaseLog(), item = job();
  phases.observe([item], 1000);
  item.phase = 'discovering'; phases.observe([item], 2000);
  item.phase = 'copying'; item.progress = { completed: 50, total: 100, bytes: 5_000_000, totalBytes: 10_000_000, speed: 0, file: 'x', step: 'moving' }; phases.observe([item], 3000);
  item.progress = { completed: 100, total: 100, bytes: 10_000_000, totalBytes: 10_000_000, speed: 0, file: 'y' }; phases.observe([item], 7000);
  item.phase = 'complete'; phases.observe([item], 9000); phases.observe([item], 9500);
  const lines = await read(dir);
  assert.deepEqual(lines.map(line => `${line.event}:${line.phase ?? line.result ?? ''}`), ['queued:', 'phase-start:discovering', 'phase-end:discovering', 'phase-start:copying', 'phase-end:copying', 'job-end:complete']);
  assert.ok(lines.every(line => line.jobId === 'j1' && line.level === 'normal'));
  const copying = lines.find(line => line.event === 'phase-end' && line.phase === 'copying');
  assert.equal(copying.ms, 6000); assert.equal(copying.completed, 100); assert.equal(copying.bytes, 10_000_000);
  assert.equal(copying.filesPerSecond, 16.67); assert.equal(copying.bytesPerSecond, Math.round(10_000_000 / 6));
});

test('progress snapshots are detailed and only for running steps', async () => {
  const dir = await start('detailed');
  const running = job({ phase: 'copying', progress: { completed: 3, total: 9, bytes: 30, totalBytes: 90, speed: 5, file: 'a.jpg', step: 'moving' } });
  logProgress([running, job({ id: 'j2', phase: 'queued' }), job({ id: 'j3', phase: 'complete' })]);
  const lines = await read(dir);
  assert.equal(lines.length, 1); assert.equal(lines[0].event, 'progress'); assert.equal(lines[0].jobId, 'j1'); assert.equal(lines[0].completed, 3);
  logger!.setLevel('normal'); logProgress([running]);
  assert.equal((await read(dir)).length, 1, 'normal does not record snapshots');
});

test('mounts, unmounts, identities, sources and destination status are logged when they change, not on every refresh', async () => {
  const dir = await start('detailed'), topology = new TopologyLog();
  const volume = { path: '/Volumes/A', name: 'A', volumeId: 'uuid-1', physicalId: 'disk4', fsType: 'exfat' };
  const source = { id: 'uuid-1', name: 'A', path: '/Volumes/A', transport: 'storage' as const };
  topology.observe([volume], [source], [{ path: '/Volumes/B/x', available: true, volumeId: 'uuid-2' }]);
  topology.observe([volume], [source], [{ path: '/Volumes/B/x', available: true, volumeId: 'uuid-2' }]);
  topology.observe([{ ...volume, volumeId: 'uuid-9' }], [], [{ path: '/Volumes/B/x', available: false }]);
  topology.observe([], [], []);
  const events = (await read(dir)).map(line => line.event);
  assert.deepEqual(events, ['mounted', 'source-connected', 'destination', 'identity-changed', 'source-disconnected', 'destination', 'unmounted']);
});

test('drive activity ticks are summarised at most every 5 seconds', async () => {
  const dir = await start('detailed'), activity = new ActivityLog(), drives = { A: { utilization: 0.8, readBps: 10, writeBps: 0, iops: 3, history: [] } };
  activity.observe(drives, 10_000); activity.observe(drives, 12_000); activity.observe(drives, 16_000);
  const lines = await read(dir);
  assert.equal(lines.length, 2); assert.equal(lines[0].busy, 1); assert.equal(lines[0].items[0].key, 'A');
});

// Seen 2026-11-01 on Windows: Stop pressed as a 7,850-file verify finished left no trace, and the job ended complete; and failed imports
// logged job-end "copied":40 and 46 (their last progress counts) while History read "0 copied".
test('a stop is logged as it arrives, and job-end carries the import result, not the last progress count', async () => {
  const dir = await start('normal'), phases = new PhaseLog(), item = job({ phase: 'verifying', progress: { phase: 'verifying', completed: 7800, total: 7850, bytes: 0, totalBytes: 0, speed: 0, file: '' } });
  phases.observe([item], 1000);
  item.stopping = 'stop'; phases.observe([item], 2000); phases.observe([item], 3000);
  delete item.stopping; item.phase = 'complete'; item.progress = { ...item.progress!, completed: 7850 }; item.importResult = { copied: 7850, skipped: 0, planned: 7850, errors: 0 };
  phases.observe([item], 4000);
  const lines = await read(dir);
  const stops = lines.filter(line => line.event === 'stop-requested');
  assert.equal(stops.length, 1); assert.equal(stops[0].kind, 'stop'); assert.equal(stops[0].completed, 7800);
  const end = lines.find(line => line.event === 'job-end');
  assert.equal(end.result, 'complete'); assert.equal(end.stopRequested, 'stop'); assert.equal(end.copied, 7850); assert.equal(end.alreadyInBackup, 0);
  const failed = job({ id: 'j9', phase: 'verifying', progress: { phase: 'verifying', completed: 40, total: 43, bytes: 0, totalBytes: 0, speed: 0, file: '' } });
  phases.observe([failed], 5000);
  failed.phase = 'error'; failed.importResult = { copied: 0, skipped: 0, planned: 43, errors: 43 }; phases.observe([failed], 6000);
  assert.equal((await read(dir)).find(line => line.event === 'job-end' && line.jobId === 'j9').copied, 0);
});
