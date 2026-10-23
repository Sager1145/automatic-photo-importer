import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as core from '../core/index';
import {metadata,closeMetadata,routingEntries,setRoutingLimit,carryRouting} from '../platform/metadata';
import type {Metadata} from '../shared';

core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const routing=(file:string)=>metadata(file,{details:false});
const keys=()=>routingEntries().map(([key])=>key.split('\0')[0]!);
const identity=(stat:import('node:fs').BigIntStats)=>({dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtime:String(stat.mtimeNs),ctime:String(stat.ctimeNs)});

test('the routing cache drops the least recently used result, not everything at once',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'routing-lru-')));
 t.after(async()=>{setRoutingLimit(500000);await closeMetadata();await fs.rm(root,{recursive:true,force:true});});
 setRoutingLimit(3);
 const files=['a','b','c','d'].map(name=>path.join(root,name+'.jpg'));
 for(const file of files)await fs.writeFile(file,'not an image '+file);
 for(const file of files.slice(0,3))await routing(file);
 await routing(files[0]!);                 // a is used again: b is now the oldest
 await routing(files[3]!);
 const held=keys().filter(key=>files.includes(key));
 assert.deepEqual(held.sort(),[files[0]!,files[2]!,files[3]!].sort());
});

test('the cache holds far more than the old 50,000 entries',async()=>{
 setRoutingLimit(500000);
 const {primeRouting,routingCacheSize}=await import('../platform/metadata');
 const before=routingCacheSize();
 primeRouting(Array.from({length:60000},(_,index)=>[`/x/${index}\0stat`,{camera:'c',date:'2026-01-01T00:00:00',fields:{}} as Metadata] as [string,Metadata]));
 assert.equal(routingCacheSize(),before+60000);
});

test('a moved file keeps its routing result under the new path and stat, only under the same name',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'routing-carry-')));
 t.after(async()=>{await closeMetadata();await fs.rm(root,{recursive:true,force:true});});
 const from=path.join(root,'IMG_1.jpg'),to=path.join(root,'sub','IMG_1.jpg'),other=path.join(root,'sub','renamed.jpg');
 await fs.writeFile(from,'not an image');
 const reviewed=identity(await fs.lstat(from,{bigint:true}));
 const result=await routing(from);
 await fs.mkdir(path.join(root,'sub'));await fs.rename(from,to);
 const now=await fs.lstat(to,{bigint:true});
 carryRouting(from,reviewed,other,now);
 assert.ok(!keys().includes(other),'a different name is read again: the result can depend on it');
 carryRouting(from,{...reviewed,size:'999'},to,now);
 assert.ok(!keys().includes(to),'a stat that does not match the cached read is not carried');
 carryRouting(from,reviewed,to,now);
 const carried=routingEntries().find(([key])=>key.startsWith(to+'\0'));
 assert.deepEqual(carried?.[1],result);
 assert.equal(carried![0],`${to}\0${now.dev}:${now.ino}:${now.size}:${now.mtimeNs}:${now.ctimeNs}`);
});

test('an organization that moves files tells the observer where each went, with the final stat',async t=>{
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'routing-move-')));
 t.after(async()=>{core.setMoveObserver(undefined);await fs.rm(drive,{recursive:true,force:true});});
 const photos=path.join(drive,'photobackup'),card=path.join(drive,'2025');
 for(const folder of [photos,card])await fs.mkdir(folder,{recursive:true});
 const names=['A.JPG','B.JPG','C.JPG'];
 for(const name of names)await fs.writeFile(path.join(card,name),'bytes of '+name);
 const stub=async():Promise<Metadata>=>({camera:'Sony A7',date:'2026-10-03T12:00:00',fields:{}});
 const plan=(await core.plan(drive,[photos],{backup:false,template:'{year}/{yyyymm}/{camera}',unknownRules:{},layout:'flat',reorganize:true,sourceFolders:['2025']},stub)).plans[0]!;
 const before=new Map<string,string>();
 for(const name of names){const stat=await fs.lstat(path.join(card,name),{bigint:true});before.set(path.join(card,name),JSON.stringify(identity(stat)));}
 const calls:{from:string;reviewed:string;to:string;now:string}[]=[];
 core.setMoveObserver((from,reviewed,to,now)=>{calls.push({from,reviewed:JSON.stringify({dev:reviewed.dev,ino:reviewed.ino,size:reviewed.size,mtime:reviewed.mtime,ctime:reviewed.ctime}),to,now:`${now.ino}:${now.size}:${now.mtimeNs}:${now.ctimeNs}`});});
 assert.deepEqual((await core.executeReorganization(plan,undefined,undefined)).errors,[]);
 assert.equal(calls.length,names.length);
 for(const call of calls){
  assert.equal(call.reviewed,before.get(call.from),'the reviewed identity is the one a scan cached');
  const stat=await fs.lstat(call.to,{bigint:true});
  assert.equal(call.now,`${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,'the final stat is what a later read sees');
 }
});
