import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EtaTracker,overviewEta,stampEstimates,type EtaInput,type EtaContext} from '../eta';
import {PriorStore} from '../eta-priors';
import {deleteOriginals} from '../core/originals';
import type {AppState,Job} from '../shared';

const preferences:AppState['preferences']={language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/b'],copyMode:'single',basePath:'p',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}};
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
 const job:AppState={preferences,sources:[source],jobs:[],history:[],platform:'darwin',scanProgress:{card:{files:0,bytes:0}}};
 for(let t=0;t<=8;t++){job.scanProgress!.card={files:t*100,bytes:t*1e8};stampEstimates(job,tracker,t*1000);}
 assert.equal(job.scanProgress!.card!.eta,undefined);
 assert.ok(job.scanProgress!.card!.fileRate!>0);
});

test('stopping removes the time left',()=>{
 const tracker=new EtaTracker(),running:Job={id:'j',source:card,phase:'copying',errors:[],backup:false,progress:{phase:'copying',completed:0,total:100,bytes:0,totalBytes:1e10,speed:0,file:''}};
 const state:AppState={preferences,sources:[card],jobs:[running],history:[],platform:'darwin'};
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
 const state:AppState={preferences,sources:[card],jobs:[done],history:[],platform:'darwin'};
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

test('comparing 43k files (500 GB) moves the job fraction every 5 s and the time left falls as files match',()=>{
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
 assert.ok(etas.at(-1)!<etas[0]!*0.8,`eta ${etas[0]} -> ${etas.at(-1)}`);
});
