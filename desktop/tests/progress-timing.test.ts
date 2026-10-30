import { freshOrganizeOptions } from '../run-policy';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator, formatSpeed, I18nProvider, languages, speedUnit } from '../renderer/i18n';
import { EtaTracker, stampEstimates } from '../eta';
import { RateMeter } from '../rate-meter';
import type { AppState, Job, Progress } from '../shared';
import { defaultPreferences } from '../preferences';

const preferences: AppState['preferences'] = { ...defaultPreferences, language:'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/b'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout: 'flat', videoBasePath: 'videobackup', videoTemplate: '', unknownRules: {} };
const card = { id: 'card', name: 'Card', path: '/Volumes/CARD', transport: 'storage' as const, selected: true, total: 128e9, free: 40e9 };
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test('speeds pick B/s, KB/s, MB/s or GB/s with 3 significant digits', () => {
  assert.equal(formatSpeed(0), '0 B/s');
  assert.equal(formatSpeed(999), '999 B/s');
  assert.equal(formatSpeed(1000), '1.00 KB/s');
  assert.equal(formatSpeed(850e3), '850 KB/s');
  assert.equal(formatSpeed(999.4e3), '999 KB/s');
  assert.equal(formatSpeed(999.6e3), '1.00 MB/s', 'rounding up to 1000 moves to the next unit');
  assert.equal(formatSpeed(12.44e6), '12.4 MB/s');
  assert.equal(formatSpeed(1.234e9), '1.23 GB/s');
  assert.equal(formatSpeed(4.2e12), '4,200 GB/s', 'GB/s is the largest unit');
  assert.equal(formatSpeed(12.4e6, 'ja'), '12.4 MB/s');
  for (const unknown of [undefined, Number.NaN, -5, Number.POSITIVE_INFINITY]) assert.equal(formatSpeed(unknown), '—', `unknown ${unknown}`);
});

test('the speed unit holds near a boundary instead of flickering', () => {
  assert.equal(speedUnit(1.02e6), 2);
  assert.equal(speedUnit(980e3, 2), 2, 'just under 1 MB/s stays in MB/s');
  assert.equal(formatSpeed(980e3, 'en', speedUnit(980e3, 2)), '0.980 MB/s');
  assert.equal(speedUnit(880e3, 2), 1, 'well under the boundary it drops to KB/s');
  assert.equal(speedUnit(1.001e6, 1), 2, 'going up switches at the boundary');
  assert.equal(speedUnit(0, 3), 0);
  assert.equal(speedUnit(Number.NaN, 2), 2, 'an unknown speed keeps the shown unit');
});

test('rates settle on the measured speed and fall during a stall', () => {
  const meter = new RateMeter();
  assert.equal(meter.next(0, 0), undefined);
  let rate: number | undefined;
  for (let t = 1; t <= 20; t++) rate = meter.next(t * 50e6, t * 500);
  assert.ok(rate! > 95e6 && rate! < 105e6, `settled ${rate}`);
  for (let t = 21; t <= 40; t++) rate = meter.next(20 * 50e6, t * 500);
  assert.ok(rate! < 20e6, `stalled ${rate}`);
  assert.equal(meter.next(0, 30000), undefined, 'a restart measures afresh');
});

test('planning steps, the review and scans get a start time and a read speed', () => {
  const tracker = new EtaTracker();
  const job: Job = { id: 'j', source: card, phase: 'verifying', errors: [], backup: false, progress: { phase: 'planning', step: 'comparing', completed: 0, total: 100, bytes: 0, totalBytes: 0, speed: 0, file: '' } };
  const state: AppState = { preferences, sources: [card], jobs: [job], history: [], platform: 'darwin', organizeOptions: freshOrganizeOptions(), reviewProgress: { phase: 'planning', step: 'reading', completed: 0, total: 10, bytes: 0, totalBytes: 1e9, speed: 0, file: '' }, scanProgress: { card: { files: 0, bytes: 0 } } };
  for (let t = 0; t <= 10; t++) {
    job.progress = { ...job.progress!, completed: t * 5, bytes: t * 20e6, speed: 0 };
    state.reviewProgress = { ...state.reviewProgress!, completed: t, bytes: t * 30e6, speed: 0 };
    state.scanProgress!.card = { files: t * 10, bytes: t * 1e6 };
    stampEstimates(state, tracker, 1_000_000 + t * 1000);
  }
  assert.ok(job.progress!.speed > 18e6 && job.progress!.speed < 22e6, `comparing ${job.progress!.speed}`);
  assert.ok(state.reviewProgress!.speed > 27e6 && state.reviewProgress!.speed < 33e6, `review reading ${state.reviewProgress!.speed}`);
  assert.equal(state.reviewProgress!.startedAt, new Date(1_000_000).toISOString(), 'the review keeps its first start time');
  assert.equal(state.scanProgress!.card!.startedAt, new Date(1_000_000).toISOString());
  job.progress = { ...job.progress!, step: 'checking', completed: 0, bytes: 0, speed: 0 };
  for (let t = 11; t <= 20; t++) { job.progress = { ...job.progress, completed: (t - 10) * 40 }; stampEstimates(state, tracker, 1_000_000 + t * 1000); }
  assert.ok(job.progress.fileRate! > 36 && job.progress.fileRate! < 44, `checking ${job.progress.fileRate} files/s`);
  assert.equal(job.progress.speed, 0, 'metadata checking reports files per second, not bytes');
  delete state.reviewProgress; stampEstimates(state, tracker, 1_100_000);
  state.reviewProgress = { phase: 'planning', step: 'listing', completed: 1, total: 0, bytes: 0, totalBytes: 0, speed: 0, file: '' }; stampEstimates(state, tracker, 1_200_000);
  assert.equal(state.reviewProgress.startedAt, new Date(1_200_000).toISOString(), 'a new review starts its own clock');
});

