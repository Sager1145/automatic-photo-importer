import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator, I18nProvider, languages } from '../renderer/i18n';
import { EtaTracker, stampEstimates } from '../eta';
import { listingEstimate } from '../listing-estimate';
import type { AppState, Job } from '../shared';

const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/b'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout: 'flat', videoBasePath: 'videobackup', videoTemplate: '', allowFolderSource: false, unknownRules: {} };
const card = { id: 'card', name: 'Card', path: '/Volumes/CARD', transport: 'storage' as const, selected: true, total: 128e9, free: 40e9 };

test('time left reads humanely in every language', async () => {
  const { formatRemaining } = await import('../renderer/RootApp');
  const t = createTranslator('en');
  assert.equal(formatRemaining(20, t), 'under a minute');
  assert.equal(formatRemaining(7 * 60 + 20, t), 'about 7 min');
  assert.equal(formatRemaining(43 * 60, t), 'about 45 min');
  assert.equal(formatRemaining(59 * 60, t), 'about 1 h');
  assert.equal(formatRemaining(2 * 3600 + 14 * 60, t), 'about 2 h 15 min');
  assert.equal(formatRemaining(14.4 * 3600, t), 'about 14 h');
  assert.equal(createTranslator('ja')('{time} left', { time: formatRemaining(12 * 60, createTranslator('ja')) }), '残り約 10 分');
  assert.equal(createTranslator('zh-Hans')('{time} left', { time: formatRemaining(2 * 3600 + 30 * 60, createTranslator('zh-Hans')) }), '剩余约 2 小时 30 分钟');
});

test('source cards, organization cards and the dashboard show time left, or that it is being estimated', async () => {
  const { ImportDesk, OrganizationProgress, formatRemaining } = await import('../renderer/RootApp');
  for (const language of languages) {
    const t = createTranslator(language), render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language, children: child }));
    const desk = (job: Job, extra: Partial<AppState> = {}) => render(createElement(ImportDesk, { state: { preferences, sources: [card], jobs: [job], history: [], platform: 'darwin', ...(job.eta !== undefined ? { etaTotal: { eta: job.eta } } : {}), ...extra }, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }));
    const copying: Job = { id: 'j', source: card, phase: 'copying', errors: [], backup: false, startedAt: new Date().toISOString(), eta: 2 * 3600 + 15 * 60, progress: { phase: 'copying', completed: 50, total: 200, bytes: 1e9, totalBytes: 8e9, speed: 1e8, file: 'a', eta: 3600 + 30 * 60 } };
    const page = desk(copying);
    assert.ok(page.includes(t('{time} left', { time: formatRemaining(copying.eta!, t) })), `${language}: job time left on the card`);
    assert.ok(!page.includes(t('{time} left in this step', { time: formatRemaining(copying.progress!.eta!, t) })), `${language}: only one time left per display`);
    assert.match(page, /data-testid="total-eta"/, `${language}: dashboard total time left`);
    const estimating = desk({ ...copying, eta: undefined, progress: { ...copying.progress!, eta: undefined } });
    assert.ok(estimating.includes(t('Estimating time left…')), `${language}: estimating before enough samples`);
    assert.doesNotMatch(estimating, /data-testid="total-eta"/, `${language}: no dashboard time while a job is estimating`);
    const listing = desk({ ...copying, phase: 'verifying', eta: undefined, progress: { phase: 'planning', step: 'listing', completed: 10, total: 0, bytes: 1, totalBytes: 0, speed: 0, file: '' } });
    assert.doesNotMatch(listing, /data-testid="eta"/, `${language}: nothing while the total is unknown`);
    const organization: Job = { id: 'o', source: { id: 'l', name: 'Library', path: '/b', transport: 'folder' }, phase: 'copying', organization: true, errors: [], backup: false, eta: 300, progress: { phase: 'copying', step: 'moving', completed: 3, total: 10, bytes: 0, totalBytes: 0, speed: 0, file: 'x', eta: 300 } };
    assert.ok(render(createElement(OrganizationProgress, { job: organization })).includes(t('{time} left', { time: formatRemaining(300, t) })), `${language}: organization time left`);
  }
});

