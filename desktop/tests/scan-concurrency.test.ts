import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CHECK_CONCURRENCY } from '../core/devices';
import { scanDuplicates, dropDuplicateStores } from '../core/duplicates';
import { destinationIndex, dropDestinationIndexes } from '../core/destination-index';
import { identity } from '../core/paths';
import type { Metadata } from '../shared';

test('the duplicate scan keeps as many metadata reads in flight as the plan check does, and no more', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scan-concurrency-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  dropDuplicateStores(); dropDestinationIndexes();
  for (let i = 0; i < CHECK_CONCURRENCY * 2; i++) await fs.writeFile(path.join(root, `IMG_${i}.JPG`), `photo ${i}`);
  let active = 0, peak = 0;
  const metadata = async (): Promise<Metadata> => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 20)); active--; return { fields: {} }; };
  await scanDuplicates(root, { metadata, index: await destinationIndex(root, await identity(root)) });
  assert.equal(CHECK_CONCURRENCY, 32);
  assert.equal(peak, CHECK_CONCURRENCY);
});
