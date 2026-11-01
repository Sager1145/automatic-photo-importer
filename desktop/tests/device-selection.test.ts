import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceSelection,deviceId,deviceRecord,recordDeviceHistory,wholeCameraId} from '../device-selection';
import {normalizePreferences} from '../preferences';
import type {Preferences,Source} from '../shared';

type Remembered=NonNullable<Preferences['rememberedDevices']>;
const card:Source={id:'6A1F-UUID-CARD',name:'NIKON Z F',path:'/Volumes/NIKON Z F',transport:'storage'};
const ssd:Source={id:'9C3D-UUID-SSD',name:'PMHOME',path:'/Volumes/PMHOME',transport:'storage'};
const camera:Source={id:'camera:0x1234',name:'Z f',path:'camera://0x1234',transport:'camera'};
const folder:Source={id:'folder:/Users/me/Photos',name:'Photos',path:'/Users/me/Photos',transport:'folder'};

test('stable device ids come from volume UUIDs and camera ids, never from mount paths or folders',()=>{
 assert.equal(deviceId(card),'6A1F-UUID-CARD');assert.equal(deviceId(camera),'camera:0x1234');
 assert.equal(deviceId({...card,id:'/Volumes/Untitled',path:'/Volumes/Untitled'}),undefined);
 assert.equal(deviceId(folder),undefined);
 assert.equal(deviceId({...card,id:'E:\\',path:'E:\\'}),undefined,'a volume without a UUID keeps its path as its id');
});

test('a drive without a volume UUID is never remembered, ignored or recorded',()=>{
 const remembered:Remembered={},ignored:NonNullable<Preferences['ignoredDevices']>={},history:NonNullable<Preferences['deviceHistory']>={};
 const untitled:Source={id:'E:\\',name:'Untitled',path:'E:\\',transport:'storage'},selection=new DeviceSelection();
 selection.apply([untitled],remembered,ignored,history);
 selection.select(untitled,true,remembered,'2026-10-23T10:00:00.000Z',ignored);
 selection.select(untitled,false,remembered,'2026-10-23T10:01:00.000Z',ignored);
 recordDeviceHistory(history,untitled,'import','2026-10-23T10:02:00.000Z');
 assert.deepEqual([remembered,ignored,history],[{},{},{}]);
});

test('device keys saved from a mount path or a diskN identifier are dropped when settings are read',()=>{
 const entry={name:'Card',lastSelected:'2026-10-01T00:00:00.000Z'},seen={name:'Card',ignoredAt:'2026-10-01T00:00:00.000Z'};
 const preferences=normalizePreferences({
  rememberedDevices:{'/Volumes/Untitled':entry,'disk4s1':entry,'E:\\':entry,'6A1F-UUID-CARD':entry,'camera:0x1234':entry},
  ignoredDevices:{'/dev/sdb1':seen,'9C3D-UUID-SSD':seen},
  deviceHistory:{'disk5s2':{name:'Old'},'9C3D-UUID-SSD':{name:'PMHOME'}}});
 assert.deepEqual(Object.keys(preferences.rememberedDevices!),['6A1F-UUID-CARD','camera:0x1234']);
 assert.deepEqual(Object.keys(preferences.ignoredDevices!),['9C3D-UUID-SSD']);
 assert.deepEqual(Object.keys(preferences.deviceHistory!),['9C3D-UUID-SSD']);
});

test('a chosen folder that the system then detects as a volume stays selected under the volume id',()=>{
 const remembered:Remembered={},selection=new DeviceSelection();
 const mounted:Source={id:'folder:/Volumes/PMHOME',name:'PMHOME',path:'/Volumes/PMHOME',transport:'folder'};
 assert.equal(selection.apply([mounted],remembered)[0]!.selected,true);
 selection.replace(mounted.id,ssd.id);
 assert.deepEqual(selection.apply([ssd],remembered).map(source=>source.selected),[true]);
 assert.deepEqual(selection.newDevices,[],'it is not announced as a new drive');
});

