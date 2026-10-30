import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {exclusiveRename} from '../platform/exclusive-rename';
import {nativeCameraHelperPath} from '../platform/camera-bridge';

async function fixture(t:test.TestContext){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'exclusive-rename-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source.JPG'),target=path.join(root,'target.JPG');
 await fs.writeFile(source,'source bytes');return {root,source,target};
}

test('native exclusive rename preserves the inode and refuses an occupied name',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),before=await fs.stat(f.source);
 await fs.writeFile(f.target,'other writer');
 await assert.rejects(exclusiveRename(f.source,f.target),{code:'EEXIST'});
 assert.equal(await fs.readFile(f.target,'utf8'),'other writer');
 assert.equal(await fs.readFile(f.source,'utf8'),'source bytes');
 await fs.unlink(f.target);await exclusiveRename(f.source,f.target);
 assert.equal((await fs.stat(f.target)).ino,before.ino);
 assert.equal(await fs.readFile(f.target,'utf8'),'source bytes');
 await assert.rejects(fs.stat(f.source),{code:'ENOENT'});
});

test('an older helper that exits without confirming a rename safely refuses',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),helper=path.join(f.root,'old-helper');
 await fs.writeFile(helper,'#!/bin/sh\nexit 0\n',{mode:0o700});
 const previous=process.env.IMPORTER_NATIVE_BRIDGE;
 process.env.IMPORTER_NATIVE_BRIDGE=helper;
 t.after(()=>{if(previous===undefined)delete process.env.IMPORTER_NATIVE_BRIDGE;else process.env.IMPORTER_NATIVE_BRIDGE=previous;});
 await assert.rejects(exclusiveRename(f.source,f.target),{code:'ENOTSUP'});
 assert.equal(await fs.readFile(f.source,'utf8'),'source bytes');
 await assert.rejects(fs.stat(f.target),{code:'ENOENT'});
});

test('an unavailable helper cannot move or overwrite files',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),previous=process.env.IMPORTER_NATIVE_BRIDGE;
 process.env.IMPORTER_NATIVE_BRIDGE=path.join(f.root,'missing-helper');
 t.after(()=>{if(previous===undefined)delete process.env.IMPORTER_NATIVE_BRIDGE;else process.env.IMPORTER_NATIVE_BRIDGE=previous;});
 await assert.rejects(exclusiveRename(f.source,f.target),{code:'ENOTSUP'});
 assert.equal(await fs.readFile(f.source,'utf8'),'source bytes');
 await assert.rejects(fs.stat(f.target),{code:'ENOENT'});
});

test('a symbolic destination parent cannot redirect an exclusive rename',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),other=path.join(f.root,'other'),alias=path.join(f.root,'alias');
 await fs.mkdir(other);await fs.symlink(other,alias);
 await assert.rejects(exclusiveRename(f.source,path.join(alias,'target.JPG')),error=>['ELOOP','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''));
 assert.equal(await fs.readFile(f.source,'utf8'),'source bytes');
 assert.deepEqual(await fs.readdir(other),[]);
});

for(const invalid of ['traversal','source replaced','source symlink','non-directory'] as const)test(`native rename refuses ${invalid} without moving any bytes`,{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),helper=await nativeCameraHelperPath();assert.ok(helper,'build the native helper before this test');
 const folder=await fs.open(f.root,constants.O_RDONLY|constants.O_DIRECTORY),input=await fs.open(f.source,'r');
 try{
  if(invalid==='source replaced'||invalid==='source symlink'){
   await fs.rename(f.source,path.join(f.root,'held.JPG'));
   if(invalid==='source replaced')await fs.writeFile(f.source,'replacement');else await fs.symlink('held.JPG',f.source);
  }
  const output=await new Promise<{status:number|null;out:string}>(resolve=>{
   const child=spawn(helper!,['--rename-exclusive',invalid==='traversal'?'../outside.JPG':'source.JPG','target.JPG'],{stdio:['ignore','pipe','ignore',invalid==='non-directory'?input.fd:folder.fd,folder.fd,input.fd]});let out='';
   child.stdout!.on('data',bytes=>{out+=bytes.toString();});child.on('close',status=>resolve({status,out}));
  });
  assert.equal(output.status,1);assert.equal(JSON.parse(output.out).errno,invalid==='traversal'||invalid==='non-directory'?22:70);
  assert.equal(await fs.readFile(f.source,'utf8'),invalid==='source replaced'?'replacement':'source bytes');
  await assert.rejects(fs.stat(f.target),{code:'ENOENT'});
 }finally{await input.close();await folder.close();}
});
