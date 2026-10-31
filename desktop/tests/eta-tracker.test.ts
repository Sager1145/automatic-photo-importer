import { freshOrganizeOptions } from '../run-policy';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EtaTracker,overviewEta,stampEstimates,type EtaInput,type EtaContext} from '../eta';
import {PriorStore} from '../eta-priors';
import {deleteOriginals} from '../core/originals';
import type {AppState,Job} from '../shared';
import { defaultPreferences } from '../preferences';

const preferences:AppState['preferences']={...defaultPreferences, language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/b'],copyMode:'single',template:'{year}',mediaLayout:'flat',videoTemplate:'',unknownRules:{}};
const card={id:'card',name:'Card',path:'/Volumes/CARD',transport:'storage' as const,selected:true,total:128e9,free:40e9};
const context:EtaContext={kind:'import',destinations:1,verify:true};
const drives={source:{id:'SRC-UUID',transport:'storage',fsType:'exfat',external:true},destinations:[{id:'DST-UUID',transport:'storage',fsType:'exfat',external:true}]};

/** A copy of `gb` gigabytes in `files` files at `secondsPerGB`, fed once a second from `from`. Returns the last result. */
function copyJob(tracker:EtaTracker,id:string,from:number,seconds:number,secondsPerGB:number,gb=40,files=2000){
 let last={} as ReturnType<EtaTracker['observe']>;
 for(let t=0;t<=seconds;t++){
  const bytes=Math.min(gb*1e9,t/secondsPerGB*1e9),done=Math.floor(files*bytes/(gb*1e9));
  const progress:EtaInput={phase:'copying',completed:done,total:files,bytes,totalBytes:gb*1e9,work:{files:done,bytes,totalFiles:files,totalBytes:gb*1e9}};
  last=tracker.observe(id,progress,context,(from+t)*1000);
 }
 return last;
}

test('a job resumed under a new id on the same drives starts from what the session measured',()=>{
 const tracker=new EtaTracker();
 tracker.plan('first',{kind:'import',verify:true,publish:'link',...drives});
 copyJob(tracker,'first',0,200,40);
 tracker.forget([]);
 tracker.plan('second',{kind:'import',verify:true,publish:'link',...drives});
 const resumed=copyJob(tracker,'second',1000,12,40);
 // 40 GB at 40 s/GB = 1600 s of copying; 12 s are done, then verifying (link: 10 s/GB default) follows
 const truth=(1600-12)+40*10+2000*0.05;
 assert.ok(resumed.job!>0&&Math.abs(resumed.job!/truth-1)<=0.1,`first estimate ${resumed.job} vs ${truth}`);
});

test('the job estimate is withheld while the job is new, and the step estimate until a window closed',()=>{
 const tracker=new EtaTracker();
 for(let t=0;t<=10;t++){
  const result=tracker.observe('j',{phase:'copying',completed:t*10,total:1000,bytes:t*1e8,totalBytes:1e10},context,t*1000);
  if(t<5)assert.equal(result.step,undefined);
  if(t<10)assert.equal(result.job,undefined,`t=${t}`);
 }
});

test('an unknown total gives no estimate, only a rate',()=>{
 const tracker=new EtaTracker(),source={...card,total:undefined,free:undefined};
 const job:AppState={preferences,sources:[source],jobs:[],history:[],platform:'darwin',organizeOptions:freshOrganizeOptions(),scanProgress:{card:{files:0,bytes:0}}};
 for(let t=0;t<=8;t++){job.scanProgress!.card={files:t*100,bytes:t*1e8};stampEstimates(job,tracker,t*1000);}
 assert.equal(job.scanProgress!.card!.eta,undefined);
 assert.ok(job.scanProgress!.card!.fileRate!>0);
});

test('stopping removes the time left',()=>{
 const tracker=new EtaTracker(),running:Job={id:'j',source:card,phase:'copying',errors:[],backup:false,progress:{phase:'copying',completed:0,total:100,bytes:0,totalBytes:1e10,speed:0,file:''}};
 const state:AppState={preferences,sources:[card],jobs:[running],history:[],platform:'darwin',organizeOptions:freshOrganizeOptions()};
 for(let t=0;t<=30;t++){running.progress={...running.progress!,completed:t,bytes:t*1e8};stampEstimates(state,tracker,t*1000);}
 assert.ok(running.eta!>0);assert.ok(running.progress!.eta!>0);
 running.stopping='stop';
 stampEstimates(state,tracker,31000);
 assert.equal(running.eta,undefined);assert.equal(running.etaRange,undefined);
 assert.equal(state.etaTotal,undefined);
});

test('delete originals reads the source and every backup copy, and gets a time left that goes away with it',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'eta-originals-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const {createHash}=await import('node:crypto');
 const files=[] as {source:string;size:number;sha256:string;destinations:string[]}[];
 for(let i=0;i<4;i++){
  const content=Buffer.alloc(1000*(i+1),i+1),source=path.join(base,`s${i}`),one=path.join(base,`a${i}`),two=path.join(base,`b${i}`);
  for(const file of [source,one,two])await fs.writeFile(file,content);
  files.push({source,size:content.length,sha256:createHash('sha256').update(content).digest('hex'),destinations:[one,two]});
 }
 const seen:[number|undefined,number|undefined][]=[];
 await deleteOriginals(base,files,{onProgress:(_c,_t,_f,done,total)=>seen.push([done,total])});
 assert.equal(seen[0]![0],0);
 assert.equal(seen.at(-1)![0],10000*3,'(1 + 2 backups) times the size');
 assert.equal(seen.at(-1)![1],10000*3);
 const tracker=new EtaTracker(),done:Job={id:'j',source:card,phase:'complete',errors:[],backup:false,verifiedOriginals:4};
 const state:AppState={preferences,sources:[card],jobs:[done],history:[],platform:'darwin',organizeOptions:freshOrganizeOptions()};
 tracker.plan('originals:j',{kind:'originals',backups:2});
 for(let s=0;s<=30;s++){done.deletingOriginals={completed:s,total:100,bytes:s*3e8,totalBytes:100*3e8};stampEstimates(state,tracker,s*1000);}
 assert.ok(done.deletingOriginals!.eta!>0,`eta ${done.deletingOriginals!.eta}`);
 assert.ok(done.deletingOriginals!.startedAt);
 delete done.deletingOriginals;
 stampEstimates(state,tracker,31000);
 assert.equal(done.deletingOriginals,undefined);
});

