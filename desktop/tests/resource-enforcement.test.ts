import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DeviceStreams, CHUNK, cpuWorkers as devicesCpuWorkers } from '../core/devices';
import { hasherWorkerCount, pendingChunks } from '../core/hasher';
import { exiftoolProcs, routingCacheLimit } from '../platform/metadata';
import { MemoryGovernor, MB, cpuWorkers, resourceLimits, setResourceLimits, uvThreadpoolSize } from '../resource-limits';
import { raiseThreadpool, THREADPOOL_SIZE } from '../threadpool';

const host = { cores: 10, totalMemBytes: 16 * 1024 * MB };
async function withLimits(patch: Parameters<typeof setResourceLimits>[0], work: () => Promise<void> | void) {
  const before = { ...resourceLimits() };
  setResourceLimits(patch, host);
  try { await work(); } finally { setResourceLimits(before, host); }
}

test('the hasher pool and exiftool processes honour maxCpuThreads', async () => {
  const cores = os.availableParallelism();
  await withLimits({ maxCpuThreads: 1 }, () => {
    assert.equal(hasherWorkerCount(), 1);
    assert.equal(exiftoolProcs(), 1);
  });
  await withLimits({ maxCpuThreads: 2 }, () => {
    assert.ok(hasherWorkerCount() <= 2);
    assert.ok(exiftoolProcs() <= 2);
  });
  await withLimits({ maxCpuThreads: cores }, () => {
    // Today's formulas are kept: at most 4 hash workers and 2 to 6 exiftool processes.
    assert.equal(hasherWorkerCount(), Math.max(1, Math.min(4, Math.floor(cores / 2))));
    assert.equal(exiftoolProcs(), Math.min(cores, Math.max(2, Math.min(6, Math.floor(cores / 2)))));
  });
  assert.equal(devicesCpuWorkers, cpuWorkers, 'one helper everywhere');
});
test('queued hash chunks, read buffers and the metadata cache scale with the memory budget', async () => {
  await withLimits({ memoryLimitMB: 2048 }, () => {
    assert.equal(pendingChunks(), 4);
    assert.equal(routingCacheLimit(), 500_000);
  });
  await withLimits({ memoryLimitMB: 512 }, async () => {
    assert.equal(pendingChunks(), 1, 'but never below one, so a hash still progresses');
    assert.equal(routingCacheLimit(), 125_000);
    let seen = 0;
    const hdd = new DeviceStreams(async () => 'hdd'); await hdd.kind(os.tmpdir());
    await hdd.run([os.tmpdir()], async chunk => { seen = chunk; });
    assert.equal(seen, 2 * MB, 'the 8 MiB spinning-disk read shrinks to 1/256 of the budget');
    assert.ok(seen < CHUNK.hdd);
  });
  await withLimits({ memoryLimitMB: 2048 }, async () => {
    let seen = 0;
    const hdd = new DeviceStreams(async () => 'hdd'); await hdd.kind(os.tmpdir());
    await hdd.run([os.tmpdir()], async chunk => { seen = chunk; });
    assert.equal(seen, CHUNK.hdd, 'default budget leaves the tuned chunk alone');
  });
});
test('streams are admitted through the memory governor: held above 90%, released below, never cancelled', async t => {
  const usage = { mb: 950 };
  const gate = new MemoryGovernor({ usage: () => usage.mb * MB, limit: () => 1000 * MB });
  gate.check();
  const streams = new DeviceStreams(async () => 'ssd', gate);
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'governed-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const file = path.join(base, 'a.bin');
  let release!: () => void;
  const first = streams.run([file], () => new Promise<void>(resolve => { release = resolve; }));
  await new Promise(resolve => setTimeout(resolve, 20));
  let second = false;
  const waiting = streams.run([file], async () => { second = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(second, false, 'the second file waits for memory');
  usage.mb = 600; gate.check();
  await waiting;
  assert.equal(second, true);
  release(); await first;
});
test('the libuv pool follows the saved thread limit (twice it, 4 to 16) and never exceeds the pool ceiling', () => {
  const env: NodeJS.ProcessEnv = {};
  raiseThreadpool(env, 5);
  assert.equal(env.UV_THREADPOOL_SIZE, String(uvThreadpoolSize(5)));
  const low: NodeJS.ProcessEnv = {};
  raiseThreadpool(low, 1);
  assert.equal(low.UV_THREADPOOL_SIZE, '4');
  const outer: NodeJS.ProcessEnv = { UV_THREADPOOL_SIZE: '8' };
  raiseThreadpool(outer, 5);
  assert.equal(outer.UV_THREADPOOL_SIZE, '10', 'the limit decides, not whatever the environment guessed');
  const fallback: NodeJS.ProcessEnv = {};
  raiseThreadpool(fallback);
  assert.equal(fallback.UV_THREADPOOL_SIZE, String(THREADPOOL_SIZE), 'without saved settings the old size stays');
});
