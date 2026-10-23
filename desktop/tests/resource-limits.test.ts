import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  MB, MemoryGovernor, cpuRange, cpuWorkers, defaultCpuThreads, defaultMemoryLimitMB, memoryRange, resourceLimits, savedLimits,
  scaledByBudget, setResourceLimits, uvThreadpoolSize, type Host,
} from '../resource-limits';
import { normalizePreferences, defaultPreferences } from '../preferences';
import { jobPreferences, lockedPreferenceKeys, acceptedPreferences, settingsLocked } from '../settings-lock';

const mac: Host = { cores: 10, totalMemBytes: 16 * 1024 * MB };
const small: Host = { cores: 4, totalMemBytes: 8 * 1024 * MB };
const tiny: Host = { cores: 1, totalMemBytes: 1024 * MB };

test('defaults: half the cores and a quarter of memory capped at 2 GB, on a 10-core 16 GB Mac and a 4-core 8 GB laptop', () => {
  assert.equal(defaultCpuThreads(mac), 5);
  assert.equal(defaultMemoryLimitMB(mac), 2048);
  assert.equal(defaultCpuThreads(small), 2);
  assert.equal(defaultMemoryLimitMB(small), 2048);
  assert.equal(defaultMemoryLimitMB({ cores: 4, totalMemBytes: 4 * 1024 * MB }), 1024);
  assert.equal(defaultMemoryLimitMB({ cores: 4, totalMemBytes: 6 * 1024 * MB }) % 256, 0, 'rounded to 256 MB');
});
test('ranges: 1 to all cores, 512 MB to 75% of memory; defaults always inside them', () => {
  assert.deepEqual(cpuRange(mac), { min: 1, max: 10 });
  assert.deepEqual(memoryRange(mac), { min: 512, max: 12288 });
  assert.deepEqual(memoryRange(tiny), { min: 512, max: 768 });
  for (const host of [mac, small, tiny]) {
    assert.ok(defaultCpuThreads(host) >= cpuRange(host).min && defaultCpuThreads(host) <= cpuRange(host).max);
    assert.ok(defaultMemoryLimitMB(host) >= memoryRange(host).min && defaultMemoryLimitMB(host) <= memoryRange(host).max);
  }
});
test('setting limits clamps to the host ranges and keeps at least one thread and 512 MB', () => {
  const before = { ...resourceLimits() };
  try {
    setResourceLimits({ maxCpuThreads: 99, memoryLimitMB: 10_000_000 }, mac);
    assert.deepEqual(resourceLimits(), { maxCpuThreads: 10, memoryLimitMB: 12288 });
    setResourceLimits({ maxCpuThreads: -4, memoryLimitMB: 1 }, mac);
    assert.deepEqual(resourceLimits(), { maxCpuThreads: 1, memoryLimitMB: 512 });
    setResourceLimits({ maxCpuThreads: Number.NaN, memoryLimitMB: Number.NaN }, mac);
    assert.deepEqual(resourceLimits(), { maxCpuThreads: 5, memoryLimitMB: 2048 }, 'garbage falls back to the defaults');
  } finally { setResourceLimits(before, mac); }
});
test('cpuWorkers never exceeds maxCpuThreads and is at least one', () => {
  const before = { ...resourceLimits() };
  try {
    setResourceLimits({ maxCpuThreads: 3 }, mac);
    assert.equal(cpuWorkers(8), 3); assert.equal(cpuWorkers(2), 2); assert.equal(cpuWorkers(0), 1);
    setResourceLimits({ maxCpuThreads: 1 }, mac);
    assert.equal(cpuWorkers(6), 1);
  } finally { setResourceLimits(before, mac); }
});
test('the libuv pool is twice the thread limit, between 4 and 16', () => {
  assert.deepEqual([1, 2, 5, 8, 10, 32].map(uvThreadpoolSize), [4, 4, 10, 16, 16, 16]);
});
test('structure sizes scale with the memory budget from their 2 GB design point', () => {
  const before = { ...resourceLimits() };
  try {
    setResourceLimits({ memoryLimitMB: 2048 }, mac);
    assert.equal(scaledByBudget(500_000, 20_000, 1_000_000), 500_000);
    setResourceLimits({ memoryLimitMB: 512 }, mac);
    assert.equal(scaledByBudget(500_000, 20_000, 1_000_000), 125_000);
    assert.equal(scaledByBudget(4, 2, 8), 2, 'never below the floor');
  } finally { setResourceLimits(before, mac); }
});
test('limits are read from the saved settings at startup, synchronously, and fall back to defaults', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'limits-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.deepEqual(savedLimits(dir, mac), { maxCpuThreads: 5, memoryLimitMB: 2048 });
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ preferences: { maxCpuThreads: 8, memoryLimitMB: 1024 } }));
  assert.deepEqual(savedLimits(dir, mac), { maxCpuThreads: 8, memoryLimitMB: 1024 });
  await fs.writeFile(path.join(dir, 'settings.json'), '{not json');
  assert.deepEqual(savedLimits(dir, mac), { maxCpuThreads: 5, memoryLimitMB: 2048 });
});

