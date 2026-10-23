import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allocateDestinations,fillFirst,requiredOrganizationSpace} from '../core/allocation';
import type {PlanEntry,TransferPlan} from '../shared';

function entry(source:string,size:number,family=source,skip=false):PlanEntry{return {id:source,source,destination:'/backup/'+source,size,family,skip,kind:'RAW',digest:'fixture'};}
function plan(entries:PlanEntry[],root='/backup'):TransferPlan{return {source:'/card',root,rootIdentity:'fixture',entries};}
function mirrored(entries:PlanEntry[]):TransferPlan[]{return [plan(entries.map(entry=>({...entry}))),plan(entries.map(entry=>({...entry})),'/second')];}
/** What plan() does in fill-first mode: the first disk keeps `fillFirst`'s sources, the second plans the rest. */
function split(plans:TransferPlan[],available:number):string[][]{
 const kept=fillFirst(plans[0]!,available),parts=(item:TransferPlan)=>[item,...(item.videos?[item.videos]:[])];
 for(const part of parts(plans[0]!))part.entries=part.entries.filter(entry=>kept.has(entry.source));
 for(const part of parts(plans[1]!))part.entries=part.entries.filter(entry=>!kept.has(entry.source));
 return plans.map(item=>parts(item).flatMap(part=>part.entries.map(entry=>entry.source)));
}

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

test('fill-first respects exact first-disk fit and never returns after spilling',()=>{
 const plans=mirrored([entry('A',6),entry('B',4),entry('C',8),entry('D',1)]),capacity=[16,17];
 assert.deepEqual(split(plans,capacity[0]),[['A','B'],['C','D']]);
 assert.deepEqual(allocateDestinations(plans,capacity,'sequential'),[16,17]);assert.deepEqual(capacity,[16,17]);
 assert.deepEqual(split(mirrored([entry('A',6),entry('B',8),entry('C',1)]),12),[['A'],['B','C']]);
});

test('RAW JPEG and video companions stay together across a spill with destination-specific skips',()=>{
 const plans=mirrored([entry('first',4),entry('photo.raw',6,'photo'),entry('photo.jpg',2,'photo'),entry('video.mp4',7,'video'),entry('video.xml',1,'video')]);
 plans[1].entries.find(entry=>entry.source==='photo.raw')!.skip=true;
 assert.deepEqual(split(plans,10),[['first'],['photo.raw','photo.jpg','video.mp4','video.xml']]);
 assert.deepEqual(allocateDestinations(plans,[10,18],'sequential'),[8,18]);
});

test('a family that fits neither destination fails the fill-first check',()=>{
 const plans=mirrored([entry('first',4),entry('raw',6,'family'),entry('jpeg',2,'family')]);
 split(plans,10);
 assert.throws(()=>allocateDestinations(plans,[10,7],'sequential'),/related file group/);
});

test('fully verified families require no space, including on a full second disk',()=>{
 const plans=mirrored([entry('raw',6,'family'),entry('jpeg',2,'family')]);for(const entry of plans[1].entries)entry.skip=true;
 assert.deepEqual(split(plans,0),[[],['raw','jpeg']]);
 assert.deepEqual(allocateDestinations(plans,[0,0],'sequential'),[0,0]);
});

test('allocation requires the configured number of plans and capacities',()=>{
 assert.throws(()=>allocateDestinations([plan([])],[0],'mirror'),/required/);
 assert.throws(()=>allocateDestinations(mirrored([]),[0],'sequential'),/required/);
 assert.deepEqual(allocateDestinations([plan([])],[0],'single'),[0]);
});

test('batch staging reserves pending bytes plus the largest related publication family',()=>{
 const transfer=plan([entry('raw',5,'photo'),entry('jpeg',3,'photo'),entry('other',2),entry('verified',100,'old',true)]);
 assert.throws(()=>allocateDestinations([transfer],[17],'single'),/space/);
 assert.deepEqual(allocateDestinations([transfer],[18],'single'),[18]);
 const complete=plan([entry('verified',100,'old',true)]);assert.deepEqual(allocateDestinations([complete],[0],'single'),[0]);
});

test('fill-first accounts for workspace growth before assigning the next family',()=>{
 const plans=mirrored([entry('A',6),entry('B',4),entry('C',3)]);
 assert.deepEqual(split(plans,12),[['A'],['B','C']]);
 assert.deepEqual(allocateDestinations(plans,[12,11],'sequential'),[12,11]);
});

test('organizing on one drive needs room for one fallback copy, not the whole library',()=>{
 const entry=(size:number)=>({id:String(size),source:'/l/a'+size,destination:'/l/b'+size,size,kind:'RAW' as const,skip:false,family:String(size)});
 const library={source:'/l',root:'/l/photobackup',rootIdentity:'1:2',entries:[entry(30e9),entry(40e9),entry(5e9)]};
 assert.equal(requiredOrganizationSpace(library),80e9,'stage and publish of the largest file');
 assert.equal(requiredOrganizationSpace({...library,entries:[]}),0);
});

test('a destination video folder counts toward that destination and follows sequential splits',()=>{
 const withVideos=(root:string)=>({...plan([entry('A',6),entry('B',4)],root+'/photos'),videos:plan([entry('V1',5),entry('V2',3)],root+'/videos')});
 const single=withVideos('/one');
 assert.deepEqual(allocateDestinations([single],[6+4+5+3+6],'single'),[24],'all pending bytes plus the largest family');
 assert.throws(()=>allocateDestinations([withVideos('/one')],[23],'single'),/Destination 1/);
 const plans=[withVideos('/one'),withVideos('/two')];
 split(plans,16);
 assert.deepEqual([plans[0].entries,plans[0].videos!.entries,plans[1].entries,plans[1].videos!.entries].map(list=>list.map(item=>item.source)),[['A','B'],[],[],['V1','V2']]);
 assert.equal(requiredOrganizationSpace(withVideos('/one')),12,'twice the largest file in either folder');
});
