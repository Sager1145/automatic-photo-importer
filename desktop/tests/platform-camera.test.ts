import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cameraSources, closeCameraBridge, prepareCamera } from '../platform/camera-bridge';
import { sourceAware } from '../core/source-fs';
import { ownTemporaryFolder } from './fixtures/os';

// The helper protocol (list, files, read by range) is tested on every system in camera-direct.test.ts.
test('a USB camera reports its card slots, and its capacity is their sum', async () => {
  const { cameraCapacity } = await import('../platform/camera-bridge');
  assert.deepEqual(cameraCapacity([{name:'Slot 1',total:100,free:40},{name:'Slot 2',total:100,free:60}]), {storages:[{name:'Slot 1',total:100,free:40},{name:'Slot 2',total:100,free:60}],total:200,free:100});
  // One slot without figures: the slots are still listed, but no partial sum is shown as the camera's capacity.
  assert.deepEqual(cameraCapacity([{name:'Slot 1',total:100,free:40},{name:'Slot 2'}]), {storages:[{name:'Slot 1',total:100,free:40},{name:'Slot 2',total:undefined,free:undefined}],total:undefined,free:undefined});
  assert.deepEqual(cameraCapacity(undefined), {});
});

test('a camera with two card slots is two sources, each with a stable id, its own capacity and its own stage request', async () => {
  const { cameraSourcesFrom, cameraOf } = await import('../platform/camera-bridge');
  const zf={cameraID:'cam\\usb#1',name:'Z f',storages:[{id:'10001',name:'Slot 1',total:124642131968,free:93033594880},{id:'20001',name:'Slot 2',total:124642131968,free:79312322560}]};
  const sources=cameraSourcesFrom([zf]);
  assert.deepEqual(sources.map(source=>[source.id,source.name,source.total,source.free]),[['camera:cam\\usb#1|10001','Z f · Slot 1',124642131968,93033594880],['camera:cam\\usb#1|20001','Z f · Slot 2',124642131968,79312322560]]);
  assert.deepEqual(sources.map(source=>source.storage),[{id:'10001',name:'Slot 1',camera:'Z f'},{id:'20001',name:'Slot 2',camera:'Z f'}]);
  assert.ok(sources.every(source=>source.transport==='camera'&&source.storages===undefined));
  // The id follows the slot, not its position: listed the other way round, each slot keeps its id.
  assert.deepEqual(cameraSourcesFrom([{...zf,storages:[...zf.storages].reverse()}]).map(source=>source.id).sort(),sources.map(source=>source.id).sort());
  assert.deepEqual(cameraOf(sources[1]!),{cameraID:'cam\\usb#1',storageID:'20001'});
  // One storage: one source under the camera's own name and id, staging the whole camera.
  const [single]=cameraSourcesFrom([{cameraID:'x100',name:'X100VI',storages:[{id:'10000001',name:'External Memory',total:100,free:40}]}]);
  assert.deepEqual(single,{id:'camera:x100',name:'X100VI',path:'camera://x100',transport:'camera',storages:[{name:'External Memory',total:100,free:40}],total:100,free:40});
  assert.deepEqual(cameraOf(single!),{cameraID:'x100'});
  // Slots without ids (an older helper), or with the same id twice, cannot be told apart: the camera stays one source.
  assert.equal(cameraSourcesFrom([{...zf,storages:zf.storages.map(({id,...rest})=>rest)}]).length,1);
  assert.equal(cameraSourcesFrom([{...zf,storages:zf.storages.map(storage=>({...storage,id:'1'}))}]).length,1);
});

test('two slots of one camera, each a source: each lists and reads only its own slot, at once, with nothing staged', async t => {
  // A temporary folder of its own: test files running alongside add theirs to the system one.
  await ownTemporaryFolder(t);
  const scratch=await realpath(await mkdtemp(path.join(tmpdir(),'importer-camera-slots-')));
  const prior=process.env.IMPORTER_NATIVE_BRIDGE;
  const helper=path.join(scratch,'fake-camera.cjs');
  await writeFile(helper,`const rl=require('node:readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
rl.on('line',line=>{const c=JSON.parse(line);
 if(c.command==='list')send({id:c.id,result:[{cameraID:'zf',name:'Z f',storages:[{id:'1',name:'Slot 1'},{id:'2',name:'Slot 2'}]}]});
 else if(c.command==='files')send({id:c.id,result:['1','2'].filter(id=>!c.storageID||c.storageID===id).map(id=>({storage:'Slot '+id,folder:['DCIM'],name:'slot.txt',size:1,objectID:'o'+id}))});
 else if(c.command==='read'){const data=Buffer.from(c.objectID.slice(1)).subarray(c.offset,c.offset+c.length);send({id:c.id,result:{bytes:data.length,data:data.toString('base64')}});}
 else send({id:c.id,result:true});});`);
  process.env.IMPORTER_NATIVE_BRIDGE=helper;
  const files=sourceAware(fs),before=new Set(await readdir(tmpdir()));
  try {
    const sources=await cameraSources();
    assert.deepEqual(sources.map(source=>source.name),['Z f · Slot 1','Z f · Slot 2']);
    const opened=await Promise.all(sources.map(source=>prepareCamera(source)));
    assert.notEqual(opened[0]!.path,opened[1]!.path,'each slot is read under a folder of its own');
    assert.deepEqual(await Promise.all(opened.map((camera,index)=>files.readdir(path.join(camera.path,`Slot ${index+1}`,'DCIM')))),[['slot.txt'],['slot.txt']]);
    await assert.rejects(files.readdir(path.join(opened[0]!.path,'Slot 2')),{code:'ENOENT'},'Slot 1 lists only Slot 1');
    const first=async(file:string)=>{const handle=await files.open(file,'r');try{const buffer=Buffer.alloc(1);await handle.read(buffer,0,1,0);return buffer.toString();}finally{await handle.close();}};
    assert.deepEqual(await Promise.all(opened.map((camera,index)=>first(path.join(camera.path,`Slot ${index+1}`,'DCIM','slot.txt')))),['1','2']);
    for(const camera of opened)await camera.cleanup();
    assert.deepEqual((await readdir(tmpdir())).filter(name=>!before.has(name)&&/photo-importer/i.test(name)),[]);
  }finally{await closeCameraBridge();if(prior===undefined)delete process.env.IMPORTER_NATIVE_BRIDGE;else process.env.IMPORTER_NATIVE_BRIDGE=prior;await rm(scratch,{recursive:true,force:true});}
});

test('a camera read only in part says so, and a camera on USB that the system never offered is no source', async () => {
  const { cameraSourcesFrom, unansweredCameras } = await import('../platform/camera-bridge');
  const listed=[{cameraID:'zf',name:'Z f',problem:'cardsUnknown'},{cameraID:'x',name:'X100VI',storages:[{id:'10000001',name:'External Memory',total:128,free:120}]},{cameraID:'usb:2228224',name:'NIKON DSC Z f',unanswered:true}];
  const sources=cameraSourcesFrom(listed);
  assert.deepEqual(sources.map(source=>[source.name,source.cameraProblem??'',source.total??'']),[['Z f','cardsUnknown',''],['X100VI','',128]]);
  assert.deepEqual(unansweredCameras(listed),['NIKON DSC Z f']);
  // Anything else in "problem" is ignored.
  assert.equal(cameraSourcesFrom([{cameraID:'a',name:'A',problem:'other'}])[0]!.cameraProblem,undefined);
});
