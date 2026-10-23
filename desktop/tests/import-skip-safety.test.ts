import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan,execute,configureOrganizationRecovery,RECOVERY_FOLDER,type PlanProgress} from '../core';
import {executeDestinations} from '../core/destinations';
import {destinationIndex} from '../core/destination-index';
import {olderRulesPaths} from '../core/allocation';
import {deleteOriginals,type VerifiedOriginal} from '../core/originals';
import {statKey} from '../core/paths';
import {identity} from '../core/paths';
import type {Metadata} from '../shared';

configureOrganizationRecovery('skip-safety-fixture-host-authentication-secret-32bytes');
const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}});
const live=async():Promise<Metadata>=>({camera:'iPhone',make:'Apple',date:'2024-02-03T12:00:00Z',fields:{}});
const bytes=(seed:number,size=5000)=>{const data=Buffer.alloc(size);for(let i=0;i<size;i++)data[i]=(i*7+seed)%251;return data;};
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
async function fixture(t:test.TestContext,roots=1){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'skip-safety-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source');await fs.mkdir(source);
 const backups=Array.from({length:roots},(_,i)=>path.join(base,`backup${i}`));for(const root of backups)await fs.mkdir(root);
 const put=async(file:string,data:Buffer)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data);return file;};
 return {base,source,root:backups[0]!,backups,put,old:(root:string)=>path.join(root,'2024/202402/Unknown Camera')};
}
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);

test('a copy changed between the preflight and the verification is not trusted: the family fails and nothing is published',async t=>{
 const f=await fixture(t),data=bytes(1);
 await f.put(path.join(f.source,'A.JPG'),data);const existing=await f.put(path.join(f.old(f.root),'A.JPG'),data);
 const {plans}=await plan(f.source,[f.root],options,metadata);
 const other=bytes(2);
 // The preflight is done when its last progress event arrives; the file is rewritten (same size) right then.
 let changed=false;
 const result=await execute(plans[0]!,undefined,progress=>{if(!changed&&progress.step==='existing'&&progress.completed===progress.total){changed=true;fsSync.writeFileSync(existing,other);}});
 assert.equal(changed,true);
 assert.equal(result.copied,0);assert.equal(result.errors.length,1);assert.match(result.errors[0]!,/Destination changed after copy preparation; retry/);
 assert.deepEqual(await fs.readFile(existing),other,'the changed file is left as it is');
 assert.equal(await exists(path.join(f.root,'2024/202402/Sony A7')),false);
 assert.equal(await exists(path.join(f.old(f.root),'Conflicts')),false);
});

test('a stale session hint for a candidate cannot make the copy trust it',async t=>{
 // Same size and same first 64 KB, so only the full SHA-256 tells them apart.
 const f=await fixture(t),data=bytes(3,100_000),other=Buffer.from(data);other.fill(99,80_000);
 await f.put(path.join(f.source,'A.JPG'),data);const existing=await f.put(path.join(f.old(f.root),'A.JPG'),other);
 // On exFAT an unchanged stat proves nothing, so the session hint for the file can claim the source's bytes.
 const index=await destinationIndex(f.root,await identity(f.root));
 const stat=await fs.lstat(existing,{bigint:true});
 (index as unknown as {hints:Map<string,{stat:string;sha256:string}>}).hints.set(existing,{stat:`${statKey(stat)}:${stat.birthtimeNs}`,sha256:sha(data)});
 const {plans}=await plan(f.source,[f.root],options,metadata);
 const [entry]=plans[0]!.entries;
 assert.equal(entry!.skip,true,'the hint can mislead planning');assert.equal(entry!.routed!==undefined,true);
 const result=await execute(plans[0]!);
 assert.equal(result.copied,0);assert.equal(result.skipped,0);
 assert.deepEqual(await fs.readFile(existing),other);
 assert.equal(await exists(path.join(f.root,'2024/202402/Sony A7')),false);
 assert.equal(await exists(path.join(f.old(f.root),'Conflicts')),false);
 assert.ok(result.errors.length>0&&result.errors.every(line=>/retry/.test(line)));
});

test('copies in Drive backups, Problem files, the recovery store and app files are ignored',async t=>{
 const f=await fixture(t),data=bytes(5);
 await f.put(path.join(f.source,'A.JPG'),data);
 for(const place of ['Drive backups/Card/A.JPG','Problem files/Empty/A.JPG',`${RECOVERY_FOLDER}/x/A.JPG`,'Photo Importer Data/A.JPG','2024/._A.JPG','2024/photo-importer-0a1b.partial','2024/.photo-importer-0a1b.partial'])await f.put(path.join(f.root,place),data);
 const {plans}=await plan(f.source,[f.root],options,metadata);
 assert.equal(plans[0]!.entries[0]!.skip,false);assert.equal(plans[0]!.entries[0]!.routed,undefined);
});

test('the lookup is off for backups, drive copies and organization',async t=>{
 const f=await fixture(t),data=bytes(6);
 await f.put(path.join(f.source,'A.JPG'),data);await f.put(path.join(f.old(f.root),'A.JPG'),data);
 const events:string[]=[],onProgress:PlanProgress=(_c,_f,detail)=>{if(detail)events.push(detail.step);};
 const backup=await plan(f.source,[f.root],{...options,backup:true},metadata,undefined,onProgress);
 assert.ok(backup.plans[0]!.entries.every(entry=>entry.routed===undefined));
 const drive=await plan(f.source,[f.root],{...options,backup:true,drive:{name:'Card',identity:'card-1',mirror:false}},metadata,undefined,onProgress);
 assert.ok(drive.plans[0]!.entries.every(entry=>entry.routed===undefined));
 // Organization works inside the library itself.
 const library=await fixture(t);
 await library.put(path.join(library.root,'2024/202402/Unknown Camera/B.JPG'),bytes(7));await library.put(path.join(library.root,'2024/202402/Other/B.JPG'),bytes(7));
 const organized=await plan(library.root,[library.root],{...options,reorganize:true},metadata,undefined,onProgress);
 assert.ok(organized.plans[0]!.entries.every(entry=>entry.routed===undefined));
 assert.equal(events.includes('locating'),false);
});

