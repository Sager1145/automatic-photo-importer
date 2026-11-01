import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {plan,configureOrganizationRecovery,discardPausedCopies} from '../core/index';
import {executeDestinations,type DestinationOutcome} from '../core/destinations';
import {dropDestinationIndexes} from '../core/destination-index';
import {JobLedger,PausedCopies,sourcesUnchanged} from '../import-resume';
import type {Progress,TransferPlan} from '../shared';

configureOrganizationRecovery('pause-resume-fixture-host-authentication-secret-32b');
const options={backup:false as const,template:'{camera}',layout:'flat' as const,unknownRules:{}};
const camera=async()=>({camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}});
const bytes=(seed:number,size:number)=>{const data=Buffer.alloc(size);for(let i=0;i<size;i+=4096)data[i]=(i/4096+seed)%251;data[0]=seed;return data;};
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');

async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'pause-resume-')));
 t.after(async()=>{t.mock.restoreAll();syncBuiltinESMExports();dropDestinationIndexes();await fs.rm(base,{recursive:true,force:true});});
 const source=path.join(base,'card'),root=path.join(base,'library');
 await fs.mkdir(source);await fs.mkdir(root);
 return {source,root};
}
/** Every byte read from and written to each file, by kind: the card's files, staged copies, and files in the library. */
function countIo(t:test.TestContext,source:string,root:string){
 const reads=new Map<string,number>(),writes=new Map<string,number>(),created:string[]=[];
 const open=fs.open.bind(fs);let on=false;
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args),file=String(args[0]);
  if(!on||!(file.startsWith(source+path.sep)||file.startsWith(root+path.sep)))return handle;
  if(args[1]==='wx'&&file.endsWith('.partial'))created.push(file);
  const read=handle.read.bind(handle) as (...values:unknown[])=>Promise<{bytesRead:number}>,write=handle.write.bind(handle) as (...values:unknown[])=>Promise<{bytesWritten:number}>;
  t.mock.method(handle,'read',async(...values:unknown[])=>{const result=await read(...values);reads.set(file,(reads.get(file)??0)+result.bytesRead);return result;});
  t.mock.method(handle,'write',async(...values:unknown[])=>{const result=await write(...values);writes.set(file,(writes.get(file)??0)+result.bytesWritten);return result;});
  return handle;
 });
 syncBuiltinESMExports();
 const sum=(map:Map<string,number>,test:(file:string)=>boolean)=>[...map].filter(([file])=>test(file)).reduce((total,[,count])=>total+count,0);
 return {
  start(){on=true;reads.clear();writes.clear();created.length=0;},
  stop(){on=false;},
  reads,writes,created,
  sourceRead:(file:string)=>reads.get(file)??0,
  stagesCreated:()=>created.length,
  libraryRead:(files:string[])=>sum(reads,file=>files.includes(file)),
 };
}
/** One run of the job as main.ts runs it: the pause carry and the job's ledger, its counts the whole job's. */
async function runJob(plans:TransferPlan[],copies:PausedCopies,ledger:JobLedger,stopWhen?:(value:Progress)=>boolean){
 const control=new AbortController(),outcomes:DestinationOutcome[]=[];
 const result=executeDestinations(plans,{signal:control.signal,reorganize:false,paused:copies,validate:async()=>{},settled:()=>{},
  progress:(_index,value)=>{if(stopWhen?.(value))control.abort();},onFileOutcome:found=>outcomes.push(ledger.note(found))});
 if(stopWhen){await assert.rejects(result,(error:Error)=>error.name==='AbortError');return {outcomes};}
 return {outcomes,totals:ledger.totals(await result)};
}
async function card(source:string,count:number,size:number,from=0){
 const files:{file:string;data:Buffer}[]=[];
 for(let i=from;i<from+count;i++){const data=bytes(i+1,size),file=path.join(source,`DSC${String(i).padStart(5,'0')}.ARW`);await fs.writeFile(file,data);files.push({file,data});}
 return files;
}
async function assertLibrary(plans:TransferPlan[],files:{file:string;data:Buffer}[]){
 for(const {file,data} of files){
  const entry=plans[0]!.entries.find(item=>item.source===file)!;
  assert.equal(sha(await fs.readFile(entry.destination)),sha(data),`${path.basename(file)} is in the library, byte for byte`);
 }
}
async function leftoverStages(root:string){
 const found:string[]=[];
 const walk=async(folder:string)=>{for(const item of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,item.name);if(item.isDirectory())await walk(file);else if(item.name.endsWith('.partial'))found.push(file);}};
 await walk(root);return found;
}

