import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {folderCapacity} from '../platform/volumes';
import {driveCameraRecord} from '../source-cameras';
import {recordDeviceHistory} from '../device-selection';
import {normalizePreferences} from '../preferences';
import {RememberedDrives} from '../renderer/RootApp';
import {I18nProvider,languages,createTranslator} from '../renderer/i18n';
import type {Preferences,Source,SourceCameraInfo} from '../shared';

test('a chosen folder reports the capacity of the volume it lives on',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'folder-capacity-'));
 try{
  const capacity=await folderCapacity(folder);
  assert.ok(capacity.total!>0,'total space is known');
  assert.ok(capacity.free!>=0&&capacity.free!<=capacity.total!,'free space is within the total');
  assert.deepEqual(await folderCapacity(path.join(folder,'missing')),{},'an unreadable folder has no capacity');
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});

const info:SourceCameraInfo={status:'complete',hints:[{name:'Nikon',evidence:'drive-name'}],issues:[{path:'/Volumes/CARD/a.NEF',message:'bad'}],models:[{name:'NIKON Z f',files:120,bytes:3_000_000_000},{name:'NIKON Z6III',files:4,bytes:100_000_000}],lenses:[{name:'NIKKOR Z 40mm f/2',files:100,bytes:2_500_000_000}],noLens:24,checked:124,total:124,unknown:0};

test('the last scan keeps only the EXIF camera summary, and nothing while it is still reading',()=>{
 const record=driveCameraRecord(info,'2026-10-22T09:00:00.000Z');
 assert.deepEqual(record,{scanned:'2026-10-22T09:00:00.000Z',status:'complete',checked:124,total:124,unknown:0,models:info.models,lenses:info.lenses});
 assert.equal(driveCameraRecord({...info,status:'reading'},'2026-10-22T09:00:00.000Z'),undefined);
 assert.equal(driveCameraRecord(undefined,'2026-10-22T09:00:00.000Z'),undefined);
});

test('a finished scan stores its cameras in the device history and a later scan without them clears the old ones',()=>{
 const source:Source={id:'UUID-CARD',name:'NIKON Z F',path:'/Volumes/NIKON Z F',transport:'storage'};
 const history:NonNullable<Preferences['deviceHistory']>={};
 const record=driveCameraRecord(info,'2026-10-22T09:00:00.000Z');
 recordDeviceHistory(history,source,'scan','2026-10-22T09:00:00.000Z',record);
 assert.deepEqual(history['UUID-CARD'],{name:'NIKON Z F',lastScanCompleted:'2026-10-22T09:00:00.000Z',cameras:record});
 recordDeviceHistory(history,source,'import','2026-10-22T10:00:00.000Z');
 assert.deepEqual(history['UUID-CARD']!.cameras,record,'an import keeps the scan result');
 recordDeviceHistory(history,source,'scan','2026-10-23T09:00:00.000Z');
 assert.equal(history['UUID-CARD']!.cameras,undefined,'a scan without camera data does not keep stale data');
});

test('saved camera summaries survive loading and malformed ones are dropped',()=>{
 const record=driveCameraRecord(info,'2026-10-22T09:00:00.000Z')!;
 const loaded=normalizePreferences({deviceHistory:{good:{name:'Good',cameras:record},bad:{name:'Bad',cameras:{models:'x'}},odd:{name:'Odd',cameras:{...record,models:[{name:'A',files:'1',bytes:2},{name:'B',files:1,bytes:2}]}}}});
 assert.deepEqual(loaded.deviceHistory!.good!.cameras,record);
 assert.equal(loaded.deviceHistory!.bad!.cameras,undefined);
 assert.deepEqual(loaded.deviceHistory!.odd!.cameras!.models,[{name:'B',files:1,bytes:2}]);
});

test('each remembered drive has details with the cameras from its last scan in every language',()=>{
 const record=driveCameraRecord(info,'2026-10-22T09:00:00.000Z')!;
 const preferences=normalizePreferences({rememberedDevices:{'UUID-CARD':{name:'NIKON Z F',lastSelected:'2026-10-22T08:00:00.000Z'},'UUID-NEW':{name:'SD_Card',lastSelected:'2026-10-21T08:00:00.000Z'}},deviceHistory:{'UUID-CARD':{name:'NIKON Z F',lastScanCompleted:'2026-10-22T09:00:00.000Z',cameras:record}}});
 for(const language of languages){
  const t=createTranslator(language);
  const markup=renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(RememberedDrives,{preferences,act:()=>{}})}));
  const panels=[...markup.matchAll(/<details[^>]*data-testid="remembered-drive-details"[^>]*data-device-id="([^"]+)"[\s\S]*?<\/details>/g)];
  assert.deepEqual(panels.map(panel=>panel[1]),['UUID-CARD','UUID-NEW'],`${language}: one details panel per remembered drive`);
  const card=panels[0]![0],fresh=panels[1]![0];
  assert.ok(card.includes(t('Details')),`${language}: details label`);
  for(const name of ['NIKON Z f','NIKON Z6III','NIKKOR Z 40mm f/2'])assert.ok(card.includes(name),`${language}: ${name}`);
  assert.ok(card.includes(t('{count} files',{count:'120'})),`${language}: files per camera`);
  assert.ok(/data-camera-bytes="3000000000"/.test(card),`${language}: bytes per camera`);
  assert.ok(card.includes(t('Camera metadata checked: {checked}/{total}',{checked:'124',total:'124'})),`${language}: how many files were read`);
  assert.ok(/data-testid="drive-scan-time"/.test(card),`${language}: scan time`);
  assert.ok(fresh.includes(t('No camera data from a scan yet. Scan this drive to see its cameras.')),`${language}: drive never scanned`);
 }
});