test('two identical runs give identical results',()=>{
 const run=()=>{const tracker=new EtaTracker(),out:unknown[]=[];tracker.plan('j',{kind:'import',verify:true,...drives});for(let t=0;t<=90;t++)out.push(tracker.observe('j',{phase:'copying',completed:t*7,total:2000,bytes:(t*t%97+t)*1e8,totalBytes:2e11},context,t*1000),tracker.view('j'));return out;};
 assert.deepEqual(run(),run());
});

test('what a long unshared step measured is saved without any id, path or name',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'eta-tracker-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'eta-priors.json'),store=new PriorStore(file,()=>'c2FsdHNhbHRzYWx0c2FsdA');await store.load();
 const tracker=new EtaTracker(store);
 tracker.plan('j',{kind:'import',verify:true,...drives});
 copyJob(tracker,'j',0,120,40);
 tracker.forget([]);
 assert.equal(await store.maybeSave(1_000_000),true);
 const text=await fs.readFile(file,'utf8');
 for(const forbidden of ['SRC-UUID','DST-UUID','/','\\','CARD'])assert.ok(!text.includes(forbidden),forbidden);
 const entries=Object.keys(JSON.parse(text).entries);
 assert.ok(entries.some(key=>key.startsWith('copying|d:')),`exact entry: ${entries}`);
});

test('jobs sharing a destination drive finish together sooner only when the drive is the bottleneck',()=>{
 const tracker=new EtaTracker();
 tracker.plan('solo',{kind:'import',verify:true,...drives});
 copyJob(tracker,'solo',0,200,40);
 tracker.forget([]);
 const job=(id:string,eta:number,speed:number):Job=>({id,source:card,phase:'copying',errors:[],backup:false,eta,progress:{phase:'copying',completed:1,total:2,bytes:1,totalBytes:2,speed,file:''}});
 const a=job('a',300,12.5e6),b=job('b',100,12.5e6);
 for(const item of [a,b]){tracker.plan(item.id,{kind:'import',verify:true,...drives});tracker.observe(item.id,item.progress!,context,0);}
 // 25 MB/s alone; together 25 MB/s: the drive is the bottleneck, so the long job speeds up when the short one ends
 assert.equal(overviewEta([a,b],tracker)!.eta,200);
 // together they move well under what the drive did alone (each is held back by something else): the longest sets the time
 a.progress!.speed=b.progress!.speed=5e6;
 assert.equal(overviewEta([a,b],tracker)!.eta,300);
 b.eta=undefined;
 assert.equal(overviewEta([a,b],tracker),undefined,'undefined while a job is still estimating');
});

