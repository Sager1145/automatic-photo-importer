import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaKindForPath } from '../media-formats';

test('inventory and preview share camera video and still classification on every platform', () => {
  for (const extension of ['mov','mp4','m4v','mts','m2ts','avi','mxf','mpg','mpeg','insv','360','r3d','braw','crm','nev','3gp','m2t','mod','tod','osv']) {
    assert.equal(mediaKindForPath(`/PRIVATE/CLIP/C0001.${extension.toUpperCase()}`), 'Videos');
    assert.equal(mediaKindForPath(`E:\\PRIVATE\\CLIP\\C0001.${extension}`), 'Videos');
  }
  assert.equal(mediaKindForPath('/DCIM/100NIKON/_NZF0001.NEF'), 'RAW');
  assert.equal(mediaKindForPath('/DCIM/image.HEIC'), 'HEIF');
  for (const file of ['NIKON001.DSC','C0001M01.XML','.mp4','image.mp4.tmp','/folder.mp4/no-extension']) {
    assert.equal(mediaKindForPath(file), 'Other');
  }
});

test('formats cameras write, as listed by ExifTool, Immich and Rapid Photo Downloader, are recognised', () => {
  // Sony pixel shift, GoPro RAW, Epson, Kodak, Mamiya.
  for (const extension of ['arq','gpr','erf','kdc','dcr','mef']) assert.equal(mediaKindForPath(`/DCIM/IMG_0001.${extension.toUpperCase()}`), 'RAW', extension);
  // Insta360 photos and multi-picture (3D) JPEG.
  for (const extension of ['insp','mpo']) assert.equal(mediaKindForPath(`/DCIM/IMG_0001.${extension}`), 'Images', extension);
  // Nikon N-RAW video is .NEV; ".nraw" is not a real extension.
  assert.equal(mediaKindForPath('/DCIM/clip.nraw'), 'Other');
});

test('whitelist additions map to their kinds in either case, and ts/txt/json/zip stay Other', () => {
  const groups: [string, string[]][] = [
    ['Images', ['webp', 'jps', 'psd', 'psb', 'jfif']],
    ['RAW', ['cap', 'eip', 'k25', 'rwz', 'cs1']],
    ['Videos', ['3g2', 'mqv', 'vob', 'dv']],
  ];
  for (const [kind, extensions] of groups) for (const extension of extensions) {
    assert.equal(mediaKindForPath(`/DCIM/X0001.${extension}`), kind, extension);
    assert.equal(mediaKindForPath(`/DCIM/X0001.${extension.toUpperCase()}`), kind, extension);
  }
  for (const extension of ['ts', 'txt', 'json', 'zip', 'mkv', 'webm', 'wmv', 'asf', 'bin', 'dat']) assert.equal(mediaKindForPath(`/DCIM/X0001.${extension}`), 'Other', extension);
});