test('preferences carry both limits, persisted, normalized to the host and defaulted', () => {
  assert.equal(typeof defaultPreferences.maxCpuThreads, 'number');
  assert.equal(typeof defaultPreferences.memoryLimitMB, 'number');
  const saved = normalizePreferences({ maxCpuThreads: 3, memoryLimitMB: 1024 });
  assert.equal(saved.maxCpuThreads, 3); assert.equal(saved.memoryLimitMB, 1024);
  const bad = normalizePreferences({ maxCpuThreads: 'lots', memoryLimitMB: 5 });
  assert.equal(bad.maxCpuThreads, defaultCpuThreads()); assert.equal(bad.memoryLimitMB, 512, 'clamped to the minimum');
  assert.equal(normalizePreferences({ maxCpuThreads: 9999 }).maxCpuThreads, cpuRange().max);
  assert.equal(normalizePreferences({}, saved).maxCpuThreads, 3, 'a missing field keeps the base');
});
test('both limits are job preferences: locked while work runs, applied to the next job', () => {
  assert.ok(jobPreferences.has('maxCpuThreads') && jobPreferences.has('memoryLimitMB'));
  assert.deepEqual(lockedPreferenceKeys({ maxCpuThreads: 2, memoryLimitMB: 1024, language: 'ja' }), ['maxCpuThreads', 'memoryLimitMB']);
  assert.deepEqual(acceptedPreferences({ maxCpuThreads: 2 }, true), {});
  assert.deepEqual(acceptedPreferences({ maxCpuThreads: 2, memoryLimitMB: 1024 }, false), { maxCpuThreads: 2, memoryLimitMB: 1024 });
  assert.equal(settingsLocked({ jobs: [] }), false);
});

function governor(usage: { mb: number }, limitMB = 1000) {
  const warnings: number[] = [];
  const g = new MemoryGovernor({ usage: () => usage.mb * MB, limit: () => limitMB * MB, onWarn: mb => warnings.push(mb) });
  return { g, warnings };
}
test('the governor admits freely below 90% of the limit', async () => {
  const { g } = governor({ mb: 500 });
  g.check();
  assert.equal(g.paused, false);
  assert.equal(await g.govern(async () => 'ok'), 'ok');
});
test('above 90% it holds new work while other work runs, and releases it when usage drops (fake timers)', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const usage = { mb: 500 };
  const { g, warnings } = governor(usage);
  g.start(3000);
  t.after(() => g.stop());
  let release!: () => void;
  const running = g.govern(() => new Promise<void>(resolve => { release = resolve; }));
  usage.mb = 920; t.mock.timers.tick(3000);
  assert.equal(g.paused, true);
  let admitted = false;
  const waiting = g.govern(async () => { admitted = true; });
  await Promise.resolve();
  assert.equal(admitted, false, 'new work waits');
  assert.deepEqual(warnings, [], 'no warning below 100%');
  usage.mb = 700; t.mock.timers.tick(3000);
  assert.equal(g.paused, false);
  await waiting;
  assert.equal(admitted, true, 'resumed');
  release(); await running;
});
test('above 100% it warns once, never cancels work, and never stalls when nothing else runs', async () => {
  const usage = { mb: 1100 };
  const { g, warnings } = governor(usage);
  g.check(); g.check();
  assert.deepEqual(warnings, [1100], 'one warning for the episode');
  assert.equal(g.paused, true);
  assert.equal(await g.govern(async () => 'progress'), 'progress', 'with nothing in flight the next file is admitted, so work cannot deadlock');
  usage.mb = 100; g.check();
  assert.equal(g.paused, false);
  usage.mb = 1200; g.check();
  assert.deepEqual(warnings, [1100, 1200], 'a new episode warns again');
});
test('a stopped job leaves the governor queue at once', async () => {
  const usage = { mb: 950 };
  const { g } = governor(usage);
  g.check();
  let release!: () => void;
  const running = g.govern(() => new Promise<void>(resolve => { release = resolve; }));
  const controller = new AbortController();
  const waiting = g.govern(async () => 'late', controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  release(); await running;
});
import { privateOrRss, childProcessMemory } from '../resource-limits';
test('memory is measured by private bytes, falling back to RSS', () => {
  assert.equal(privateOrRss({ private: 2048 }, 999 * MB), 2048 * 1024);
  assert.equal(privateOrRss({ private: 0 }, 5 * MB), 5 * MB);
  assert.equal(privateOrRss(undefined, 7 * MB), 7 * MB);
});

test('only utility processes count as child memory; the renderer never throttles imports', () => {
  const metrics = [{ type: 'Browser', memory: { workingSetSize: 900 } }, { type: 'Utility', memory: { workingSetSize: 300, privateBytes: 100 } }, { type: 'Utility', memory: { workingSetSize: 50 } }, { type: 'Tab', memory: { workingSetSize: 5000 } }];
  assert.equal(childProcessMemory(metrics), (100 + 50) * 1024);
});