test('two destinations are each searched, with their own counters',async t=>{
 const f=await fixture(t,2),data=bytes(8);
 await f.put(path.join(f.source,'A.JPG'),data);
 const existing=[await f.put(path.join(f.old(f.backups[0]!),'A.JPG'),data),await f.put(path.join(f.old(f.backups[1]!),'B.JPG'),data)];
 const events:{count:number;total:number;bytes:number}[]=[];
 const {plans}=await plan(f.source,f.backups,options,metadata,undefined,(count,_file,detail)=>{if(detail?.step==='locating'&&detail.total>0)events.push({count,total:detail.total,bytes:detail.bytes});});
 assert.deepEqual(plans.map(item=>item.entries[0]!.destination),existing);
 assert.ok(plans.every(item=>item.entries[0]!.skip&&item.entries[0]!.routed!==undefined));
 assert.equal(events.filter(event=>event.count===0).length,2,'each destination starts its own count');
 assert.equal(events.filter(event=>event.count===event.total).length>=2,true);
});

test('a Live Photo whose MOV sits in the video root runs through both plans of a destination',async t=>{
 const f=await fixture(t),videos=path.join(f.base,'videobackup');await fs.mkdir(videos);
 const heic=bytes(9),mov=bytes(10,9000);
 await f.put(path.join(f.source,'IMG_1.HEIC'),heic);await f.put(path.join(f.source,'IMG_1.MOV'),mov);
 const video={...options,layout:'video-root' as const,videoRoots:[videos]};
 const first=await plan(f.source,[f.root],video,live);
 await f.put(first.plans[0]!.entries.find(entry=>entry.source.endsWith('.HEIC'))!.destination,heic);
 const existing=await f.put(path.join(videos,'old/IMG_1.MOV'),mov);
 const {dropDestinationIndexes}=await import('../core/destination-index');dropDestinationIndexes();
 const {plans}=await plan(f.source,[f.root],video,live);
 const verified:string[]=[];
 const result=await executeDestinations(plans,{signal:new AbortController().signal,reorganize:false,validate:async()=>{},progress:()=>{},settled:()=>{},onFileOutcome:outcome=>{verified.push(outcome.source);}});
 assert.deepEqual(result.errors,[]);assert.equal(result.copied,0);assert.equal(result.skipped,2);assert.equal(result.routed,1);
 assert.deepEqual(verified.sort(),[path.join(f.source,'IMG_1.HEIC'),path.join(f.source,'IMG_1.MOV')]);
 assert.deepEqual(olderRulesPaths(plans).map(item=>item.existing),[existing]);
 assert.equal(await exists(path.join(f.root,'2024/202402/iPhone/IMG_1.MOV')),false);
});

test('reporting: an import that copies nothing still counts the files found under older rules',async t=>{
 const f=await fixture(t),data=bytes(11);
 await f.put(path.join(f.source,'A.JPG'),data);const existing=await f.put(path.join(f.old(f.root),'A.JPG'),data);
 const {plans,elsewhere}=await plan(f.source,[f.root],options,metadata);
 assert.deepEqual(elsewhere,{files:1,partialFamilies:0,skipped:[]});
 const result=await execute(plans[0]!);
 assert.equal(result.copied,0);assert.equal(result.routed,1);
 assert.deepEqual(olderRulesPaths(plans),[{source:path.join(f.source,'A.JPG'),existing,routed:path.join(f.root,'2024/202402/Sony A7/A.JPG')}]);
 // A family that fails is not counted as found.
 const again=await plan(f.source,[f.root],options,metadata);
 await fs.rm(existing);
 assert.equal((await execute(again.plans[0]!)).routed,undefined);
});

test('Delete originals for a file found under an older rule re-hashes the old path',async t=>{
 const f=await fixture(t),data=bytes(12);
 const original=await f.put(path.join(f.source,'A.JPG'),data);const existing=await f.put(path.join(f.old(f.root),'A.JPG'),data);
 const {plans}=await plan(f.source,[f.root],options,metadata);
 const verified:Record<string,{sha256:string}>={};
 await execute(plans[0]!,undefined,undefined,{onFileOutcome:outcome=>{verified[outcome.source]={sha256:outcome.sha256};}});
 const entry=plans[0]!.entries[0]!;
 const files:VerifiedOriginal[]=[{source:original,size:entry.size,sha256:verified[original]!.sha256,destinations:[entry.destination]}];
 assert.deepEqual(files[0]!.destinations,[existing]);
 // The backup copy changes after the import: the original must stay.
 await fs.writeFile(existing,bytes(13));
 const kept=await deleteOriginals(f.source,files);
 assert.deepEqual(kept.deleted,[]);assert.equal(kept.kept[0]!.reason,'destination-differs');assert.equal(await exists(original),true);
 await fs.writeFile(existing,data);
 const removed=await deleteOriginals(f.source,files);
 assert.equal(removed.deleted.length,1);assert.equal(await exists(original),false);assert.equal(await exists(existing),true);
});
