import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openCatalog} from '../catalog/store';
import {CatalogCoordinator,bindLibrary,catalogStat,type CatalogMoveObservation} from '../catalog/coordinator';
import * as core from '../core/index';
import type {CatalogQuery,CatalogMoveEvent} from '../catalog/types';
core.configureOrganizationRecovery('catalog-mutations-fixture-secret-32bytes');
const options={backup:false as const,reorganize:true as const,template:'{year}/{camera}',layout:'flat' as const};
const metadata=async()=>({camera:'Canon',date:'2024-02-03',fields:{}});
const query=(libraryId:string):CatalogQuery=>({libraryId,filters:[],sort:{field:'name',direction:'asc'},limit:200});
async function fixture(t:test.TestContext,names=['old/A.JPG','old/A.xmp']){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'catalog-mutations-'))),c=openCatalog(':memory:');
 for(const name of names){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),name.endsWith('.xmp')?'sidecar':'same bytes');}
 const binding=await bindLibrary({root,mountPath:root,volumeId:root,name:'Photos',role:'photos',rulesScope:'r',online:true});
 const coordinator=new CatalogCoordinator(c,{metadata,options:()=>options});await coordinator.configure([binding]);await coordinator.refresh(binding.library.libraryId,new AbortController().signal);
 t.after(async()=>{core.setMoveObserver(undefined);await coordinator.settled();await c.close();await fs.rm(root,{recursive:true,force:true});});
 const events:CatalogMoveEvent[]=[];
 core.setMoveObserver((from,_reviewed,to,now,action)=>{const event={action:action??'organize',libraryId:binding.library.libraryId,oldRoot:root,oldRelativePath:path.relative(root,from),newRoot:root,newRelativePath:path.relative(root,to),stat:catalogStat(now),reviewedStat:{dev:_reviewed.dev,ino:_reviewed.ino,size:_reviewed.size,mtimeNs:_reviewed.mtime,ctimeNs:_reviewed.ctime}} satisfies CatalogMoveObservation;events.push(event);return coordinator.observeMove(event);});
 return {root,c,binding,coordinator,events};
}
test('actual organization and undo preserve IDs and companion relations through a later refresh',async t=>{
 const f=await fixture(t),id=f.binding.library.libraryId,original=await f.c.query(query(id));
 const plan=(await core.plan(f.root,[f.root],options,metadata)).plans[0]!;
 const result=await core.executeReorganization(plan);assert.deepEqual(result.errors,[]);await f.coordinator.settled();
 let page=await f.c.query(query(id));assert.equal(page.total,1);assert.equal(page.rows[0].relativePath,'2024/Canon/A.JPG');assert.equal(page.rows[0].fileId,original.rows[0].fileId);assert.equal(page.rows[0].companionCount,1);assert.equal(page.rows[0].values.camera,'Canon');
 await f.coordinator.refresh(id,new AbortController().signal);page=await f.c.query(query(id));assert.equal(page.rows[0].fileId,original.rows[0].fileId);assert.equal(page.rows[0].companionCount,1);
 const [journal]=await core.getOrganizationRecovery(f.root);await core.undoOrganization(f.root,journal.id);await f.coordinator.settled();
 page=await f.c.query(query(id));assert.equal(page.total,1);assert.equal(page.rows[0].relativePath,'old/A.JPG');assert.equal(page.rows[0].fileId,original.rows[0].fileId);assert.equal(page.rows[0].companionCount,1);
});
test('duplicate stashing hides only the removed file, undo restores it, and recovery cleanup leaves the keeper',async t=>{
 const f=await fixture(t,['2024/Canon/A.JPG','old/A.JPG']),id=f.binding.library.libraryId;
 const plan=(await core.plan(f.root,[f.root],options,metadata)).plans[0]!;const result=await core.executeReorganization(plan);assert.deepEqual(result.errors,[]);await f.coordinator.settled();
 assert.equal((await f.c.query(query(id))).total,1);assert.ok(f.events.some(event=>event.newRelativePath?.includes('originals')));
 let [journal]=await core.getOrganizationRecovery(f.root);await core.undoOrganization(f.root,journal.id);await f.coordinator.settled();assert.equal((await f.c.query(query(id))).total,2);
 await core.deleteOrganizationRecovery(f.root,journal.id);await f.coordinator.settled();assert.equal((await f.c.query(query(id))).total,2);
 const next=(await core.plan(f.root,[f.root],options,metadata)).plans[0]!;await core.executeReorganization(next);await f.coordinator.settled();[journal]=await core.getOrganizationRecovery(f.root);await core.finalizeOrganization(f.root,journal.id);await core.deleteOrganizationRecovery(f.root,journal.id);await f.coordinator.settled();assert.equal((await f.c.query(query(id))).total,1);
});
test('rename invalidates filename-sensitive metadata, cross-library moves are atomic, and stale scans cannot resurrect old paths',async t=>{
 const f=await fixture(t,['A.JPG']),id=f.binding.library.libraryId,original=(await f.c.query(query(id))).rows[0],run=await f.c.beginScan(id,['']);
 const old=(await f.c.records(id,['A.JPG']))[0];await fs.rename(path.join(f.root,'A.JPG'),path.join(f.root,'B.JPG'));
 await f.coordinator.observeMove({action:'organize',libraryId:id,oldRoot:f.root,oldRelativePath:'A.JPG',newRoot:f.root,newRelativePath:'B.JPG',stat:catalogStat(await fs.stat(path.join(f.root,'B.JPG'),{bigint:true}))});
 await f.c.ingest(run,[old]);await f.c.endScan(run,'complete');let page=await f.c.query(query(id));assert.equal(page.total,1);assert.equal(page.rows[0].fileId,original.fileId);assert.equal(page.rows[0].metadataStatus,'pending');
 const other=path.join(f.root,'second');await fs.mkdir(other);const binding=await bindLibrary({root:other,mountPath:f.root,volumeId:f.root,name:'Second',role:'photos',rulesScope:'r',online:true});await f.coordinator.configure([f.binding,binding]);
 await fs.rename(path.join(f.root,'B.JPG'),path.join(other,'B.JPG'));await f.coordinator.observeMove({action:'restore',libraryId:id,oldRoot:f.root,oldRelativePath:'B.JPG',newRoot:other,newRelativePath:'B.JPG',stat:catalogStat(await fs.stat(path.join(other,'B.JPG'),{bigint:true}))});
 assert.equal((await f.c.query(query(id))).total,0);assert.equal((await f.c.query(query(binding.library.libraryId))).total,1);
});
test('cancelled organization indexes completed moves only and resume fills the remaining paths',async t=>{
 const f=await fixture(t,['old/A.JPG','old/B.JPG','old/C.JPG']),id=f.binding.library.libraryId,control=new AbortController();
 core.setMoveObserver((from,_reviewed,to,now,action)=>{const observed=f.coordinator.observeMove({action:action??'organize',libraryId:id,oldRoot:f.root,oldRelativePath:path.relative(f.root,from),newRoot:f.root,newRelativePath:path.relative(f.root,to),stat:catalogStat(now)});control.abort();return observed;});
 const plan=(await core.plan(f.root,[f.root],options,metadata)).plans[0]!;await core.executeReorganization(plan,control.signal).catch(error=>assert.equal(error.name,'AbortError'));await f.coordinator.settled();
 const partial=await f.c.query(query(id));assert.equal(partial.total,3);assert.equal(partial.rows.filter(row=>row.relativePath.startsWith('2024/')).length,1);assert.equal(partial.rows.filter(row=>row.relativePath.startsWith('old/')).length,2);
 const [journal]=await core.getOrganizationRecovery(f.root);const result=await core.resumeOrganization(f.root,journal.id);assert.deepEqual(result.errors,[]);await f.coordinator.settled();assert.equal((await f.c.query(query(id))).rows.every(row=>row.relativePath.startsWith('2024/')),true);
});
test('actual duplicate removal carries a companion and its undo restores both originals',async t=>{
 const f=await fixture(t,['keep/A.JPG','old/A.JPG','old/A.xmp']),id=f.binding.library.libraryId;
 const {removeDuplicates}=await import('../core/duplicate-removal'),{digest}=await import('../core/paths');
 const files=await Promise.all(['keep/A.JPG','old/A.JPG'].map(async relative=>{const stat=await fs.stat(path.join(f.root,relative),{bigint:true});return {path:relative,size:Number(stat.size),kind:'JPEG' as const,edited:false,birth:Number(stat.birthtimeMs),ctime:Number(stat.ctimeMs),sha256:await digest(path.join(f.root,relative))};}));
 const removal=await removeDuplicates(f.root,[{group:{id:'group',strength:'sha',files},keep:'keep/A.JPG',remove:[files[1]],decided:false,auto:true,suggested:'keep/A.JPG',needsDecision:false}],new Map([['old/A.JPG',['old/A.xmp']]]));assert.equal(removal.removed,1);assert.equal(removal.carried,1);await f.coordinator.settled();
 let page=await f.c.query(query(id));assert.equal(page.total,1);assert.equal(page.rows[0].relativePath,'keep/A.JPG');assert.equal(page.rows[0].companionCount,1);
 await core.undoOrganization(f.root,removal.id!);await f.coordinator.settled();page=await f.c.query(query(id));assert.equal(page.total,2);assert.equal(page.rows.find(row=>row.relativePath==='old/A.JPG')?.companionCount,1);
});
test('excluded app records and backups stay outside an empty-base library after moves and refresh',async t=>{
 const f=await fixture(t,['A.JPG']),id=f.binding.library.libraryId;
 for(const folder of ['Photo Importer Data','Photo Importer Recovery','.photo-importer-recovery','Drive backups']){
  await fs.mkdir(path.join(f.root,folder),{recursive:true});await fs.rename(path.join(f.root,'A.JPG'),path.join(f.root,folder,'A.JPG'));
  await f.coordinator.observeMove({action:'duplicateRemoval',libraryId:id,oldRoot:f.root,oldRelativePath:'A.JPG',newRoot:f.root,newRelativePath:folder+'/A.JPG',stat:catalogStat(await fs.stat(path.join(f.root,folder,'A.JPG'),{bigint:true}))});assert.equal((await f.c.query(query(id))).total,0);
  await f.coordinator.refresh(id,new AbortController().signal);assert.equal((await f.c.query(query(id))).total,0);
  await fs.rename(path.join(f.root,folder,'A.JPG'),path.join(f.root,'A.JPG'));await f.coordinator.observeMove({action:'restore',libraryId:id,oldRoot:f.root,oldRelativePath:folder+'/A.JPG',newRoot:f.root,newRelativePath:'A.JPG',stat:catalogStat(await fs.stat(path.join(f.root,'A.JPG'),{bigint:true}))});assert.equal((await f.c.query(query(id))).total,1);
 }
});
test('observer promise rejection cannot fail an actual move, including a file without a capture timestamp',async t=>{
 const f=await fixture(t,['old/A.JPG']);let heard=0;core.setMoveObserver(async()=>{heard++;throw new Error('index offline');});
 const plan=(await core.plan(f.root,[f.root],options,async()=>({camera:'Canon',fields:{}}))).plans[0]!;
 const result=await core.executeReorganization(plan);assert.deepEqual(result.errors,[]);assert.equal(heard,1);await new Promise(resolve=>setImmediate(resolve));
});
test('resume replays verified moves missed before a process exit without changing stable IDs',async t=>{
 const f=await fixture(t,['old/A.JPG']),id=f.binding.library.libraryId,before=(await f.c.query(query(id))).rows[0];core.setMoveObserver(undefined);
 const plan=(await core.plan(f.root,[f.root],options,metadata)).plans[0]!;await core.executeReorganization(plan);assert.equal((await f.c.query(query(id))).rows[0].relativePath,'old/A.JPG');
 core.setMoveObserver((from,_reviewed,to,now,action)=>f.coordinator.observeMove({action:action??'organize',libraryId:id,oldRoot:f.root,oldRelativePath:path.relative(f.root,from),newRoot:f.root,newRelativePath:path.relative(f.root,to),stat:catalogStat(now)}));
 const [journal]=await core.getOrganizationRecovery(f.root);await core.resumeOrganization(f.root,journal.id);await f.coordinator.settled();const after=(await f.c.query(query(id))).rows[0];assert.equal(after.relativePath,'2024/Canon/A.JPG');assert.equal(after.fileId,before.fileId);
});
test('catalog write failure does not fail organization and a dirty refresh repairs it',async t=>{
 const f=await fixture(t,['old/A.JPG']),id=f.binding.library.libraryId,apply=f.c.apply;
 const plan=(await core.plan(f.root,[f.root],options,metadata)).plans[0]!;f.c.apply=async()=>{throw new Error('catalog temporarily unavailable');};
 try{const result=await core.executeReorganization(plan);assert.deepEqual(result.errors,[]);await f.coordinator.settled();assert.equal((await f.coordinator.status(id)).dirty,true);assert.equal(await fs.readFile(path.join(f.root,'2024/Canon/A.JPG'),'utf8'),'same bytes');}finally{f.c.apply=apply;}
 await f.coordinator.refresh(id,new AbortController().signal);assert.equal((await f.c.query(query(id))).rows[0].relativePath,'2024/Canon/A.JPG');
});
test('settled drains bounded move work including a follow-up enqueued by a completed observation',async t=>{
 const f=await fixture(t,['A.JPG']),id=f.binding.library.libraryId;await fs.rename(path.join(f.root,'A.JPG'),path.join(f.root,'B.JPG'));
 const event:CatalogMoveEvent={action:'organize',libraryId:id,oldRoot:f.root,oldRelativePath:'A.JPG',newRoot:f.root,newRelativePath:'B.JPG',stat:catalogStat(await fs.stat(path.join(f.root,'B.JPG'),{bigint:true}))};
 let followupDone=false;const first=f.coordinator.observeMove(event),followup=first.then(()=>f.coordinator.observeMove(event)).then(()=>{followupDone=true;});assert.equal(f.coordinator.running,true);await f.coordinator.settled();assert.equal(f.coordinator.running,false);assert.equal(followupDone,true);await followup;assert.equal((await f.c.query(query(id))).total,1);
 const pending=Array.from({length:4500},()=>f.coordinator.observeMove({action:'undo',libraryId:id,oldRoot:f.root,oldRelativePath:'B.JPG'}));await f.coordinator.settled();await Promise.all(pending);assert.equal(f.coordinator.running,false);assert.equal((await f.c.query(query(id))).total,1);assert.equal((await f.coordinator.status(id)).dirty,true);
});

