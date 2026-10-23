import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import * as core from '../core/index';
import type {Metadata} from '../shared';
import {appendJournalLine,journalFileFor,journalFolderFor} from './fixtures/records';

// A finished journal's events are read once per app session: a large journal from an earlier
// version (tens of thousands of event files on a USB drive) would otherwise be read again by every
// listing and before every organization. Only a finished, unchanged journal is cached.
core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
// These tests are about the read cache; the listing's automatic conversion (auto-conversion.test.ts) would empty the per-event files they set up.
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2026-10-03T12:00:00',fields:{}});
const base={backup:false,template:'{year}/{yyyymm}/{camera}',unknownRules:{}};

async function library(t:test.TestContext,{stop=false}:{stop?:boolean}={}){
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'journal-cache-')));
 t.after(async()=>{await fs.chmod(path.join(drive,'photobackup'),0o755).catch(()=>{});await fs.rm(drive,{recursive:true,force:true});});
 const photos=path.join(drive,'photobackup'),card=path.join(drive,'2025');
 for(const folder of [photos,card])await fs.mkdir(folder,{recursive:true});
 for(const name of ['A.JPG','B.JPG','C.JPG'])await fs.writeFile(path.join(card,name),'bytes of '+name);
 const plan=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 const controller=new AbortController();
 const run=core.executeReorganization(plan,stop?controller.signal:undefined,stop?value=>{if(value.step==='moving'&&value.completed>=1)controller.abort();}:undefined,{strategy:'rename'});
 if(stop)await assert.rejects(run,{name:'AbortError'});else assert.deepEqual((await run).errors,[]);
 const [journal]=await core.getOrganizationRecovery(photos);
 const log=await journalFileFor(photos,journal!.id);
 return {drive,photos,id:journal!.id,log};
}
/** Damage the last signed line without changing the file's size or modified time: only a read of the journal notices. */
async function corruptQuietly(log:string){
 const reference=log+'.reference';await fs.copyFile(log,reference);execFileSync('touch',['-r',log,reference]);
 const text=await fs.readFile(log,'utf8'),at=text.lastIndexOf('"seal":"')+8;
 await fs.writeFile(log,text.slice(0,at)+(text[at]==='0'?'1':'0')+text.slice(at+1));
 execFileSync('touch',['-r',reference,log]);await fs.rm(reference);
}
const listed=async(root:string,id:string)=>(await core.getOrganizationRecovery(root,{verifyContents:false})).find(job=>job.id===id);

test('a finished, unchanged journal is not read again',async t=>{
 const {photos,id,log}=await library(t);
 assert.equal((await listed(photos,id))?.status,'complete');
 // Damaged now, yet unchanged in size and date: the cached finished state is used.
 await corruptQuietly(log);
 const again=await listed(photos,id);
 assert.equal(again?.status,'complete');assert.equal(again?.error,undefined);
});

test('a new event invalidates the cached state',async t=>{
 const {photos,id}=await library(t);
 assert.equal((await listed(photos,id))?.status,'complete');
 // Undo appends events: the journal is read again and is no longer listed (fully undone).
 assert.ok((await core.undoOrganization(photos,id)).restored>0);
 assert.equal(await listed(photos,id),undefined);
});

test('an unfinished journal is never cached',async t=>{
 const {photos,id,log}=await library(t,{stop:true});
 assert.equal((await listed(photos,id))?.status,'pending');
 await corruptQuietly(log);
 const again=await listed(photos,id);
 assert.ok(again?.error,'read again, and the damaged log is reported');
});

test('replacing the event log with different contents of another size invalidates the cache',async t=>{
 const {photos,id,log}=await library(t);
 assert.equal((await listed(photos,id))?.status,'complete');
 const text=await fs.readFile(log,'utf8');
 // Drop the signed 'complete' record: the journal is unfinished again and must be read as such.
 await fs.writeFile(log,text.split('\n').filter(line=>!line.includes('"event":"complete"')).join('\n'));
 assert.equal((await listed(photos,id))?.status,'pending');
});

