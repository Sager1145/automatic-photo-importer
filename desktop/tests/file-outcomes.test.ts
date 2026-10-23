import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { plan, configureOrganizationRecovery, type FileOutcome } from '../core';
import { executeDestinations, type DestinationOutcome } from '../core/destinations';
import { destinationIndex, dropDestinationIndexes } from '../core/destination-index';
import { verifiedOriginals } from '../core/originals';
import { duplicateStore, dropDuplicateStores, recordPlanDuplicates, type PlanDuplicates } from '../core/duplicates';
import { identity, statKey } from '../core/paths';
import type { Metadata, TransferPlan } from '../shared';

configureOrganizationRecovery('file-outcomes-fixture-host-authentication-secret-32b');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const sony=async():Promise<Metadata>=>({camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}});
const live=async():Promise<Metadata>=>({camera:'iPhone',make:'Apple',date:'2024-02-03T12:00:00Z',fields:{}});
const bytes=(seed:number,size=5000)=>{const data=Buffer.alloc(size);for(let i=0;i<size;i++)data[i]=(i*7+seed)%251;return data;};
async function fixture(t:test.TestContext,roots=1){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'file-outcomes-')));
 t.after(async()=>{t.mock.restoreAll();syncBuiltinESMExports();dropDestinationIndexes();dropDuplicateStores();await fs.rm(base,{recursive:true,force:true});});
 const source=path.join(base,'source');await fs.mkdir(source);
 const backups=Array.from({length:roots},(_,i)=>path.join(base,`backup${i}`));for(const root of backups)await fs.mkdir(root);
 const put=async(file:string,data:Buffer)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data);return file;};
 return {source,backups,put};
}
async function run(plans:TransferPlan[],extra:{verify?:boolean;fail?:number}={}){
 const outcomes:DestinationOutcome[]=[],bySource=new Map<string,DestinationOutcome[]>();
 const result=await executeDestinations(plans,{signal:new AbortController().signal,reorganize:false,verify:extra.verify,progress:()=>{},settled:()=>{},
  validate:async index=>{if(index===extra.fail)throw new Error('disk unavailable');},
  onFileOutcome:outcome=>{outcomes.push(outcome);bySource.set(outcome.source,[...bySource.get(outcome.source)??[],outcome]);}});
 return {result,outcomes,bySource};
}
const exif={camera:'Sony A7',date:'2024-02-03T12:00:00',serial:'123'};
/** Change time equal to modification time under `drive`, as exFAT reports it: no stat there proves a file unchanged. */
function simulateExfat(t:test.TestContext,drive:string){
 const exfat=<T,>(file:string,stat:T):T=>{const value=stat as {mtimeNs?:bigint;ctimeNs?:bigint;mtimeMs?:number;ctimeMs?:number};if(typeof value?.mtimeNs==='bigint'&&file.startsWith(drive+path.sep)){value.ctimeNs=value.mtimeNs;value.ctimeMs=value.mtimeMs;}return stat;};
 const lstat=fs.lstat.bind(fs),stat=fs.stat.bind(fs),open=fs.open.bind(fs);
 t.mock.method(fs,'lstat',async(...args:Parameters<typeof fs.lstat>)=>exfat(String(args[0]),await lstat(...args)));
 t.mock.method(fs,'stat',async(...args:Parameters<typeof fs.stat>)=>exfat(String(args[0]),await stat(...args)));
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args),file=String(args[0]),own=handle.stat.bind(handle);
  t.mock.method(handle,'stat',async(...values:Parameters<typeof handle.stat>)=>exfat(file,await own(...values)));
  return handle;
 });syncBuiltinESMExports();
}

