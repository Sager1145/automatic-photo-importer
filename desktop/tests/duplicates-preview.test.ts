import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { thumbnail, pruneThumbnails, type ThumbnailDecoders } from '../platform/thumbnails';
import { categorize } from '../renderer/exif-categories';
import { metadataFromTags } from '../platform/metadata';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
async function scratch(t: test.TestContext) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'thumb-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}
test('a RAW the system cannot decode falls back to the embedded preview and says why', async t => {
  const base = await scratch(t), raw = path.join(base, 'new-camera.NEF');
  await fs.writeFile(raw, 'raw bytes');
  const decoders: ThumbnailDecoders = { decode: async () => false, poster: async () => false, embedded: async () => jpeg };
  const result = await thumbnail(raw, { cache: path.join(base, 'cache'), decoders });
  assert.equal(result.via, 'embedded'); assert.equal(result.problem, 'raw-unsupported'); assert.ok(result.src?.startsWith('data:image/jpeg'));
  // The cached embedded preview is used next time, without decoding again.
  const again = await thumbnail(raw, { cache: path.join(base, 'cache'), decoders: { decode: async () => { throw new Error('decoded again'); }, poster: async () => false, embedded: async () => undefined } });
  assert.equal(again.via, 'embedded');
});
test('with no decoder and no embedded preview only the message remains; a decodable file is cached', async t => {
  const base = await scratch(t), raw = path.join(base, 'a.ARW'), photo = path.join(base, 'b.JPG');
  await fs.writeFile(raw, 'x'); await fs.writeFile(photo, 'y');
  const none = await thumbnail(raw, { cache: path.join(base, 'c'), decoders: { decode: async () => false, poster: async () => false, embedded: async () => undefined } });
  assert.deepEqual(none, { via: 'none', problem: 'raw-unsupported' });
  let calls = 0;
  const decoders: ThumbnailDecoders = { decode: async (_f, out) => { calls++; await fs.writeFile(out, jpeg); return true; }, poster: async () => false, embedded: async () => undefined };
  assert.equal((await thumbnail(photo, { cache: path.join(base, 'c'), decoders })).via, 'system');
  await thumbnail(photo, { cache: path.join(base, 'c'), decoders });
  assert.equal(calls, 1);
});
test('full EXIF is grouped into curated categories with friendly units and no binary or repeated tags', () => {
  // Exposure and capture time are the interpreter's values in the summary card's format, not formatted again here.
  const categories = categorize(metadataFromTags({
    'ExifIFD:ExposureTime': 0.004, 'ExifIFD:FNumber': 2.8, 'ExifIFD:ISO': 400, 'ExifIFD:FocalLength': 50, 'ExifIFD:ExposureCompensation': -0.3, 'ExifIFD:Flash': 16,
    'IFD0:Model': 'NIKON Z f', 'IFD0:Copy1:Model': 'NIKON Z f', 'ExifIFD:LensModel': 'NIKKOR Z 50mm', 'ExifIFD:DateTimeOriginal': '2024:05:06 07:08:09',
    'GPS:GPSLatitude': 35.12345678, 'ExifIFD:ExifImageWidth': 6048, 'ExifIFD:ExifImageHeight': 4032, 'File:FileSize': 2048,
    'IFD1:ThumbnailImage': '(Binary data 5000 bytes)', 'ExifIFD:ComponentsConfiguration': '1 2 3 0', 'Nikon:ShutterCount': 1234, 'Nikon:LensData0100': 'x',
  }), 'en', bytes => `${bytes / 1024} KB`);
  const by = Object.fromEntries(categories.map(c => [c.id, Object.fromEntries(c.rows.map(r => [r.label, r.value]))]));
  assert.deepEqual(by.exposure, { 'Shutter speed': '1/250 s', Aperture: 'f/2.8', ISO: '400', 'Exposure compensation': '-0.3 EV', Flash: 'No flash', 'Focal length': '50 mm' });
  assert.deepEqual(by.camera, { 'Camera model': 'NIKON Z f', Lens: 'NIKKOR Z 50mm' });
  assert.deepEqual(by.datetime, { Captured: 'May 6, 2024 07:08:09' });
  assert.deepEqual(by.location, { Latitude: '35.12346°' });
  assert.deepEqual(by.image, { Width: '6048 px', Height: '4032 px' });
  assert.deepEqual(by.maker, { 'Shutter count': '1234' });
  assert.deepEqual(by.file, { 'File size': '2 KB' });
  assert.deepEqual(categories.map(c => c.title), ['Exposure', 'Camera & Lens', 'Date & Time', 'Location', 'Image', 'Maker Notes', 'File']);
});

test('the thumbnail cache is pruned least recently used first down to its cap', async t => {
  const base = await scratch(t), cache = path.join(base, 'cache');
  await fs.mkdir(cache);
  const now = Date.now() / 1000;
  for (const [index, name] of ['a', 'b', 'c', 'd', 'e'].entries()) {
    await fs.writeFile(path.join(cache, `${name}.jpg`), Buffer.alloc(100));
    await fs.utimes(path.join(cache, `${name}.jpg`), now - (5 - index) * 100, now - (5 - index) * 100);
  }
  await fs.writeFile(path.join(cache, 'note.txt'), Buffer.alloc(1000));
  // `a` is the oldest but was used just now (a cache hit touches the file), so `b` and `c` go first.
  await fs.utimes(path.join(cache, 'a.jpg'), now, now);
  assert.deepEqual(await pruneThumbnails(cache, 1000), { removed: 0, bytes: 0 });
  assert.deepEqual(await pruneThumbnails(cache, 300), { removed: 2, bytes: 200 });
  assert.deepEqual((await fs.readdir(cache)).sort(), ['a.jpg', 'd.jpg', 'e.jpg', 'note.txt']);
  assert.deepEqual(await pruneThumbnails(path.join(base, 'missing'), 1), { removed: 0, bytes: 0 });
});
