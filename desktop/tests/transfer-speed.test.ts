import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {plan,execute,inventory} from '../core';
import {executeDestinations} from '../core/destinations';
import {dropDestinationIndexes} from '../core/destination-index';

const options={backup:true,template:'{camera}',layout:'flat' as const,unknownRules:{}};
const noMetadata=async()=>({fields:{}});
async function fixture(t:test.TestContext,destinations=1){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'transfer-speed-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'card'),roots=Array.from({length:destinations},(_,index)=>path.join(base,`disk-${index+1}`)),original=path.join(source,'DCIM','original.bin'),data=Buffer.alloc(2*1024*1024);
 for(let index=0;index<data.length;index++)data[index]=(index*31+Math.floor(index/4093)*17)%251;
 await fs.mkdir(path.dirname(original),{recursive:true});for(const root of roots)await fs.mkdir(root);await fs.writeFile(original,data);
 return {base,source,roots,original,data};
}
/** Count bytes read through fs.open handles, grouped by what was opened. */
function countReads(t:test.TestContext,original:string,roots:string[]){
 const read={source:0,stage:0,target:0};
 const open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args),file=String(args[0]);
  const kind=file===original?'source':roots.some(root=>file.startsWith(root+path.sep))?file.endsWith('.partial')?'stage':path.basename(file).startsWith('.photo-importer-index')?undefined:'target':undefined;
  if(kind){const reader=handle.read.bind(handle);t.mock.method(handle,'read',async(...values:Parameters<typeof handle.read>)=>{const result=await reader(...values);read[kind]+=result.bytesRead;return result;});}
  return handle;
 });syncBuiltinESMExports();
 const stop=()=>{t.mock.restoreAll();syncBuiltinESMExports();};t.after(stop);
 return {read,stop};
}

test('planning a new file reads nothing from the card; copying reads it once',async t=>{
 const f=await fixture(t),{read,stop}=countReads(t,f.original,f.roots);
 const {plans:[transfer]}=await plan(f.source,f.roots,options,noMetadata);
 assert.equal(transfer!.entries[0]!.digest,undefined);
 assert.deepEqual(read,{source:0,stage:0,target:0});
 assert.deepEqual(await execute(transfer!),{copied:1,skipped:0,errors:[]});
 stop();
 assert.deepEqual(read,{source:f.data.length,stage:f.data.length,target:0});
 assert.deepEqual(await fs.readFile(path.join(f.roots[0]!,'DCIM','original.bin')),f.data);
});

test('copying to two destinations reads the card once and verifies each copy',async t=>{
 const f=await fixture(t,2),{read,stop}=countReads(t,f.original,f.roots);
 const {plans}=await plan(f.source,f.roots,options,noMetadata);
 const result=await executeDestinations(plans,{signal:new AbortController().signal,reorganize:false,validate:async()=>{},progress:()=>{},settled:()=>{}});
 stop();
 assert.equal(result.copied,2);assert.deepEqual(result.errors,[]);
 assert.deepEqual(read,{source:f.data.length,stage:2*f.data.length,target:0});
 for(const root of f.roots)assert.deepEqual(await fs.readFile(path.join(root,'DCIM','original.bin')),f.data);
});

test('re-importing an unchanged copy reads the card once and the destination not at all',async t=>{
 const f=await fixture(t);
 await execute((await plan(f.source,f.roots,options,noMetadata)).plans[0]!);
 const {read,stop}=countReads(t,f.original,f.roots);
 const {plans:[again]}=await plan(f.source,f.roots,options,noMetadata);
 assert.ok(again!.entries.every(entry=>entry.skip&&entry.digest));
 assert.deepEqual(await execute(again!),{copied:0,skipped:1,errors:[]});
 stop();
 assert.deepEqual(read,{source:f.data.length,stage:0,target:0});
});