test('paused while verifying: Continue publishes the rest without checking, copying or verifying the published files again, and counts the whole job',async t=>{
 const {source,root}=await fixture(t),size=256*1024;
 // Two files are already in the library from an earlier import.
 const before=await card(source,2,size);
 {const {plans}=await plan(source,[root],options,camera);await executeDestinations(plans,{signal:new AbortController().signal,reorganize:false,validate:async()=>{},settled:()=>{},progress:()=>{}});}
 const added=await card(source,10,size,2),all=[...before,...added];
 const {plans}=await plan(source,[root],options,camera);
 const io=countIo(t,source,root),copies=new PausedCopies(),ledger=new JobLedger();
 io.start();
 const first=await runJob(plans,copies,ledger,value=>value.phase==='verifying'&&!value.step&&value.completed>=5);
 io.stop();
 const published=first.outcomes.filter(item=>item.disposition==='published'),kept=[...copies.stages.values()].map(item=>item.staged.file);
 assert.ok(published.length>0&&published.length<added.length,`paused partway: ${published.length} of ${added.length} published`);
 assert.equal(published.length+copies.stages.size,added.length,'every new file is either published or its verified-later staged copy is kept');
 assert.equal(io.stagesCreated(),added.length);
 for(const stage of kept)assert.ok((await fs.stat(stage)).isFile(),'a kept staged copy stays on the destination while paused');

 // Continue: the plan still holds (no file on the card changed), so nothing is listed or compared again.
 assert.equal(await sourcesUnchanged(plans),true);
 io.start();
 const second=await runJob(plans,copies,new JobLedger(ledger.outcomes));
 io.stop();
 // (a) Nothing done before the pause is done again.
 assert.equal(io.stagesCreated(),0,'no file is copied again');
 for(const item of published)assert.equal(io.sourceRead(item.source),0,`${path.basename(item.source)}: published before the pause, its card file is not read`);
 assert.equal(io.libraryRead(published.map(item=>item.destination)),0,'files published before the pause are not read back again');
 assert.equal(io.libraryRead(before.map(({file})=>plans[0]!.entries.find(entry=>entry.source===file)!.destination)),0,'files found in the library before the pause are not read again');
 for(const {file} of added)assert.equal(io.sourceRead(file),0,'no card file is read again: copies kept at the pause are verified against the checksum of the bytes written');
 // (c) A copy not yet verified at the pause is verified now: each kept staged copy is read back in full.
 for(const stage of kept)assert.equal(io.reads.get(stage),size,`${path.basename(stage)} is read back once before it is published`);
 // (b) The job's counts cover the whole job and match the library.
 assert.deepEqual({copied:second.totals!.copied,skipped:second.totals!.skipped,errors:second.totals!.errors},{copied:added.length,skipped:before.length,errors:[]});
 assert.equal(second.outcomes.filter(item=>item.disposition==='published').length,added.length,'files published before the pause are still this job\'s copies');
 await assertLibrary(plans,all);
 assert.deepEqual(await leftoverStages(root),[],'no staged copy is left');
 assert.equal(copies.stages.size,0);
});

