import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { plan as planDestinations, execute, configureOrganizationRecovery } from '../core/index';
import { EtaTracker, RateMeter, stampEstimates } from '../eta';
import type { AppState, Job, Metadata, Progress } from '../shared';

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
  ['verify 5,000 x 200 KB', { files: 5000, size: 200e3, bw: 400 * MB / 1000, pre: 0, post: 10, workers: 4, phase: 'verifying' }],
  ['verify 40 x 1 GB', { files: 40, size: 1e9, bw: 400 * MB / 1000, pre: 0, post: 10, workers: 4, phase: 'verifying' }],
];
for (const [name, scenario] of scenarios) {
  test(`${name}: after 5 s, at least 90% of the shown speeds are within 10% of the true 5 s rate`, () => {
    const result = simulate(scenario);
    assert.ok(result.settled.length >= 3, `${result.settled.length} samples`);
    assert.ok(result.within >= 0.9, `${name}: ${(result.within * 100).toFixed(0)}% within 10%`);
  });
}

test('small-file steps show files per second together with MB/s', () => {
  const result = simulate({ files: 5000, size: 200e3, bw: 100 * MB / 1000, pre: 5, post: 20, workers: 4, phase: 'copying' });
  assert.ok(result.settled.every(s => s.speed > 0 && s.fileRate !== undefined && s.fileRate > 0), 'both rates on every settled sample');
  const last = result.settled.at(-1)!;
  const average = 5000 / result.seconds;
  assert.ok(Math.abs(last.fileRate! - average) / average < 0.15, `files/s ${last.fileRate} against an average of ${average}`);
});

test('metadata checking shows files per second and never MB/s', () => {
  const tracker = new EtaTracker();
  const job: Job = { id: 'j', source: card, phase: 'verifying', errors: [], backup: false };
  const state: AppState = { preferences, sources: [card], jobs: [job], history: [], platform: 'darwin' };
  for (let t = 0; t <= 10; t++) {
    job.progress = { phase: 'planning', step: 'checking', completed: t * 40, total: 1000, bytes: t * 400e6, totalBytes: 10e9, speed: 0, file: 'f' };
    stampEstimates(state, tracker, 1e9 + t * 1000);
  }
  assert.equal(job.progress!.speed, 0);
  assert.ok(Math.abs(job.progress!.fileRate! - 40) < 1, `${job.progress!.fileRate}`);
});

test('the overview Transfer speed and the Total line show the same rates, and planning adds no MB/s', async () => {
  const { ImportDashboard, combinedSpeed } = await import('../renderer/RootApp');
  const { createTranslator, I18nProvider, languages } = await import('../renderer/i18n');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const other = { id: 'b', name: 'Other', path: '/Volumes/OTHER', transport: 'storage' as const, selected: true, total: 128e9, free: 40e9 };
  const copying: Job = { id: 'j', source: card, phase: 'copying', errors: [], backup: false, startedAt: new Date().toISOString(), eta: 480, progress: { phase: 'copying', completed: 50, total: 200, bytes: 1e9, totalBytes: 8e9, speed: 12.4e6, fileRate: 30, file: 'a', eta: 480 } };
  const planning: Job = { id: 'k', source: other, phase: 'verifying', errors: [], backup: false, startedAt: new Date().toISOString(), progress: { phase: 'planning', step: 'comparing', completed: 1, total: 10, bytes: 5e8, totalBytes: 0, speed: 50e6, fileRate: 7, file: 'a' } };
  assert.deepEqual(combinedSpeed([copying, planning]), { speed: 12.4e6, fileRate: 30 }, 'planning adds neither');
  const checking: Job = { ...planning, progress: { ...planning.progress!, step: 'checking', speed: 0, fileRate: 42 } };
  assert.deepEqual(combinedSpeed([checking]), { speed: 0, fileRate: 42 }, 'checking alone shows its files/s');
  for (const language of languages) {
    const t = createTranslator(language);
    const page = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(ImportDashboard, { state: { preferences, sources: [card, other], jobs: [copying, planning], history: [], platform: 'darwin' }, act: () => {} }) }));
    const metric = page.slice(page.indexOf(`${t('Transfer speed')}</dt>`), page.indexOf('</dd>', page.indexOf(`${t('Transfer speed')}</dt>`)));
    const total = page.slice(page.indexOf('data-testid="total-progress"'));
    assert.ok(metric.includes('12.4 MB/s'), `${language}: overview ${metric}`);
    assert.ok(total.includes('12.4 MB/s') && total.includes(t('{count} files/s', { count: '30' })), `${language}: total line`);
    assert.ok(!page.includes('50.0 MB/s'), `${language}: planning read speed is not counted`);
  }
});

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

test('the verify rate is labelled "Verify read" in every language, and copy rates are not', async () => {
  const { ProgressDisplay } = await import('../renderer/RootApp');
  const { createTranslator, I18nProvider, languages } = await import('../renderer/i18n');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  for (const language of languages) {
    const t = createTranslator(language);
    const render = (speed: object) => renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(ProgressDisplay, { label: 'x', speed: { speed: 123e6, ...speed } as never }) }));
    assert.ok(render({ phase: 'verifying' }).includes(`${t('Verify read')} 123 MB/s`), `${language}: verify label`);
    assert.ok(!render({ phase: 'copying' }).includes(t('Verify read')), `${language}: copy has no label`);
    assert.notEqual(t('Verify read'), language === 'en' ? '' : 'Verify read', `${language}: translated`);
  }
});

test('verification reports the bytes it hashed as it reads, so a large file moves the verify speed before it is published', async t => {
  configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'photo-speed-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'), root = path.join(base, 'destination');
  await fs.mkdir(source); await fs.mkdir(root);
  const size = 6 * 1024 * 1024;
  await fs.writeFile(path.join(source, 'DSC0001.ARW'), Buffer.alloc(size, 7));
  const metadata = async (): Promise<Metadata> => ({ camera: 'Sony A7', date: '2024-02-03T12:00:00Z', fields: {} });
  const planned = (await planDestinations(source, [root], { backup: false, template: '{year}/{yyyymm}/{camera}', layout: 'format', unknownRules: {} }, metadata)).plans[0]!;
  const seen: Progress[] = [];
  const result = await execute(planned, undefined, progress => seen.push({ ...progress }));
  assert.deepEqual(result.errors, []);
  const verifying = seen.filter(progress => progress.phase === 'verifying');
  assert.ok(verifying.every(progress => progress.hashedBytes !== undefined), 'every verifying report carries hashedBytes');
  assert.ok(seen.filter(progress => progress.phase === 'copying').every(progress => progress.hashedBytes === undefined), 'copying reports do not');
  const steps = new Set(verifying.map(progress => progress.hashedBytes!));
  assert.ok(steps.size > 2, `hashed bytes grow in several steps while the file is read: ${[...steps]}`);
  assert.ok(Math.max(...steps) >= size, 'at least the staged copy was read');
  assert.ok(verifying.every((progress, index) => index === 0 || progress.hashedBytes! >= verifying[index - 1]!.hashedBytes!), 'never decreases');
});
