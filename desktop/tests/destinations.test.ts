import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan} from '../core/index';
import {executeDestinations} from '../core/destinations';
import type {Progress} from '../shared';

async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-destinations-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),roots=[path.join(base,'one'),path.join(base,'two')];
 for(const folder of [source,...roots])await fs.mkdir(folder);
 await fs.writeFile(path.join(source,'original.txt'),'preserve this original');
 const {plans}=await plan(source,roots,{backup:true,template:'{year}',separateMedia:false,unknownRules:{}},async()=>({fields:{}}));
 return {source,roots,plans};
}

test('first destination identity failure still copies and verifies the second, without claiming failed work',async t=>{
 const {source,roots,plans}=await fixture(t),progress:Progress[]=[],settled:number[]=[],validated:number[]=[];
 const result=await executeDestinations(plans,{signal:new AbortController().signal,reorganize:false,
  validate:async index=>{validated.push(index);if(index===0)throw new Error('Disk identity changed');},
  progress:(_index,value)=>progress.push(value),settled:index=>settled.push(index)});
 assert.deepEqual(validated,[0,1]);assert.deepEqual(settled,[0,1]);
 assert.equal(result.copied,1);assert.deepEqual(result.errors,['Destination 1: Disk identity changed']);
 assert.equal(await fs.readFile(path.join(roots[1],'original.txt'),'utf8'),'preserve this original');
 assert.equal(await fs.readFile(path.join(source,'original.txt'),'utf8'),'preserve this original');
 await assert.rejects(fs.stat(path.join(roots[0],'original.txt')),{code:'ENOENT'});
 assert.equal(progress.at(-1)?.completed,1);assert.equal(progress.at(-1)?.total,2);
 assert.equal(progress.at(-1)?.bytes,22);assert.equal(progress.at(-1)?.totalBytes,44);
});

test('publication failure is isolated to its destination and reservations settle',async t=>{
 const {roots,plans}=await fixture(t),settled:number[]=[];
 const result=await executeDestinations(plans,{signal:new AbortController().signal,reorganize:false,
  validate:async index=>{if(index===0)await fs.rename(roots[0],roots[0]+'.disconnected');},
  progress:()=>{},settled:index=>settled.push(index)});
 assert.ok(result.errors.some(error=>error.startsWith('Destination 1:')));
 assert.equal(result.copied,1);assert.deepEqual(settled,[0,1]);
 assert.equal(await fs.readFile(path.join(roots[1],'original.txt'),'utf8'),'preserve this original');
});

test('Stop aborts the whole request and never starts the next destination',async t=>{
 const {roots,plans}=await fixture(t),controller=new AbortController(),validated:number[]=[],settled:number[]=[];
 await assert.rejects(executeDestinations(plans,{signal:controller.signal,reorganize:false,
  validate:async index=>{validated.push(index);controller.abort();},
  progress:()=>{},settled:index=>settled.push(index)}));
 assert.deepEqual(validated,[0]);assert.deepEqual(settled,[0]);
 for(const root of roots)await assert.rejects(fs.stat(path.join(root,'original.txt')),{code:'ENOENT'});
});

test('successful copies aggregate actual completed work and repeat verification across both destinations',async t=>{
 const {source,roots,plans}=await fixture(t);let latest:Progress|undefined;
 const hooks={signal:new AbortController().signal,reorganize:false,validate:async()=>{},progress:(_index:number,value:Progress)=>{latest=value;},settled:()=>{}};
 assert.equal((await executeDestinations(plans,hooks)).copied,2);
 assert.equal(latest?.completed,2);assert.equal(latest?.bytes,44);
 const repeated=await plan(source,roots,{backup:true,template:'{year}',separateMedia:false,unknownRules:{}},async()=>({fields:{}}));
 assert.deepEqual(await executeDestinations(repeated.plans,hooks),{copied:0,skipped:2,moved:0,retained:0,retainedBytes:0,removed:0,errors:[],notes:[]});
 assert.equal(latest?.completed,2);assert.equal(latest?.bytes,0);assert.equal(latest?.totalBytes,0);
});


test('a reviewed duplicate removed before Apply grows actual work totals when restored',async t=>{
 const {source,roots,plans}=await fixture(t);
 const hooks={signal:new AbortController().signal,reorganize:false,validate:async()=>{},progress:()=>{},settled:()=>{}};
 await executeDestinations(plans,hooks);
 const reviewed=await plan(source,roots,{backup:true,template:'{year}',separateMedia:false,unknownRules:{}},async()=>({fields:{}}));
 assert.ok(reviewed.plans.every(plan=>plan.entries.every(entry=>entry.skip)));
 await fs.unlink(path.join(roots[0],'original.txt'));const progress:Progress[]=[];
 const result=await executeDestinations(reviewed.plans,{...hooks,progress:(_index,value)=>progress.push(value)});
 assert.equal(result.copied,1);assert.equal(result.skipped,1);
 assert.ok(progress.length>0);for(const value of progress)assert.ok(value.totalBytes>=value.bytes,JSON.stringify(value));
 assert.equal(progress.at(-1)?.bytes,22);assert.equal(progress.at(-1)?.totalBytes,22);
 assert.equal(await fs.readFile(path.join(roots[0],'original.txt'),'utf8'),'preserve this original');
});

test('publication workspace stays reserved after source copying until the destination settles',async t=>{
 const {plans}=await fixture(t);const reservations:{phase?:string;pending:number}[]=[],settled:number[]=[];
 const result=await executeDestinations([plans[0]],{signal:new AbortController().signal,reorganize:false,validate:async()=>{},progress:(_index,value,pending)=>reservations.push({phase:value.phase,pending}),settled:index=>settled.push(index)});
 assert.equal(result.copied,1);assert.deepEqual(settled,[0]);
 const validating=reservations.filter(value=>value.phase==='verifying');assert.ok(validating.length>0);assert.ok(validating.every(value=>value.pending>=22),'One whole related family must remain reserved through publication');
});
