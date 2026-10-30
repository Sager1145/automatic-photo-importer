import { freshOrganizeOptions } from '../run-policy';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStateChannel,createStateReceiver,type StateUpdate} from '../state-channel';
import type {AppState,Inventory,Job,Review} from '../shared';
import {text} from '../messages';
import {withFigures} from '../core/inventory';
import { defaultPreferences } from '../preferences';

function inventory(name='photo.nef'):Inventory{return withFigures({files:[{path:'/card/'+name,relative:name,size:8,kind:'RAW',included:true}],media:1,companions:0,unknown:0,bytes:8,unknownExtensions:{},elapsedMs:1});}
function state():AppState{return {preferences:{...defaultPreferences, language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:[],copyMode:'single',basePath:'photobackup',template:'{year}/{yyyymm}/{camera}',mediaLayout:'flat' as const,videoBasePath:'videobackup',videoTemplate:'',unknownRules:{}},sources:[{id:'card',name:'Card',path:'/card',transport:'storage'}],jobs:[],history:[],platform:'darwin',organizeOptions:freshOrganizeOptions()};}
function review():Review{return {id:'review',kind:'import',source:{id:'card',name:'Card',path:'/card',transport:'storage'},backup:false,plans:[{source:'/card',root:'/backup',rootIdentity:'disk',entries:[{id:'photo',source:'/card/photo.nef',destination:'/backup/photo.nef',size:8,kind:'RAW',digest:'abc',skip:false,family:'photo'}]}]};}
const wire=(update:StateUpdate)=>structuredClone(update);

test('progress sends each shared file list and review once, preserving receiver details',()=>{
 const updates:StateUpdate[]=[],channel=createStateChannel(update=>updates.push(wire(update))),receiver=createStateReceiver(),value=state();
 const files=inventory();value.sourceInventories={card:files};value.jobs=[{id:'job',source:value.sources[0],phase:'copying',detail:text('Copying'),errors:[],backup:false,inventory:files}];value.review=review();
 channel.publish(value);
 const initial=channel.snapshot(value);assert.equal(Object.values(initial.details).filter(item=>item===files).length,1);receiver.apply(wire(initial));
 const received=receiver.snapshot()!,retained=received.jobs[0].inventory,savedReview=received.review;
 for(let bytes=1;bytes<=3;bytes++){value.jobs[0].progress={completed:0,total:1,bytes,totalBytes:8,speed:1,file:'photo.nef'};channel.publish(value);const update=updates.at(-1)!;assert.deepEqual(update.details,{});assert.equal(Object.hasOwn(update,'review'),false);receiver.apply(update);}
 assert.equal(receiver.snapshot()!.jobs[0].inventory,retained);assert.equal(receiver.snapshot()!.sourceInventories!.card,retained);assert.equal(receiver.snapshot()!.review,savedReview);assert.equal(receiver.snapshot()!.jobs[0].progress!.bytes,3);
});

test('replacement, job eviction, source disconnection and review removal update details exactly',()=>{
 const updates:StateUpdate[]=[],channel=createStateChannel(update=>updates.push(wire(update))),receiver=createStateReceiver(),value=state();
 const original=inventory();value.sourceInventories={card:original};value.jobs=[{id:'job',source:value.sources[0],phase:'complete',detail:text('Done'),errors:[],backup:false,inventory:original}];value.review=review();channel.publish(value);receiver.apply(wire(channel.snapshot(value)));
 const replacement=inventory('next.nef');value.sourceInventories.card=replacement;channel.publish(value);assert.equal(Object.keys(updates.at(-1)!.details).length,1);receiver.apply(updates.at(-1)!);assert.equal(receiver.snapshot()!.sourceInventories!.card.files[0].relative,'next.nef');assert.equal(receiver.snapshot()!.jobs[0].inventory!.files[0].relative,'photo.nef');
 value.jobs=[];value.sources=[];value.sourceInventories={};value.review=undefined;channel.publish(value);assert.equal(updates.at(-1)!.review,null);receiver.apply(updates.at(-1)!);assert.deepEqual(receiver.snapshot()!.jobs,[]);assert.deepEqual(receiver.snapshot()!.sourceInventories,{});assert.equal(receiver.snapshot()!.review,undefined);
 // The same object returning after eviction must be transmitted again.
 value.sourceInventories={card:original};channel.publish(value);assert.equal(Object.keys(updates.at(-1)!.details).length,1);receiver.apply(updates.at(-1)!);assert.equal(receiver.snapshot()!.sourceInventories!.card.files[0].relative,'photo.nef');
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
 channel.publish(value);const published=updates.at(-1)!;assert.equal(Object.keys(published.details).length,1);assert.equal(published.review!.id,'review');
 first.apply(published);assert.equal(first.snapshot()!.sourceInventories!.card.media,1);assert.equal(first.snapshot()!.review!.id,'review');
});

