import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cameraSources, closeCameraBridge, prepareCamera } from '../platform/camera-bridge';

test('native camera protocol stages only into its own temporary folder and aborts safely', {skip:process.platform!=='darwin'}, async () => {
  const scratch=await mkdtemp(path.join(tmpdir(),'importer-camera-protocol-'));
  const prior=process.env.IMPORTER_NATIVE_BRIDGE;
  const helper=path.join(scratch,'fake-camera');
  await writeFile(helper,`#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const rl=require('node:readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');rl.on('line',line=>{const c=JSON.parse(line);if(c.command==='list')send({id:c.id,result:[{cameraID:'fixture',name:'Fixture Camera'}]});else if(c.cameraID==='escape')send({id:c.id,result:{path:require('node:os').tmpdir()}});else if(c.cameraID==='hold')send({id:c.id,progress:{completed:0,total:1}});else{const dir=path.join(c.directory,'camera-fixture');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'test.jpg'),'fixture');send({id:c.id,result:{path:dir}});}});`);
  await chmod(helper,0o700);process.env.IMPORTER_NATIVE_BRIDGE=helper;
  try {
    const [source]=await cameraSources();assert.equal(source.transport,'camera');assert.equal(source.id,'camera:fixture');assert.equal(source.camera,undefined,'a camera over USB says nothing about DCIM folders');assert.equal(source.path,'camera://fixture');
    const stage=await prepareCamera(source);assert.equal((await stat(path.join(stage.path,'test.jpg'))).size,7);
    await stage.cleanup();await assert.rejects(stat(stage.path));
    await assert.rejects(prepareCamera({...source,path:'camera://escape'}),/unsafe/);
    const controller=new AbortController();
    await assert.rejects(prepareCamera({...source,path:'camera://hold'},controller.signal,()=>controller.abort()));
    assert.equal(controller.signal.aborted,true);
    assert.equal((await stat(scratch)).isDirectory(),true);
  }finally{closeCameraBridge();if(prior===undefined)delete process.env.IMPORTER_NATIVE_BRIDGE;else process.env.IMPORTER_NATIVE_BRIDGE=prior;await rm(scratch,{recursive:true,force:true});}
});

test('a USB camera reports its card slots, and its capacity is their sum', async () => {
  const { cameraCapacity } = await import('../platform/camera-bridge');
  assert.deepEqual(cameraCapacity([{name:'Slot 1',total:100,free:40},{name:'Slot 2',total:100,free:60}]), {storages:[{name:'Slot 1',total:100,free:40},{name:'Slot 2',total:100,free:60}],total:200,free:100});
  // One slot without figures: the slots are still listed, but no partial sum is shown as the camera's capacity.
  assert.deepEqual(cameraCapacity([{name:'Slot 1',total:100,free:40},{name:'Slot 2'}]), {storages:[{name:'Slot 1',total:100,free:40},{name:'Slot 2',total:undefined,free:undefined}],total:undefined,free:undefined});
  assert.deepEqual(cameraCapacity(undefined), {});
});

test('a camera with two card slots is two sources, each with a stable id, its own capacity and its own stage request', async () => {
  const { cameraSourcesFrom, stageRequest } = await import('../platform/camera-bridge');
  const zf={cameraID:'cam\\usb#1',name:'Z f',storages:[{id:'10001',name:'Slot 1',total:124642131968,free:93033594880},{id:'20001',name:'Slot 2',total:124642131968,free:79312322560}]};
  const sources=cameraSourcesFrom([zf]);
  assert.deepEqual(sources.map(source=>[source.id,source.name,source.total,source.free]),[['camera:cam\\usb#1|10001','Z f · Slot 1',124642131968,93033594880],['camera:cam\\usb#1|20001','Z f · Slot 2',124642131968,79312322560]]);
  assert.deepEqual(sources.map(source=>source.storage),[{id:'10001',name:'Slot 1',camera:'Z f'},{id:'20001',name:'Slot 2',camera:'Z f'}]);
  assert.ok(sources.every(source=>source.transport==='camera'&&source.storages===undefined));
  // The id follows the slot, not its position: listed the other way round, each slot keeps its id.
  assert.deepEqual(cameraSourcesFrom([{...zf,storages:[...zf.storages].reverse()}]).map(source=>source.id).sort(),sources.map(source=>source.id).sort());
  assert.deepEqual(stageRequest(sources[1]!,'/tmp/x'),{command:'stage',cameraID:'cam\\usb#1',storageID:'20001',directory:'/tmp/x'});
  // One storage: one source under the camera's own name and id, staging the whole camera.
  const [single]=cameraSourcesFrom([{cameraID:'x100',name:'X100VI',storages:[{id:'10000001',name:'External Memory',total:100,free:40}]}]);
  assert.deepEqual(single,{id:'camera:x100',name:'X100VI',path:'camera://x100',transport:'camera',storages:[{name:'External Memory',total:100,free:40}],total:100,free:40});
  assert.deepEqual(stageRequest(single!,'/tmp/x'),{command:'stage',cameraID:'x100',directory:'/tmp/x'});
  // Slots without ids (an older helper), or with the same id twice, cannot be told apart: the camera stays one source.
  assert.equal(cameraSourcesFrom([{...zf,storages:zf.storages.map(({id,...rest})=>rest)}]).length,1);
  assert.equal(cameraSourcesFrom([{...zf,storages:zf.storages.map(storage=>({...storage,id:'1'}))}]).length,1);
});

test('two slots of one camera are staged one after another', {skip:process.platform!=='darwin'}, async () => {
  const scratch=await mkdtemp(path.join(tmpdir(),'importer-camera-slots-'));
  const prior=process.env.IMPORTER_NATIVE_BRIDGE;
  const helper=path.join(scratch,'fake-camera');
  await writeFile(helper,`#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const rl=require('node:readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');let busy=false;rl.on('line',line=>{const c=JSON.parse(line);if(c.command==='list')send({id:c.id,result:[{cameraID:'zf',name:'Z f',storages:[{id:'1',name:'Slot 1'},{id:'2',name:'Slot 2'}]}]});else{if(busy){send({id:c.id,error:'An import is already running for this camera.'});return;}busy=true;setTimeout(()=>{const dir=path.join(c.directory,'camera-'+c.storageID);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'slot.txt'),String(c.storageID));busy=false;send({id:c.id,result:{path:dir}});},200);}});`);
  await chmod(helper,0o700);process.env.IMPORTER_NATIVE_BRIDGE=helper;
  try {
    const sources=await cameraSources();
    assert.deepEqual(sources.map(source=>source.name),['Z f · Slot 1','Z f · Slot 2']);
    const stages=await Promise.all(sources.map(source=>prepareCamera(source)));
    assert.deepEqual(await Promise.all(stages.map(stage=>import('node:fs/promises').then(fs=>fs.readFile(path.join(stage.path,'slot.txt'),'utf8')))),['1','2']);
    for(const stage of stages)await stage.cleanup();
  }finally{await closeCameraBridge();if(prior===undefined)delete process.env.IMPORTER_NATIVE_BRIDGE;else process.env.IMPORTER_NATIVE_BRIDGE=prior;await rm(scratch,{recursive:true,force:true});}
});