test('new drives start deselected and are announced once; remembered drives start selected',()=>{
 const remembered:Remembered={'6A1F-UUID-CARD':{name:'NIKON Z F',lastSelected:'2026-10-20T10:00:00.000Z'}};
 const selection=new DeviceSelection();
 const sources=selection.apply([card,ssd,camera,folder],remembered);
 assert.deepEqual(sources.map(source=>[source.id,source.selected]),[['6A1F-UUID-CARD',true],['9C3D-UUID-SSD',false],['camera:0x1234',false],['folder:/Users/me/Photos',true]]);
 assert.deepEqual(selection.newDevices,['9C3D-UUID-SSD','camera:0x1234']);
 selection.apply([card,ssd,camera,folder],remembered);
 assert.deepEqual(selection.newDevices,['9C3D-UUID-SSD','camera:0x1234'],'announced once per connection');
 selection.apply([card,folder],remembered);
 assert.deepEqual(selection.newDevices,[],'cleared on disconnect');
 assert.deepEqual(selection.apply([card,ssd],remembered).map(source=>source.selected),[true,false]);
 assert.deepEqual(selection.newDevices,['9C3D-UUID-SSD'],'a reconnection is announced again');
});

test('selecting remembers the device; deselecting or forgetting revokes it',()=>{
 const remembered:Remembered={},selection=new DeviceSelection();
 selection.apply([ssd,card],remembered);
 selection.select(ssd,true,remembered,'2026-10-21T04:00:00.000Z');
 assert.deepEqual(remembered,{'9C3D-UUID-SSD':{name:'PMHOME',lastSelected:'2026-10-21T04:00:00.000Z'}});
 assert.deepEqual(selection.newDevices,['6A1F-UUID-CARD']);
 assert.equal(selection.apply([ssd,card],remembered)[0]!.selected,true);
 selection.select(ssd,false,remembered,'2026-10-21T04:01:00.000Z');
 assert.deepEqual(remembered,{});assert.equal(selection.apply([ssd,card],remembered)[0]!.selected,false);
 selection.select(card,true,remembered,'2026-10-21T04:02:00.000Z');
 selection.forget('6A1F-UUID-CARD',remembered);
 assert.deepEqual(remembered,{});
 assert.equal(selection.apply([ssd,card],remembered)[1]!.selected,false,'forgetting deselects the connected drive');
 const fresh=new DeviceSelection();
 assert.equal(fresh.apply([card],remembered)[0]!.selected,false,'a forgotten drive is new again next session');
});

test('deselecting a drive ignores it: it stays deselected without a popup until the user stops ignoring it',()=>{
 const remembered:Remembered={},ignored:NonNullable<Preferences['ignoredDevices']>={},selection=new DeviceSelection();
 selection.apply([ssd],remembered,ignored);
 selection.select(ssd,false,remembered,'2026-10-21T05:00:00.000Z',ignored);
 assert.deepEqual(ignored,{'9C3D-UUID-SSD':{name:'PMHOME',ignoredAt:'2026-10-21T05:00:00.000Z'}});
 const next=new DeviceSelection();
 assert.equal(next.apply([ssd],remembered,ignored)[0]!.selected,false);
 assert.deepEqual(next.newDevices,[],'an ignored drive does not ask again');
 next.select(ssd,true,remembered,'2026-10-21T05:01:00.000Z',ignored);
 assert.deepEqual(ignored,{});assert.ok(remembered['9C3D-UUID-SSD']);
 next.select(ssd,false,remembered,'2026-10-21T05:02:00.000Z',ignored);
 next.forget('9C3D-UUID-SSD',remembered,ignored);
 assert.deepEqual([remembered,ignored],[{},{}]);
 const later=new DeviceSelection();later.apply([ssd],remembered,ignored);
 assert.deepEqual(later.newDevices,['9C3D-UUID-SSD'],'after stop-ignoring it is asked about again');
});

test('a re-plugged drive with history or a remembered choice is announced as reconnected, once per connection',()=>{
 const remembered:Remembered={'6A1F-UUID-CARD':{name:'NIKON Z F',lastSelected:'2026-10-20T10:00:00.000Z'}};
 const history:NonNullable<Preferences['deviceHistory']>={'9C3D-UUID-SSD':{name:'PMHOME',lastScanCompleted:'2026-10-21T09:00:00.000Z'}};
 const selection=new DeviceSelection();
 selection.apply([card,ssd,camera,folder],remembered,{},history);
 assert.deepEqual(selection.reconnectedDevices,['6A1F-UUID-CARD','9C3D-UUID-SSD']);
 assert.deepEqual(selection.newDevices,['9C3D-UUID-SSD','camera:0x1234'],'a drive the user never answered for still needs a choice');
 selection.dismissReconnected('6A1F-UUID-CARD');
 selection.apply([card,ssd,camera,folder],remembered,{},history);
 assert.deepEqual(selection.reconnectedDevices,['9C3D-UUID-SSD'],'dismissed drives stay dismissed while connected');
 // Unplugged and plugged in again: announced again.
 selection.apply([ssd],remembered,{},history);
 assert.deepEqual(selection.reconnectedDevices,['9C3D-UUID-SSD']);
 selection.apply([card,ssd],remembered,{},history);
 assert.deepEqual(selection.reconnectedDevices,['9C3D-UUID-SSD','6A1F-UUID-CARD']);
 selection.dismissReconnected();
 assert.deepEqual(selection.reconnectedDevices,[]);
});