test('receiver retains updates arriving while an initial snapshot response is in flight',()=>{
 const updates:StateUpdate[]=[],channel=createStateChannel(update=>updates.push(wire(update))),receiver=createStateReceiver(),value=state();
 const initial=wire(channel.snapshot(value));value.sourceInventories={card:inventory()};channel.publish(value);
 assert.equal(receiver.apply(updates.at(-1)!),undefined);
 const latest=receiver.apply(initial)!;assert.equal(latest.sourceInventories!.card.media,1);
});

test('job errors, problem files, the error log and history cross once until they change',async()=>{
 const updates:StateUpdate[]=[],channel=createStateChannel(update=>updates.push(wire(update))),receiver=createStateReceiver(),value=state();
 value.jobs=[{id:'job',source:value.sources[0],phase:'copying',detail:text('Copying'),errors:[text('first')],backup:false,problemFiles:[{path:'/card/empty.jpg',relative:'empty.jpg',reason:'empty',group:'empty',collected:false}]}];
 value.history=[{id:'h',date:'2026-10-23',title:text('Import'),detail:text('Done'),outcome:'done'}];value.errorLog={entries:[]};
 channel.publish(value);receiver.apply(wire(channel.snapshot(value)));
 const first=receiver.snapshot()!,errors=first.jobs[0].errors,problems=first.jobs[0].problemFiles,log=first.errorLog,history=first.history;
 value.jobs[0].progress={completed:1,total:2,bytes:1,totalBytes:2,speed:1,file:'a'};channel.publish(value);
 const quiet=updates.at(-1)!;assert.deepEqual(quiet.details,{});receiver.apply(quiet);
 const second=receiver.snapshot()!;
 assert.equal(second.jobs[0].errors,errors);assert.equal(second.jobs[0].problemFiles,problems);assert.equal(second.errorLog,log);assert.equal(second.history,history);
 // Errors are appended in place through addErrors: the list crosses again, whole.
 const {addErrors}=await import('../job-issues');addErrors(value.jobs[0],text('second'));channel.publish(value);
 const grown=updates.at(-1)!;assert.equal(Object.keys(grown.details).length,1);receiver.apply(grown);
 assert.deepEqual(receiver.snapshot()!.jobs[0].errors.map(item=>item.params!.text),['first','second']);assert.equal(receiver.snapshot()!.history,history);
 value.history=[{id:'i',date:'2026-10-24',title:text('Import'),detail:text('Again'),outcome:'done'},...value.history];value.errorLog={entries:[]};channel.publish(value);
 receiver.apply(updates.at(-1)!);assert.equal(receiver.snapshot()!.history.length,2);assert.deepEqual(receiver.snapshot()!.errorLog!.entries,[]);
});

test('one inventory shared by a source and its job crosses once',()=>{
 const updates:StateUpdate[]=[],channel=createStateChannel(update=>updates.push(wire(update))),receiver=createStateReceiver(),value=state();
 const files=inventory();
 value.sourceInventories={card:files};value.jobs=[{id:'job',source:value.sources[0],phase:'copying',detail:text('Copying'),errors:[],backup:false,inventory:files}];
 value.duplicates={scopes:[],status:'ready',revision:1,groups:0,files:0};
 channel.publish(value);receiver.apply(wire(channel.snapshot(value)));
 const received=receiver.snapshot()!;
 assert.equal(received.sourceInventories!.card.media,1);
 assert.equal(received.sourceInventories!.card,received.jobs[0].inventory,'one copy is shared');
 value.duplicates={...value.duplicates!,revision:2};channel.publish(value);const quiet=updates.at(-1)!;assert.deepEqual(quiet.details,{});receiver.apply(quiet);
 assert.equal(receiver.snapshot()!.duplicates!.revision,2);
});

