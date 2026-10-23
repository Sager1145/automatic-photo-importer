import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStateChannel,createStateReceiver,type StateUpdate} from '../state-channel';
import type {AppState,Inventory,Review} from '../shared';
import {text} from '../messages';

function inventory(name='photo.nef'):Inventory{return {files:[{path:'/card/'+name,relative:name,size:8,kind:'RAW',included:true}],media:1,companions:0,unknown:0,bytes:8,unknownExtensions:{},elapsedMs:1};}
function state():AppState{return {preferences:{language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:[],copyMode:'single',basePath:'photobackup',template:'{year}/{yyyymm}/{camera}',mediaLayout:'flat' as const,videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}},sources:[{id:'card',name:'Card',path:'/card',transport:'storage'}],jobs:[],history:[],platform:'darwin'};}
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

test('job errors, problem files, the error log and history cross once until they change',()=>{
 const updates:StateUpdate[]=[],channel=createStateChannel(update=>updates.push(wire(update))),receiver=createStateReceiver(),value=state();
 value.jobs=[{id:'job',source:value.sources[0],phase:'copying',detail:text('Copying'),errors:[text('first')],backup:false,problemFiles:[{path:'/card/empty.jpg',relative:'empty.jpg',reason:'empty',group:'empty',collected:false}]}];
 value.history=[{id:'h',date:'2026-10-23',title:text('Import'),detail:text('Done')}];value.errorLog={at:{a:'2026-10-23'},cleared:[]};
 channel.publish(value);receiver.apply(wire(channel.snapshot(value)));
 const first=receiver.snapshot()!,errors=first.jobs[0].errors,problems=first.jobs[0].problemFiles,log=first.errorLog,history=first.history;
 value.jobs[0].progress={completed:1,total:2,bytes:1,totalBytes:2,speed:1,file:'a'};channel.publish(value);
 const quiet=updates.at(-1)!;assert.deepEqual(quiet.details,{});receiver.apply(quiet);
 const second=receiver.snapshot()!;
 assert.equal(second.jobs[0].errors,errors);assert.equal(second.jobs[0].problemFiles,problems);assert.equal(second.errorLog,log);assert.equal(second.history,history);
 // Errors are appended in place: a longer list crosses again, whole.
 value.jobs[0].errors.push(text('second'));channel.publish(value);
 const grown=updates.at(-1)!;assert.equal(Object.keys(grown.details).length,1);receiver.apply(grown);
 assert.deepEqual(receiver.snapshot()!.jobs[0].errors.map(item=>item.params!.text),['first','second']);assert.equal(receiver.snapshot()!.history,history);
 value.history=[{id:'i',date:'2026-10-24',title:text('Import'),detail:text('Again')},...value.history];value.errorLog={at:{},cleared:['a']};channel.publish(value);
 receiver.apply(updates.at(-1)!);assert.equal(receiver.snapshot()!.history.length,2);assert.deepEqual(receiver.snapshot()!.errorLog!.cleared,['a']);
});

test('an inventory crosses without its folder listing, and an unchanged earlier-placed list is not resent',()=>{
 const updates:StateUpdate[]=[],channel=createStateChannel(update=>updates.push(wire(update))),receiver=createStateReceiver(),value=state();
 const files={...inventory(),listing:{backup:false,folders:[['/card','id',['a']] as [string,string,string[]]]}};
 value.sourceInventories={card:files};value.jobs=[{id:'job',source:value.sources[0],phase:'copying',detail:text('Copying'),errors:[],backup:false,inventory:files}];
 const earlier=['a/1.jpg','a/2.jpg'];value.duplicates={scopes:[],status:'ready',revision:1,groups:0,files:0,earlier};
 channel.publish(value);receiver.apply(wire(channel.snapshot(value)));
 const received=receiver.snapshot()!;
 assert.equal(Object.hasOwn(received.sourceInventories!.card,'listing'),false);assert.equal(Object.hasOwn(received.jobs[0].inventory!,'listing'),false);
 assert.equal(received.sourceInventories!.card.media,1);assert.ok(files.listing,'main keeps its own listing');
 assert.equal(received.sourceInventories!.card,received.jobs[0].inventory,'one stripped copy is shared');
 assert.deepEqual(received.duplicates!.earlier,earlier);assert.equal(Object.hasOwn(received.duplicates!,'duplicatesEarlierRef'),false);
 const kept=received.duplicates!.earlier;
 value.duplicates={...value.duplicates,revision:2};channel.publish(value);const quiet=updates.at(-1)!;assert.deepEqual(quiet.details,{});receiver.apply(quiet);
 assert.equal(receiver.snapshot()!.duplicates!.earlier,kept);assert.equal(receiver.snapshot()!.duplicates!.revision,2);
 value.duplicates={...value.duplicates,earlier:['b/3.jpg']};channel.publish(value);assert.equal(Object.keys(updates.at(-1)!.details).length,1);receiver.apply(updates.at(-1)!);
 assert.deepEqual(receiver.snapshot()!.duplicates!.earlier,['b/3.jpg']);
 value.duplicates={...value.duplicates,earlier:undefined};channel.publish(value);receiver.apply(updates.at(-1)!);
 assert.equal(receiver.snapshot()!.duplicates!.earlier,undefined);
});
