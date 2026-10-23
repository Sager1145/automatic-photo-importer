import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { organizesAfterImport } from '../after-import';

test('a finished import queues the backup organization; an organization, a failed or stopped job does not', () => {
  assert.equal(organizesAfterImport({ phase: 'complete' }, false), true);
  assert.equal(organizesAfterImport({ phase: 'complete' }, true), false);
  for (const phase of ['error', 'stopped', 'copying'] as const) assert.equal(organizesAfterImport({ phase }, false), false);
});

test('both ways a job ends (queued, and started from Preview/Continue) ask for the organization', async () => {
  const source = await fs.readFile(new URL('../main.ts', import.meta.url), 'utf8');
  const uses = source.match(/if\(organizesAfterImport\([^)]*\)\)organizeAfterImport=true;finishJob\(job\)/g) ?? [];
  assert.equal(uses.length, 2, 'the run queue and applyReview each set organizeAfterImport before finishJob');
  assert.match(source, /prepared\.review\.kind==='reorganize'\)\)organizeAfterImport/);
});