test('paused while copying: Continue copies only the files not yet staged and verifies every copy',async t=>{
 const {source,root}=await fixture(t),size=1024*1024;
 const files=await card(source,12,size);
 const {plans}=await plan(source,[root],options,camera);
 const io=countIo(t,source,root),copies=new PausedCopies(),ledger=new JobLedger();
 io.start();
 await runJob(plans,copies,ledger,value=>value.phase==='copying'&&value.completed>=3);
 io.stop();
 const kept=new Map([...copies.stages.values()].map(item=>[item.staged.file,item]));
 assert.ok(kept.size>=3&&kept.size<files.length,`paused partway through copying: ${kept.size} of ${files.length} staged`);
 const keptSources=new Set(plans[0]!.entries.filter(entry=>[...copies.stages.keys()].some(key=>key.endsWith(`\0${entry.id}`))).map(entry=>entry.source));
 assert.equal(keptSources.size,kept.size);

 io.start();
 const second=await runJob(plans,copies,new JobLedger(ledger.outcomes));
 io.stop();
 assert.equal(io.stagesCreated(),files.length-kept.size,'only the files not staged before the pause are copied');
 for(const file of keptSources)assert.equal(io.sourceRead(file),0,`${path.basename(file)} was staged before the pause: its card file is not read again`);
 for(const stage of kept.keys())assert.equal(io.reads.get(stage),size,'each copy staged before the pause is read back once and compared');
 assert.deepEqual({copied:second.totals!.copied,skipped:second.totals!.skipped,errors:second.totals!.errors},{copied:files.length,skipped:0,errors:[]});
 await assertLibrary(plans,files);
 assert.deepEqual(await leftoverStages(root),[]);
});

test('paused twice: the counts still cover the whole job',async t=>{
 const {source,root}=await fixture(t),size=256*1024;
 const files=await card(source,12,size);
 const {plans}=await plan(source,[root],options,camera);
 const copies=new PausedCopies();let ledger=new JobLedger();
 await runJob(plans,copies,ledger,value=>value.phase==='verifying'&&!value.step&&value.completed>=3);
 ledger=new JobLedger(ledger.outcomes);
 await runJob(plans,copies,ledger,value=>value.phase==='verifying'&&!value.step&&value.completed>=7);
 const last=await runJob(plans,copies,new JobLedger(ledger.outcomes));
 assert.deepEqual({copied:last.totals!.copied,skipped:last.totals!.skipped,errors:last.totals!.errors},{copied:files.length,skipped:0,errors:[]});
 await assertLibrary(plans,files);
});

test('a staged copy changed while paused is not trusted: it is removed and the file is copied and verified again',async t=>{
 const {source,root}=await fixture(t),size=1024*1024;
 const files=await card(source,12,size);
 const {plans}=await plan(source,[root],options,camera);
 const copies=new PausedCopies(),ledger=new JobLedger();
 await runJob(plans,copies,ledger,value=>value.phase==='copying'&&value.completed>=3);
 const [tampered]=[...copies.stages.values()],keptBefore=copies.stages.size;
 assert.ok(tampered);
 await fs.appendFile(tampered.staged.file,Buffer.from('changed'));
 const io=countIo(t,source,root);
 io.start();
 const second=await runJob(plans,copies,new JobLedger(ledger.outcomes));
 io.stop();
 assert.equal(io.stagesCreated(),files.length-keptBefore+1,'the changed copy is made again, the unchanged ones are not');
 assert.deepEqual({copied:second.totals!.copied,errors:second.totals!.errors},{copied:files.length,errors:[]});
 await assertLibrary(plans,files);
 assert.deepEqual(await leftoverStages(root),[],'the changed copy was removed');
});

test('a card file changed while paused: the plan is not reused',async t=>{
 const {source,root}=await fixture(t);
 const files=await card(source,3,64*1024);
 const {plans}=await plan(source,[root],options,camera);
 assert.equal(await sourcesUnchanged(plans),true);
 await fs.appendFile(files[1]!.file,Buffer.from('more'));
 assert.equal(await sourcesUnchanged(plans),false);
 await fs.rm(files[1]!.file);
 assert.equal(await sourcesUnchanged(plans),false);
});