test('comparing 43k files (500 GB) moves the job fraction every 5 s and the time left falls with the time spent, the share found identical counted from the start',()=>{
 const tracker=new EtaTracker(),files=43000,bytes=500e9,sameSize=200e9;
 tracker.plan('j',{kind:'import',verify:true,publish:'link',...drives});
 let t=0;
 for(;t<=60;t++)tracker.observe('j',{phase:'planning',step:'checking',completed:Math.round(files*t/60),total:files,bytes:bytes*t/60,totalBytes:bytes},context,t*1000);
 const fractions:number[]=[],etas:number[]=[];
 for(let s=0;s<=300;s++,t++){
  const share=s/300,compared=Math.round(files*share),read=sameSize*share;
  const eta=tracker.observe('j',{phase:'planning',step:'comparing',completed:compared,total:files,bytes:read,totalBytes:sameSize,matched:Math.round(compared*0.9),matchedBytes:read*0.9},context,t*1000);
  if(s>=10&&s%5===0){fractions.push(tracker.view('j').fraction!);etas.push(eta.job!);}
 }
 for(let i=1;i<fractions.length;i++)assert.ok(fractions[i]!>fractions[i-1]!,`fraction at sample ${i}: ${fractions[i-1]} -> ${fractions[i]}`);
 for(let i=1;i<etas.length;i++)assert.ok(etas[i]!<=etas[i-1]!,`eta at sample ${i}: ${etas[i-1]} -> ${etas[i]}`);
 // The share found identical stands for the files still to compare from the first samples on, so the time left falls with the time spent:
 // 290 s of comparing between the first sample and the last.
 assert.ok(Math.abs(etas[0]!-etas.at(-1)!-290)<30,`eta ${etas[0]} -> ${etas.at(-1)}`);
});

// Recorded 2026-10-24: a folder of 6,759 planned files (2,110 already in the backup, 20.0 GB to copy) to an exFAT drive written directly.
// At 1:46 the copy count read 3,490 of 4,649 files (it then left out the 2,110 being confirmed as the copy went) and 15 GB of 20 GB, but the job showed 7% and about 13 min left: the model still
// planned an exFAT verify step that a direct copy never runs (it checks each file in place as it copies).
test('a direct copy to exFAT plans no verify step: the job percent and time left follow the copy counts',async()=>{
 const {overviewFraction}=await import('../renderer/RootApp');
 const {cardFraction,copyBasis}=await import('../renderer/progress');
 const total=6759,skipped=2110,totalBytes=20032300690;
 const tracker=new EtaTracker();
 tracker.plan('j',{kind:'import',verify:true,...drives,publish:tracker.predictPublish(drives.destinations),totals:{copying:{files:total-skipped,bytes:totalBytes},verifying:{files:total,bytes:totalBytes}}});
 const job:Job={id:'j',source:card,phase:'verifying',errors:[],backup:false,progress:{phase:'planning',step:'existing',completed:0,total,bytes:0,totalBytes:0,speed:0,file:''}};
 const state:AppState={preferences,sources:[card],jobs:[job],history:[],platform:'darwin',organizeOptions:freshOrganizeOptions()};
 // Confirming the files already on the drive: about 4 s.
 for(let t=0;t<=4;t++){job.progress={...job.progress!,completed:Math.round(6287*t/4)};stampEstimates(state,tracker,t*1000);}
 // Copying, as logged every 5 s from 08:08:01.9 (completed files, bytes); the progress between them is interpolated each second.
 const logged:[number,number][]=[[34,397938893],[216,2176764504],[424,3895583514],[600,5717159537],[784,7214368276],[1076,7605324344],[1413,7605324344],[1753,7605324344],[2089,7605324344],[2448,7605324344],[2737,7605324344],[3077,8195114656],[3245,9838477429],[3373,11452902090],[3517,12868051383],[3879,13638258024],[4343,14025964993],[4758,14329316111],[4994,14496662394],[5262,14678906897],[5495,14873610246],[5853,15160326622]];
 job.phase='copying';
 let previous:[number,number]=[0,0],now=5000;
 for(const point of logged){
  for(let step=1;step<=5;step++){
   const completed=Math.round(previous[0]+(point[0]-previous[0])*step/5),bytes=previous[1]+(point[1]-previous[1])*step/5;
   job.progress={phase:'copying',completed,total,bytes,totalBytes,speed:0,file:'',work:{files:completed,bytes,totalFiles:total,totalBytes,direct:{files:total,bytes:totalBytes,present:skipped}}};
   stampEstimates(state,tracker,now);now+=1000;
  }
  previous=point;
 }
 // 08:09:46: 18 s before the copy (and the job) ended.
 const basis=copyBasis(job.progress!),files=basis.completed/basis.total,data=job.progress!.bytes/totalBytes;
 assert.equal(basis.completed,5853);assert.equal(basis.total,total);
 const percent=cardFraction(job)!;
 assert.equal(percent,files,'the card reads its counter: files copied or confirmed');
 // The model's share of the whole job (what the time left is measured against) has no verify step left to add.
 for(const [name,value] of [['files',files],['bytes',data]] as const)assert.ok(Math.abs(job.fraction!-value)<0.1,`job share ${Math.round(job.fraction!*100)}% vs ${name} ${Math.round(value*100)}%`);
 assert.equal(overviewFraction([job]),percent,'the overview reads the same number');
 assert.ok(job.eta!>0&&job.eta!<120,`time left ${job.eta} s, not the ~13 min a verify step would add`);
});

