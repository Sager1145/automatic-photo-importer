import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHmac,randomUUID} from 'node:crypto';
import * as core from '../core/index';
import type {Metadata} from '../shared';

// Journals from before the event log keep one small file per event. On a USB drive a large one
// (86,526 files on A006) takes many minutes to read. An explicit Recheck or Resume folds those
// records, unchanged and still signed, into the event log and then removes the files.
const secret='fixture-only-host-recovery-secret-32bytes';
core.configureOrganizationRecovery(secret);
// These tests drive the conversion by hand; the automatic one (auto-conversion.test.ts) stays off here.
core.setConversionGate(()=>false);
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2026-10-03T12:00:00',fields:{}});
const base={backup:false,template:'{year}/{yyyymm}/{camera}',unknownRules:{}};
const names=['A.JPG','B.JPG','C.JPG','D.MOV'];

/** A finished organization (kept originals: copy-and-keep) whose events are rewritten in the older
 * one-file-per-event form, exactly as that version stored them. */
async function legacy(t:test.TestContext,extra=0){
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'journal-compaction-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup'),card=path.join(drive,'2025');
 for(const folder of [photos,card])await fs.mkdir(folder,{recursive:true});
 for(const name of names)await fs.writeFile(path.join(card,name),'bytes of '+name);
 const plan=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 assert.deepEqual((await core.executeReorganization(plan,undefined,undefined,{strategy:'copy'})).errors,[]);
 const [journal]=await core.getOrganizationRecovery(photos);const id=journal!.id;
 const folder=path.join(photos,'Photo Importer Recovery',id),log=path.join(folder,'event-log.jsonl');
 const lines=(await fs.readFile(log,'utf8')).split('\n').filter(Boolean);
 // Further signed records of a kind that changes nothing, to make a large journal.
 for(let index=0;index<extra;index++){const record={id,root:photos,event:'checked',index:0,at:new Date(Date.UTC(2026,9,21,0,0,0,index)).toISOString()};lines.push(JSON.stringify({...record,seal:createHmac('sha256',secret).update(JSON.stringify(record)).digest('hex')}));}
 for(const line of lines)await fs.writeFile(path.join(folder,`event-${randomUUID()}.json`),line);
 await fs.rm(log);
 return {drive,photos,id,folder,log,lines};
}
const listing=async(root:string,id:string)=>{const job=(await core.getOrganizationRecovery(root)).find(item=>item.id===id);assert.ok(job);const {id:_,root:__,...rest}=job!;return rest;};
const legacyFiles=async(folder:string)=>(await fs.readdir(folder)).filter(name=>/^event-.*\.json$/.test(name));
const logLines=async(log:string)=>(await fs.readFile(log,'utf8')).split('\n').filter(Boolean);
/** Each original record is in the log exactly once (the Recheck itself may add new ones after them). */
const eachOnce=async(log:string,lines:string[])=>{const now=await logLines(log);for(const line of lines)assert.equal(now.filter(item=>item===line).length,1,'once: '+line.slice(0,60));};

test('Recheck folds the per-event files into the log; state, signatures and listing are unchanged',async t=>{
 const {photos,id,folder,log,lines}=await legacy(t);
 const before=await listing(photos,id);
 assert.deepEqual((await core.resumeOrganization(photos,id)).errors,[]);
 assert.deepEqual(await legacyFiles(folder),[],'no per-event file is left');
 await eachOnce(log,lines);
 assert.deepEqual(await listing(photos,id),before);
 assert.ok(!(await fs.readdir(folder)).some(name=>name.startsWith('.')),'no hidden files');
 // Still a working journal: its kept originals can be released.
 assert.ok((await core.finalizeOrganization(photos,id)).removed>0);
});

test('With the automatic conversion held off (a job on the drive), a listing writes nothing',async t=>{
 const {photos,id,folder,lines}=await legacy(t);
 await core.getOrganizationRecovery(photos);await core.getOrganizationRecovery(photos,{verifyContents:false});
 assert.equal((await legacyFiles(folder)).length,lines.length);
 await assert.rejects(fs.stat(path.join(folder,'event-log.jsonl')),{code:'ENOENT'});
});

for(const stage of ['after the log was written','after some files were removed'] as const)test(`a Recheck stopped ${stage} is finished by the next one, and reads the same meanwhile`,async t=>{
 const {photos,id,folder,log,lines}=await legacy(t);
 const before=await listing(photos,id);
 // The state a crash at that point leaves: every record in the log, some or all files still there.
 await fs.writeFile(log,lines.join('\n')+'\n');
 if(stage==='after some files were removed'){const files=await legacyFiles(folder);for(const name of files.slice(0,Math.ceil(files.length/2)))await fs.rm(path.join(folder,name));}
 assert.deepEqual(await listing(photos,id),before,'a record both in the log and in a file counts once');
 assert.deepEqual((await core.resumeOrganization(photos,id)).errors,[]);
 assert.deepEqual(await legacyFiles(folder),[]);
 await eachOnce(log,lines);
 assert.deepEqual(await listing(photos,id),before);
});