test('device history records completed scans and verified imports per device',()=>{
 const history:NonNullable<Preferences['deviceHistory']>={};
 recordDeviceHistory(history,card,'scan','2026-10-21T09:00:00.000Z');
 recordDeviceHistory(history,card,'import','2026-10-21T10:00:00.000Z');
 recordDeviceHistory(history,folder,'import','2026-10-21T10:00:00.000Z');
 assert.deepEqual(history,{'6A1F-UUID-CARD':{name:'NIKON Z F',lastScanCompleted:'2026-10-21T09:00:00.000Z',lastImportVerified:'2026-10-21T10:00:00.000Z'}});
});

test('a source dropped from the app leaves the selection and both announcement lists',()=>{
 const selection=new DeviceSelection();
 const folder:Source={id:'folder:/a',name:'A',path:'/a',transport:'folder'};
 selection.apply([folder],{});
 selection.newDevices.push(folder.id);selection.reconnectedDevices.push(folder.id);
 selection.drop(folder.id);
 assert.deepEqual([selection.newDevices,selection.reconnectedDevices],[[],[]]);
 assert.equal(selection.apply([folder],{})[0]!.selected,true,'chosen again later, it starts from its defaults');
});

test('card slots of a camera chosen before slots were sources follow that choice until decided one by one',()=>{
 const slot=(id:string,name:string):Source=>({id:`camera:0x1234|${id}`,name:`Z f · ${name}`,path:`camera://0x1234/${id}`,transport:'camera',storage:{id,name,camera:'Z f'}});
 const [one,two]=[slot('10001','Slot 1'),slot('20001','Slot 2')];
 assert.equal(deviceId(one),'camera:0x1234|10001');assert.equal(wholeCameraId(one),'camera:0x1234');assert.equal(wholeCameraId(camera),undefined);
 const now='2026-11-01T10:00:00.000Z';
 // The whole camera was remembered: both slots start selected, unannounced as new, and read as reconnected.
 const remembered:Remembered={'camera:0x1234':{name:'Z f',lastSelected:now}};
 let selection=new DeviceSelection();
 assert.deepEqual(selection.apply([one,two],remembered).map(source=>source.selected),[true,true]);
 assert.deepEqual(selection.newDevices,[]);assert.deepEqual(selection.reconnectedDevices,[one.id,two.id]);
 // Turning one slot off is saved for that slot alone; the other keeps following the camera.
 const ignored:NonNullable<Preferences['ignoredDevices']>={};
 selection.select(two,false,remembered,now,ignored);
 assert.ok(two.id in ignored);assert.ok('camera:0x1234' in remembered);
 selection=new DeviceSelection();
 assert.deepEqual(selection.apply([one,two],remembered,ignored).map(source=>source.selected),[true,false]);
 assert.deepEqual(selection.newDevices,[]);
 // The whole camera was ignored: its slots start off without asking.
 selection=new DeviceSelection();
 assert.deepEqual(selection.apply([one,two],{},{'camera:0x1234':{name:'Z f',ignoredAt:now}}).map(source=>source.selected),[false,false]);
 assert.deepEqual(selection.newDevices,[]);
 // Never decided: each slot is a new device of its own.
 selection=new DeviceSelection();selection.apply([one,two],{});
 assert.deepEqual(selection.newDevices,[one.id,two.id]);
 // History recorded for the whole camera is shown for a slot, and carried into the slot's own first record.
 const history:NonNullable<Preferences['deviceHistory']>={'camera:0x1234':{name:'Z f',lastImportVerified:now}};
 assert.equal(deviceRecord(history,one)?.lastImportVerified,now);
 const later='2026-11-02T10:00:00.000Z';
 recordDeviceHistory(history,one,'scan',later);
 assert.deepEqual(history[one.id],{name:'Z f · Slot 1',lastImportVerified:now,lastScanCompleted:later});
 assert.deepEqual(history['camera:0x1234'],{name:'Z f',lastImportVerified:now});
});