// Recorded 2026-10-24 21:09: 6,759 files (40.9 GB) checked, then compared with an exFAT drive that already held every one. Checking and
// comparing took about 1½ min each and the import after them 1½ min, but the time left read "about 15–60 min" while checking and
// "about 10–40 min" while comparing: it counted every file as copied, then verified, on a drive written directly with no verify step.
test('checking and comparing do not count files as copied before comparing has measured how many are new',()=>{
 const tracker=new EtaTracker(),id='r';
 tracker.plan(id,{kind:'import',...drives,publish:tracker.predictPublish(drives.destinations),direct:tracker.predictDirect(drives.destinations,'darwin')});
 const logged:[number,string,number,number,number,number][]=[[585,'checking',64,6759,645723256,40890450976],[590,'checking',688,6759,6465819101,40890450976],[595,'checking',1392,6759,12971178360,40890450976],[600,'checking',2112,6759,19992968183,40890450976],[605,'checking',2816,6759,27248704367,40890450976],[610,'checking',3520,6759,33541652892,40890450976],[615,'checking',4240,6759,34693645589,40890450976],[620,'checking',5056,6759,35287081286,40890450976],[625,'checking',5824,6759,35890489120,40890450976],[630,'checking',6576,6759,39349318165,40890450976],[635,'candidates',297,1614,0,0],[640,'candidates',755,1614,0,0],[645,'candidates',1353,1614,0,0],[650,'comparing',58,6759,623788806,37800850158],[655,'comparing',569,6759,5263063431,37800850158],[660,'comparing',1323,6759,12382405124,37800850158],[665,'comparing',1771,6759,16800692369,37800850158],[670,'comparing',2143,6759,20271197431,37800850158],[675,'comparing',2553,6759,24267566896,37800850158],[680,'comparing',2933,6759,28355551090,37800850158],[685,'comparing',3417,6759,32544558195,37800850158],[690,'comparing',6599,6759,36522821603,37800850158],[695,'comparing',6759,6759,37800850158,37800850158]];
 const results=new Map<number,ReturnType<EtaTracker['observe']>>();
 let previous:typeof logged[number]|undefined;
 for(const point of logged){
  const [at,step,completed,total,bytes,totalBytes]=point,from=previous&&previous[1]===step?previous:undefined;
  for(let second=from?from[0]+1:at;second<=at;second++){
   const share=from?(second-from[0])/(at-from[0]):1,done=Math.round((from?.[2]??0)+(completed-(from?.[2]??0))*share),read=(from?.[4]??0)+(bytes-(from?.[4]??0))*share;
   // Every file compared was already on the drive.
   const progress:EtaInput={phase:'planning',step,completed:done,total,bytes:read,totalBytes,...(step==='comparing'?{matched:done,matchedBytes:read}:{})};
   results.set(second,tracker.observe(id,progress,context,second*1000));
  }
  previous=point;
 }
 for(const second of [600,620,630]){
  const result=results.get(second)!;
  assert.equal(result.job,undefined,`at ${second} s the job's time is not claimed while copies are only assumed`);
  assert.ok(result.step!==undefined&&result.step<120,`checking's own time left at ${second} s: ${result.step}`);
 }
 for(const second of [660,675,690]){
  const job=results.get(second)!.job;
  assert.ok(job!==undefined&&job<240,`at ${second} s the job's time left is ${job} s (it took about 2 min more)`);
 }
});