test('a same-size file that takes the planned path after planning: the outcome is the conflict copy, and only it gets the source facts',async t=>{
 const f=await fixture(t),root=f.backups[0]!,data=bytes(1);
 const original=await f.put(path.join(f.source,'A.JPG'),data);
 const {plans}=await plan(f.source,[root],options,sony);
 const planned=plans[0]!.entries[0]!.destination;
 // Another writer puts different bytes of the same size at the planned name.
 const foreign=await f.put(planned,bytes(2));
 const {result,outcomes,bySource}=await run(plans);
 assert.deepEqual(result.errors,[]);assert.equal(result.copied,1);
 assert.equal(outcomes.length,1);
 const outcome=outcomes[0]!;
 assert.notEqual(outcome.destination,planned);
 assert.ok(outcome.destination.split(path.sep).includes('Conflicts'),outcome.destination);
 assert.deepEqual(await fs.readFile(outcome.destination),data);
 assert.deepEqual({disposition:outcome.disposition,verification:outcome.verification,destinationSlot:outcome.destinationSlot},{disposition:'published',verification:'content-verified',destinationSlot:0});
 assert.equal(outcome.finalIdentity,statKey(await fs.lstat(outcome.destination,{bigint:true})));
 // Delete originals re-reads the copy where it is, never the foreign file.
 const {files,withheld}=verifiedOriginals(bySource,plans);
 assert.deepEqual(withheld,[]);
 assert.deepEqual(files.map(file=>file.destinations),[[outcome.destination]]);
 // Duplicate records go to the copy; the foreign file gets neither the source's kind nor its EXIF.
 const found:PlanDuplicates={files:[{path:original,size:data.length,kind:'JPEG',edited:false,birth:0,ctime:0,exif}]};
 await recordPlanDuplicates(root,found,source=>{const item=bySource.get(source)?.[0];return item?.finalIdentity?{destination:item.destination,identity:item.finalIdentity}:undefined;});
 dropDuplicateStores();
 const store=await duplicateStore(root,await identity(root));
 assert.equal(store.files.has(path.relative(root,foreign)),false);
 assert.deepEqual(store.files.get(path.relative(root,outcome.destination))?.exif,exif);
});

test('mirror: one disk failing leaves the original undeletable, with the reason',async t=>{
 const f=await fixture(t,2);
 const original=await f.put(path.join(f.source,'A.JPG'),bytes(3));
 const {plans}=await plan(f.source,f.backups,options,sony);
 const {outcomes,bySource,result}=await run(plans,{fail:1});
 assert.equal(result.errors.length,1);
 assert.deepEqual(outcomes.map(item=>item.destinationSlot),[0]);
 assert.deepEqual(verifiedOriginals(bySource,plans),{files:[],withheld:[{source:original,reason:'copy-missing'}]});
 // Both disks verified: offered, with both actual copies.
 const again=await plan(f.source,f.backups,options,sony),both=await run(again.plans);
 const {files}=verifiedOriginals(both.bySource,again.plans);
 assert.deepEqual(files.map(file=>file.destinations.length),[2]);
 assert.deepEqual(both.outcomes.map(item=>[item.destinationSlot,item.disposition]).sort(),[[0,'existing'],[1,'published']]);
});

test('fill-first: only the disk a file was assigned is required',async t=>{
 const f=await fixture(t,2);
 const original=await f.put(path.join(f.source,'A.JPG'),bytes(4));
 const {plans}=await plan(f.source,f.backups,{...options,fillFirst:first=>new Set(first.entries.map(entry=>entry.source))},sony);
 assert.equal(plans[1]!.entries.length,0);
 const {bySource}=await run(plans);
 assert.deepEqual(verifiedOriginals(bySource,plans).files.map(file=>file.source),[original]);
});

