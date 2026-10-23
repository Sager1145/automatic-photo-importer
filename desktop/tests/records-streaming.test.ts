import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import * as core from '../core/index';
import {sealedLine,storeFor} from '../core/app-store';
import {openReceipts} from '../core/import-recovery';
import {journalFileFor,journalLines} from './fixtures/records';
import type {Metadata} from '../shared';

// Records are read in 1 MiB chunks, line by line: a journal or a receipt log far larger than any one read (300 MiB
// here) is read whole without a read past 64 MiB, and without a cap on the file's size.
core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2026-10-03T12:00:00',fields:{}});
const TARGET=300*1024*1024;
/** The largest read any file handle makes while `work` runs. */
async function largestRead(file:string,work:()=>Promise<void>):Promise<number>{
 const probe=await fs.open(file,'r'),prototype=Object.getPrototypeOf(probe) as {read:(...args:unknown[])=>Promise<unknown>};await probe.close();
 const read=prototype.read;let largest=0;
 prototype.read=function(this:unknown,...args:unknown[]){const length=typeof args[2]==='number'?args[2]:(args[0] as {length?:number})?.length??0;largest=Math.max(largest,length);return read.apply(this,args);};
 try{await work();}finally{prototype.read=read;}
 return largest;
}
async function library(t:test.TestContext){
 const folder=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'records-streaming-')));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const root=path.join(folder,'library');await fs.mkdir(path.join(root,'incoming'),{recursive:true});await fs.writeFile(path.join(root,'incoming','A.MOV'),'bytes');
 return root;
}

test('a 300 MiB journal is read whole, streaming, with no read past 1 MiB',{timeout:240000},async t=>{
 const root=await library(t);
 const reviewed=(await core.plan(root,[root],{backup:false,template:'{year}/{camera}',unknownRules:{},layout:'flat',reorganize:true,sourceFolders:['incoming']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(reviewed,undefined,undefined,{strategy:'rename'})).errors,[]);
 const [job]=await core.getOrganizationRecovery(root);
 // The identity the journal recorded last for the moved file.
 const renamed=(await journalLines(root,job!.id)).map(line=>JSON.parse(line)).filter(record=>record.event==='renamed'||record.event==='timed').at(-1);
 // The same identity recorded again and again (as a long run of date updates would), padded towards the cap.
 const line=sealedLine('event',{id:job!.id,root,event:'timed',index:0,at:new Date().toISOString(),stat:renamed.stat,note:'x'.repeat(1400)})+'\n';
 const block=line.repeat(Math.floor(8*1024*1024/line.length)),file=await journalFileFor(root,job!.id);
 while((await fs.stat(file)).size<TARGET)await fs.appendFile(file,block);
 let listed:Awaited<ReturnType<typeof core.getOrganizationRecovery>>=[];
 const largest=await largestRead(file,async()=>{listed=await core.getOrganizationRecovery(root,{verifyContents:false});});
 assert.equal(listed[0]?.status,'complete');assert.equal(listed[0]?.error,undefined);
 assert.ok(largest<=1024*1024,`largest read ${largest}`);
});

test('a 300 MiB receipt log in many segments is read whole, streaming, with no read past 1 MiB',{timeout:240000},async t=>{
 const root=await library(t),store=await storeFor(root),imports=path.join(store.path,'Imports');await fs.mkdir(imports,{recursive:true});
 const record={type:'stage',file:path.join(imports,'Staging',`${randomUUID()}.partial`),source:'/card/A.NEF',destination:path.join(root,'A.NEF'),sha256:'',sourceStat:{dev:'1',ino:'2',size:'3',mtime:'4',ctime:'5'},root,rootIdentity:'1:2',sourceRoot:'/card',sourceIdentity:'1:3',parentIdentity:'1:4',fileIdentity:'1:5:6',note:'y'.repeat(20000)};
 let segment=0,total=0,open='';
 while(total<TARGET){
  segment++;const lines:string[]=[];let size=0;
  while(size<8*1024*1024){const rid=randomUUID(),opened=sealedLine('receipt',{op:'open',rid,...record}),closed=sealedLine('receipt',{op:'close',rid});lines.push(opened,closed);size+=opened.length+closed.length+2;}
  if(total+size>=TARGET){open=randomUUID();lines.push(sealedLine('receipt',{op:'open',rid:open,...record}));}
  await fs.writeFile(path.join(imports,`receipts-${String(segment).padStart(6,'0')}.jsonl`),lines.join('\n')+'\n');total+=size;
 }
 let found=new Map<string,unknown>();
 const largest=await largestRead(path.join(imports,'receipts-000001.jsonl'),async()=>{found=await openReceipts(store);});
 assert.deepEqual([...found.keys()],[open],'every receipt but the last one is closed');
 assert.ok(largest<=1024*1024,`largest read ${largest}`);
});
