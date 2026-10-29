import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openCatalog} from '../catalog/store';
import {bindLibrary,CatalogCoordinator,type LibraryBinding} from '../catalog/coordinator';
import {configuredRefreshIds,createCatalogRefreshScheduler} from '../catalog/refresh-scheduler';
function clock(){const jobs:{active:boolean;callback:()=>void}[]=[];return {schedule(callback:()=>void){const job={active:true,callback};jobs.push(job);return()=>{job.active=false;};},tick(){const job=jobs.find(item=>item.active);assert.ok(job,'Expected a scheduled refresh');job.active=false;job.callback();},get pending(){return jobs.filter(job=>job.active).length;}};}
for(const mode of ['initial','explicit'] as const)test(`${mode} configuration replaces an already-dirty active refresh and the idle scheduler completes the new scope`,async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'catalog-scheduler-'))),root=path.join(dir,'photos'),catalog=openCatalog(':memory:'),timers=clock();let unblock:()=>void=()=>{},entered:()=>void=()=>{},reads=0,template='{year}/{camera}';
 const release=new Promise<void>(resolve=>{unblock=resolve;}),reading=new Promise<void>(resolve=>{entered=resolve;});
 try{
  await fs.mkdir(root);await fs.writeFile(path.join(root,'A.jpg'),'media');const binding=await bindLibrary({root,mountPath:dir,volumeId:'disk',name:'Photos',role:'photos',rulesScope:'one',online:true});
  const coordinator=new CatalogCoordinator(catalog,{metadata:async()=>{reads++;if(reads===(mode==='initial'?1:2)){entered();await release;}return {camera:'Canon',date:'2024-02-03T12:00:00',fields:{}};},options:()=>({template,layout:'flat'})});
  const scheduler=createCatalogRefreshScheduler({idle:()=>true,schedule:callback=>timers.schedule(callback),run:async()=>{for(const id of coordinator.needsRefresh())await coordinator.refresh(id,new AbortController().signal);}});
  const configure=async(bindings:LibraryBinding[])=>{const previous=coordinator.needsRefresh(),changed=await coordinator.configure(bindings);if(configuredRefreshIds(previous,coordinator.needsRefresh(),changed).length)scheduler.request();};
  await configure([binding]);timers.tick();if(mode==='explicit'){await scheduler.settled();await fs.writeFile(path.join(root,'A.jpg'),'changed media');coordinator.markDirty(binding.library.libraryId);scheduler.request();timers.tick();}await reading;
  template='{camera}/{year}';await configure([{...binding,library:{...binding.library,rulesScope:'two'}}]);unblock();await scheduler.settled();
  assert.equal(timers.pending,1,'A changed scope must replace the aborted pass even when the library was already dirty');timers.tick();await scheduler.settled();
  const row=(await catalog.records(binding.library.libraryId,['A.jpg']))[0];assert.equal(row.placement.rulesScope,'two');assert.equal(row.placement.expectedRoute?.relativePath,'Canon/2024/A.jpg');assert.equal((await coordinator.status(binding.library.libraryId)).state,'idle');
  scheduler.resume();assert.equal(timers.pending,0,'Finishing a pass does not invent another request');scheduler.close();
 }finally{unblock();await catalog.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('an unchanged failed configuration remains dirty without retrying every idle release',async()=>{
 const timers=clock();let runs=0;const scheduler=createCatalogRefreshScheduler({idle:()=>true,schedule:callback=>timers.schedule(callback),run:async()=>{runs++;throw new Error('index unavailable');}});
 scheduler.request();timers.tick();await scheduler.settled();assert.equal(runs,1);assert.deepEqual(configuredRefreshIds(['library'],['library'],[]),[]);scheduler.resume();scheduler.resume();assert.equal(timers.pending,0);scheduler.close();
});
