import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {plan,execute} from '../core';

async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'verification-reads-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),root=path.join(base,'destination'),original=path.join(source,'original.bin'),data=Buffer.alloc(4*1024*1024,7);
 await fs.mkdir(source);await fs.mkdir(root);await fs.writeFile(original,data);
 const {plans:[transfer]}=await plan(source,[root],{backup:true,template:'{camera}',separateMedia:false,unknownRules:{}},async()=>({fields:{}}));
 return {source,root,original,data,transfer};
}

// Streaming hashes the bytes it stages and staging is reread once from disk. A
// hard link publishes that verified inode, so neither the source nor the
// published name needs another full read.
test('a hard-linked copy reads its source once and its staged bytes once',async t=>{
 const f=await fixture(t),read={source:0,stage:0,target:0};
 const open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args),file=String(args[0]);
  const kind=file===f.original?'source':file.startsWith(f.root+path.sep)?file.endsWith('.partial')?'stage':'target':undefined;
  if(kind){const original=handle.read.bind(handle);t.mock.method(handle,'read',async(...values:Parameters<typeof handle.read>)=>{const result=await original(...values);read[kind]+=result.bytesRead;return result;});}
  return handle;
 });syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const result=await execute(f.transfer);
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.deepEqual(result,{copied:1,skipped:0,errors:[]});
 assert.deepEqual(read,{source:f.data.length,stage:f.data.length,target:0});
 assert.deepEqual(await fs.readFile(path.join(f.root,'original.bin')),f.data);
});

test('a source replaced after streaming is rejected before publication',async t=>{
 const f=await fixture(t),replacement=Buffer.alloc(f.data.length,9);let replaced=false;
 const result=await execute(f.transfer,undefined,value=>{if(value.phase==='verifying'&&!replaced){replaced=true;writeFileSync(f.original,replacement);}});
 assert.equal(replaced,true);assert.equal(result.copied,0);assert.equal(result.errors.length,1);assert.match(result.errors[0],/Source changed/);
 await assert.rejects(fs.lstat(path.join(f.root,'original.bin')),{code:'ENOENT'});
 assert.deepEqual(await fs.readFile(f.original),replacement);
});

test('with verification after copy turned off, staged bytes are not read again',async t=>{
 const f=await fixture(t),read={source:0,stage:0,target:0};
 const open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args),file=String(args[0]);
  const kind=file===f.original?'source':file.startsWith(f.root+path.sep)?file.endsWith('.partial')?'stage':'target':undefined;
  if(kind){const original=handle.read.bind(handle);t.mock.method(handle,'read',async(...values:Parameters<typeof handle.read>)=>{const result=await original(...values);read[kind]+=result.bytesRead;return result;});}
  return handle;
 });syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const result=await execute(f.transfer,undefined,undefined,{verify:false});
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.deepEqual(result,{copied:1,skipped:0,errors:[]});
 assert.deepEqual(read,{source:f.data.length,stage:0,target:0});
 assert.deepEqual(await fs.readFile(path.join(f.root,'original.bin')),f.data);
});
