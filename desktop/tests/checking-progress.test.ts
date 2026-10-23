import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator, I18nProvider, languages } from '../renderer/i18n';
import { EtaTracker, stampEstimates } from '../eta';
import * as core from '../core/index';
import type { AppState, Job, Metadata } from '../shared';

core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const preferences = { language: 'en', appearance: 'system', textScale: 1.25, accent: 'coral', automatic: false, parallel: 2, destinations: ['/b'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout: 'flat', videoBasePath: 'videobackup', videoTemplate: '' } as unknown as AppState['preferences'];
const card = { id: 'card', name: 'Card', path: '/Volumes/CARD', transport: 'storage' as const, selected: true, total: 128e9, free: 40e9 };
const checking = (total: number, totalBytes: number): Job => ({ id: 'j', source: card, phase: 'verifying', errors: [], backup: false, progress: { phase: 'planning', step: 'checking', completed: 0, total, bytes: 0, totalBytes, speed: 0, file: 'a' } });

test('metadata checking measures and shows files/s only', async () => {
  const { PlanningProgress } = await import('../renderer/RootApp');
  const tracker = new EtaTracker(), job = checking(1000, 4e9);
  const state: AppState = { preferences, sources: [card], jobs: [job], history: [], platform: 'darwin' };
  for (let s = 0; s <= 10; s++) { job.progress = { ...job.progress!, completed: s * 40, bytes: s * 40 * 4e6 }; stampEstimates(state, tracker, 2_000_000 + s * 1000); }
  assert.ok(job.progress!.fileRate! > 36 && job.progress!.fileRate! < 44, `${job.progress!.fileRate} files/s`);
  assert.equal(job.progress!.speed, 0, 'the bytes of the files covered are not data moved');
  for (const language of languages) {
    const t = createTranslator(language);
    const page = renderToStaticMarkup(createElement(I18nProvider, { language, children: createElement(PlanningProgress, { progress: { ...job.progress!, fileRate: 40 }, label: 'Review progress' }) }));
    assert.ok(!page.includes('MB/s'), `${language}: no MB/s`);
    assert.ok(page.includes(t('{count} files/s', { count: '40' })), `${language}: files/s`);
    assert.ok(page.includes('data-testid="progress-file"'), `${language}: current file`);
  }
});

test('time left stays steady while files finish in bursts of a batch', () => {
  const tracker = new EtaTracker(), job = checking(29000, 29000 * 5e6);
  const state: AppState = { preferences, sources: [card], jobs: [job], history: [], platform: 'darwin' };
  let completed = 0, last: number | undefined, worst = 0;
  for (let ms = 0; ms <= 120_000; ms += 100) {
    if (!(ms > 60_000 && ms < 63_000) && (ms / 100) % 2 === 0) completed += 48; // about 240 files/s in bursts
    job.progress = { ...job.progress!, completed, bytes: completed * 5e6 };
    stampEstimates(state, tracker, 3_000_000 + ms);
    const eta = job.progress!.eta;
    if (eta !== undefined && last !== undefined && ms > 10_000 && !(ms > 60_000 && ms < 66_000)) worst = Math.max(worst, Math.abs(eta - (last - 0.1)) / last);
    last = eta;
  }
  assert.ok(last !== undefined && last > 0, 'an estimate is shown');
  assert.ok(worst < 0.05, `time left moved by ${(worst * 100).toFixed(1)}% in one step`);
});

test('metadata checking reports every file as it is read, with its name and the bytes covered so far', async t => {
  const drive = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'checking-')));
  t.after(() => fs.rm(drive, { recursive: true, force: true }));
  await fs.mkdir(path.join(drive, 'photobackup'), { recursive: true });
  for (const folder of ['2025', '2026', '2027']) { await fs.mkdir(path.join(drive, folder)); for (const name of ['A.JPG', 'B.JPG']) await fs.writeFile(path.join(drive, folder, name), 'bytes of ' + folder + name); }
  const read = async (): Promise<Metadata> => ({ camera: 'Sony A7', date: '2026-10-03T12:00:00', fields: {} });
  const events: { count: number; file: string; bytes: number; totalBytes: number; total: number }[] = [];
  await core.plan(drive, [path.join(drive, 'photobackup')], { backup: false, template: '{year}', unknownRules: {}, layout: 'flat', reorganize: true }, read, undefined, (count, file, detail) => { if (detail?.step === 'checking') events.push({ count, file, bytes: detail.bytes, totalBytes: detail.totalBytes, total: detail.total }); });
  assert.deepEqual(events.map(event => event.count), [1, 2, 3, 4, 5, 6], 'one report per file, not per batch');
  assert.ok(events.every(event => event.file !== '' && event.total === 6));
  assert.ok(events.every((event, index) => index === 0 || event.bytes > events[index - 1]!.bytes));
  assert.equal(events.at(-1)!.bytes, events.at(-1)!.totalBytes);
});