test('copy publication settled before original stashing retains its original logical ID',async t=>{
 const f=await fixture(t,['old/A.JPG']),id=f.binding.library.libraryId,original=(await f.c.query(query(id))).rows[0],published=path.join(f.root,'new/A.JPG'),saved=path.join(f.root,'Photo Importer Data/slot/A.JPG');
 await fs.mkdir(path.dirname(published),{recursive:true});await fs.copyFile(path.join(f.root,'old/A.JPG'),published);
 await f.coordinator.observeMove({action:'organize',libraryId:id,oldRoot:f.root,oldRelativePath:'old/A.JPG',newRoot:f.root,newRelativePath:'new/A.JPG',stat:catalogStat(await fs.stat(published,{bigint:true}))});assert.equal((await f.c.query(query(id))).total,2);
 await fs.mkdir(path.dirname(saved),{recursive:true});await fs.rename(path.join(f.root,'old/A.JPG'),saved);
 await f.coordinator.observeMove({action:'organize',libraryId:id,oldRoot:f.root,oldRelativePath:'old/A.JPG',newRoot:f.root,newRelativePath:'Photo Importer Data/slot/A.JPG',stat:catalogStat(await fs.stat(saved,{bigint:true}))});
 const page=await f.c.query(query(id));assert.equal(page.total,1);assert.equal(page.rows[0].relativePath,'new/A.JPG');assert.equal(page.rows[0].fileId,original.fileId);
});
test('reusing an original filename after rename creates a distinct file ID without overwriting the moved file',async t=>{
 const f=await fixture(t,['A.JPG']),id=f.binding.library.libraryId,original=(await f.c.query(query(id))).rows[0];await fs.rename(path.join(f.root,'A.JPG'),path.join(f.root,'B.JPG'));
 await f.coordinator.observeMove({action:'organize',libraryId:id,oldRoot:f.root,oldRelativePath:'A.JPG',newRoot:f.root,newRelativePath:'B.JPG',stat:catalogStat(await fs.stat(path.join(f.root,'B.JPG'),{bigint:true}))});
 await fs.writeFile(path.join(f.root,'A.JPG'),'another photograph');await f.coordinator.refresh(id,new AbortController().signal);
 const page=await f.c.query(query(id));assert.equal(page.total,2);assert.equal(new Set(page.rows.map(row=>row.fileId)).size,2);assert.equal(page.rows.find(row=>row.relativePath==='B.JPG')?.fileId,original.fileId);
});

