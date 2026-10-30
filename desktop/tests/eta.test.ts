import { freshOrganizeOptions } from '../run-policy';
import assert from 'node:assert/strict';
import test from 'node:test';
import { EtaTracker, stampEstimates, type EtaInput } from '../eta';
import { bucketSeconds } from '../eta-format';
import { listingEstimate } from '../listing-estimate';
import type { AppState, Job } from '../shared';
import { defaultPreferences } from '../preferences';

const MB = 1e6;
const context = { kind: 'import' as const, destinations: 1, verify: true };
const copying = (bytes: number, totalBytes: number, files = 0, totalFiles = 0) => ({ phase: 'copying' as const, completed: files, total: totalFiles, bytes, totalBytes });
/** Feeds `seconds` of copy progress at `rate(t)` bytes per second, once a second on a fake clock; returns every result. */
function run(tracker: EtaTracker, totalBytes: number, seconds: number, rate: (t: number) => number, state = { t: 0, bytes: 0 }) {
  const shown: ReturnType<EtaTracker['observe']>[] = [];
  for (let end = state.t + seconds; state.t < end;) {
    state.bytes = Math.min(totalBytes, state.bytes + rate(state.t)); state.t++;
    shown.push(tracker.observe('j', copying(state.bytes, totalBytes, Math.floor(state.bytes / (10 * MB)), Math.ceil(totalBytes / (10 * MB))), context, state.t * 1000));
  }
  return shown;
}

test('a finished step and job read 0', () => {
  const tracker = new EtaTracker(), state = { t: 0, bytes: 0 };
  run(tracker, 1000 * MB, 60, () => 5 * MB, state);
  const done = tracker.observe('j', { phase: 'verifying', completed: 100, total: 100, bytes: 1000 * MB, totalBytes: 1000 * MB }, context, (state.t + 20) * 1000);
  assert.equal(done.job, 0); assert.equal(done.step, 0);
});

test('a long stall raises the time left as it goes on, and it never reads 0 while work remains', () => {
  const tracker = new EtaTracker(), state = { t: 0, bytes: 0 };
  const before = run(tracker, 2000 * MB, 100, () => 5 * MB, state).at(-1)!.step!;
  const brief = run(tracker, 2000 * MB, 10, () => 0, state).map(item => item.step!);
  for (const value of brief) assert.ok(Math.abs(value / before - 1) < 0.1, `a brief stall leaves it near ${before}: ${value}`);
  const long = run(tracker, 2000 * MB, 120, () => 0, state).map(item => item.step!);
  for (let index = 1; index < long.length; index++) assert.ok(long[index]! >= long[index - 1]!, 'it only grows while stalled');
  assert.ok(long.at(-1)! > before * 1.5, `a two-minute stall raises it: ${before} -> ${long.at(-1)}`);
  for (const value of [...brief, ...long]) assert.ok(value >= 1);
});

test('a job stores the model seconds, not a display bucket', () => {
  const tracker = new EtaTracker();
  const card = { id: 'card', name: 'Card', path: '/Volumes/CARD', transport: 'storage' as const, selected: true };
  const job: Job = { id: 'j', source: card, phase: 'copying', errors: [], backup: false, progress: { ...copying(0, 10e9), speed: 0, file: '' } };
  const preferences = { ...defaultPreferences, language:'en', appearance: 'system', textScale: 1, accent: 'coral', automatic: false, parallel: 1, destinations: ['/b'], copyMode: 'single', basePath: 'p', template: '{year}', mediaLayout: 'flat', videoBasePath: '', videoTemplate: '', unknownRules: {} } as AppState['preferences'];
  const state: AppState = { preferences, sources: [card], jobs: [job], history: [], platform: 'darwin', organizeOptions: freshOrganizeOptions() };
  const seen: number[] = [];
  for (let t = 0; t <= 40; t++) { job.progress = { ...copying(t * 37 * MB, 10e9, t * 3, 1000), speed: 0, file: '' }; stampEstimates(state, tracker, t * 1000); if (job.eta !== undefined) seen.push(job.eta); }
  assert.ok(seen.length > 10);
  assert.ok(seen.some(value => value !== bucketSeconds(value)), `raw seconds reach the state: ${seen.slice(-3)}`);
  assert.ok(seen.every(value => value > 0 && Number.isFinite(value)));
});

