import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {plan,type PlanProgress} from '../core';
import {placementId,placementScope,replacePlacement} from '../platform/placement-memory';
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

test('placement record scope: unrecorded until a library is filled, then unchanged for the same rules and changed when a rule changes',async t=>{
 const routingScope=(rules:Partial<Preferences>)=>rulesScope(ruleOptions({...defaultPreferences,unknownRules:{},mediaLayout:'flat',...rules}));
 const f=await fixture(t),scope=routingScope({template:'{year}/{camera}'}),id=placementId('uuid',f.root);
 assert.equal(await placementScope(f.store,id),undefined);
 await replacePlacement(f.store,id,scope,[]);
 assert.equal(await placementScope(f.store,id),scope,'a header with no files still records the rules');
 assert.notEqual(await placementScope(f.store,id),routingScope({template:'other'}));
 assert.equal(await placementScope(f.store,placementId('uuid',path.join(f.base,'other'))),undefined,'another library is not recorded');
 assert.notEqual(routingScope({template:'{year}/{yyyymm}/{camera}'}),scope);
 assert.notEqual(routingScope({template:'{year}/{camera}',mediaLayout:'video-root'}),scope);
 assert.notEqual(routingScope({template:'{year}/{camera}',videoTemplate:'v'}),scope);
 assert.notEqual(routingScope({template:'{year}/{camera}',editedFolder:'x'}),scope);
});

test('a library is recognised by its volume UUID and folders, whatever device number the volume has now',async t=>{
 const f=await fixture(t),scope=rulesScope(ruleOptions({...defaultPreferences,unknownRules:{}}));
 // The id is made of the volume UUID and the folders only; the stat's device number (part of the root identity "dev:ino") changes on every mount and is not in it.
 const before=placementId('volume-uuid',f.root),after=placementId('volume-uuid',f.root);
 await replacePlacement(f.store,before,scope,[]);
 assert.equal(await placementScope(f.store,after),scope);
 assert.equal(await placementScope(f.store,placementId('another-uuid',f.root)),undefined);
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
