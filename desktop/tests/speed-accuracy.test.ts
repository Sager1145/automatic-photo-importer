import assert from 'node:assert/strict';
import test from 'node:test';
import { EtaTracker, RateMeter, stampEstimates } from '../eta';
import type { AppState, Job, Progress } from '../shared';

const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/b'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout: 'flat', videoBasePath: 'videobackup', videoTemplate: '', allowFolderSource: false, unknownRules: {} };
const card = { id: 'card', name: 'Card', path: '/Volumes/CARD', transport: 'storage' as const, selected: true, total: 128e9, free: 40e9 };
const MB = 1e6;

interface Scenario { files: number; size: number; bw: number; pre: number; post: number; workers: number; phase: 'copying' | 'verifying'; }
/** A millisecond simulation of a transfer: workers spend `pre` ms opening a file, stream its bytes at a shared bandwidth, then `post` ms syncing it.
 * The real tracker stamps the speed on every progress report (throttled to 250 ms) and on a 5 s timer, as the main process does. */
function simulate(sc: Scenario) {
  const tracker = new EtaTracker(), chunk = 1 << 20;
  const run = { bytes: 0, completed: 0, verifiedBytes: 0, hashedBytes: 0 };
  const job: Job = { id: 'j', source: card, phase: sc.phase, errors: [], backup: false };
  const state: AppState = { preferences, sources: [card], jobs: [job], history: [], platform: 'darwin' };
  tracker.plan('j', { kind: 'import', verify: true, totals: { copying: { files: sc.files, bytes: sc.files * sc.size }, verifying: { files: sc.files, bytes: sc.files * sc.size } } });
  const total = sc.files * sc.size;
  let now = 0, lastEmit = -Infinity, nextTimer = 5000, nextActivity = 1050;
  const truth: number[] = [];
  let streamed = 0;
  const samples: { t: number; speed: number; fileRate?: number }[] = [];
  const emit = () => {
    if (!job.progress) return;
    stampEstimates(state, tracker, 1e9 + now);
    samples.push({ t: now, speed: job.progress.speed, ...(job.progress.fileRate !== undefined ? { fileRate: job.progress.fileRate } : {}) });
  };
  const progress = () => {
    job.progress = { phase: sc.phase, completed: run.completed, total: sc.files, bytes: run.bytes, totalBytes: total, speed: sc.phase === 'copying' ? run.bytes / Math.max(now / 1000, 0.001) : 0, file: 'f',
      work: sc.phase === 'copying' ? { files: run.completed, bytes: run.bytes, totalFiles: sc.files, totalBytes: total } : { files: run.completed, bytes: run.verifiedBytes, totalFiles: sc.files, totalBytes: total },
      ...(sc.phase === 'verifying' ? { hashedBytes: run.hashedBytes } : {}) } as Progress;
    if (now - lastEmit > 250) { lastEmit = now; emit(); }
  };
  type Worker = { stage: 'pre' | 'data' | 'post'; left: number; pending: number };
  const workers: (Worker | undefined)[] = Array.from({ length: sc.workers }, () => undefined);
  let next = 0, done = 0;
  while (done < sc.files) {
    for (let k = 0; k < workers.length; k++) if (!workers[k] && next < sc.files) { next++; workers[k] = { stage: 'pre', left: sc.pre, pending: 0 }; }
    const streaming = workers.filter(w => w?.stage === 'data').length;
    for (let k = 0; k < workers.length; k++) {
      const w = workers[k];
      if (!w) continue;
      if (w.stage === 'pre') { if (--w.left <= 0) { w.stage = 'data'; w.left = sc.size; } continue; }
      if (w.stage === 'data') {
        const d = Math.min(w.left, sc.bw / streaming);
        w.left -= d; w.pending += d; streamed += d;
        if (w.pending >= chunk || w.left <= 0) {
          const n = w.pending; w.pending = 0;
          if (sc.phase === 'copying') run.bytes += n; else run.hashedBytes += n;
          progress();
        }
        if (w.left <= 0) { w.stage = 'post'; w.left = sc.post; }
        continue;
      }
      if (--w.left <= 0) { workers[k] = undefined; done++; run.completed++; if (sc.phase === 'verifying') run.verifiedBytes += sc.size; progress(); }
    }
    truth.push(streamed);
    if (now >= nextTimer) { nextTimer += 5000; emit(); }
    if (now >= nextActivity) { nextActivity += 1050; emit(); }
    now++;
  }
  const end = now, at = (t: number) => truth[Math.max(0, Math.min(truth.length - 1, Math.round(t)))]!;
  const settled = samples.filter(s => s.t >= 5000 && s.t <= end - 1000);
  const within = settled.filter(s => { const real = (at(s.t) - at(s.t - 5000)) / 5; return real > 0 && Math.abs(s.speed - real) / real <= 0.1; }).length / settled.length;
  return { samples, settled, within, seconds: end / 1000 };
}

const scenarios: [string, Scenario][] = [
  ['copy 5,000 x 200 KB', { files: 5000, size: 200e3, bw: 100 * MB / 1000, pre: 5, post: 20, workers: 4, phase: 'copying' }],
  ['copy 20 x 2 GB', { files: 20, size: 2e9, bw: 100 * MB / 1000, pre: 5, post: 20, workers: 4, phase: 'copying' }],
];
for (const [name, scenario] of scenarios) {
  test(`${name}: after 5 s, at least 90% of the shown speeds are within 10% of the true 5 s rate`, () => {
    const result = simulate(scenario);
    assert.ok(result.settled.length >= 3, `${result.settled.length} samples`);
    assert.ok(result.within >= 0.9, `${name}: ${(result.within * 100).toFixed(0)}% within 10%`);
  });
}

test('the speed window follows a steady rate, shows nothing for its first 2 s and falls to zero within 5 s of a stall', () => {
  const meter = new RateMeter();
  assert.equal(meter.next(0, 0), undefined);
  assert.equal(meter.next(100e6, 1000), undefined, 'under 2 s of history');
  assert.equal(meter.next(300e6, 3000), 100e6, 'exactly the average over the first 3 s');
  for (let t = 4; t <= 12; t++) meter.next(t * 100e6, t * 1000);
  assert.equal(meter.next(1200e6, 17000), 0, 'a 5 s stall reads zero');
  assert.equal(meter.next(500e6, 18000), undefined, 'a total that goes down starts a new measure');
});

test('a copy shows no speed until its window holds 2 s, and never the lifetime average from before the data moved', () => {
  const tracker = new EtaTracker();
  const job: Job = { id: 'j', source: card, phase: 'copying', errors: [], backup: false };
  const state: AppState = { preferences, sources: [card], jobs: [job], history: [], platform: 'darwin' };
  // The run's clock started 10 minutes ago (a long check of existing files); the transfer reports that lifetime average.
  const report = (seconds: number, bytes: number) => { job.progress = { phase: 'copying', completed: 1, total: 100, bytes, totalBytes: 1e9, speed: bytes / 600, file: 'f' }; stampEstimates(state, tracker, 1e9 + seconds * 1000); };
  report(0, 0);
  report(1, 100e6);
  assert.equal(job.progress!.speed, 0);
  report(3, 300e6);
  assert.equal(job.progress!.speed, 100e6);
});