test('an unsigned event line appended to the journal invalidates the cached state',async t=>{
 const {photos,id}=await library(t);
 assert.equal((await listed(photos,id))?.status,'complete');
 // Not signed by this host: once read, it is refused, which shows the journal was read again.
 await appendJournalLine(photos,id,JSON.stringify({v:5,kind:'event',id,event:'undone',index:0}));
 assert.match((await listed(photos,id))?.error??'',/authentication/);
});

async function copied(t:test.TestContext){
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'journal-cache-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup'),card=path.join(drive,'2025');
 for(const folder of [photos,card])await fs.mkdir(folder,{recursive:true});
 await fs.writeFile(path.join(card,'BIG.MOV'),Buffer.alloc(160*1024*1024,7));
 for(const name of ['A.JPG','B.JPG'])await fs.writeFile(path.join(card,name),'bytes of '+name);
 const plan=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(plan,undefined,undefined,{strategy:'copy'})).errors,[]);
 const [journal]=await core.getOrganizationRecovery(photos);
 return {drive,photos,id:journal!.id,folder:await journalFolderFor(photos,journal!.id)};
}

test('events the app appends are applied on top of the cached state',async t=>{
 const {photos,id}=await copied(t);
 assert.equal((await listed(photos,id))?.retainedFiles,3);
 assert.ok((await core.finalizeOrganization(photos,id)).removed===3);
 const after=await listed(photos,id);
 assert.equal(after?.retainedFiles,0);assert.equal(after?.status,'complete');
});

test('a journal folder replaced by a copy is read in full',async t=>{
 const {photos,id,folder}=await copied(t);
 assert.equal((await listed(photos,id))?.status,'complete');
 await fs.cp(folder,folder+'-copy',{recursive:true});await fs.rm(folder,{recursive:true});await fs.rename(folder+'-copy',folder);
 await corruptQuietly(path.join(folder,'journal.jsonl'));
 assert.ok((await listed(photos,id))?.error,'read again: the damaged log is reported');
});

test('a second recheck does not read unchanged files again, a full recheck does, and a changed file is caught',async t=>{
 const {photos,id}=await copied(t);
 const recheck=async(full=false)=>{const started=performance.now();const result=await core.resumeOrganization(photos,id,undefined,undefined,{full});return {errors:result.errors,ms:performance.now()-started};};
 const first=await recheck();assert.deepEqual(first.errors,[]);
 const second=await recheck();assert.deepEqual(second.errors,[]);
 const full=await recheck(true);assert.deepEqual(full.errors,[]);
 assert.ok(second.ms<first.ms/2&&second.ms<full.ms/2,`first ${first.ms.toFixed(0)} ms, second ${second.ms.toFixed(0)} ms, full ${full.ms.toFixed(0)} ms`);
 // Same size, different bytes: its identity changed, so it is read and the change is reported.
 const target=path.join(photos,'2026/202610/Sony A7/BIG.MOV');await fs.writeFile(target,Buffer.alloc(160*1024*1024,8));
 assert.match((await recheck()).errors.join(' '),/Destination changed/);
});

test('after a quick recheck, finalize still reads file contents before releasing anything',async t=>{
 const {photos,id}=await copied(t);
 assert.deepEqual((await core.resumeOrganization(photos,id)).errors,[]);
 assert.deepEqual((await core.resumeOrganization(photos,id)).errors,[]);
 // Same size, different bytes, dates put back: a quick check alone would not see it.
 const target=path.join(photos,'2026/202610/Sony A7/A.JPG'),stat=await fs.stat(target);
 await fs.writeFile(target,'BYTES OF A.JPG');await fs.utimes(target,stat.atime,stat.mtime);
 await assert.rejects(core.finalizeOrganization(photos,id),/changed|unavailable/i);
 assert.equal((await listed(photos,id))?.retainedFiles,3,'nothing was released');
});