test('a tampered per-event file is refused, never laundered into the log',async t=>{
 const {photos,id,folder,log}=await legacy(t);
 const [first]=await legacyFiles(folder),file=path.join(folder,first!);
 const record=JSON.parse(await fs.readFile(file,'utf8'));await fs.writeFile(file,JSON.stringify({...record,at:'2000-01-01T00:00:00.000Z'}));
 const result=await core.resumeOrganization(photos,id).then(value=>value.errors.join(' '),error=>String(error));
 assert.match(result,/authentication/);
 await assert.rejects(fs.stat(log),{code:'ENOENT'},'nothing was written to the log');
 assert.ok((await legacyFiles(folder)).includes(first!),'the files are left as they were');
});

test('a large legacy journal reads much faster once compacted',async t=>{
 const {photos,id,folder}=await legacy(t,12000);
 const time=async()=>{const started=performance.now();await listing(photos,id);return performance.now()-started;};
 const slow=await time();
 assert.deepEqual((await core.resumeOrganization(photos,id)).errors,[]);
 assert.deepEqual(await legacyFiles(folder),[]);
 const fast=await time();
 assert.ok(fast<slow/2,`${fast.toFixed(0)} ms after, ${slow.toFixed(0)} ms before`);
});

test('a journal with both a log and per-event files is converted with every record once',async t=>{
 const {photos,id,folder,log,lines}=await legacy(t);
 const before=await listing(photos,id),files=await legacyFiles(folder);
 // Half the records already in a log (as a version that had just started writing one would leave).
 const half=files.slice(0,Math.floor(files.length/2));
 await fs.writeFile(log,(await Promise.all(half.map(name=>fs.readFile(path.join(folder,name),'utf8')))).join('\n')+'\n');
 for(const name of half)await fs.rm(path.join(folder,name));
 assert.deepEqual(await listing(photos,id),before);
 assert.deepEqual((await core.resumeOrganization(photos,id)).errors,[]);
 await eachOnce(log,lines);assert.deepEqual(await legacyFiles(folder),[]);assert.deepEqual(await listing(photos,id),before);
});

test('a per-event file cut short carries no event and is dropped',async t=>{
 const {photos,id,folder,log,lines}=await legacy(t);
 const before=await listing(photos,id);
 await fs.writeFile(path.join(folder,`event-${randomUUID()}.json`),'{"id":"'+id+'","even');
 assert.deepEqual(await listing(photos,id),before);
 assert.deepEqual((await core.resumeOrganization(photos,id)).errors,[]);
 await eachOnce(log,lines);assert.deepEqual(await legacyFiles(folder),[]);assert.deepEqual(await listing(photos,id),before);
});

test('a log ending in bytes an interrupted write left (no line end, too long for a record) still reads',async t=>{
 const {photos,id}=await legacy(t);
 assert.deepEqual((await core.resumeOrganization(photos,id)).errors,[]);
 const before=await listing(photos,id);
 await fs.appendFile(path.join(photos,'Photo Importer Recovery',id,'event-log.jsonl'),Buffer.alloc(4096,0));
 assert.deepEqual(await listing(photos,id),before);
 assert.deepEqual((await core.resumeOrganization(photos,id)).errors,[]);
});

test('Stop before the conversion leaves the record exactly as it was',async t=>{
 const {photos,id,folder,lines}=await legacy(t);
 const controller=new AbortController();controller.abort();
 await assert.rejects(core.resumeOrganization(photos,id,controller.signal),{name:'AbortError'});
 assert.equal((await legacyFiles(folder)).length,lines.length);
 await assert.rejects(fs.stat(path.join(folder,'event-log.jsonl')),{code:'ENOENT'});
});

test('a record already read by a listing is converted without reading its files again, and stays read',async t=>{
 const {photos,id,folder,log,lines}=await legacy(t);
 const before=await listing(photos,id);
 // Unreadable now but unchanged: the listing's copy of each record is used.
 const files=await legacyFiles(folder);for(const name of files)await fs.chmod(path.join(folder,name),0o000);
 assert.deepEqual((await core.resumeOrganization(photos,id)).errors,[]);
 await eachOnce(log,lines);assert.deepEqual(await legacyFiles(folder),[]);
 // Afterwards only what the Recheck itself appended is read; the record lists as before.
 assert.deepEqual(await listing(photos,id),before);
});

const sign=(record:Record<string,unknown>)=>JSON.stringify({...record,seal:createHmac('sha256',secret).update(JSON.stringify(record)).digest('hex')});

test('a record appended after the listing read the journal is not lost when Recheck converts it',async t=>{
 const {photos,id,folder}=await legacy(t);
 await listing(photos,id);
 // Another writer appends after the listing (here: the journal was undone elsewhere).
 await fs.appendFile(path.join(folder,'event-log.jsonl'),sign({id,root:photos,event:'undo-complete',at:new Date().toISOString()})+'\n');
 await assert.rejects(core.resumeOrganization(photos,id),/was undone/);
 assert.equal((await core.getOrganizationRecovery(photos)).find(job=>job.id===id),undefined,'listed as undone, like a fresh read');
});

test('junk an interrupted write left at the end of the log stays harmless after later appends',async t=>{
 const {photos,id}=await legacy(t);
 assert.deepEqual((await core.resumeOrganization(photos,id)).errors,[]);
 const before=await listing(photos,id);
 await fs.appendFile(path.join(photos,'Photo Importer Recovery',id,'event-log.jsonl'),Buffer.alloc(4096,0));
 assert.deepEqual((await core.resumeOrganization(photos,id)).errors,[]);
 assert.deepEqual((await core.resumeOrganization(photos,id)).errors,[]);
 assert.deepEqual(await listing(photos,id),before);
});
