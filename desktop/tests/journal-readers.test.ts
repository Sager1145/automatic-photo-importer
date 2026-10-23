import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { streams, STREAMS, type DeviceKind } from '../core/devices';
import { journalReaderCount } from '../core/recovery';

test('journal readers follow the journal device: twice its stream limit', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'journal-readers-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const internals = streams as unknown as { kinds: Map<bigint, Promise<DeviceKind>>; known: Map<bigint, DeviceKind> };
  const dev = (await fs.stat(base, { bigint: true })).dev;
  t.after(() => { internals.kinds.delete(dev); internals.known.delete(dev); });
  const expected: Record<DeviceKind, number> = { hdd: 2, card: 4, ssd: 8, unknown: STREAMS.unknown * 2 };
  for (const kind of Object.keys(expected) as DeviceKind[]) {
    internals.kinds.set(dev, Promise.resolve(kind)); internals.known.set(dev, kind);
    assert.equal(await journalReaderCount(path.join(base, 'not-created-yet')), expected[kind], kind);
  }
  assert.deepEqual([expected.hdd, expected.card, expected.ssd], [2, 4, 8]);
});
