import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { exportLogs } from '../log-export';

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'log-export-'));

test('Export logs writes a zip that a standard unzip reads back byte for byte', async (t) => {
  const logs = await temp(), out = path.join(await temp(), 'logs.zip');
  const first = '{"a":1}\n'.repeat(5000), second = '{"b":"é"}\n';
  await fs.writeFile(path.join(logs, 'importer-20260101-100000.jsonl'), first); await fs.writeFile(path.join(logs, 'importer-20260101-110000.jsonl'), second); await fs.writeFile(path.join(logs, 'ignored.txt'), 'x');
  const result = await exportLogs(logs, out);
  assert.equal(result.kind, 'zip'); assert.equal(result.files, 2); assert.equal(result.bytes, (await fs.stat(out)).size);
  try { execFileSync('unzip', ['-tq', out]); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return t.skip('no unzip'); throw error; }
  const extracted = await temp(); execFileSync('unzip', ['-q', out, '-d', extracted]);
  assert.equal(await fs.readFile(path.join(extracted, 'importer-20260101-100000.jsonl'), 'utf8'), first);
  assert.equal(await fs.readFile(path.join(extracted, 'importer-20260101-110000.jsonl'), 'utf8'), second);
  assert.deepEqual((await fs.readdir(extracted)).sort(), ['importer-20260101-100000.jsonl', 'importer-20260101-110000.jsonl']);
});

test('when a zip cannot be written the folder is copied instead', async () => {
  const logs = await temp(), out = path.join(await temp(), 'logs.zip');
  await fs.writeFile(path.join(logs, 'importer-20260101-100000.jsonl'), 'line\n');
  const result = await exportLogs(logs, out, { zip: async () => { throw new Error('no zip'); } });
  assert.equal(result.kind, 'folder'); assert.equal(result.path, out.replace(/\.zip$/, ''));
  assert.equal(await fs.readFile(path.join(result.path, 'importer-20260101-100000.jsonl'), 'utf8'), 'line\n');
});