for(const order of [['A.JPG','A.xmp'],['A.xmp','A.JPG']] as const)test(`separately settled copy publications keep companion links when stashed ${order[0]} first`,async t=>{
 const f=await fixture(t),id=f.binding.library.libraryId,original=(await f.c.query(query(id))).rows[0];await fs.mkdir(path.join(f.root,'new'));await fs.mkdir(path.join(f.root,'Photo Importer Data/slot'),{recursive:true});
 const observe=async(from:string,to:string)=>f.coordinator.observeMove({action:'organize',libraryId:id,oldRoot:f.root,oldRelativePath:from,newRoot:f.root,newRelativePath:to,stat:catalogStat(await fs.stat(path.join(f.root,to),{bigint:true}))});
 const stash=async(name:string)=>{await fs.rename(path.join(f.root,'old',name),path.join(f.root,'Photo Importer Data/slot',name));await observe('old/'+name,'Photo Importer Data/slot/'+name);};
 const noDangling=async()=>{for(const record of await f.c.records(id,['old/A.JPG','old/A.xmp','new/A.JPG','new/A.xmp']))if(record.companionOf)assert.ok(await f.c.file(id,record.companionOf),`${record.relativePath} points at a missing row`);};
 for(const name of ['A.JPG','A.xmp']){await fs.copyFile(path.join(f.root,'old',name),path.join(f.root,'new',name));await observe('old/'+name,'new/'+name);}
 await stash(order[0]);await noDangling();
 let page=await f.c.query(query(id));
 if(order[0]==='A.JPG'){assert.equal(page.total,1);assert.equal(page.rows[0].fileId,original.fileId);assert.equal(page.rows[0].companionCount,2);}
 await stash(order[1]);await noDangling();
 page=await f.c.query(query(id));assert.equal(page.total,1);assert.equal(page.rows[0].fileId,original.fileId);assert.equal(page.rows[0].relativePath,'new/A.JPG');assert.equal(page.rows[0].companionCount,1);
 assert.equal((await f.c.records(id,['new/A.xmp']))[0]?.companionOf,original.fileId);
});
test('removed libraries no longer exclude their former subtree from a parent library refresh',async t=>{
 const f=await fixture(t,['Archive/B.JPG','C.JPG']),id=f.binding.library.libraryId;
 const child=await bindLibrary({root:path.join(f.root,'Archive'),mountPath:f.root,volumeId:f.root,name:'Archive',role:'photos',rulesScope:'r',online:true});
 await f.coordinator.configure([f.binding,child]);await f.coordinator.refresh(id,new AbortController().signal);
 assert.deepEqual((await f.c.query(query(id))).rows.map(row=>row.relativePath),['C.JPG']);
 await f.coordinator.configure([f.binding]);await f.coordinator.refresh(id,new AbortController().signal);
 assert.deepEqual((await f.c.query(query(id))).rows.map(row=>row.relativePath).sort(),['Archive/B.JPG','C.JPG']);
 assert.ok((await f.c.status(child.library.libraryId)));
});