test('every progress display shows elapsed time and time left together, and the read speed', async context => {
  // Elapsed time is read from the clock at render: frozen, a busy machine cannot push 12:03 past 12:04.
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { ImportDesk, ImportDashboard, PlanningProgress, ScanProgress } = await import('../renderer/RootApp');
  const { OrganizationProgress, formatRemaining } = await import('../renderer/progress');
  for (const language of languages) {
    const t = createTranslator(language), render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language, children: child }));
    const together = (page: string, eta: string, where: string) => {
      const start = page.indexOf('data-testid="timing"'), timing = start < 0 ? '' : page.slice(start, page.indexOf('</em></span>', start));
      assert.ok(timing.includes(t('{time} elapsed', { time: '12:03' })) || timing.includes(t('{time} elapsed', { time: '12:04' })), `${language} ${where}: elapsed`);
      assert.ok(timing.includes(eta), `${language} ${where}: time left next to elapsed`);
      assert.ok(timing.includes(' · '), `${language} ${where}: separated by a dot`);
    };
    const left = (seconds: number) => t('{time} left', { time: formatRemaining(seconds, t) });
    const desk = (job: Job) => render(createElement(ImportDesk, { state: { preferences, sources: [card], jobs: [job], history: [], platform: 'darwin', organizeOptions: freshOrganizeOptions() }, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }));
    const base: Job = { id: 'j', source: card, phase: 'copying', errors: [], backup: false, startedAt: ago(723_000), eta: 480, progress: { phase: 'copying', completed: 50, total: 200, bytes: 1e9, totalBytes: 8e9, speed: 12.44e6, file: 'a', eta: 480 } };
    const copying = desk(base);
    together(copying, left(480), 'source card');
    assert.ok(copying.includes('12.4 MB/s'), `${language}: copy speed`);
    const comparing = desk({ ...base, phase: 'verifying', progress: { phase: 'planning', step: 'comparing', completed: 10, total: 100, bytes: 5e8, totalBytes: 0, speed: 850e3, file: 'a', eta: 480 } });
    together(comparing, left(480), 'comparing');
    assert.ok(comparing.includes('850 KB/s'), `${language}: comparing read speed`);
    const checking = desk({ ...base, phase: 'verifying', progress: { phase: 'planning', step: 'checking', completed: 10, total: 100, bytes: 1, totalBytes: 4, speed: 0, fileRate: 42.3, file: 'a', eta: 480 } });
    assert.ok(checking.includes(t('{count} files/s', { count: '42.3' })), `${language}: metadata check rate`);
    const verifying = desk({ ...base, progress: { phase: 'verifying', completed: 10, total: 100, bytes: 8e9, totalBytes: 8e9, speed: 1.234e9, file: 'a', eta: 480 } });
    assert.ok(verifying.includes('1.23 GB/s'), `${language}: verify speed`);
    const estimating = desk({ ...base, eta: undefined, progress: { ...base.progress!, eta: undefined } });
    together(estimating, t('Estimating time left…'), 'estimating');

    const dashboard = render(createElement(ImportDashboard, { state: { preferences, sources: [card], jobs: [base], history: [], platform: 'darwin', organizeOptions: freshOrganizeOptions(), etaTotal: { eta: 480 } }, act: () => {} }));
    const total = dashboard.slice(dashboard.indexOf('data-testid="total-progress"'));
    together(total, left(480), 'dashboard total');
    assert.match(total, /data-testid="total-eta"/);
    assert.ok(dashboard.includes('12.4 MB/s'), `${language}: dashboard speed`);

    const organization: Job = { id: 'o', source: { id: 'l', name: 'Library', path: '/b', transport: 'folder' }, phase: 'verifying', organization: true, errors: [], backup: false, startedAt: ago(723_000), eta: 300, progress: { phase: 'planning', step: 'reading', completed: 3, total: 10, bytes: 3e8, totalBytes: 1e9, speed: 25.5e6, file: 'x', eta: 300 } };
    const organizing = render(createElement(OrganizationProgress, { job: organization }));
    together(organizing, left(300), 'organization card');
    assert.ok(organizing.includes('25.5 MB/s'), `${language}: organization read speed`);

    const review: Progress = { phase: 'planning', step: 'reading', completed: 3, total: 10, bytes: 3e8, totalBytes: 1e9, speed: 25.5e6, file: 'x', eta: 480, startedAt: ago(723_000) };
    const reviewing = render(createElement(PlanningProgress, { progress: review, label: 'Review progress' }));
    together(reviewing, left(480), 'review bar');
    assert.ok(reviewing.includes('25.5 MB/s'), `${language}: review read speed`);
    const reviewChecking = render(createElement(PlanningProgress, { progress: { ...review, step: 'checking', speed: 0, fileRate: 120 }, label: 'Review progress' }));
    assert.ok(reviewChecking.includes(t('{count} files/s', { count: '120' })), `${language}: review check rate`);

    const scanning = render(createElement(ScanProgress, { sourceName: 'Card', cameraInfo: { status: 'reading', hints: [], models: [], checked: 10, total: 100, unknown: 0, eta: 480, startedAt: ago(723_000), fileRate: 8.5 } }));
    together(scanning, left(480), 'scan');
    assert.ok(scanning.includes(t('{count} files/s', { count: '8.5' })), `${language}: metadata read rate`);
    const listing = render(createElement(ScanProgress, { sourceName: 'Card', listing: { files: 10, bytes: 1e6, share: 1e-3, eta: 480, startedAt: ago(723_000) } }));
    together(listing, left(480), 'listing');
  }
});
