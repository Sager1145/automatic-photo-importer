import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan,execute,configureOrganizationRecovery,RECOVERY_FOLDER,type PlanProgress} from '../core';
import {placedOutcomes} from '../platform/placement-memory';
import {dropDestinationIndexes} from '../core/destination-index';
import {recordPartial} from '../core/import-recovery';
import type {Metadata,TransferPlan} from '../shared';
import {stagePathFor} from './fixtures/receipts';
import {randomUUID} from 'node:crypto';

configureOrganizationRecovery('skip-existing-fixture-host-authentication-secret-32bytes');
const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}});
const bytes=(seed:number,size=5000)=>{const data=Buffer.alloc(size);for(let i=0;i<size;i++)data[i]=(i*7+seed)%251;return data;};
async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'skip-existing-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),root=path.join(base,'backup');await fs.mkdir(source);await fs.mkdir(root);
 const put=async(file:string,data:Buffer)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data);return file;};
 return {base,source,root,put,old:path.join(root,'2024/202402/Unknown Camera')};
}
const all=(transfer:TransferPlan)=>[...transfer.entries,...(transfer.videos?.entries??[])];
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);

test('a file already at an old route is skipped there, with the wanted route recorded and nothing written at it',async t=>{
 const f=await fixture(t),data=bytes(1);
 await f.put(path.join(f.source,'A.JPG'),data);const existing=await f.put(path.join(f.old,'A.JPG'),data);
 const {plans}=await plan(f.source,[f.root],options,metadata);
 const [entry]=plans[0]!.entries;
 assert.equal(entry!.skip,true);assert.equal(entry!.destination,existing);assert.equal(entry!.routed,path.join(f.root,'2024/202402/Sony A7/A.JPG'));
 assert.equal(entry!.allocation!.destination,existing);assert.equal(entry!.allocation!.folder,path.dirname(existing));
 assert.ok(entry!.digest);
 const result=await execute(plans[0]!);
 assert.equal(result.copied,0);assert.equal(result.skipped,1);assert.deepEqual(result.errors,[]);
 assert.equal(await exists(path.join(f.root,'2024/202402/Sony A7')),false);
});

test('a renamed copy elsewhere is found by size and SHA-256',async t=>{
 const f=await fixture(t),data=bytes(2);
 await f.put(path.join(f.source,'A.JPG'),data);const existing=await f.put(path.join(f.old,'renamed.JPG'),data);
 const {plans}=await plan(f.source,[f.root],options,metadata);
 assert.equal(plans[0]!.entries[0]!.skip,true);assert.equal(plans[0]!.entries[0]!.destination,existing);
});

test('the same size with different bytes is copied',async t=>{
 const f=await fixture(t);
 await f.put(path.join(f.source,'A.JPG'),bytes(3));await f.put(path.join(f.old,'A.JPG'),bytes(4));
 const {plans}=await plan(f.source,[f.root],options,metadata);
 const entry=plans[0]!.entries[0]!;
 assert.equal(entry.skip,false);assert.equal(entry.routed,undefined);assert.equal(entry.destination,path.join(f.root,'2024/202402/Sony A7/A.JPG'));
 assert.equal((await execute(plans[0]!)).copied,1);
});

test('a Live MOV whose copy is in the video root is moved into the video plan and skipped',async t=>{
 const f=await fixture(t),videos=path.join(f.base,'videobackup');await fs.mkdir(videos);
 const live=async():Promise<Metadata>=>({camera:'iPhone',make:'Apple',date:'2024-02-03T12:00:00Z',fields:{}});
 const heic=bytes(5),mov=bytes(6,9000);
 await f.put(path.join(f.source,'IMG_1.HEIC'),heic);await f.put(path.join(f.source,'IMG_1.MOV'),mov);
 const video={...options,layout:'video-root' as const,videoRoots:[videos]};
 const first=await plan(f.source,[f.root],video,live);
 const photo=first.plans[0]!.entries.find(entry=>entry.source.endsWith('.HEIC'))!;
 await f.put(photo.destination,heic);const existing=await f.put(path.join(videos,'old/IMG_1.MOV'),mov);
 dropDestinationIndexes();
 const {plans}=await plan(f.source,[f.root],video,live);
 const moved=plans[0]!.videos!.entries.find(entry=>entry.source.endsWith('.MOV'))!;
 assert.ok(moved,'moved into the video plan');
 assert.equal(plans[0]!.entries.some(entry=>entry.source.endsWith('.MOV')),false);
 assert.equal(moved.skip,true);assert.equal(moved.destination,existing);assert.ok(moved.routed!.startsWith(f.root));
 const result=await execute(plans[0]!.videos!);assert.deepEqual(result.errors,[]);
 assert.equal(all(plans[0]!).every(entry=>entry.skip),true);
});

