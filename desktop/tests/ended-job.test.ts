import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../renderer/i18n';
import type { AppState, Job } from '../shared';

const preferences: AppState['preferences'] = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/b'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout: 'flat', videoBasePath: 'videobackup', videoTemplate: '', allowFolderSource: false, unknownRules: {} };
const card = { id: 'card', name: 'Card', path: '/Volumes/CARD', transport: 'storage' as const, selected: true, total: 300e9, free: 50e9 };
const space = [{ needed: 218.2e9, free: 400e9, existing: 0, existingFiles: 0, newFiles: 43539 }];
/** A job that ended with an error only because of cleanup leftovers, after every file was verified. */
const verifiedError = (over: Partial<Job> = {}): Job => ({ id: 'j', source: card, phase: 'error', errors: [], backup: false, space, fraction: 0.9, startedAt: new Date().toISOString(), progress: { phase: 'verifying', completed: 43539, total: 43539, bytes: 0, totalBytes: 167e9, speed: 0, file: '' }, ...over });
const render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: child }));
const desk = async (jobs: Job[]) => {
  const { ImportDesk } = await import('../renderer/RootApp');
  return render(createElement(ImportDesk, { state: { preferences, sources: [card], jobs, history: [], platform: 'darwin' }, act: () => {}, inspect: () => {}, onOrganization: () => {}, onSettings: () => {} }));
};

test('a job that ended with every file verified is 100%, on the card and in the header', async () => {
  const { cardFraction, allVerified, jobFinished } = await import('../renderer/progress');
  for (const phase of ['error', 'stopped', 'complete'] as const) {
    const job = verifiedError({ phase });
    assert.equal(cardFraction(job), 1, phase);
  }
  assert.ok(allVerified(verifiedError()));
  assert.ok(jobFinished(verifiedError()));
  // Not every file verified, a failed file, or a job still running: not 100%
  assert.equal(cardFraction(verifiedError({ progress: { ...verifiedError().progress!, completed: 43538 } })), 0.9);
  assert.equal(cardFraction(verifiedError({ progress: { ...verifiedError().progress!, failed: 2 } })), 0.9);
  assert.equal(cardFraction(verifiedError({ phase: 'verifying' })), 0.9);
  assert.ok(!jobFinished(verifiedError({ progress: { ...verifiedError().progress!, failed: 2 } })));
});

test('the card and the header read 100% and Verified-style finished state for such a job', async () => {
  const page = await desk([verifiedError()]);
  assert.match(page, /100%/);
  assert.doesNotMatch(page, /99%/);
  const { ImportDashboard } = await import('../renderer/RootApp');
  const dashboard = render(createElement(ImportDashboard, { state: { preferences, sources: [card], jobs: [verifiedError()], history: [], platform: 'darwin' }, act: () => {} }));
  const total = dashboard.slice(dashboard.indexOf('data-testid="total-progress"'));
  assert.match(total, /100%/);
  assert.doesNotMatch(total.slice(0, 600), /99%/);
});

test('the header is not finished while a job ended short of 100%', async () => {
  const { ImportDashboard } = await import('../renderer/RootApp');
  const other = { ...card, id: 'other', name: 'Other' };
  const unfinished = verifiedError({ id: 'k', source: other, progress: { phase: 'copying', completed: 10, total: 100, bytes: 1e9, totalBytes: 1e10, speed: 0, file: '' }, fraction: 0.3 });
  const dashboard = render(createElement(ImportDashboard, { state: { preferences, sources: [card, other], jobs: [verifiedError(), unfinished], history: [], platform: 'darwin' }, act: () => {} }));
  const total = dashboard.slice(dashboard.indexOf('data-testid="total-progress"'));
  assert.doesNotMatch(total.slice(0, 600), /100%/);
});

test('no step is marked as an error when every file was verified', async () => {
  const { sourceStepStates } = await import('../renderer/RootApp');
  assert.deepEqual(sourceStepStates(verifiedError(), undefined, false, false), ['done', 'done', 'done']);
  assert.deepEqual(sourceStepStates(verifiedError({ phase: 'stopped' }), undefined, false, true), ['done', 'done', 'skipped']);
  assert.deepEqual(sourceStepStates(verifiedError({ progress: { ...verifiedError().progress!, completed: 5 } }), undefined, false, false), ['done', 'done', 'error']);
  const page = await desk([verifiedError()]);
  assert.doesNotMatch(page, /data-state="error"/);
});

test('the space a job needs shows only while it is queued or running', async () => {
  const needs = /data-testid="source-space"/;
  assert.match(await desk([verifiedError({ phase: 'queued', progress: undefined })]), needs);
  assert.match(await desk([verifiedError({ phase: 'copying', progress: { phase: 'copying', completed: 1, total: 2, bytes: 1, totalBytes: 2, speed: 0, file: '' } })]), needs);
  for (const phase of ['complete', 'error', 'stopped'] as const) assert.doesNotMatch(await desk([verifiedError({ phase })]), needs, phase);
});
