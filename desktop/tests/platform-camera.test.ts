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
  await writeFile(helper,`#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const rl=require('node:readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');rl.on('line',line=>{const c=JSON.parse(line);if(c.command==='list')send({id:c.id,result:[{id:'camera:fixture',cameraID:'fixture',name:'Fixture Camera'}]});else if(c.cameraID==='escape')send({id:c.id,result:{path:require('node:os').tmpdir()}});else if(c.cameraID==='hold')send({id:c.id,progress:{completed:0,total:1}});else{const dir=path.join(c.directory,'camera-fixture');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'test.jpg'),'fixture');send({id:c.id,result:{path:dir}});}});`);
  await chmod(helper,0o700);process.env.IMPORTER_NATIVE_BRIDGE=helper;
  try {
    const [source]=await cameraSources();assert.equal(source.transport,'camera');assert.equal(source.path,'camera://fixture');
    const stage=await prepareCamera(source);assert.equal((await stat(path.join(stage.path,'test.jpg'))).size,7);
    await stage.cleanup();await assert.rejects(stat(stage.path));
    await assert.rejects(prepareCamera({...source,path:'camera://escape'}),/unsafe/);
    const controller=new AbortController();
    await assert.rejects(prepareCamera({...source,path:'camera://hold'},controller.signal,()=>controller.abort()));
    assert.equal(controller.signal.aborted,true);
    assert.equal((await stat(scratch)).isDirectory(),true);
  }finally{closeCameraBridge();if(prior===undefined)delete process.env.IMPORTER_NATIVE_BRIDGE;else process.env.IMPORTER_NATIVE_BRIDGE=prior;await rm(scratch,{recursive:true,force:true});}
});