test('Stop on a paused job removes the staged copies it kept',async t=>{
 const {source,root}=await fixture(t);
 await card(source,12,1024*1024);
 const {plans}=await plan(source,[root],options,camera);
 const copies=new PausedCopies();
 await runJob(plans,copies,new JobLedger(),value=>value.phase==='copying'&&value.completed>=3);
 assert.ok(copies.stages.size>0);
 assert.ok((await leftoverStages(root)).length>=copies.stages.size);
 await discardPausedCopies(copies);
 assert.equal(copies.stages.size,0);
 assert.deepEqual(await leftoverStages(root),[]);
});

test('publishing by copying with change times that prove nothing (exFAT on Windows and Linux): Continue still reads nothing done before the pause',async t=>{
 const {source,root}=await fixture(t),size=256*1024;
 // No hard links: each verified copy is published by copying it into place. Change time equals modification time in the library, so no stat there proves a file unchanged to the index.
 const lstat=fs.lstat.bind(fs);
 const exfat=<T,>(file:string,stat:T):T=>{const value=stat as {mtimeNs?:bigint;ctimeNs?:bigint;mtimeMs?:number;ctimeMs?:number};if(typeof value?.mtimeNs==='bigint'&&file.startsWith(root+path.sep)){value.ctimeNs=value.mtimeNs;value.ctimeMs=value.mtimeMs;}return stat;};
 t.mock.method(fs,'lstat',async(...args:Parameters<typeof fs.lstat>)=>exfat(String(args[0]),await lstat(...args)));
 const open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args),file=String(args[0]),own=handle.stat.bind(handle);t.mock.method(handle,'stat',async(...values:Parameters<typeof handle.stat>)=>exfat(file,await own(...values)));return handle;});
 t.mock.method(fs,'link',async()=>{throw Object.assign(new Error('not permitted'),{code:'EPERM'});});
 syncBuiltinESMExports();
 const files=await card(source,12,size);
 const {plans}=await plan(source,[root],options,camera);
 const io=countIo(t,source,root),copies=new PausedCopies(),ledger=new JobLedger();
 io.start();
 const first=await runJob(plans,copies,ledger,value=>value.phase==='verifying'&&!value.step&&value.completed>=4);
 io.stop();
 const published=first.outcomes.filter(item=>item.disposition==='published'),kept=[...copies.stages.values()].map(item=>item.staged.file),keptSources=[...copies.stages.keys()].map(key=>key.split(' ')[1]!);
 assert.ok(published.length>0&&published.length<files.length,`paused partway: ${published.length} of ${files.length} published`);
 assert.equal(published.length+kept.length,files.length);
 io.start();
 const second=await runJob(plans,copies,new JobLedger(ledger.outcomes));
 io.stop();
 for(const item of published)assert.equal(io.sourceRead(item.source),0,`${path.basename(item.source)}: its card file is not read again`);
 assert.equal(io.libraryRead(published.map(item=>item.destination)),0,'files published before the pause are not read back again');
 assert.equal(io.stagesCreated(),0,'no file is copied again');
 for(const file of keptSources)assert.equal(io.sourceRead(file),0,`${path.basename(file)}: staged before the pause, its card file is not read again`);
 for(const stage of kept)assert.ok((io.reads.get(stage)??0)>=size,`${path.basename(stage)} is read back before it is published`);
 // Each file left unverified at the pause is published now by copying, and that copy is read back and compared too.
 const now=second.outcomes.filter(item=>!published.some(earlier=>earlier.source===item.source));
 for(const item of now)assert.equal(io.reads.get(item.destination),size,`${path.basename(item.destination)} is read back after it is copied into place`);
 assert.deepEqual({copied:second.totals!.copied,skipped:second.totals!.skipped,errors:second.totals!.errors},{copied:files.length,skipped:0,errors:[]});
 await assertLibrary(plans,files);
 assert.deepEqual(await leftoverStages(root),[]);
});
