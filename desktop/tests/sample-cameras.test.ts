import assert from 'node:assert/strict';
import test from 'node:test';
import {sampleCameras,sampleShot} from '../renderer/sample-cameras';
import {formatFolder,mediaKindForPath} from '../media-formats';

test('every example capture is a camera body with the files it writes: NEF, JPG, a WAV memo with the same number, then a MOV or MP4',()=>{
 const seen=new Set<string>();
 for(let i=0;i<2000;i++){
  const shot=sampleShot();seen.add(shot.camera);
  assert.ok((sampleCameras as readonly string[]).includes(shot.camera));
  assert.match(shot.raw,/^(DSC_|_DSC)\d{4}\.NEF$/);assert.equal(shot.jpeg,shot.raw.replace(/NEF$/,'JPG'));assert.equal(shot.voiceMemo,shot.raw.replace(/NEF$/,'WAV'));
  assert.match(shot.video,/^(DSC_|_DSC)\d{4}\.(MOV|MP4)$/);assert.equal(Number(shot.video.slice(4,8)),Number(shot.raw.slice(4,8))+1,'the clip is the next number');
  assert.equal(mediaKindForPath(shot.raw),'RAW');assert.equal(mediaKindForPath(shot.jpeg),'JPEG');assert.equal(mediaKindForPath(shot.video),'Videos');
 }
 assert.equal(seen.size,sampleCameras.length,'every body comes up');
 assert.ok(sampleCameras.every(model=>/^NIKON /.test(model)),'only verified camera bodies, no phones or drones');
 assert.deepEqual([formatFolder('DSC_0001.NEF'),formatFolder('DSC_0001.JPG'),formatFolder('DSC_0002.MP4')],['NEF','JPEG','MP4']);
});