test('a step without a total, and a listing without an estimate, give no time left', () => {
  const tracker = new EtaTracker();
  for (let t = 0; t <= 30; t++) {
    assert.deepEqual(tracker.observe('a', { phase: 'planning', step: 'locating', completed: t * 10, total: 0, bytes: t * MB, totalBytes: 0 }, context, t * 1000), {});
    assert.deepEqual(tracker.observe('b', { phase: 'planning', step: 'listing', completed: t * 10, total: 0, bytes: t * MB, totalBytes: 0 }, context, t * 1000), {});
  }
});

test('every step is estimated by the model: a listing is an estimated-total step, a step outside the plan uses its own total', () => {
  const tracker = new EtaTracker(), hint = { files: 20000 };
  let listing: ReturnType<EtaTracker['observe']> = {};
  for (let t = 0; t <= 30; t++) {
    const found = { files: t * 200, bytes: t * 200 * 30 * MB }, estimate = listingEstimate(hint, found);
    listing = tracker.observe('l', { phase: 'planning', step: 'listing', completed: found.files, total: estimate.total, bytes: found.bytes, totalBytes: estimate.totalBytes, share: estimate.share }, context, t * 1000);
  }
  // 6,000 of about 20,000 found in 30 s: about 70 s to go.
  assert.ok(listing.step! > 50 && listing.step! < 95, `listing ${listing.step}`);
  assert.equal(tracker.view('l').fraction, undefined, 'an estimated total says nothing of the job\'s share done');
  let locating: ReturnType<EtaTracker['observe']> = {};
  for (let t = 0; t <= 30; t++) locating = tracker.observe('x', { phase: 'planning', step: 'locating', completed: t * 10, total: 600, bytes: 0, totalBytes: 0 }, context, t * 1000);
  assert.ok(locating.step! > 20 && locating.step! < 45, `locating ${locating.step}`);
});

test('the job estimate adds the steps still ahead and stays defined across a step change', () => {
  const tracker = new EtaTracker();
  const checking = (t: number): EtaInput => ({ phase: 'planning', step: 'checking', completed: t * 40, total: 4000, bytes: t * 40 * 25 * MB, totalBytes: 100e9 });
  const two = { ...context, destinations: 2 };
  let eta = tracker.observe('j', checking(0), two, 0);
  for (let t = 1; t <= 20; t++) eta = tracker.observe('j', checking(t), two, t * 1000);
  assert.ok(eta.step! > 70 && eta.step! < 90, `checking ${eta.step}`);
  assert.ok(eta.job! > eta.step! + 3000, `job includes copying and verifying: ${eta.job}`);
  const comparing = tracker.observe('j', { phase: 'planning', step: 'comparing', completed: 0, total: 8000, bytes: 0, totalBytes: 200e9 }, two, 101000);
  assert.equal(comparing.step, undefined, 'a new step is estimating');
  assert.ok(comparing.job! > 3000, 'the job estimate stays');
  tracker.forget([]);
  assert.deepEqual(tracker.observe('j', checking(0), two, 0), {}, 'forgotten jobs start fresh');
});

test('a step outside the job\'s plan (a camera download) counts for time left, not for the job\'s share done', () => {
  const tracker = new EtaTracker();
  for (let t = 0; t <= 20; t++) tracker.observe('c', { phase: 'planning', step: 'downloading', completed: t * 5, total: 100, bytes: 0, totalBytes: 0 }, context, t * 1000);
  assert.equal(tracker.view('c').fraction, undefined, 'the download says nothing of the import\'s share done');
  for (let t = 21; t <= 40; t++) tracker.observe('c', { phase: 'planning', step: 'checking', completed: (t - 21) * 5, total: 100, bytes: (t - 21) * 5e7, totalBytes: 5e9 }, context, t * 1000);
  const fraction = tracker.view('c').fraction!;
  assert.ok(fraction > 0 && fraction < 0.5, `the import's own steps set the bar: ${fraction}`);
});
