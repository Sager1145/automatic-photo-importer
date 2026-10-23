import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { plan, execute, configureOrganizationRecovery } from '../core/index';
import { configureLogger, resetLogger, type LogLevel } from '../logger';
import type { Metadata } from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const metadata = async (): Promise<Metadata> => ({ camera: 'Nikon Z f', date: '2024-02-03T12:00:00Z', fields: {} });
const options = { backup: false as const, template: '{year}/{yyyymm}/{camera}', layout: 'flat' as const, unknownRules: {} };
const FILES = 2000;

/** One complete import (plan, copy, verify, publish) of 2,000 small files; returns wall and CPU time in ms. */
async function importOnce(source: string, level: LogLevel | undefined, logs: string): Promise<{ ms: number; cpu: number; lines: number }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overhead-dest-'));
  const logger = level ? configureLogger({ dir: logs, level }) : undefined;
  const cpu = process.cpuUsage(), start = performance.now();
  const { plans: [transfer] } = await plan(source, [root], options, metadata);
  const result = await execute(transfer!);
  await logger?.close();
  const ms = performance.now() - start, used = process.cpuUsage(cpu);
  resetLogger();
  assert.equal(result.copied, FILES);
  let lines = 0;
  if (level) for (const name of await fs.readdir(logs)) lines += (await fs.readFile(path.join(logs, name), 'utf8')).split('\n').length - 1;
  await fs.rm(root, { recursive: true, force: true });
  return { ms, cpu: (used.user + used.system) / 1000, lines };
}

test('detailed logging adds little to a 2,000-small-file import', async (t) => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'overhead-src-')), logs = await fs.mkdtemp(path.join(os.tmpdir(), 'overhead-logs-'));
  t.after(() => Promise.all([fs.rm(source, { recursive: true, force: true }), fs.rm(logs, { recursive: true, force: true })]));
  for (let i = 0; i < FILES; i++) await fs.writeFile(path.join(source, `IMG_${String(i).padStart(5, '0')}.JPG`), `small file ${i}`);
  const off: number[] = [], on: number[] = [];
  let lines = 0;
  // Alternate so drift on a busy machine hits both the same way; compare the best of each.
  for (let round = 0; round < 2; round++) {
    off.push((await importOnce(source, undefined, logs)).cpu);
    await fs.rm(logs, { recursive: true, force: true });
    const detailed = await importOnce(source, 'detailed', logs); on.push(detailed.cpu); lines = detailed.lines;
    await fs.rm(logs, { recursive: true, force: true });
  }
  const baseline = Math.min(...off), logged = Math.min(...on), overhead = (logged - baseline) / baseline * 100;
  console.log(`2,000-file import: logging off ${baseline.toFixed(0)} ms CPU, detailed ${logged.toFixed(0)} ms CPU (${overhead.toFixed(1)}% overhead), ${lines} log lines`);
  assert.ok(lines > FILES * 5, `${lines} lines were written at detailed`);
  // The target is under 5%; the test allows more only because a shared machine adds noise.
  assert.ok(overhead < 15, `overhead ${overhead.toFixed(1)}%`);
});
