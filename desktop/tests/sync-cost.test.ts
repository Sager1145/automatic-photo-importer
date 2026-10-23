import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {plan,execute} from '../core/index';
import {contained,makeParent,syncParents} from '../core/paths';
import type {Metadata} from '../shared';
import {configureOrganizationRecovery} from '../core/index';
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');

const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Nikon Z f',date:'2024-02-03T12:00:00Z',fields:{}});

test('publishing many files into one folder syncs each ancestor folder once, not once per file',async t=>{
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sync-cost-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'card'),root=path.join(base,'photobackup');
 await fs.mkdir(source);await fs.mkdir(root);
 for(let index=0;index<20;index++)await fs.writeFile(path.join(source,`DSC_${index}.NEF`),`raw ${index}`);
 const reviewed=(await plan(source,[root],options,metadata)).plans[0]!;
 const synced=new Map<string,number>(),open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args),file=String(args[0]);
  if(file===root||file===path.join(root,'2024')){const sync=handle.sync.bind(handle);handle.sync=async()=>{synced.set(file,(synced.get(file)??0)+1);return sync();};}
  return handle;
 });syncBuiltinESMExports();
 const result=await execute(reviewed);
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.deepEqual(result.errors,[]);assert.equal(result.copied,20);
 // Each gains one new subfolder in this run: a sync after it is created suffices.
 assert.ok((synced.get(root)??0)<=2,`backup root synced ${synced.get(root)} times`);
 assert.ok((synced.get(path.join(root,'2024'))??0)<=2,`year folder synced ${synced.get(path.join(root,'2024'))} times`);
});

test('checking a deep path resolves it once and still refuses a symbolic link anywhere in it',async t=>{
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'contained-cost-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const root=path.join(base,'photobackup'),deep=path.join(root,'2024','202402','Nikon Z f','RAW');
 await fs.mkdir(deep,{recursive:true});
 const resolve=fs.realpath.bind(fs);let resolved=0;
 t.mock.method(fs,'realpath',async(...args:Parameters<typeof fs.realpath>)=>{resolved++;return resolve(...args);});syncBuiltinESMExports();
 await contained(path.join(deep,'DSC_0001.NEF'),root);
 await makeParent(path.join(root,'2025','202501','Nikon Z f','RAW','DSC_0002.NEF'),root);
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.ok(resolved<=4,`realpath called ${resolved} times`);
 await fs.symlink(base,path.join(root,'2024','escape'));
 await assert.rejects(contained(path.join(root,'2024','escape','x','y.NEF'),root),/symbolic link/);
 await assert.rejects(makeParent(path.join(root,'2024','escape','x','y.NEF'),root),/symbolic link|Unsafe/);
});

test('a folder sync still in progress makes a second caller wait for it, and its failure reaches both',async t=>{
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sync-race-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const root=path.join(base,'photobackup'),year=path.join(root,'2026');
 await fs.mkdir(root);
 await makeParent(path.join(year,'Start','x'),root);await syncParents(path.join(year,'Start','x'),root);
 await makeParent(path.join(year,'CamA','a'),root);await makeParent(path.join(year,'CamB','b'),root);
 const order:string[]=[],open=fs.open.bind(fs);let fail=false;
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args);
  if(String(args[0])===year){const sync=handle.sync.bind(handle);handle.sync=async()=>{order.push('year sync started');await new Promise(resolve=>setTimeout(resolve,200));if(fail)throw Object.assign(new Error('simulated I/O error'),{code:'EIO'});await sync();order.push('year sync finished');};}
  return handle;
 });syncBuiltinESMExports();
 const a=syncParents(path.join(year,'CamA','a'),root);await new Promise(resolve=>setTimeout(resolve,50));
 await syncParents(path.join(year,'CamB','b'),root);order.push('B returned');await a;
 assert.deepEqual(order.slice(0,3),['year sync started','year sync finished','B returned']);
 await makeParent(path.join(year,'CamC','c'),root);await makeParent(path.join(year,'CamD','d'),root);fail=true;
 const c=syncParents(path.join(year,'CamC','c'),root);await new Promise(resolve=>setTimeout(resolve,50));
 const d=syncParents(path.join(year,'CamD','d'),root);
 await assert.rejects(c,/simulated I\/O error/);await assert.rejects(d,/simulated I\/O error/);
 t.mock.restoreAll();syncBuiltinESMExports();
});
