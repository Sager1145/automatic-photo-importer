import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import filesystem from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHmac,randomUUID} from 'node:crypto';
import * as core from '../core/index';
import {deferredRefresh} from '../deferred-refresh';
import {journalConversion} from '../core/recovery';
import {migrateDrive} from '../core/migrate/index';
import {toLegacy} from './fixtures/legacy-records';
import type {Metadata} from '../shared';

// The converter's first read of an earlier version's journal gives way to a job that needs the same drive, and keeps
// what it had read, so that once the job ends the conversion goes on instead of starting over.
const secret='fixture-only-host-recovery-secret-32bytes';
core.configureOrganizationRecovery(secret);
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2026-10-03T12:00:00',fields:{}});
const base={backup:false,template:'{year}/{yyyymm}/{camera}',unknownRules:{}};

/** A finished organization turned into the earlier version's one-file-per-event journal, `extra` more events. */
async function legacy(t:test.TestContext,extra:number){
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'listing-yield-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup'),card=path.join(drive,'2025');
 for(const folder of [photos,card])await fs.mkdir(folder,{recursive:true});
 for(const name of ['A.JPG','B.JPG'])await fs.writeFile(path.join(card,name),'bytes of '+name);
 const plan=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(plan,undefined,undefined,{strategy:'copy'})).errors,[]);
 const [journal]=await core.getOrganizationRecovery(photos);const id=journal!.id;
 const folder=await toLegacy(photos,id,{format:'files'});
 for(let index=0;index<extra;index++){const record={id,root:photos,event:'checked',index:0,at:new Date(Date.UTC(2026,9,21,0,0,0,index)).toISOString()};await fs.writeFile(path.join(folder,`event-${randomUUID()}.json`),JSON.stringify({...record,seal:createHmac('sha256',secret).update(JSON.stringify(record)).digest('hex')}));}
 const total=(await fs.readdir(folder)).filter(name=>eventFile.test(name)).length;
 return {photos,id,folder,total};
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
const stopAt=(controller:AbortController,count:number)=>(read:number)=>{if(read>=count)controller.abort();};

test('a first read stopped part-way makes no more file calls, and the next one reads only the rest',async t=>{
 const {photos,id,total}=await legacy(t,600);
 const controller=new AbortController(),watcher=watch();t.after(watcher.restore);
 await assert.rejects(journalConversion.read(photos,id,stopAt(controller,100),controller.signal),{name:'AbortError'});
 const afterStop=watcher.counts.calls;
 await new Promise(resolve=>setTimeout(resolve,100));
 assert.equal(watcher.counts.calls,afterStop,'nothing touches the drive while the read is stopped');
 const first=watcher.counts.events;assert.ok(first>=100&&first<total,`stopped part-way (${first} of ${total})`);
 const read=await journalConversion.read(photos,id);
 watcher.restore();
 assert.equal(read.records.length,total);
 assert.equal(watcher.counts.events,total,'every per-event file was read once across both reads');
});

test('what a stopped first read kept is not trusted once the log has changed',async t=>{
 const {photos,id,folder,total}=await legacy(t,300);
 const controller=new AbortController();
 await assert.rejects(journalConversion.read(photos,id,stopAt(controller,50),controller.signal),{name:'AbortError'});
 const record={id,root:photos,event:'checked',index:0,at:new Date(Date.UTC(2026,9,22)).toISOString()};
 await fs.writeFile(path.join(folder,'event-log.jsonl'),JSON.stringify({...record,seal:createHmac('sha256',secret).update(JSON.stringify(record)).digest('hex')})+'\n');
 const watcher=watch();t.after(watcher.restore);
 await journalConversion.read(photos,id);
 watcher.restore();
 assert.equal(watcher.counts.events,total,'read in full again');
});

test('a stopped first read still authenticates every record it later applies',async t=>{
 const {photos,id,folder}=await legacy(t,200);
 const controller=new AbortController();
 await assert.rejects(journalConversion.read(photos,id,stopAt(controller,50),controller.signal),{name:'AbortError'});
 // A forged file that no signature covers is refused, whatever the earlier read held.
 const names=(await fs.readdir(folder)).filter(name=>eventFile.test(name));
 await fs.writeFile(path.join(folder,names[names.length-1]!),JSON.stringify({id,root:photos,event:'undo-complete',seal:'0'.repeat(64)}));
 await assert.rejects(journalConversion.read(photos,id),/authentic|seal|Invalid/i);
});

test('a job stopping the converter during its first read: nothing is changed, and the next run converts the journal',async t=>{
 const {photos,id,folder,total}=await legacy(t,600);
 const controller=new AbortController(),watcher=watch();t.after(watcher.restore);
 await assert.rejects(migrateDrive([photos],{signal:controller.signal,onProgress:progress=>{if(progress.step==='converting'&&progress.completed>=100)controller.abort();}}),{name:'AbortError'});
 watcher.restore();
 assert.ok(watcher.counts.events<total,`the read stopped promptly (${watcher.counts.events} of ${total} files)`);
 assert.ok((await fs.lstat(path.join(folder,'manifest.json'))).isFile(),'the earlier version\'s journal is untouched');
 assert.equal((await fs.readdir(folder)).filter(name=>eventFile.test(name)).length,total);
 const result=await migrateDrive([photos]);
 assert.deepEqual(result.problems,[]);assert.equal(result.converted,1);
 await assert.rejects(fs.lstat(folder),{code:'ENOENT'});
 assert.equal((await core.getOrganizationRecovery(photos)).find(job=>job.id===id)?.status,'complete');
});

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
