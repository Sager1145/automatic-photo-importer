import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allocateDestinations,requiredOrganizationSpace} from '../core/allocation';
import type {PlanEntry,TransferPlan} from '../shared';

function entry(source:string,size:number,family=source,skip=false):PlanEntry{return {id:source,source,destination:'/backup/'+source,size,family,skip,kind:'RAW',digest:'fixture'};}
function plan(entries:PlanEntry[],root='/backup'):TransferPlan{return {source:'/card',root,rootIdentity:'fixture',entries};}
function mirrored(entries:PlanEntry[]):TransferPlan[]{return [plan(entries.map(entry=>({...entry}))),plan(entries.map(entry=>({...entry})),'/second')];}

test('single destination reserves pending bytes and workspace and accepts exact fit',()=>{
 const transfer=plan([entry('raw',8),entry('jpeg',3,'raw',true)]),original=transfer.entries;
 assert.deepEqual(allocateDestinations([transfer],[16],'single'),[16]);assert.equal(transfer.entries,original);
 assert.throws(()=>allocateDestinations([transfer],[15],'single'),/Destination 1/);
});

test('mirror reserves independently for differing verified skips and keeps both complete plans',()=>{
 const plans=mirrored([entry('A',7),entry('B',3)]);plans[0].entries[0].skip=true;plans[1].entries[1].skip=true;
 const originals=plans.map(plan=>plan.entries);assert.deepEqual(allocateDestinations(plans,[6,14],'mirror'),[6,14]);
 assert.equal(plans[0].entries,originals[0]);assert.equal(plans[1].entries,originals[1]);
 assert.throws(()=>allocateDestinations(plans,[6,13],'mirror'),/Destination 2/);
});

test('sequential allocation respects exact first-disk fit and never returns after spilling',()=>{
 const plans=mirrored([entry('A',6),entry('B',4),entry('C',8),entry('D',1)]),capacity=[16,17];
 assert.deepEqual(allocateDestinations(plans,capacity,'sequential'),[16,17]);assert.deepEqual(capacity,[16,17]);
 assert.deepEqual(plans[0].entries.map(entry=>entry.source),['A','B']);assert.deepEqual(plans[1].entries.map(entry=>entry.source),['C','D']);
 const spill=mirrored([entry('A',6),entry('B',8),entry('C',1)]);allocateDestinations(spill,[12,17],'sequential');
 assert.deepEqual(spill[0].entries.map(entry=>entry.source),['A']);assert.deepEqual(spill[1].entries.map(entry=>entry.source),['B','C']);
});

test('RAW JPEG and video companions stay together across a spill with destination-specific skips',()=>{
 const plans=mirrored([entry('first',4),entry('photo.raw',6,'photo'),entry('photo.jpg',2,'photo'),entry('video.mp4',7,'video'),entry('video.xml',1,'video')]);
 plans[1].entries.find(entry=>entry.source==='photo.raw')!.skip=true;
 assert.deepEqual(allocateDestinations(plans,[10,18],'sequential'),[8,18]);
 assert.deepEqual(plans[0].entries.map(entry=>entry.source),['first']);
 assert.deepEqual(plans[1].entries.map(entry=>entry.source),['photo.raw','photo.jpg','video.mp4','video.xml']);
});

test('a family that cannot fit either destination leaves both plans untouched',()=>{
 const plans=mirrored([entry('first',4),entry('raw',6,'family'),entry('jpeg',2,'family')]),originals=plans.map(plan=>plan.entries);
 assert.throws(()=>allocateDestinations(plans,[10,7],'sequential'),/related file group/);
 assert.equal(plans[0].entries,originals[0]);assert.equal(plans[1].entries,originals[1]);
 assert.equal(plans[0].entries.length,3);assert.equal(plans[1].entries.length,3);
});

test('fully verified families require no space, including on a full second disk',()=>{
 const plans=mirrored([entry('raw',6,'family'),entry('jpeg',2,'family')]);for(const entry of plans[1].entries)entry.skip=true;
 assert.deepEqual(allocateDestinations(plans,[0,0],'sequential'),[0,0]);assert.equal(plans[0].entries.length,0);assert.equal(plans[1].entries.length,2);
});

test('allocation requires the configured number of plans and capacities',()=>{
 assert.throws(()=>allocateDestinations([plan([])],[0],'mirror'),/required/);
 assert.throws(()=>allocateDestinations(mirrored([]),[0],'sequential'),/required/);
 assert.deepEqual(allocateDestinations([plan([])],[0],'single'),[0]);
});

test('second-disk spill visits source keys linearly rather than scanning its plan for every family',()=>{
 const count=5000,plans=mirrored(Array.from({length:count},(_,index)=>entry('file-'+index,1)));let reads=0;
 plans[1].entries=plans[1].entries.map(entry=>new Proxy(entry,{get(target,key,receiver){if(key==='source')reads++;return Reflect.get(target,key,receiver);}}));
 assert.deepEqual(allocateDestinations(plans,[0,count+1],'sequential'),[0,count+1]);
 assert.equal(plans[0].entries.length,0);assert.equal(plans[1].entries.length,count);
 assert.ok(reads<=3*count,`Expected linear source-key visits, observed ${reads} for ${count} entries`);
});

test('batch staging reserves pending bytes plus the largest related publication family',()=>{
 const transfer=plan([entry('raw',5,'photo'),entry('jpeg',3,'photo'),entry('other',2),entry('verified',100,'old',true)]);
 assert.throws(()=>allocateDestinations([transfer],[17],'single'),/space/);
 assert.deepEqual(allocateDestinations([transfer],[18],'single'),[18]);
 const complete=plan([entry('verified',100,'old',true)]);assert.deepEqual(allocateDestinations([complete],[0],'single'),[0]);
});

test('sequential fill accounts for workspace growth before assigning the next family',()=>{
 const plans=mirrored([entry('A',6),entry('B',4),entry('C',3)]);
 assert.deepEqual(allocateDestinations(plans,[12,11],'sequential'),[12,11]);
 assert.deepEqual(plans[0].entries.map(entry=>entry.source),['A']);assert.deepEqual(plans[1].entries.map(entry=>entry.source),['B','C']);
});

test('organizing on one drive needs room for one fallback copy, not the whole library',()=>{
 const entry=(size:number)=>({id:String(size),source:'/l/a'+size,destination:'/l/b'+size,size,kind:'RAW' as const,skip:false,family:String(size)});
 const library={source:'/l',root:'/l/photobackup',rootIdentity:'1:2',entries:[entry(30e9),entry(40e9),entry(5e9)]};
 assert.equal(requiredOrganizationSpace(library),80e9,'stage and publish of the largest file');
 assert.equal(requiredOrganizationSpace({...library,entries:[]}),0);
});