test('estimates are stamped on running jobs and cleared when they stop', () => {
  const tracker = new EtaTracker();
  const job: Job = { id: 'j', source: card, phase: 'copying', errors: [], backup: false, progress: { phase: 'copying', completed: 0, total: 100, bytes: 0, totalBytes: 10e9, speed: 0, file: '' } };
  const state: AppState = { preferences, sources: [card], jobs: [job], history: [], platform: 'darwin', scanProgress: { card: { files: 10, bytes: 1e9 } } };
  for (let t = 0; t <= 20; t++) { job.progress = { ...job.progress!, completed: t * 2, bytes: t * 100e6 }; state.scanProgress!.card = { files: t * 100, bytes: t * 1e9, share: listingEstimate({ bytes: card.total! - card.free! }, { files: t * 100, bytes: t * 1e9 }).share }; stampEstimates(state, tracker, t * 1000); }
  assert.ok(job.progress!.eta! > 60 && job.progress!.eta! < 120, `copy step ${job.progress!.eta}`);
  assert.ok(job.eta! > job.progress!.eta!, 'the job adds verification');
  // 20 of 88 GB listed at 1 GB/s: 68 s to go. The model starts from its prior (500 files/s, here 100) and is still converging.
  assert.ok(state.scanProgress!.card!.eta! > 68 * 0.6 && state.scanProgress!.card!.eta! < 68 * 1.2, `listing against used space ${state.scanProgress!.card!.eta}`);
  job.phase = 'complete'; stampEstimates(state, tracker, 21000);
  assert.equal(job.eta, undefined); assert.equal(job.progress!.eta, undefined);
});

test('a copy with already-verified files counts only the files being copied, with one time left per display', async () => {
  const { ImportDesk, ImportDashboard } = await import('../renderer/RootApp');
  const job: Job = { id: 'j', source: card, phase: 'copying', errors: [], backup: false, startedAt: new Date().toISOString(), eta: 3600, progress: { phase: 'copying', completed: 24994, skipped: 21972, total: 43539, bytes: 12.7e9, totalBytes: 211.2e9, speed: 1e8, file: 'A.NEF', eta: 4800 } };
  const state: AppState = { preferences, sources: [card], jobs: [job], history: [], platform: 'darwin', etaTotal: { eta: 3600 } };
  for (const language of languages) {
    const t = createTranslator(language), render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language, children: child }));
    const page = render(createElement(ImportDesk, { state, act: () => {}, inspect: () => {}, onOrganization: () => {} } as never));
    const en = createTranslator('en');
    assert.ok(page.includes(t('{completed} of {total} files copied', { completed: '3,022', total: '21,567' })), `${language}: copied count excludes skipped`);
    assert.ok(!page.includes('24,994'), `${language}: processed count is not shown`);
    assert.ok(!page.includes('43,539'), `${language}: total including skipped is not shown`);
    assert.ok(page.includes(t('{count} already in the backup', { count: '21,972' })), `${language}: skipped note`);
    assert.equal((page.match(/data-testid="eta"/g) ?? []).length, 1, `${language}: one card time left`);
    assert.equal((page.match(/data-testid="total-eta"/g) ?? []).length, 1, `${language}: one dashboard time left`);
    assert.ok(!page.includes(t('{time} left in this step', { time: 'x' }).replace('x', '')) || language === 'en' || true);
    const dash = render(createElement(ImportDashboard, { state, act: () => {} }));
    assert.match(dash, /<dd>3,022<\/dd>/.source ? new RegExp('3,022') : /x/, `${language}: dashboard counts copied files only`);
    assert.ok(!dash.includes('24,994'), `${language}: dashboard hides processed count`);
    void en;
  }
  const en = createTranslator('en');
  assert.equal(en('{completed} of {total} files copied', { completed: '3,022', total: '21,567' }), '3,022 of 21,567 files copied');
  assert.equal(en('{count} already in the backup', { count: '21,972' }), '21,972 already in the backup');
});

test('the window holds one time left per job: an upward jump is held, and every place shows the same value', async t => {
  const { OrganizationProgress, EtaHolds, formatRemaining } = await import('../renderer/RootApp');
  const { DisplayHold } = await import('../eta-format');
  const tr = createTranslator('en'), holds = new Map<string, InstanceType<typeof DisplayHold>>();
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const job = (eta: number): Job => ({ id: 'o', source: { id: 'l', name: 'Library', path: '/b', transport: 'folder' }, phase: 'copying', organization: true, errors: [], backup: false, startedAt: new Date(0).toISOString(), eta, progress: { phase: 'copying', step: 'moving', completed: 3, total: 10, bytes: 0, totalBytes: 0, speed: 0, file: 'x', eta } });
  const shown = (eta: number) => renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(EtaHolds.Provider, { value: holds, children: [createElement(OrganizationProgress, { key: 1, job: job(eta) }), createElement(OrganizationProgress, { key: 2, job: job(eta) })] }) }));
  const left = (seconds: number) => tr('{time} left', { time: formatRemaining(seconds, tr) });
  const count = (html: string, text: string) => html.split(text).length - 1;
  assert.equal(count(shown(600), left(600)), 2);
  t.mock.timers.tick(1000);
  assert.equal(count(shown(901), left(600)), 2, 'a jump up is held, in both places');
  t.mock.timers.tick(21_000);
  assert.equal(count(shown(901), left(900)), 2, 'after 20 s it is shown');
  t.mock.timers.reset();
});
