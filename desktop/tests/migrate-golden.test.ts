import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import * as core from '../core/index';
import {journalStateFor,legacyStateFor,journalFolderFor} from '../core/recovery';
import {identity} from '../core/paths';
import {migrateDrive} from '../core/migrate/index';
import * as main from './fixtures/legacy-main/recovery';
import * as mainReceipts from './fixtures/legacy-main/import-recovery';
import {pointerFilesFor} from './fixtures/records';
import {openReceiptsFor} from './fixtures/receipts';
import type {Metadata,PlanEntry,TransferPlan} from '../shared';

// Golden tests: records written by main's own code (the last version before records v5, vendored under
// fixtures/legacy-main), read by main and by the converter, then converted. The converter must read exactly what
// main reads, and the converted journal must give the same state, with the same kept originals.
const KEY='fixture-only-host-recovery-secret-32bytes';
core.configureOrganizationRecovery(KEY);main.configureOrganizationRecovery(KEY);
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function folder(t:test.TestContext,name:string){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),name)));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 return base;
}
/** Main's organization entries for files moved from `source` into `root` (flat, by name). */
async function entries(source:string,root:string,files:string[]):Promise<main.OrganizationEntry[]>{
 return Promise.all(files.map(async file=>{const bytes=await fs.readFile(file);return {source:file,destination:path.join(root,'2024',path.basename(file)),digest:sha(bytes),size:bytes.length,stat:await fs.lstat(file,{bigint:true}),move:true};}));
}
const transfer=async(root:string,source:string)=>({root,rootIdentity:await identity(root),source,sourceIdentity:await identity(source),entries:[]}) as unknown as TransferPlan;
/** Every kept original under a journal folder: path below originals/, inode and SHA-256. */
async function originals(journal:string):Promise<string[]>{
 const base=path.join(journal,'originals');if(!await exists(base))return [];
 const found:string[]=[];
 for(const name of (await fs.readdir(base,{recursive:true})).map(String).sort()){const file=path.join(base,name),stat=await fs.lstat(file,{bigint:true});if(stat.isFile()&&!path.basename(name).startsWith('._'))found.push(`${name} ${stat.ino} ${sha(await fs.readFile(file))}`);}
 return found;
}
/** One file per event, as versions before the event log wrote them: main's own signed records, in folder order. */
async function toEventFiles(journal:string,keep:number){
 const log=path.join(journal,'event-log.jsonl'),lines=(await fs.readFile(log,'utf8')).split('\n').filter(Boolean);
 for(const line of lines.slice(keep))await fs.writeFile(path.join(journal,`event-${randomUUID()}.json`),line);
 if(keep)await fs.writeFile(log,lines.slice(0,keep+1).join('\n')+'\n');else await fs.unlink(log);
}

for(const format of ['log','files','both'] as const)test(`a journal main wrote (${format}) with kept originals: the converter reads what main reads, and converts it to the same state and the same originals`,async t=>{
 const base=await folder(t,'migrate-golden-');
 const root=path.join(base,'library'),incoming=path.join(root,'incoming');await fs.mkdir(incoming,{recursive:true});
 const files=[];for(let index=0;index<4;index++){const file=path.join(incoming,`DSC_${index}.NEF`);await fs.writeFile(file,Buffer.alloc(2000+index,index+1));files.push(file);}
 const result=await main.beginOrganization(await transfer(root,root),await entries(root,root,files),undefined,undefined,'copy');
 assert.deepEqual(result.errors,[]);assert.equal(result.retained,4);
 const [job]=await main.getOrganizationRecovery(root);
 const legacy=path.join(root,'Photo Importer Recovery',job!.id);
 if(format!=='log')await toEventFiles(legacy,format==='both'?3:0);
 const before=await main.mainStateFor(root,job!.id),kept=await originals(legacy);
 assert.equal(kept.length,4);
 assert.equal(await legacyStateFor(root,job!.id),before,'the converter reads exactly what main reads');
 assert.deepEqual((await migrateDrive([root])).problems,[]);
 assert.equal(await journalStateFor(root,job!.id),before,'the converted journal gives the same state');
 assert.deepEqual(await originals(await journalFolderFor(root,job!.id)),kept,'the same originals, same inodes and bytes, at the same places');
 assert.equal(await exists(legacy),false);
 const [listed]=await core.getOrganizationRecovery(root);
 assert.deepEqual({status:listed!.status,files:listed!.files,completed:listed!.completed,retainedFiles:listed!.retainedFiles,retainedBytes:listed!.retainedBytes},{status:job!.status,files:job!.files,completed:job!.completed,retainedFiles:job!.retainedFiles,retainedBytes:job!.retainedBytes});
 assert.equal((await core.undoOrganization(root,job!.id)).restored,4);
 for(const [index,file] of files.entries())assert.deepEqual(await fs.readFile(file),Buffer.alloc(2000+index,index+1));
});

