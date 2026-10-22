import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStateChannel,createStateReceiver,type StateUpdate} from '../state-channel';
import type {AppState,Inventory,Review} from '../shared';
import {text} from '../messages';

function inventory(name='photo.nef'):Inventory{return {files:[{path:'/card/'+name,relative:name,size:8,kind:'RAW',included:true}],media:1,companions:0,unknown:0,bytes:8,unknownExtensions:{},elapsedMs:1};}
function state():AppState{return {preferences:{language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:[],copyMode:'single',basePath:'photobackup',template:'{year}/{yyyymm}/{camera}',separateMedia:false,allowFolderSource:false,unknownRules:{}},sources:[{id:'card',name:'Card',path:'/card',transport:'storage'}],jobs:[],history:[],platform:'darwin'};}
function review():Review{return {id:'review',kind:'import',source:{id:'card',name:'Card',path:'/card',transport:'storage'},backup:false,plans:[{source:'/card',root:'/backup',rootIdentity:'disk',entries:[{id:'photo',source:'/card/photo.nef',destination:'/backup/photo.nef',size:8,kind:'RAW',digest:'abc',skip:false,family:'photo'}]}]};}
const wire=(update:StateUpdate)=>structuredClone(update);

test('progress sends each shared file list and review once, preserving receiver details',()=>{
 const updates:StateUpdate[]=[],channel=createStateChannel(update=>updates.push(wire(update))),receiver=createStateReceiver(),value=state();
 const files=inventory();value.sourceInventories={card:files};value.jobs=[{id:'job',source:value.sources[0],phase:'copying',detail:text('Copying'),errors:[],backup:false,inventory:files}];value.review=review();
 channel.publish(value);
 const initial=channel.snapshot(value);assert.equal(Object.keys(initial.inventories).length,1);receiver.apply(wire(initial));
 const received=receiver.snapshot()!,retained=received.jobs[0].inventory,savedReview=received.review;
 for(let bytes=1;bytes<=3;bytes++){value.jobs[0].progress={completed:0,total:1,bytes,totalBytes:8,speed:1,file:'photo.nef'};channel.publish(value);const update=updates.at(-1)!;assert.deepEqual(update.inventories,{});assert.equal(Object.hasOwn(update,'review'),false);receiver.apply(update);}
 assert.equal(receiver.snapshot()!.jobs[0].inventory,retained);assert.equal(receiver.snapshot()!.sourceInventories!.card,retained);assert.equal(receiver.snapshot()!.review,savedReview);assert.equal(receiver.snapshot()!.jobs[0].progress!.bytes,3);
});

test('replacement, job eviction, source disconnection and review removal update details exactly',()=>{
 const updates:StateUpdate[]=[],channel=createStateChannel(update=>updates.push(wire(update))),receiver=createStateReceiver(),value=state();
 const original=inventory();value.sourceInventories={card:original};value.jobs=[{id:'job',source:value.sources[0],phase:'complete',detail:text('Done'),errors:[],backup:false,inventory:original}];value.review=review();channel.publish(value);receiver.apply(wire(channel.snapshot(value)));
 const replacement=inventory('next.nef');value.sourceInventories.card=replacement;channel.publish(value);assert.equal(Object.keys(updates.at(-1)!.inventories).length,1);receiver.apply(updates.at(-1)!);assert.equal(receiver.snapshot()!.sourceInventories!.card.files[0].relative,'next.nef');assert.equal(receiver.snapshot()!.jobs[0].inventory!.files[0].relative,'photo.nef');
 value.jobs=[];value.sources=[];value.sourceInventories={};value.review=undefined;channel.publish(value);assert.equal(updates.at(-1)!.review,null);receiver.apply(updates.at(-1)!);assert.deepEqual(receiver.snapshot()!.jobs,[]);assert.deepEqual(receiver.snapshot()!.sourceInventories,{});assert.equal(receiver.snapshot()!.review,undefined);
 // The same object returning after eviction must be transmitted again.
 value.sourceInventories={card:original};channel.publish(value);assert.equal(Object.keys(updates.at(-1)!.inventories).length,1);receiver.apply(updates.at(-1)!);assert.equal(receiver.snapshot()!.sourceInventories!.card.files[0].relative,'photo.nef');
});

test('initial snapshots supersede older events and new review objects replace old plans',()=>{
 const updates:StateUpdate[]=[],channel=createStateChannel(update=>updates.push(wire(update))),receiver=createStateReceiver(),value=state();
 channel.publish(value);assert.equal(receiver.apply(updates[0]),undefined);
 value.review=review();channel.publish(value);receiver.apply(wire(channel.snapshot(value)));const before=receiver.snapshot();receiver.apply(updates[0]);assert.equal(receiver.snapshot(),before);
 value.review={...review(),id:'new-review',plans:[]};channel.publish(value);receiver.apply(updates.at(-1)!);assert.equal(receiver.snapshot()!.review!.id,'new-review');assert.deepEqual(receiver.snapshot()!.review!.plans,[]);
});


test('snapshot queries do not consume changes owed to existing subscribers',()=>{
 const updates:StateUpdate[]=[],channel=createStateChannel(update=>updates.push(wire(update))),first=createStateReceiver(),second=createStateReceiver(),value=state();
 channel.publish(value);first.apply(wire(channel.snapshot(value)));
 value.sourceInventories={card:inventory()};value.review=review();
 second.apply(wire(channel.snapshot(value)));
 channel.publish(value);const published=updates.at(-1)!;assert.equal(Object.keys(published.inventories).length,1);assert.equal(published.review!.id,'review');
 first.apply(published);assert.equal(first.snapshot()!.sourceInventories!.card.media,1);assert.equal(first.snapshot()!.review!.id,'review');
});

test('receiver retains updates arriving while an initial snapshot response is in flight',()=>{
 const updates:StateUpdate[]=[],channel=createStateChannel(update=>updates.push(wire(update))),receiver=createStateReceiver(),value=state();
 const initial=wire(channel.snapshot(value));value.sourceInventories={card:inventory()};channel.publish(value);
 assert.equal(receiver.apply(updates.at(-1)!),undefined);
 const latest=receiver.apply(initial)!;assert.equal(latest.sourceInventories!.card.media,1);
});
