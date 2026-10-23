import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan,execute} from '../core';
import {configureOrganizationRecovery} from '../core/index';
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');

const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-planning-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),roots=[path.join(base,'first'),path.join(base,'second')];
 await Promise.all([source,...roots].map(folder=>fs.mkdir(folder)));
 return {source,roots};
}

test('one source preparation produces independent verified plans for both destinations',async t=>{
 const {source,roots}=await fixture(t);
 const raw=path.join(source,'A.ARW'),jpeg=path.join(source,'A.JPG');
 await fs.writeFile(raw,'raw original');await fs.writeFile(jpeg,'jpeg original');
 const firstFolder=path.join(roots[0],'2024/202402/Sony A7');await fs.mkdir(firstFolder,{recursive:true});
 await fs.writeFile(path.join(firstFolder,'A.ARW'),'raw original');
 const secondFolder=path.join(roots[1],'2024/202402/Sony A7');await fs.mkdir(secondFolder,{recursive:true});
 await fs.writeFile(path.join(secondFolder,'A.ARW'),'unrelated original');
 const calls:string[]=[];
 const prepared=await plan(source,roots,options,async file=>{calls.push(file);return {camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}};});
 assert.deepEqual(calls.sort(),[raw,jpeg].sort());
 assert.equal(prepared.inventory.media,2);assert.equal(prepared.plans.length,2);
 assert.equal(prepared.plans[0].entries.find(entry=>entry.kind==='RAW')?.skip,true);
 assert.ok(prepared.plans[1].entries.every(entry=>!entry.skip));
 const secondRaw=prepared.plans[1].entries.find(entry=>entry.kind==='RAW')!;
 assert.notEqual(secondRaw.destination,path.join(secondFolder,'A.ARW'));
 for(const transfer of prepared.plans){const result=await execute(transfer);assert.deepEqual(result.errors,[]);for(const entry of transfer.entries)assert.deepEqual(await fs.readFile(entry.destination),await fs.readFile(entry.source));}
 assert.equal(await fs.readFile(path.join(secondFolder,'A.ARW'),'utf8'),'unrelated original');
});

test('source mutation while metadata is read rejects the shared preparation',async t=>{
 const {source,roots}=await fixture(t);const file=path.join(source,'A.JPG');await fs.writeFile(file,'original');
 await assert.rejects(plan(source,roots,options,async()=>{await fs.writeFile(file,'modified');return {fields:{}};}),/Source changed/);
 assert.deepEqual(await fs.readdir(roots[0]),[]);assert.deepEqual(await fs.readdir(roots[1]),[]);
});

test('both destination executions reject source bytes changed after shared planning',async t=>{
 const {source,roots}=await fixture(t);const file=path.join(source,'A.JPG');await fs.writeFile(file,'original');
 const {plans}=await plan(source,roots,options,async()=>({fields:{}}));await fs.writeFile(file,'modified');
 for(const transfer of plans){const result=await execute(transfer);assert.equal(result.copied,0);assert.equal(result.errors.length,1);await assert.rejects(fs.stat(transfer.entries[0].destination));}
});

test('organization accepts one reviewed destination at a time',async t=>{
 const {source}=await fixture(t);await fs.writeFile(path.join(source,'A.JPG'),'original');
 const roots=[path.join(source,'new-first'),path.join(source,'new-second')];await Promise.all(roots.map(root=>fs.mkdir(root)));
 await assert.rejects(plan(source,roots,{...options,reorganize:true},async()=>({fields:{}})),/one organization destination/);
 assert.equal(await fs.readFile(path.join(source,'A.JPG'),'utf8'),'original');
});
