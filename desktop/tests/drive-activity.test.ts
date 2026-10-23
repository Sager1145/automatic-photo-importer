import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { activityTargets, computeRates, createDriveSampler, parseDiskMap, parseStatistics, startActivityLoop, wholeDisk, wholeDisks, type Counters } from '../platform/drive-activity';
import { DriveActivityMeter, SidebarSources, totalDriveActivity } from '../renderer/RootApp';
import { I18nProvider, languages, createTranslator } from '../renderer/i18n';
import type { AppState, DriveActivity } from '../shared';

// Real `ioreg -c IOBlockStorageDriver -r -w0 -l -a` output from this Mac, reduced to ids, BSD names and statistics.
const a = readFileSync(new URL('./fixtures/ioreg-storage-a.plist', import.meta.url), 'utf8');
const b = readFileSync(new URL('./fixtures/ioreg-storage-b.plist', import.meta.url), 'utf8');

test('partition names map to their whole disk', () => {
  assert.equal(wholeDisk('disk6s2'), 'disk6');
  assert.equal(wholeDisk('disk3s1s1'), 'disk3');
  assert.equal(wholeDisk('disk6'), 'disk6');
  assert.equal(wholeDisk('/dev/disk6'), undefined);
  assert.deepEqual(wholeDisks('disk0+disk5'), ['disk0', 'disk5']);
  assert.deepEqual(wholeDisks('disk6s2'), ['disk6']);
  assert.deepEqual(wholeDisks(undefined), []);
});

test('real ioreg output yields statistics per driver and whole disks from the media children', () => {
  const stats = parseStatistics(a), map = parseDiskMap(a);
  assert.ok(stats.size >= 2);
  const disks = [...map.values()].flat();
  assert.ok(disks.length >= 1);
  for (const disk of disks) assert.match(disk, /^disk\d+$/);
  // Synthesized containers and partitions below a whole disk are not drives of their own.
  for (const names of map.values()) assert.ok(names.length <= 1);
  const [first] = [...stats.values()].filter(counters => counters.readBytes > 0);
  assert.ok(first && first.readNs > 0 && first.readOps > 0);
  assert.deepEqual([...parseStatistics(b).keys()].sort(), [...stats.keys()].sort());
});

test('rates between two real readings are within range', () => {
  const before = parseStatistics(a), after = parseStatistics(b);
  for (const [id, current] of after) {
    const rates = computeRates(before.get(id)!, current, 2);
    assert.ok(rates, 'counters only grow');
    assert.ok(rates.utilization >= 0 && rates.utilization <= 100 && rates.readBps >= 0 && rates.iops >= 0);
  }
});

const zero: Counters = { readBytes: 0, writeBytes: 0, readOps: 0, writeOps: 0, readNs: 0, writeNs: 0 };
test('utilization is busy time over wall time, capped at 100%, with MB/s and IOPS from the deltas', () => {
  const rates = computeRates(zero, { readBytes: 50e6, writeBytes: 20e6, readOps: 300, writeOps: 100, readNs: 0.25e9, writeNs: 0.25e9 }, 2)!;
  assert.deepEqual(rates, { utilization: 25, readBps: 25e6, writeBps: 10e6, iops: 200 });
  assert.equal(computeRates(zero, { ...zero, readNs: 5e9 }, 1)!.utilization, 100);
  assert.equal(computeRates({ ...zero, readBytes: 10 }, zero, 1), undefined);
  assert.equal(computeRates(zero, zero, 0), undefined);
});

test('the sampler needs two readings, keeps a bounded history and reads media only when needed', async () => {
  const calls: boolean[] = [];
  let tick = 0, clock = 0;
  const sampler = createDriveSampler({ historyLength: 3, now: () => clock, run: async media => { calls.push(media); return tick === 0 ? a : b; } });
  const disk = [...parseDiskMap(a).values()].flat()[0]!;
  sampler.setTargets({ vol: [disk] });
  assert.deepEqual(await sampler.sample(), {});
  tick = 1;
  for (let i = 0; i < 5; i++) { clock += 1000; tick = i % 2 ? 0 : 1; await sampler.sample(); }
  const last = (await sampler.sample())['vol'];
  assert.ok(last === undefined || last.history.length <= 3);
  assert.equal(calls.filter(Boolean).length, 1, 'one media listing, the rest are plain');
});

test('targets map sources and destinations to whole disks through their volume', () => {
  const volumes = [{ path: '/', physicalId: 'disk0' }, { path: '/Volumes/A006', physicalId: 'disk6' }, { path: '/Volumes/Pair', physicalId: 'disk4+disk5' }];
  const targets = activityTargets(volumes, [
    { id: 'uuid-1', path: '/Volumes/A006', transport: 'storage' },
    { id: 'f', path: '/Users/me/Pictures', transport: 'folder' },
    { id: 'cam', path: '', transport: 'camera' },
  ], [{ path: '/Volumes/Pair/Backup', available: true, physicalId: 'disk4+disk5' }, { path: '/Volumes/Gone', available: false }]);
  assert.deepEqual(targets, { 'uuid-1': ['disk6'], f: ['disk0'], '/Volumes/Pair/Backup': ['disk4', 'disk5'] });
});