test('a stopped rename main wrote, with its pointer in the card folder: converted, the pointer rewritten in the store, and resume finishes',async t=>{
 const base=await folder(t,'migrate-golden-pointer-');
 const drive=path.join(base,'drive'),photos=path.join(drive,'photobackup'),card=path.join(drive,'2025');
 await fs.mkdir(photos,{recursive:true});await fs.mkdir(card,{recursive:true});
 const files=[];for(const name of ['A.JPG','B.JPG','C.JPG']){const file=path.join(card,name);await fs.writeFile(file,'bytes of '+name);files.push(file);}
 const controller=new AbortController();
 await assert.rejects(main.beginOrganization(await transfer(photos,drive),await entries(drive,photos,files),controller.signal,value=>{if(value.step==='moving'&&value.completed>=1)controller.abort();},'rename'),{name:'AbortError'});
 const [job]=await main.getOrganizationRecovery(photos);
 const oldPointer=path.join(card,'Photo Importer Recovery',`journal-${job!.id}.json`);
 assert.ok(await exists(oldPointer),'main left its pointer in the card folder');
 const before=await main.mainStateFor(photos,job!.id);
 assert.equal(await legacyStateFor(photos,job!.id),before);
 assert.deepEqual((await migrateDrive([photos])).problems,[]);
 assert.equal(await journalStateFor(photos,job!.id),before);
 assert.equal(await exists(oldPointer),false);assert.equal(await exists(path.join(card,'Photo Importer Recovery')),false);
 assert.equal((await pointerFilesFor(card)).length,1,'the live journal\'s pointer is in the store');
 assert.deepEqual((await core.resumeOrganization(photos,job!.id)).errors,[]);
 assert.deepEqual(await pointerFilesFor(card),[]);
 for(const name of ['A.JPG','B.JPG','C.JPG'])assert.equal(await fs.readFile(path.join(photos,'2024',name),'utf8'),'bytes of '+name);
 assert.equal(await exists(card),false,'the emptied card folder is gone');
});

test('receipts main wrote: its staged copy is moved into the store and continued in place; its creation receipt for a file being written is kept in the log',async t=>{
 const base=await folder(t,'migrate-golden-receipts-');
 const source=path.join(base,'card'),root=path.join(base,'backup');await fs.mkdir(source);await fs.mkdir(root);
 const bytes=Buffer.alloc(3*1024*1024+11,5),other=Buffer.alloc(40_000,9);
 await fs.writeFile(path.join(source,'DSC_0001.NEF'),bytes);await fs.writeFile(path.join(source,'DSC_0002.NEF'),other);
 const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});
 const plan=()=>core.plan(source,[root],{backup:false,template:'{year}/{camera}',layout:'flat',unknownRules:{}},metadata).then(result=>result.plans[0]!);
 const reviewed=await plan(),[first,second]=reviewed.entries as [PlanEntry,PlanEntry];
 await fs.mkdir(path.dirname(first.destination),{recursive:true});
 // Main's stage: a prefix beside the destination with its receipt.
 const partial=path.join(path.dirname(first.destination),`photo-importer-${randomUUID()}.partial`);await fs.writeFile(partial,bytes.subarray(0,1_000_000));
 const stat=await fs.lstat(partial,{bigint:true});
 await mainReceipts.recordPartial('stage',partial,stat,first,reviewed,new Map());
 // Main's publication receipt for a destination it started writing exclusively (exFAT path), and the bytes so far.
 const creating=await mainReceipts.recordCreation(second.destination,{...second,digest:sha(other)},reviewed,new Map());
 await fs.writeFile(second.destination,other.subarray(0,10_000));
 const destinationStat=await fs.lstat(second.destination,{bigint:true});
 await mainReceipts.recordPartial('publication',second.destination,destinationStat,{...second,digest:sha(other)},reviewed,new Map());
 await fs.unlink(creating.journal);
 assert.deepEqual((await migrateDrive([root])).problems,[]);
 assert.deepEqual((await fs.readdir(path.dirname(first.destination))).sort(),[path.basename(second.destination)].sort(),'no receipt or staged copy beside the media');
 const open=[...(await openReceiptsFor(root)).values()];
 assert.deepEqual(open.map(record=>record.kind).sort(),['publication','stage']);
 const result=await core.execute(await plan());
 assert.deepEqual(result.errors,[]);
 assert.deepEqual(await fs.readFile(first.destination),bytes);
 assert.equal((await fs.lstat(first.destination,{bigint:true})).ino,stat.ino,'main\'s staged bytes were continued, not copied again');
 assert.deepEqual(await fs.readFile(second.destination),other);
 assert.equal((await openReceiptsFor(root)).size,0);
});