test('a group count change crosses as a number; its paths cross only when they change',async()=>{
 const {recordIssue}=await import('../job-issues');const {MAX_GROUP_ITEMS}=await import('../shared');
 const updates:StateUpdate[]=[],channel=createStateChannel(update=>updates.push(wire(update))),receiver=createStateReceiver(),value=state();
 const job:Job={id:'job',source:value.sources[0],phase:'copying',detail:text('Copying'),errors:[],backup:false};value.jobs=[job];
 for(let index=0;index<MAX_GROUP_ITEMS;index++)recordIssue(job,{code:'copy-failed',severity:'error',path:`/card/${index}.nef`});
 channel.publish(value);receiver.apply(wire(channel.snapshot(value)));
 const items=receiver.snapshot()!.jobs[0].groups![0]!.items;assert.equal(items.length,MAX_GROUP_ITEMS);
 recordIssue(job,{code:'copy-failed',severity:'error',path:'/card/more.nef'});channel.publish(value);
 const counted=updates.at(-1)!;assert.deepEqual(counted.details,{},'the capped paths are not resent');receiver.apply(counted);
 assert.equal(receiver.snapshot()!.jobs[0].groups![0]!.count,MAX_GROUP_ITEMS+1);assert.equal(receiver.snapshot()!.jobs[0].groups![0]!.items,items);
 job.progress={completed:1,total:2,bytes:1,totalBytes:2,speed:1,file:'a'};channel.publish(value);assert.deepEqual(updates.at(-1)!.details,{});
 recordIssue(job,{code:'staging-left',severity:'warning',path:'/card/.partial'});channel.publish(value);
 const added=updates.at(-1)!;assert.equal(Object.keys(added.details).length,1,'only the new group\'s paths');receiver.apply(added);
 assert.deepEqual(receiver.snapshot()!.jobs[0].groups!.map(group=>[group.code,group.count]),[['copy-failed',MAX_GROUP_ITEMS+1],['staging-left',1]]);
});

test('an equal-length replacement of job errors crosses again',async()=>{
 const {addErrors}=await import('../job-issues');
 const updates:StateUpdate[]=[],channel=createStateChannel(update=>updates.push(wire(update))),receiver=createStateReceiver(),value=state();
 const job={id:'job',source:value.sources[0],phase:'error' as const,detail:text('Failed'),errors:[text('A')],backup:false};value.jobs=[job];
 channel.publish(value);receiver.apply(wire(channel.snapshot(value)));
 job.errors=[text('B')];channel.publish(value);receiver.apply(updates.at(-1)!);
 assert.deepEqual(receiver.snapshot()!.jobs[0].errors.map(item=>item.params!.text),['B']);
 addErrors(job,text('C'));channel.publish(value);receiver.apply(updates.at(-1)!);
 assert.deepEqual(receiver.snapshot()!.jobs[0].errors.map(item=>item.params!.text),['B','C']);
});

test('an update with a missing reference fails without emptying the received state',()=>{
 const updates:StateUpdate[]=[],channel=createStateChannel(update=>updates.push(wire(update))),receiver=createStateReceiver(),value=state();
 value.sourceInventories={card:inventory()};channel.publish(value);receiver.apply(wire(channel.snapshot(value)));
 const before=receiver.snapshot()!;
 const broken=wire(channel.snapshot(value));broken.revision+=100;broken.historyRef='missing';
 assert.throws(()=>receiver.apply(broken),/unavailable detail/);
 assert.equal(receiver.snapshot(),before);
 value.jobs=[{id:'job',source:value.sources[0],phase:'copying',detail:text('Copying'),errors:[],backup:false}];channel.publish(value);
 const next=updates.at(-1)!;next.revision=broken.revision-1;receiver.apply(next);
 assert.equal(receiver.snapshot()!.sourceInventories!.card,before.sourceInventories!.card,'details from before the failed reset are kept');
});