test('a family published in part reports the member that is there and not the one that failed',async t=>{
 const f=await fixture(t),root=f.backups[0]!;
 await f.put(path.join(f.source,'IMG_1.HEIC'),bytes(5));await f.put(path.join(f.source,'IMG_1.MOV'),bytes(6,9000));
 const {plans}=await plan(f.source,[root],options,live);
 assert.equal(plans[0]!.entries.length,2);
 const link=fs.link.bind(fs);
 t.mock.method(fs,'link',async(from:string,to:string)=>{if(String(to).endsWith('.MOV'))throw Object.assign(new Error('I/O error'),{code:'EIO'});return link(from,to);});syncBuiltinESMExports();
 const {result,outcomes}=await run(plans);
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.equal(result.errors.length,1);
 const order=plans[0]!.entries.map(entry=>path.extname(entry.source));
 // Members publish in plan order: whatever came before the MOV is there and reported; the MOV is not.
 const before=order.slice(0,order.indexOf('.MOV'));
 assert.deepEqual(before,['.HEIC']);
 assert.deepEqual(outcomes.map(item=>path.extname(item.source)),before);
 for(const item of outcomes)assert.deepEqual(await fs.readFile(item.destination),await fs.readFile(item.source));
});

test('verification off: new copies are stream-only, cache nothing and authorize no deletion',async t=>{
 const f=await fixture(t),root=f.backups[0]!;
 const original=await f.put(path.join(f.source,'A.JPG'),bytes(7));
 const {plans}=await plan(f.source,[root],options,sony);
 const {outcomes,bySource}=await run(plans,{verify:false});
 assert.deepEqual(outcomes.map(item=>[item.disposition,item.verification,item.finalIdentity]),[['published','stream-only',undefined]]);
 const index=await destinationIndex(root,await identity(root)),file=outcomes[0]!.destination;
 assert.equal(index.cached(file,await fs.lstat(file,{bigint:true})),undefined);
 assert.deepEqual(verifiedOriginals(bySource,plans),{files:[],withheld:[{source:original,reason:'unverified'}]});
 // Found already there by this run's own comparison: content-verified, even with verification off.
 const again=await plan(f.source,[root],options,sony),second=await run(again.plans,{verify:false});
 assert.deepEqual(second.outcomes.map(item=>[item.disposition,item.verification]),[['existing','content-verified']]);
 assert.equal(verifiedOriginals(second.bySource,again.plans).files.length,1);
});

test('a copy whose stat proves nothing (exFAT-like) is verified but bound to no identity, so no cache trusts it',async t=>{
 const f=await fixture(t),root=f.backups[0]!;
 const original=await f.put(path.join(f.source,'A.JPG'),bytes(8));
 const {plans}=await plan(f.source,[root],{...options},sony);
 simulateExfat(t,root);
 const {outcomes,bySource,result}=await run(plans);
 assert.deepEqual(result.errors,[]);
 assert.deepEqual(outcomes.map(item=>[item.verification,item.finalIdentity]),[['content-verified',undefined]]);
 const found:PlanDuplicates={files:[{path:original,size:5000,kind:'JPEG',edited:false,birth:0,ctime:0,exif}]};
 await recordPlanDuplicates(root,found,source=>{const item=bySource.get(source)?.[0];return item?.finalIdentity?{destination:item.destination,identity:item.finalIdentity}:undefined;});
 t.mock.restoreAll();syncBuiltinESMExports();dropDuplicateStores();
 assert.equal((await duplicateStore(root,await identity(root))).files.size,0);
 // Delete originals still re-reads every copy, so a verified copy keeps the original deletable.
 assert.equal(verifiedOriginals(bySource,plans).files.length,1);
});

test('every way a file ends up at a destination reports it once',async t=>{
 const f=await fixture(t),root=f.backups[0]!;
 await f.put(path.join(f.source,'A.JPG'),bytes(9));await f.put(path.join(f.source,'B.JPG'),bytes(10));
 const {plans}=await plan(f.source,[root],options,sony);
 // B is found present by the preflight (and again before publishing); A is copied.
 await f.put(plans[0]!.entries.find(entry=>entry.source.endsWith('B.JPG'))!.destination,bytes(10));
 dropDestinationIndexes();
 const {outcomes}=await run(plans);
 const seen=outcomes.map(item=>[path.basename(item.source),item.disposition] as [string,FileOutcome['disposition']]).sort();
 assert.deepEqual(seen,[['A.JPG','published'],['B.JPG','existing']]);
});
