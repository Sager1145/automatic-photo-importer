import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openCatalog} from '../catalog/store';
import {CatalogCoordinator,bindLibrary} from '../catalog/coordinator';
import type {CatalogQuery} from '../catalog/types';
const query=(libraryId:string):CatalogQuery=>({libraryId,filters:[],sort:{field:'name',direction:'asc'},limit:200});
async function library(count:number){
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'catalog-pool-'))),root=path.join(dir,'photos');await fs.mkdir(root);
 for(let i=0;i<count;i++)await fs.writeFile(path.join(root,`IMG${String(i).padStart(4,'0')}.jpg`),String(i));
 return {dir,binding:await bindLibrary({root,mountPath:dir,volumeId:'disk',name:'Photos',role:'photos',rulesScope:'r',online:true})};
}
test('a refresh keeps many metadata reads in flight so the reader can batch them',async()=>{
 const {dir,binding}=await library(60),c=openCatalog(':memory:');let now=0,peak=0;
 try{
  const coordinator=new CatalogCoordinator(c,{metadata:async(_file,options)=>{assert.equal(options?.background,true);assert.ok(options?.signal);peak=Math.max(peak,++now);await new Promise(done=>setTimeout(done,5));now--;return {camera:'Canon',date:'2024-02-03T12:00:00',fields:{}};},options:()=>({template:'{year}/{camera}',layout:'flat'})});
  await coordinator.configure([binding]);await coordinator.refresh(binding.library.libraryId,new AbortController().signal);
  assert.ok(peak>1,`peak metadata concurrency ${peak}`);
  const page=await c.query(query(binding.library.libraryId));assert.equal(page.total,60);assert.ok(page.rows.every(row=>row.metadataStatus==='ready'));
  const status=await coordinator.status(binding.library.libraryId);assert.equal(status.state,'idle');assert.equal(status.progress?.read,60);
 }finally{await c.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('aborting mid-pool stops reads, settles the writer, and keeps the catalog usable',async()=>{
 const {dir,binding}=await library(200),c=openCatalog(':memory:'),stop=new AbortController();let started=0;
 try{
  const coordinator=new CatalogCoordinator(c,{metadata:async()=>{if(++started===20)stop.abort();await new Promise(done=>setTimeout(done,5));return {camera:'Canon',fields:{}};},options:()=>({template:'{year}/{camera}',layout:'flat'})});
  await coordinator.configure([binding]);await coordinator.refresh(binding.library.libraryId,stop.signal);
  const at=started;await new Promise(done=>setTimeout(done,50));assert.equal(started,at,'no reads start after the pool stops');assert.ok(started<200);
  const status=await coordinator.status(binding.library.libraryId);assert.equal(status.state,'paused');assert.equal(coordinator.running,false);
  await coordinator.refresh(binding.library.libraryId,new AbortController().signal);assert.equal((await c.query(query(binding.library.libraryId))).total,200);
 }finally{await c.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('status reports the newest placement check from the stored aggregate, including for catalogs written before it existed',async()=>{
 const {library:lib,record}=await import('./catalog-fixtures');const {DatabaseSync}=await import('node:sqlite');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-checked-')),file=path.join(dir,'library.sqlite');
 try{
  let c=openCatalog(file);await c.configure([lib]);const run=await c.beginScan(lib.libraryId,['']);
  await c.ingest(run,[record('a','a.NEF',{placement:{status:'inPlace',actualRelativePath:'a.NEF',rulesScope:lib.rulesScope,checkedAt:'2024-01-01T00:00:00.000Z'}}),record('b','b.NEF',{placement:{status:'inPlace',actualRelativePath:'b.NEF',rulesScope:lib.rulesScope,checkedAt:'2024-03-01T00:00:00.000Z'}}),record('c','c.NEF')]);
  await c.endScan(run,'complete');assert.equal((await c.status(lib.libraryId)).lastCheckedAt,'2024-03-01T00:00:00.000Z');await c.close();
  const raw=new DatabaseSync(file);raw.exec('ALTER TABLE libraries DROP COLUMN lastCheckedAt');raw.close();
  c=openCatalog(file);assert.equal((await c.status(lib.libraryId)).lastCheckedAt,'2024-03-01T00:00:00.000Z');await c.close();
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('a file that changes while it is read ends the scan partial and the warning names it',async()=>{
 const {dir,binding}=await library(5),c=openCatalog(':memory:'),warnings:string[]=[];
 try{
  const victim=path.join(binding.root,'IMG0002.jpg');
  const coordinator=new CatalogCoordinator(c,{metadata:async file=>{if(file===victim)await fs.writeFile(file,'changed while reading');return {camera:'Canon',fields:{}};},options:()=>({template:'{year}/{camera}',layout:'flat'}),warning:error=>{warnings.push(String(error));}});
  await coordinator.configure([binding]);await coordinator.refresh(binding.library.libraryId,new AbortController().signal);
  assert.equal(warnings.length,1);assert.match(warnings[0]!,/changed during read 1.*IMG0002\.jpg/);
  assert.equal((await c.status(binding.library.libraryId)).lastCompletedAt,undefined);
 }finally{await c.close();await fs.rm(dir,{recursive:true,force:true});}
});
