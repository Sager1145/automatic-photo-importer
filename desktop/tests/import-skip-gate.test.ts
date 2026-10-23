import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {plan,type PlanProgress} from '../core';
import {routingChanged,rememberRouting} from '../platform/routing-memory';
import {ruleOptions,rulesScope} from '../routing-options';
import {defaultPreferences} from '../preferences';
import type {Preferences} from '../shared';
import type {Metadata} from '../shared';

const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}});
const data=Buffer.alloc(4000,7);
async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'skip-gate-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),root=path.join(base,'backup'),store=path.join(base,'store');
 await fs.mkdir(source);await fs.mkdir(path.join(root,'2024/202402/Unknown Camera'),{recursive:true});
 await fs.writeFile(path.join(source,'A.JPG'),data);await fs.writeFile(path.join(root,'2024/202402/Unknown Camera/A.JPG'),data);
 return {base,source,root,store};
}
const listings=(t:test.TestContext,root:string)=>{
 const calls:string[]=[],original=fs.readdir.bind(fs);
 t.mock.method(fs,'readdir',(async(...args:Parameters<typeof fs.readdir>)=>{if(String(args[0]).startsWith(root))calls.push(String(args[0]));return (original as (...a:unknown[])=>unknown)(...args);}) as typeof fs.readdir);
 syncBuiltinESMExports();
 return calls;
};

test('routing memory: changed until recorded, unchanged for the same rules, changed when a rule changes',async t=>{
 const routingScope=(rules:Partial<Preferences>)=>rulesScope(ruleOptions({...defaultPreferences,unknownRules:{},mediaLayout:'flat',...rules}));
 const f=await fixture(t),scope=routingScope({template:'{year}/{camera}'});
 assert.equal(await routingChanged(f.store,['a'],scope),true);
 await rememberRouting(f.store,['a','b'],scope);
 assert.equal(await routingChanged(f.store,['a','b'],scope),false);
 assert.equal(await routingChanged(f.store,['a','c'],scope),true,'one unrecorded library is enough');
 assert.notEqual(routingScope({template:'{year}/{yyyymm}/{camera}'}),scope);
 assert.notEqual(routingScope({template:'{year}/{camera}',mediaLayout:'video-root'}),scope);
 assert.notEqual(routingScope({template:'{year}/{camera}',videoTemplate:'v'}),scope);
 assert.notEqual(routingScope({template:'{year}/{camera}',editedFolder:'x'}),scope);
 assert.equal(await routingChanged(f.store,['a'],routingScope({template:'other'})),true);
});

test('with unchanged rules the library is not listed and nothing is looked for',async t=>{
 const f=await fixture(t),calls=listings(t,f.root),events:string[]=[];
 const onProgress:PlanProgress=(_c,_f,detail)=>{if(detail)events.push(detail.step);};
 const {plans}=await plan(f.source,[f.root],{...options,lookElsewhere:()=>false},metadata,undefined,onProgress);
 assert.equal(plans[0]!.entries[0]!.skip,false);assert.equal(events.includes('locating'),false);
 assert.deepEqual(calls.filter(call=>call===f.root),[],'the library root was never listed');
});

test('with changed rules the library is listed once per session and the listing is reused',async t=>{
 const f=await fixture(t),calls=listings(t,f.root);
 const first=await plan(f.source,[f.root],{...options,lookElsewhere:()=>true},metadata);
 assert.equal(first.plans[0]!.entries[0]!.skip,true);
 const listed=calls.filter(call=>call===f.root).length;assert.ok(listed>0);
 const second=await plan(f.source,[f.root],{...options,lookElsewhere:()=>true},metadata);
 assert.equal(second.plans[0]!.entries[0]!.skip,true);
 assert.equal(calls.filter(call=>call===f.root).length,listed,'the second plan reuses the session listing');
});
