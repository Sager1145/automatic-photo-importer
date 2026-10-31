import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openCatalog} from '../catalog/store';
import {CatalogCoordinator,bindLibrary} from '../catalog/coordinator';
import {cachedRouting,primeRouting} from '../platform/metadata';
import type {CatalogQuery} from '../catalog/types';
const query=(libraryId:string):CatalogQuery=>({libraryId,filters:[],sort:{field:'name',direction:'asc'},limit:200});
test('library refresh revalidates file stats, reuses raw metadata, and never creates missing photo roots',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-ingest-'));const c=openCatalog(':memory:');let reads=0;
 try{
  const root=path.join(dir,'photos');await fs.mkdir(root);await fs.writeFile(path.join(root,'A.jpg'),'photo');
  const binding=await bindLibrary({root,mountPath:dir,volumeId:'disk',name:'Photos',role:'photos',rulesScope:'rules',online:true});
  const coordinator=new CatalogCoordinator(c,{metadata:async()=>{reads++;return {camera:'Canon',date:'2024-02-03T12:00:00',fields:{}};},options:()=>({template:'{year}/{camera}',layout:'flat'})});
  await coordinator.configure([binding]);await coordinator.refresh(binding.library.libraryId,new AbortController().signal);
  assert.equal(reads,1);let page=await c.query(query(binding.library.libraryId));assert.equal(page.total,1);assert.equal(page.rows[0].values.captureDay,'2024-02-03');
  await coordinator.refresh(binding.library.libraryId,new AbortController().signal);assert.equal(reads,1);
  await fs.writeFile(path.join(root,'A.jpg'),'edited photo');await coordinator.refresh(binding.library.libraryId,new AbortController().signal);assert.equal(reads,2);
  const missing=await bindLibrary({root:path.join(dir,'missing'),mountPath:dir,volumeId:'disk',name:'Missing',role:'photos',rulesScope:'rules',online:true});await coordinator.configure([binding,missing]);await coordinator.refresh(missing.library.libraryId,new AbortController().signal);await assert.rejects(fs.stat(path.join(dir,'missing')),{code:'ENOENT'});
 }finally{await c.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('source scanning never indexes target files; only each successful actual outcome adds a destination',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'catalog-outcomes-'))),c=openCatalog(':memory:');
 try{
  const source=path.join(dir,'card');await fs.mkdir(source);await fs.writeFile(path.join(source,'A.jpg'),'raw');
  const one=path.join(dir,'one'),two=path.join(dir,'two');await fs.mkdir(one);await fs.mkdir(two);await fs.mkdir(path.join(one,'older'));await fs.writeFile(path.join(one,'older','actual.jpg'),'raw');
  const bindings=await Promise.all([one,two].map(root=>bindLibrary({root,mountPath:dir,volumeId:path.basename(root),name:root,role:'photos',rulesScope:'r',online:true})));
  const sourceFile=path.join(source,'A.jpg'),sourceStat=await fs.stat(sourceFile,{bigint:true}),sourceIdentity=`${sourceStat.dev}:${sourceStat.ino}:${sourceStat.size}:${sourceStat.mtimeNs}:${sourceStat.ctimeNs}`;primeRouting([[`${sourceFile}\0${sourceIdentity}`,{camera:'Raw camera',fields:{}}]]);await fs.unlink(sourceFile);
  let reads=0;const coordinator=new CatalogCoordinator(c,{metadata:async()=>{reads++;return {fields:{}};},cachedMetadata:cachedRouting,options:()=>({template:'{year}/{camera}',layout:'flat'})});await coordinator.configure(bindings);
  assert.equal((await c.query(query(bindings[0].library.libraryId))).total,0);
  await assert.rejects(coordinator.observeScan({kind:'begin',libraryId:'source-card',scope:['']}));
  const pending=coordinator.observeOutcome({entryId:'A',family:'A',source:path.join(source,'A.jpg'),sourceIdentity,root:one,rootIdentity:bindings[0].rootIdentity!,destination:path.join(one,'older','actual.jpg'),size:3,sha256:'verified',disposition:'routed',verification:'content-verified'});await coordinator.flush();await pending;
  const first=await c.query(query(bindings[0].library.libraryId));assert.equal(first.total,1);assert.equal(first.rows[0].relativePath,'older/actual.jpg');assert.equal(first.rows[0].values.camera,'Raw camera');assert.equal((await c.query(query(bindings[1].library.libraryId))).total,0);assert.equal(reads,0);
 }finally{await c.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('cancelled refresh preserves previously indexed unseen files and reconnect validates root identity',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'catalog-cancel-'))),root=path.join(dir,'photos'),c=openCatalog(':memory:');
 try{
  await fs.mkdir(root);await fs.writeFile(path.join(root,'A.jpg'),'a');await fs.writeFile(path.join(root,'B.jpg'),'b');
  const binding=await bindLibrary({root,mountPath:dir,volumeId:'disk',name:'Photos',role:'photos',rulesScope:'r',online:true});let stop:AbortController|undefined;
  const coordinator=new CatalogCoordinator(c,{metadata:async()=>{stop?.abort();return {camera:'Canon',fields:{}};},options:()=>({template:'{year}/{camera}',layout:'flat'})});await coordinator.configure([binding]);await coordinator.refresh(binding.library.libraryId,new AbortController().signal);assert.equal((await c.query(query(binding.library.libraryId))).total,2);
  await fs.unlink(path.join(root,'B.jpg'));await fs.writeFile(path.join(root,'A.jpg'),'changed');stop=new AbortController();await coordinator.refresh(binding.library.libraryId,stop.signal);assert.equal((await c.query(query(binding.library.libraryId))).total,2);assert.equal((await coordinator.status(binding.library.libraryId)).state,'paused');
  await fs.rename(root,path.join(dir,'old-root'));await fs.mkdir(root);await fs.writeFile(path.join(root,'foreign.jpg'),'foreign');stop=undefined;await coordinator.refresh(binding.library.libraryId,new AbortController().signal);assert.equal((await c.query(query(binding.library.libraryId))).total,2);
  const reconnected=await bindLibrary({root,mountPath:dir,volumeId:'disk',name:'Photos',role:'photos',rulesScope:'r',online:true});await coordinator.configure([reconnected]);await coordinator.refresh(binding.library.libraryId,new AbortController().signal);assert.deepEqual((await c.query(query(binding.library.libraryId))).rows.map(row=>row.name),['foreign.jpg']);
  const fallback=await bindLibrary({root,mountPath:dir,name:'Fallback',role:'photos',rulesScope:'r',online:true}),next=await bindLibrary({root,mountPath:dir,name:'Fallback',role:'photos',rulesScope:'r',online:true});assert.notEqual(fallback.library.libraryId,next.library.libraryId);
 }finally{await c.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('persisted raw reads survive restart while family routing never supplies missing raw capture values',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'catalog-raw-'))),root=path.join(dir,'photos'),database=path.join(dir,'catalog.sqlite');let c=openCatalog(database),reads=0;
 try{
  await fs.mkdir(root);await fs.writeFile(path.join(root,'A.NEF'),'raw');await fs.writeFile(path.join(root,'A.JPG'),'jpeg');
  const binding=await bindLibrary({root,mountPath:dir,volumeId:'disk',name:'Photos',role:'photos',rulesScope:'r1',online:true});
  const options=()=>({template:'{year}/{camera}',layout:'flat' as const});
  let coordinator=new CatalogCoordinator(c,{metadata:async file=>{reads++;return file.endsWith('NEF')?{camera:'Canon',date:'2024-02-03T12:00:00',fields:{},exposure:{iso:200}}:{fields:{}};},options});
  await coordinator.configure([binding]);await coordinator.refresh(binding.library.libraryId,new AbortController().signal);assert.equal(reads,2);
  const jpeg=(await c.records(binding.library.libraryId,['A.JPG']))[0];assert.equal(jpeg.values.captureDay,undefined);assert.equal(jpeg.values.camera,undefined);assert.equal(jpeg.values.iso,undefined);assert.equal(jpeg.placement.expectedRoute?.relativePath,'2024/Canon/A.JPG');assert.deepEqual(jpeg.routingMetadata,{fields:{}});
  await c.close();c=openCatalog(database);coordinator=new CatalogCoordinator(c,{metadata:async()=>{throw new Error('Unchanged persisted file must not be reread');},options});await coordinator.configure([binding]);await coordinator.refresh(binding.library.libraryId,new AbortController().signal);assert.equal((await coordinator.status(binding.library.libraryId)).state,'idle');assert.equal((await c.query(query(binding.library.libraryId))).total,2);
  await coordinator.configure([{...binding,library:{...binding.library,rulesScope:'r2'}}]);assert.equal((await c.query(query(binding.library.libraryId))).rows.every(row=>row.placement.status==='unchecked'),true);
  await c.query(query(binding.library.libraryId));await c.directories(query(binding.library.libraryId));await c.facets(query(binding.library.libraryId),'camera');assert.equal(reads,2);
 }finally{await c.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('pending metadata is queryable before a read completes and parser failures remain distinct errors',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'catalog-pending-'))),root=path.join(dir,'photos'),c=openCatalog(':memory:');let unblock:()=>void=()=>{},entered:()=>void=()=>{};
 const reading=new Promise<void>(resolve=>{entered=resolve;}),release=new Promise<void>(resolve=>{unblock=resolve;});
 try{
  await fs.mkdir(root);await fs.writeFile(path.join(root,'A.JPG'),'jpeg');const binding=await bindLibrary({root,mountPath:dir,volumeId:'disk',name:'Photos',role:'photos',rulesScope:'r',online:true});
  const coordinator=new CatalogCoordinator(c,{metadata:async()=>{entered();await release;throw new Error('Unreadable header');},options:()=>({template:'{year}/{camera}',layout:'flat'})});await coordinator.configure([binding]);const refresh=coordinator.refresh(binding.library.libraryId,new AbortController().signal);await reading;
  assert.equal((await c.query(query(binding.library.libraryId))).rows[0].metadataStatus,'pending');unblock();await refresh;const page=await c.query(query(binding.library.libraryId));assert.equal(page.rows[0].metadataStatus,'error');assert.equal(page.rows[0].values.metadataError,'Unreadable header');
 }finally{unblock();await c.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('existing-library refresh always honors edited ancestry and policy-owned folders',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'catalog-existing-'))),root=path.join(dir,'photos'),c=openCatalog(':memory:');
 try{
  const names=['2024/202402/editied/Canon/A.jpg','2024/Canon/Conflicts/id/B.jpg','Problem files/Empty files/C.jpg'];
  for(const name of names){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),'media');}
  const binding=await bindLibrary({root,mountPath:dir,volumeId:'disk',name:'Photos',role:'photos',rulesScope:'r',online:true});
  const coordinator=new CatalogCoordinator(c,{metadata:async()=>({camera:'Canon',date:'2024-02-03T12:00:00',fields:{}}),options:()=>({template:'{year}/{camera}',layout:'flat',editedFolder:'editied'})});
  await coordinator.configure([binding]);await coordinator.refresh(binding.library.libraryId,new AbortController().signal);
  const records=await c.records(binding.library.libraryId,names);assert.deepEqual(Object.fromEntries(records.map(record=>[record.relativePath,record.placement.status])),Object.fromEntries(names.map(name=>[name,'inPlace'])));
 }finally{await c.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('warm listing refresh uses fresh sizes for media and companion placement in both directions',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'catalog-sizes-'))),root=path.join(dir,'photos'),c=openCatalog(':memory:');
 try{
  await fs.mkdir(root);await fs.writeFile(path.join(root,'A.jpg'),'');await fs.writeFile(path.join(root,'A.xmp'),'sidecar');
  const binding=await bindLibrary({root,mountPath:dir,volumeId:'disk',name:'Photos',role:'photos',rulesScope:'r',online:true});const coordinator=new CatalogCoordinator(c,{metadata:async()=>({camera:'Canon',date:'2024-02-03T12:00:00',fields:{}}),options:()=>({template:'{year}/{camera}',layout:'flat'})});
  await coordinator.configure([binding]);await coordinator.refresh(binding.library.libraryId,new AbortController().signal);
  let records=await c.records(binding.library.libraryId,['A.jpg','A.xmp']);assert.deepEqual(records.map(record=>record.placement.status),['unclassifiable','unclassifiable']);
  const directoryBefore=await fs.stat(root,{bigint:true});await fs.writeFile(path.join(root,'A.jpg'),'twelve bytes');const directoryAfter=await fs.stat(root,{bigint:true});assert.equal(directoryAfter.mtimeNs,directoryBefore.mtimeNs,'Changing bytes does not invalidate the cached directory names');
  await coordinator.refresh(binding.library.libraryId,new AbortController().signal);records=await c.records(binding.library.libraryId,['A.jpg','A.xmp']);assert.equal(records[0].stat.size,'12');assert.deepEqual(records.map(record=>record.placement.status),['misplaced','misplaced']);assert.equal(records[1].companionOf,records[0].fileId);
  await fs.writeFile(path.join(root,'A.jpg'),'');await coordinator.refresh(binding.library.libraryId,new AbortController().signal);records=await c.records(binding.library.libraryId,['A.jpg','A.xmp']);assert.equal(records[0].stat.size,'0');assert.deepEqual(records.map(record=>record.placement.status),['unclassifiable','unclassifiable']);
 }finally{await c.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('a folder added only to browse is indexed with its companions but never checked against the organization rules',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-browse-')),root=path.join(dir,'Any folder');const c=openCatalog(':memory:');
 try{
  await fs.mkdir(root);await fs.writeFile(path.join(root,'A.jpg'),'twelve bytes');await fs.writeFile(path.join(root,'A.xmp'),'sidecar');
  const binding=await bindLibrary({root,mountPath:dir,volumeId:'disk',name:'Any folder',role:'photos',rulesScope:'r',online:true,browseOnly:true});
  assert.equal(binding.library.browseOnly,true);
  const coordinator=new CatalogCoordinator(c,{metadata:async()=>({camera:'Canon',date:'2024-02-03T12:00:00',fields:{}}),options:()=>({template:'{year}/{camera}',layout:'flat'})});
  await coordinator.configure([binding]);await coordinator.refresh(binding.library.libraryId,new AbortController().signal);
  const records=await c.records(binding.library.libraryId,['A.jpg','A.xmp']);
  assert.deepEqual(records.map(record=>record.placement.status),['unchecked','unchecked'],'misplaced in a backup, but a browsed folder is never judged');
  assert.equal(records[1].companionOf,records[0].fileId,'companions are still linked');
  const status=await c.status(binding.library.libraryId);assert.equal(status.misplaced,0);
 }finally{await c.close();await fs.rm(dir,{recursive:true,force:true});}
});
