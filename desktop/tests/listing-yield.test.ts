import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import filesystem from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHmac,randomUUID} from 'node:crypto';
import * as core from '../core/index';
import {deferredRefresh} from '../deferred-refresh';
import type {Metadata} from '../shared';

// The organization listing gives way to a job that plans, copies or verifies on the same drive, and keeps
// what it had read, so that once the job ends the listing goes on instead of starting over.
const secret='fixture-only-host-recovery-secret-32bytes';
core.configureOrganizationRecovery(secret);
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2026-10-03T12:00:00',fields:{}});
const base={backup:false,template:'{year}/{yyyymm}/{camera}',unknownRules:{}};

/** A finished organization whose events are rewritten as the older one-file-per-event form, `extra` more of them. */
async function legacy(t:test.TestContext,extra:number){
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'listing-yield-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup'),card=path.join(drive,'2025');
 for(const folder of [photos,card])await fs.mkdir(folder,{recursive:true});
 for(const name of ['A.JPG','B.JPG'])await fs.writeFile(path.join(card,name),'bytes of '+name);
 const plan=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(plan,undefined,undefined,{strategy:'copy'})).errors,[]);
 const [journal]=await core.getOrganizationRecovery(photos);const id=journal!.id;
 const folder=path.join(photos,'Photo Importer Recovery',id),log=path.join(folder,'event-log.jsonl');
 const lines=(await fs.readFile(log,'utf8')).split('\n').filter(Boolean);
 for(let index=0;index<extra;index++){const record={id,root:photos,event:'checked',index:0,at:new Date(Date.UTC(2026,9,21,0,0,0,index)).toISOString()};lines.push(JSON.stringify({...record,seal:createHmac('sha256',secret).update(JSON.stringify(record)).digest('hex')}));}
 for(const line of lines)await fs.writeFile(path.join(folder,`event-${randomUUID()}.json`),line);
 await fs.rm(log);
 return {photos,id,folder,log,total:lines.length};
}
const eventFile=/event-[a-f0-9-]+\.json$/;
/** Counts opens of per-event files, and every file-system call, until restored. */
function watch(){
 const counts={events:0,calls:0},names=['open','readdir','lstat','stat','readFile','realpath'] as const,originals=new Map<string,unknown>();
 const target=filesystem as unknown as Record<string,(...args:unknown[])=>Promise<unknown>>;
 for(const name of names){
  const original=target[name]!;originals.set(name,original);
  target[name]=(...args:unknown[])=>{counts.calls++;if(name==='open'&&eventFile.test(String(args[0])))counts.events++;return original.apply(filesystem,args);};
 }
 return {counts,restore:()=>{for(const [name,original] of originals)(target as Record<string,unknown>)[name]=original;}};
}

test('a refresh that gives way to planning stays deferred, stops its run and starts again once nothing plans',async()=>{
 let planning=false,runs=0,stopped=0;
 const refresh=deferredRefresh({planning:()=>planning,run:signal=>new Promise<void>(resolve=>{runs++;signal.addEventListener('abort',()=>{stopped++;resolve();},{once:true});})});
 assert.equal(refresh.request(),true);assert.equal(runs,1);
 planning=true;refresh.pause();
 assert.equal(stopped,1);assert.equal(refresh.deferred,true);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(refresh.running,false);
 refresh.resume();assert.equal(runs,1,'not while a job plans');
 planning=false;refresh.resume();assert.equal(runs,2,'resumes once nothing plans');
 refresh.pause();refresh.pause();assert.equal(stopped,2,'pausing twice stops the run once');
});
