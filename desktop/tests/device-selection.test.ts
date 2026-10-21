import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceSelection,deviceId} from '../device-selection';
import type {Preferences,Source} from '../shared';

type Remembered=NonNullable<Preferences['rememberedDevices']>;
const card:Source={id:'6A1F-UUID-CARD',name:'NIKON Z F',path:'/Volumes/NIKON Z F',transport:'storage'};
const ssd:Source={id:'9C3D-UUID-SSD',name:'PMHOME',path:'/Volumes/PMHOME',transport:'storage'};
const camera:Source={id:'camera:0x1234',name:'Z f',path:'camera://0x1234',transport:'camera'};
const folder:Source={id:'folder:/Users/me/Photos',name:'Photos',path:'/Users/me/Photos',transport:'folder'};

test('stable device ids come from volume UUIDs and camera ids, never from mount paths or folders',()=>{
 assert.equal(deviceId(card),'6A1F-UUID-CARD');assert.equal(deviceId(camera),'camera:0x1234');
 assert.equal(deviceId({...card,id:'/Volumes/Untitled'}),undefined);
 assert.equal(deviceId(folder),undefined);
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
