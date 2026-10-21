import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaKindForPath } from '../media-formats';

test('inventory and preview share camera video and still classification on every platform', () => {
  for (const extension of ['mov','mp4','m4v','mts','m2ts','avi','mxf','mpg','mpeg','insv','360','r3d','braw','crm','nraw','nev']) {
    assert.equal(mediaKindForPath(`/PRIVATE/CLIP/C0001.${extension.toUpperCase()}`), 'Videos');
    assert.equal(mediaKindForPath(`E:\\PRIVATE\\CLIP\\C0001.${extension}`), 'Videos');
  }
  assert.equal(mediaKindForPath('/DCIM/100NIKON/_NZF0001.NEF'), 'RAW');
  assert.equal(mediaKindForPath('/DCIM/image.HEIC'), 'HEIF');
  for (const file of ['NIKON001.DSC','C0001M01.XML','.mp4','image.mp4.tmp','/folder.mp4/no-extension']) {
    assert.equal(mediaKindForPath(file), 'Other');
  }
});