test('the loop publishes only when a shown value changed', async () => {
  const values: Record<string, DriveActivity>[] = [{ x: { utilization: 1, readBps: 0, writeBps: 0, iops: 0, history: [1] } }, { x: { utilization: 1, readBps: 0, writeBps: 0, iops: 0, history: [1] } }, { x: { utilization: 2, readBps: 0, writeBps: 0, iops: 0, history: [1, 2] } }];
  let n = 0; const published: unknown[] = [];
  const loop = startActivityLoop({ sampler: { setTargets() {}, sample: async () => values[Math.min(n++, 2)]! }, wanted: () => true, publish: value => published.push(value), intervals: { fast: 1e9 } });
  await loop.tick(); await loop.tick(); await loop.tick(); loop.stop();
  assert.ok(published.length >= 2 && published.length <= 3);
});

const sample: DriveActivity = { utilization: 37, readBps: 12_400_000, writeBps: 850_000, iops: 210, history: [0, 10, 40, 80, 37] };
const render = (node: Parameters<typeof createElement>[0] extends never ? never : ReturnType<typeof createElement>, language: typeof languages[number] = 'en') => renderToStaticMarkup(createElement(I18nProvider, { language, children: node }));

test('the activity meter shows utilization, speeds and a sparkline, labelled apart from capacity, in every language', () => {
  for (const language of languages) {
    const markup = render(createElement(DriveActivityMeter, { activity: sample }), language);
    const t = createTranslator(language);
    assert.match(markup, /data-testid="drive-activity-percent">37%/);
    assert.match(markup, /aria-valuenow="37"/);
    assert.ok(markup.includes(t('Drive activity')) && markup.includes(t('Read')) && markup.includes(t('Write')));
    assert.ok(markup.includes('MB/s') && markup.includes('KB/s'));
    assert.match(markup, /<polyline/);
    assert.ok(!markup.includes('storage-capacity'));
  }
  assert.equal(render(createElement(DriveActivityMeter, {})), '');
});

test('the sidebar drive row shows the utilization next to the capacity line', () => {
  const state = { preferences: { copyMode: 'single', destinations: [], sourceLayout: 'cards' }, sources: [{ id: 's1', name: 'Card', path: '/Volumes/Card', transport: 'storage', total: 1000, free: 400 }], jobs: [], history: [], platform: 'darwin', driveActivity: { s1: sample } } as unknown as AppState;
  const markup = render(createElement(SidebarSources, { state, onOpen() {} }));
  assert.match(markup, /data-testid="sidebar-activity"/);
  assert.ok(markup.includes('Activity 37%'));
  assert.ok(markup.includes('400') || markup.includes('free'));
});

test('the dashboard total counts drives sharing one disk once and takes the busiest utilization', () => {
  const other: DriveActivity = { ...sample, utilization: 80, readBps: 1000, history: [80] };
  const state = { driveActivity: { a: sample, b: { ...sample }, c: other } } as unknown as AppState;
  assert.deepEqual(totalDriveActivity(state, ['a', 'b', 'c']), { utilization: 80, readBps: sample.readBps + 1000, writeBps: sample.writeBps + other.writeBps, count: 2 });
  assert.equal(totalDriveActivity(state, ['zzz']), undefined);
});

test('the loop stops entirely while hidden and idle, and resumes on wake', async () => {
  let wanted = false, samples = 0;
  const scheduled: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const timers = {
    set: (fn: () => void, ms: number) => { const entry = { fn: () => { entry.cleared = true; fn(); }, ms, cleared: false }; scheduled.push(entry); return entry as unknown as ReturnType<typeof setTimeout>; },
    clear: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true; },
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const loop = startActivityLoop({ sampler: { setTargets() {}, sample: async () => { samples++; return {}; } }, wanted: () => wanted, publish() {}, timers });
  await flush();
  assert.equal(samples, 0, 'no sampling at all while hidden and idle');
  assert.equal(scheduled.filter(entry => !entry.cleared).length, 0, 'no timer is left pending');
  wanted = true; loop.wake(); loop.wake();
  await flush();
  assert.equal(samples, 1, 'wake resumes sampling once');
  const next = scheduled.filter(entry => !entry.cleared);
  assert.equal(next.length, 1); assert.equal(next[0]!.ms, 1000);
  next[0]!.fn(); await flush();
  assert.equal(samples, 2);
  wanted = false;
  scheduled.filter(entry => !entry.cleared)[0]!.fn(); await flush();
  assert.equal(samples, 2, 'hidden again: the tick that finds nothing wanted does not sample or reschedule');
  assert.equal(scheduled.filter(entry => !entry.cleared).length, 0);
  wanted = true; loop.wake(); await flush();
  assert.equal(samples, 3);
  loop.stop(); loop.wake(); await flush();
  assert.equal(samples, 3, 'stopped loops stay stopped');
});

test('the costly media listing backs off exponentially, up to 5 minutes, while a wanted disk never maps', async () => {
  const media: number[] = [];
  let clock = 0;
  const sampler = createDriveSampler({ now: () => clock, mediaRetryMs: 10000, run: async withMedia => { if (withMedia) media.push(clock); return withMedia ? a : a; } });
  sampler.setTargets({ ghost: ['disk99'] });
  for (; clock <= 1_500_000; clock += 5000) await sampler.sample();
  const gaps = media.slice(1).map((at, index) => at - media[index]!);
  assert.deepEqual(gaps.slice(0, 4), [20000, 40000, 80000, 160000]);
  assert.ok(gaps.slice(4).every(gap => gap === 300000), 'capped at 5 minutes');
  // A newly wanted disk is looked for without waiting out the backoff.
  const known = [...parseDiskMap(a).values()].flat()[0]!;
  const before = media.length; clock += 1000;
  sampler.setTargets({ ghost: ['disk99'], real: [known] });
  await sampler.sample();
  assert.equal(media.length, before + 1);
});