test('a touched or replaced destination file is hashed again instead of trusted',async t=>{
 const f=await fixture(t),copy=path.join(f.roots[0]!,'DCIM','original.bin');
 await execute((await plan(f.source,f.roots,options,noMetadata)).plans[0]!);
 await fs.utimes(copy,new Date(),new Date());
 let counter=countReads(t,f.original,f.roots);
 const touched=(await plan(f.source,f.roots,options,noMetadata)).plans[0]!;
 counter.stop();
 assert.ok(touched.entries[0]!.skip);assert.equal(counter.read.target,f.data.length);
 const different=Buffer.from(f.data);different[0]=different[0]!^1;
 await fs.rm(copy);await fs.writeFile(copy,different);
 counter=countReads(t,f.original,f.roots);
 const replaced=(await plan(f.source,f.roots,options,noMetadata)).plans[0]!;
 counter.stop();
 assert.equal(replaced.entries[0]!.skip,false);
 assert.match(replaced.entries[0]!.destination,/Conflicts/);
});

test('a corrupt or foreign index is ignored and rebuilt by the next app session',async t=>{
 const f=await fixture(t);
 await execute((await plan(f.source,f.roots,options,noMetadata)).plans[0]!);
 const index=path.join(f.roots[0]!,'.photo-importer-index.json');
 assert.ok((await fs.stat(index)).isFile());
 await fs.writeFile(index,'{not json');dropDestinationIndexes();
 const counter=countReads(t,f.original,f.roots);
 const again=(await plan(f.source,f.roots,options,noMetadata)).plans[0]!;
 counter.stop();
 assert.ok(again.entries[0]!.skip);assert.equal(counter.read.target,f.data.length);
 JSON.parse(await fs.readFile(index,'utf8'));
});

test('the destination index is never treated as user media',async t=>{
 const f=await fixture(t);
 await execute((await plan(f.source,f.roots,options,noMetadata)).plans[0]!);
 const scan=await inventory(f.roots[0]!,{backup:true});
 assert.deepEqual(scan.files.map(file=>file.relative),[path.join('DCIM','original.bin')]);
});

test('a source changed after planning is rejected even without a planned checksum',async t=>{
 const f=await fixture(t);
 const {plans:[transfer]}=await plan(f.source,f.roots,options,noMetadata);
 const changed=Buffer.from(f.data);changed[10]=changed[10]!^1;
 await fs.writeFile(f.original,changed);
 const result=await execute(transfer!);
 assert.equal(result.copied,0);assert.match(result.errors[0]??'',/Source changed/);
 await assert.rejects(fs.lstat(path.join(f.roots[0]!,'DCIM','original.bin')),{code:'ENOENT'});
});

test('a destination failing mid-file is dropped while the other still gets its copy from the same read',async t=>{
 const f=await fixture(t,2),{read,stop}=countReads(t,f.original,f.roots);
 const {plans}=await plan(f.source,f.roots,options,noMetadata);
 const open=fs.open.bind(fs);let failedWrites=0;
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args),file=String(args[0]);
  if(file.startsWith(f.roots[0]!+path.sep)&&file.endsWith('.partial')){const write=handle.write.bind(handle) as (...values:unknown[])=>Promise<unknown>;let calls=0;t.mock.method(handle,'write',async(...values:unknown[])=>{if(++calls>1){failedWrites++;throw Object.assign(new Error('No space left on device'),{code:'ENOSPC'});}return write(...values);});}
  return handle;
 });syncBuiltinESMExports();
 const result=await executeDestinations(plans,{signal:new AbortController().signal,reorganize:false,validate:async()=>{},progress:()=>{},settled:()=>{}});
 stop();
 assert.equal(failedWrites,1);assert.equal(result.copied,1);
 assert.equal(result.errors.length,1);assert.match(result.errors[0]!,/^Destination 1: .*No space left/);
 assert.equal(read.source,f.data.length);
 assert.deepEqual(await fs.readFile(path.join(f.roots[1]!,'DCIM','original.bin')),f.data);
 await assert.rejects(fs.lstat(path.join(f.roots[0]!,'DCIM','original.bin')),{code:'ENOENT'});
 assert.deepEqual((await fs.readdir(path.join(f.roots[0]!,'DCIM'))).filter(name=>name.endsWith('.partial')),[]);
});