test('a partly present family is copied whole',async t=>{
 const f=await fixture(t),jpg=bytes(7),raw=bytes(8,8000);
 await f.put(path.join(f.source,'A.JPG'),jpg);await f.put(path.join(f.source,'A.ARW'),raw);
 const existing=await f.put(path.join(f.old,'A.JPG'),jpg);
 const result=await plan(f.source,[f.root],options,metadata);
 const entries=result.plans[0]!.entries;
 assert.equal(entries.length,2);assert.ok(entries.every(entry=>!entry.skip&&entry.routed===undefined));
 assert.ok(entries.every(entry=>entry.destination.startsWith(path.join(f.root,'2024/202402/Sony A7'))));
 assert.equal(await exists(existing),true);
});

test('an existing copy removed before the copy fails the family with a retry and publishes nothing',async t=>{
 const f=await fixture(t),data=bytes(9);
 await f.put(path.join(f.source,'A.JPG'),data);const existing=await f.put(path.join(f.old,'A.JPG'),data);
 const {plans}=await plan(f.source,[f.root],options,metadata);
 await fs.rm(existing);
 const result=await execute(plans[0]!);
 assert.equal(result.copied,0);assert.equal(result.errors.length,1);assert.match(result.errors[0]!,/Destination changed after copy preparation; retry/);
 assert.equal(await exists(path.join(f.root,'2024/202402/Sony A7')),false);
 assert.equal(await exists(existing),false);
 assert.deepEqual((await fs.readdir(f.old)).filter(name=>name.endsWith('.partial')),[]);
});

test('a receipt-bound stale stage at the old path is released by the copy',async t=>{
 const f=await fixture(t),data=bytes(10);
 await f.put(path.join(f.source,'A.JPG'),data);const existing=await f.put(path.join(f.old,'A.JPG'),data);
 const {plans}=await plan(f.source,[f.root],options,metadata);
 const entry=plans[0]!.entries[0]!;
 // The staged copy waits in the records folder's staging folder (records v5).
 const stage=await f.put(await stagePathFor(f.root,randomUUID()),data);
 await recordPartial('stage',stage,await fs.lstat(stage,{bigint:true}),entry,plans[0]!,new Map());
 const result=await execute(plans[0]!);
 assert.deepEqual(result.errors,[]);assert.equal(result.skipped,1);
 assert.equal(await exists(stage),false);assert.equal(await exists(existing),true);
});

test('a skipped file is reported verified at the old path',async t=>{
 const f=await fixture(t),data=bytes(11);
 await f.put(path.join(f.source,'A.JPG'),data);const existing=await f.put(path.join(f.old,'A.JPG'),data);
 const {plans}=await plan(f.source,[f.root],options,metadata);
 const seen:string[]=[];
 await execute(plans[0]!,undefined,undefined,{onFileOutcome:outcome=>{seen.push(outcome.source);}});
 assert.deepEqual(seen,[path.join(f.source,'A.JPG')]);
 assert.equal(plans[0]!.entries.find(entry=>entry.source===seen[0])!.destination,existing);
});

test('a copy inside the recovery store never counts',async t=>{
 const f=await fixture(t),data=bytes(12);
 await f.put(path.join(f.source,'A.JPG'),data);await f.put(path.join(f.root,RECOVERY_FOLDER,'set-aside/A.JPG'),data);
 const {plans}=await plan(f.source,[f.root],options,metadata);
 assert.equal(plans[0]!.entries[0]!.skip,false);assert.equal(plans[0]!.entries[0]!.routed,undefined);
});

test('files found elsewhere are not remembered as placed',()=>{
 const outcome=(destination:string,destinationSlot:number,disposition:string)=>({destination,destinationSlot,disposition,size:1});
 const outcomes=[[outcome('/d/a',0,'existing'),outcome('/e/a',1,'published')],[outcome('/d/old/b',0,'routed')],[outcome('/v/c',0,'published')]];
 assert.deepEqual(placedOutcomes(outcomes,0).map(item=>item.destination),['/d/a','/v/c']);
});

test('the lookup reports a counter that moves to the number of files looked up',async t=>{
 const f=await fixture(t);
 for(let i=0;i<3;i++){const data=bytes(20+i);await f.put(path.join(f.source,`P${i}.JPG`),data);await f.put(path.join(f.old,`P${i}.JPG`),data);}
 const events:{count:number;total:number}[]=[];
 const onProgress:PlanProgress=(count,_file,detail)=>{if(detail?.step==='locating')events.push({count,total:detail.total});};
 await plan(f.source,[f.root],options,metadata,undefined,onProgress);
 // First the files found while listing the library (no total yet), then N of M.
 const counted=events.filter(event=>event.total>0),listing=events.filter(event=>event.total===0);
 assert.ok(listing.length>0&&events.indexOf(listing.at(-1)!)<events.indexOf(counted[0]!),'listing is reported before the count');
 assert.ok(listing.some(event=>event.count>0),'the files found so far are reported');
 assert.ok(counted.length>=2);assert.ok(counted.every(event=>event.total===3));
 assert.deepEqual(counted.map(event=>event.count),[...counted.map(event=>event.count)].sort((a,b)=>a-b));
 assert.equal(counted[0]!.count,0);assert.equal(counted.at(-1)!.count,3);
});
