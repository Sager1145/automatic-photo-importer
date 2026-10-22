import assert from 'node:assert/strict';
import test from 'node:test';
import { EtaEstimator, EtaTracker, type EtaInput } from '../eta';

const MB = 1e6;
/** Feeds `seconds` of progress at `rate(t)` bytes per second, sampled every `step` seconds; returns every shown ETA. */
function run(estimator: EtaEstimator, totalBytes: number, seconds: number, rate: (t: number) => number, state = { t: 0, bytes: 0 }, step = 1) {
  const shown: (number | undefined)[] = [];
  for (let end = state.t + seconds; state.t < end;) {
    state.bytes = Math.min(totalBytes, state.bytes + rate(state.t) * step); state.t += step;
    shown.push(estimator.update({ files: 0, bytes: state.bytes, totalFiles: 0, totalBytes }, state.t * 1000));
  }
  return shown;
}

test('a steady rate gives the true remaining time once warmed up, and nothing before', () => {
  const estimator = new EtaEstimator({ perFileBytes: 0 });
  assert.equal(estimator.update({ files: 0, bytes: 0, totalFiles: 0, totalBytes: 1000 * MB }, 0), undefined);
  const shown = run(estimator, 1000 * MB, 300, () => 2 * MB, { t: 0, bytes: 0 });
  assert.equal(shown[0], undefined, 'no estimate after one second');
  const last = shown.at(-1)!;
  assert.ok(Math.abs(last - 200) < 10, `about 200 s left, got ${last}`);
});

test('a rate change is followed within a minute without jumping', () => {
  const estimator = new EtaEstimator({ perFileBytes: 0 }), state = { t: 0, bytes: 0 };
  run(estimator, 6000 * MB, 200, () => 10 * MB, state);
  const shown = run(estimator, 6000 * MB, 90, () => 5 * MB, state);
  const truth = (6000 * MB - state.bytes) / (5 * MB);
  assert.ok(Math.abs(shown.at(-1)! - truth) / truth < 0.15, `close to ${truth}, got ${shown.at(-1)}`);
  for (let index = 1; index < shown.length; index++) assert.ok(shown[index]! < shown[index - 1]! * 1.2, 'rises gradually');
});

test('a brief stall holds the estimate; a long stall raises it gradually; it never reaches zero early', () => {
  const estimator = new EtaEstimator({ perFileBytes: 0 }), state = { t: 0, bytes: 0 };
  const before = run(estimator, 1000 * MB, 100, () => 5 * MB, state).at(-1)!;
  const brief = run(estimator, 1000 * MB, 10, () => 0, state);
  for (const value of brief) assert.ok(value! > before * 0.85 && value! < before * 1.1, `held near ${before}, got ${value}`);
  const long = run(estimator, 1000 * MB, 120, () => 0, state);
  assert.ok(long.at(-1)! > before * 1.2, 'a long stall raises the estimate');
  for (const value of [...brief, ...long]) assert.ok(value! >= 1, 'never zero while work remains');
  const done = estimator.update({ files: 0, bytes: 1000 * MB, totalFiles: 0, totalBytes: 1000 * MB }, (state.t + 1) * 1000);
  assert.equal(done, 0, 'zero only when finished');
});

test('a burst of tiny files before large videos does not swing the estimate wildly when files carry a cost', () => {
  // Truth: 100 MB/s plus 10 ms per file. 3000 files of 200 kB, then 20 files of 2 GB.
  const files = [...Array.from({ length: 3000 }, () => 200e3), ...Array.from({ length: 20 }, () => 2e9)];
  const totalBytes = files.reduce((a, b) => a + b, 0), totalFiles = files.length;
  const estimator = new EtaEstimator({ perFileBytes: 1 << 20 });
  let t = 0, bytes = 0, done = 0, next = 1;
  const shown: { t: number; value: number; truth: number }[] = [];
  const truthLeft = (from: number, partial: number) => files.slice(from).reduce((sum, size) => sum + size / 100e6 + 0.01, 0) - partial;
  estimator.update({ files: 0, bytes: 0, totalFiles, totalBytes }, 0);
  for (const [index, size] of files.entries()) {
    for (let copied = 0; copied < size;) {
      const take = Math.min(size - copied, 50e6); copied += take; bytes += take; t += take / 100e6;
      if (copied === size) { t += 0.01; done++; }
      if (t >= next) { next = t + 1; const value = estimator.update({ files: done, bytes, totalFiles, totalBytes }, t * 1000); if (value !== undefined) shown.push({ t, value, truth: truthLeft(index + (copied === size ? 1 : 0), copied === size ? 0 : copied / 100e6) }); }
    }
  }
  const settled = shown.filter(item => item.t > 30 && item.truth > 10);
  for (const item of settled) assert.ok(Math.abs(item.value - item.truth) / item.truth < 0.5, `within 50% at ${item.t.toFixed(0)}s: ${item.value} vs ${item.truth}`);
  for (let index = 1; index < shown.length; index++) assert.ok(shown[index]!.value <= shown[index - 1]!.value * 1.25 + 1, 'no jumps up');
});

test('unknown totals and files-only stages', () => {
  const unknown = new EtaEstimator({ perFileBytes: 0 });
  for (let t = 0; t < 30; t++) assert.equal(unknown.update({ files: t * 10, bytes: t * MB, totalFiles: 0, totalBytes: 0 }, t * 1000), undefined);
  const metadata = new EtaEstimator({});
  let last: number | undefined;
  for (let t = 0; t <= 20; t++) last = metadata.update({ files: t * 40, bytes: t * 999 * MB, totalFiles: 4000, totalBytes: 1 }, t * 1000);
  assert.ok(Math.abs(last! - 80) < 5, `files drive a metadata stage: ${last}`);
  assert.equal(new EtaEstimator({}).update({ files: 5, bytes: 0, totalFiles: 3, totalBytes: 0 }, 0), 0, 'past the total means finished, never negative');
});

test('the job estimate adds the stages still ahead and stays defined across a stage change', () => {
  const tracker = new EtaTracker(), context = { kind: 'import' as const, destinations: 2, verify: true };
  const checking = (t: number): EtaInput => ({ phase: 'planning', step: 'checking', completed: t * 40, total: 4000, bytes: t * 40 * 25 * MB, totalBytes: 100e9 });
  let eta = tracker.observe('j', checking(0), context, 0);
  for (let t = 1; t <= 20; t++) eta = tracker.observe('j', checking(t), context, t * 1000);
  assert.ok(eta.step! > 70 && eta.step! < 90, `checking ${eta.step}`);
  // Copying 200 GB at the default 60 MB/s and verifying it take far longer than checking.
  assert.ok(eta.job! > eta.step! + 3000, `job includes copying and verifying: ${eta.job}`);
  const comparing = tracker.observe('j', { phase: 'planning', step: 'comparing', completed: 0, total: 8000, bytes: 0, totalBytes: 200e9 }, context, 101000);
  assert.equal(comparing.step, undefined, 'a new stage is estimating');
  assert.ok(comparing.job! > 3000, 'the job estimate stays');
  tracker.forget([]);
  assert.deepEqual(tracker.observe('j', checking(0), context, 0), {}, 'forgotten jobs start fresh');
  const unknownStage = tracker.observe('k', { phase: 'planning', step: 'listing', completed: 10, total: 0, bytes: MB, totalBytes: 0 }, { kind: 'import', destinations: 1, verify: true }, 0);
  assert.deepEqual(unknownStage, {});
});