test('planning reads metadata for several files at once and keeps issues in file order',async t=>{
 const f=await fixture(t);
 for(let index=0;index<6;index++)await fs.writeFile(path.join(f.source,'DCIM',`DSC000${index}.JPG`),`photo ${index}`);
 let active=0,peak=0;
 const metadata=async(file:string)=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,20));active--;return {fields:{'File:Error':`bad ${path.basename(file)}`}};};
 const {inventory:scan}=await plan(f.source,f.roots,{...options,backup:false},metadata);
 assert.ok(peak>1,`peak concurrency ${peak}`);
 assert.deepEqual(scan.issues?.map(issue=>path.basename(issue.path)),['DSC0000.JPG','DSC0001.JPG','DSC0002.JPG','DSC0003.JPG','DSC0004.JPG','DSC0005.JPG']);
});

test('file progress rises while copying, restarts for verification, and never counts failed files',async t=>{
 const f=await fixture(t);
 for(const name of ['b.bin','c.bin'])await fs.writeFile(path.join(f.source,'DCIM',name),Buffer.alloc(64*1024,name.charCodeAt(0)));
 const {plans:[transfer]}=await plan(f.source,f.roots,options,noMetadata);
 const open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args),file=String(args[0]);
  if(file.endsWith('.partial')){const write=handle.write.bind(handle) as (...values:unknown[])=>Promise<unknown>;t.mock.method(handle,'write',async(...values:unknown[])=>{if(values[0] instanceof Buffer&&(values[0] as Buffer)[0]==='b'.charCodeAt(0))throw Object.assign(new Error('No space left on device'),{code:'ENOSPC'});return write(...values);});}
  return handle;
 });syncBuiltinESMExports();
 const events:{phase?:string;completed:number;failed?:number}[]=[];
 const result=await execute(transfer!,undefined,value=>events.push({phase:value.phase,completed:value.completed,failed:value.failed}));
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.equal(result.copied,2);assert.equal(result.errors.length,1);
 const copying=events.filter(event=>event.phase==='copying'),verifying=events.filter(event=>event.phase==='verifying');
 assert.ok(copying.length>1);
 for(let index=1;index<copying.length;index++)assert.ok(copying[index]!.completed>=copying[index-1]!.completed,'copying never goes backwards');
 assert.equal(copying.at(-1)!.completed,2,'both good files counted before verification');
 assert.equal(verifying[0]!.completed,0,'verification restarts the count');
 assert.equal(verifying.at(-1)!.completed,2);assert.equal(verifying.at(-1)!.failed,1);
});

test('a card whose files were imported before is recognised without reading them again',async t=>{
 const f=await fixture(t);
 const first=await plan(f.source,f.roots,options,noMetadata);
 const imported:Record<string,{sha256:string;identity:string}>={};
 await execute(first.plans[0]!,undefined,undefined,{onVerified:(source:string,sha256:string,identity:string)=>{imported[source]={sha256,identity};}});
 assert.ok(imported[f.original]?.sha256&&imported[f.original]?.identity,'each copied file reports its checksum and the source identity it was read under');
 const {read,stop}=countReads(t,f.original,f.roots);
 const again=await plan(f.source,f.roots,{...options,sourceDigest:(file:string,identity:string)=>imported[file]?.identity===identity?imported[file]!.sha256:undefined},noMetadata);
 assert.ok(again.plans[0]!.entries.every(entry=>entry.skip));
 assert.deepEqual(await execute(again.plans[0]!),{copied:0,skipped:1,errors:[]});
 stop();
 assert.deepEqual(read,{source:0,stage:0,target:0},'nothing is read: the card file is unchanged and the copy is indexed');
});
