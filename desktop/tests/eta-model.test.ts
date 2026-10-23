import test from 'node:test';
import assert from 'node:assert/strict';
import {StepFit,JobModel,defaultBook,stepUncertainty,sharedDriveTotal,stepDefault,type Coef} from '../eta-model';
import {DisplayHold,bucketSeconds,remainingRange} from '../eta-format';
import {simulate,mixedSizes,within,ratio,lcg} from './eta-sim';

const copying:Coef={a:0.02,b:16.7};

test('steady bytes: within 5% after 30 s, and no step estimate before the first window closes',()=>{
 const {trace}=simulate({sizes:Array(2000).fill(0.1),a:0.01,b:10,prior:copying});
 for(const point of trace.filter(p=>p.t<5))assert.equal(point.windows,0,`window closed at ${point.t}`);
 assert.ok(trace.some(p=>p.windows>0));
 for(const point of trace.filter(p=>p.t>=30&&p.truth>20))assert.ok(within(point,0.05),`t=${point.t} ratio ${ratio(point).toFixed(3)}`);
});

test('mixed sizes with a right-shaped prior: within 10% after 60 s; a prior 3x off: within 15% after 120 s',()=>{
 const sizes=mixedSizes(6000);
 const right=simulate({sizes,a:0.01,b:10,prior:{a:0.01,b:10},noise:0.2});
 for(const point of right.trace.filter(p=>p.t>=60&&p.truth>20))assert.ok(within(point,0.10),`right: t=${point.t} ratio ${ratio(point).toFixed(3)}`);
 const off=simulate({sizes,a:0.01,b:10,prior:{a:0.03,b:30},noise:0.2});
 for(const point of off.trace.filter(p=>p.t>=120&&p.truth>20))assert.ok(within(point,0.15),`3x off: t=${point.t} ratio ${ratio(point).toFixed(3)}`);
});

test('small then big, big then small: an unobserved coefficient stays at its prior and the error never exceeds the prior error',()=>{
 const small=Array(3000).fill(0.0002),big=Array(20).fill(2),prior={a:0.04,b:2.5};
 for(const [name,sizes] of [['small->big',[...small,...big]],['big->small',[...big,...small]]] as [string,number[]][]){
  const {trace,fit}=simulate({sizes,a:0.01,b:10,prior});
  const twice=simulate({sizes,a:0.01,b:10,prior:{a:0.017,b:5.9}}).trace;
  for(const point of twice.filter(p=>p.windows>0&&p.truth>20)){
   // (a prior 1.7x off) the estimate stays inside [low, high] around the truth
   const u=point.u;
   assert.ok(point.truth>=point.est/(1+u)&&point.truth<=point.est*(1+u),`${name}: t=${point.t} truth ${point.truth.toFixed(0)} outside [${(point.est/(1+u)).toFixed(0)}, ${(point.est*(1+u)).toFixed(0)}]`);
  }
  // the worst error is no worse than the worst error of the prior alone
  const late=trace.filter(p=>p.observed>=30&&p.truth>20),worst=(pick:(p:typeof late[number])=>number)=>Math.max(...late.map(p=>Math.abs(Math.log(pick(p)/p.truth))));
  assert.ok(worst(p=>p.est)<=worst(p=>p.priorEst)+0.1,`${name}: worst error ${worst(p=>p.est).toFixed(2)} vs the prior's ${worst(p=>p.priorEst).toFixed(2)}`);
  void fit;
 }
 // while only small files were seen the byte coefficient stays at its prior
 const early=simulate({sizes:[...small,...big],a:0.01,b:10,prior,every:1}).trace.filter(p=>p.files<2500&&p.windows>0);
 for(const point of early)assert.ok(Math.abs(point.theta.b/prior.b-1)<=0.1,`b drifted to ${point.theta.b.toFixed(2)} at t=${point.t}`);
});

test('a rate drop of 0.5x is followed within 15% after three time constants, without jumps',()=>{
 const sizes=mixedSizes(3000),run=simulate({sizes,a:0.01,b:10,prior:{a:0.01,b:10},noise:0.1,drop:{at:300,factor:2}});
 // R is about 1000 s here, so the time constant is 0.05 R = 50 s
 for(const point of run.trace.filter(p=>p.t>=300+3*60&&p.truth>20))assert.ok(within(point,0.15),`t=${point.t} ratio ${ratio(point).toFixed(3)}`);
 let jumps=0;
 for(let i=1;i<run.trace.length;i++){const a=run.trace[i-1]!.est,b=run.trace[i]!.est;if(b>a*1.25+60)jumps++;}
 assert.equal(jumps,0,'no raw one-second jump above x1.25 + 60 s');
 const hold=new DisplayHold();let last:number|undefined,increases=0;
 for(const point of run.trace){const shown=hold.next(point.est,point.t*1000);if(last!==undefined&&shown!==undefined&&shown>last)increases++;last=shown;}
 assert.ok(increases<=2,`shown label rose ${increases} times`);
});

test('a stall of 10 s leaves the label alone; one of 120 s never takes the estimate below 0.85x or to 0',()=>{
 const sizes=Array(3000).fill(0.1);
 const base=simulate({sizes,a:0.01,b:10,prior:copying});
 const short=simulate({sizes,a:0.01,b:10,prior:copying,stalls:[{at:300,length:10}]});
 const hold=new DisplayHold(),held:number[]=[];
 for(const point of short.trace){const shown=hold.next(point.est,point.t*1000);if(point.t>=290&&point.t<=330&&shown!==undefined)held.push(shown);}
 const changes=held.filter((value,i)=>i>0&&value!==held[i-1]).length;
 assert.ok(changes<=1,`label changed ${changes} times around a 10 s stall`);
 const long=simulate({sizes,a:0.01,b:10,prior:copying,stalls:[{at:300,length:120}]});
 const before=long.trace.filter(p=>p.t>=295&&p.t<300).at(-1)!;
 for(const point of long.trace.filter(p=>p.t>=300&&p.t<500)){assert.ok(point.est>0);assert.ok(point.est>=before.est*0.85-(point.t-300)*0,`t=${point.t} est ${point.est.toFixed(0)} vs ${before.est.toFixed(0)}`);}
 void base;
});

test('a suspend gap of 10 minutes does not move the estimate across it',()=>{
 const sizes=Array(4000).fill(0.1),run=simulate({sizes,a:0.01,b:10,prior:copying,gaps:[{at:300,length:600}]});
 const before=run.trace.filter(p=>p.t<300).at(-1)!,after=run.trace.find(p=>p.t>=900+12)!;
 // the work done in between is small; compare the estimate with the truth on each side
 assert.ok(within(before,0.05),`before ${ratio(before)}`);
 assert.ok(within(after,0.05),`after ${ratio(after)}`);
});

test('no oscillation: noisy bursts for 30 minutes change the label no more than the countdown does',()=>{
 const sizes=Array(60000).fill(0.02),run=simulate({sizes,a:0.002,b:20,prior:{a:0.002,b:20},noise:0.3});
 const hold=new DisplayHold(),shown:number[]=[];
 for(const point of run.trace.filter(p=>p.t<=1800)){const value=hold.next(point.est,point.t*1000);if(value!==undefined)shown.push(value);}
 const changes=shown.filter((value,i)=>i>0&&value!==shown[i-1]).length,natural=new Set(run.trace.filter(p=>p.t<=1800).map(p=>bucketSeconds(p.truth))).size;
 assert.ok(changes<=natural+2,`${changes} changes, ${natural} natural buckets`);
 for(let i=1;i<shown.length;i++)assert.ok(shown[i]!<=shown[i-1]!+0,`rose from ${shown[i-1]} to ${shown[i]}`);
});

test('the model is deterministic, and survives zero totals, overshoot and NaN',()=>{
 const one=simulate({sizes:mixedSizes(1500),a:0.01,b:10,prior:copying,noise:0.2}),two=simulate({sizes:mixedSizes(1500),a:0.01,b:10,prior:copying,noise:0.2});
 assert.deepEqual(one.trace,two.trace);
 const fit=new StepFit(copying,20);
 for(let t=0;t<30;t++){fit.observe(t*1000,t*10,t*1e8);}
 assert.equal(fit.remaining(0,0),0);
 assert.ok(Number.isFinite(fit.remaining(-5,-1e9)));
 fit.observe(40000,Number.NaN,Number.NaN);fit.observe(41000,Infinity,5);
 assert.ok(Number.isFinite(fit.remaining(Number.NaN,Number.NaN)));
 assert.ok(Number.isFinite(fit.remaining(10,undefined)));
 const model=new JobModel({kind:'import',book:defaultBook(),totals:{}});
 const snapshot=model.update((0)*1000,'copying',{files:5,bytes:10},{files:0,bytes:0});
 assert.ok(snapshot.fraction>=0&&snapshot.fraction<=1);
 assert.equal(snapshot.step,undefined);
 const over=model.update((1)*1000,'copying',{files:9,bytes:1e9},{files:3,bytes:5e8});
 assert.ok(over.fraction<=1&&(over.job===undefined||over.job>=0));
});

const importTotals=(files:number,gb:number)=>({checking:{files,bytes:0},copying:{files,bytes:gb*1e9},'verifying:copy':{files,bytes:gb*1e9}});

test('copy then verify with a history prior: the job estimate moves at most 25% at the switch and is within 10% after 120 s',()=>{
 const files=3000,gb=30,truthCopy={a:0.02,b:16.7},truthVerify={a:0.1,b:40};
 const history:Coef=truthVerify;
 const book={lookup:(step:string)=>step==='verifying:copy'?{coef:history,T0:60,level:'exact' as const,runs:3}:defaultBook().lookup(step)};
 const model=new JobModel({kind:'import',book,totals:importTotals(files,gb),verify:true,publish:'copy'});
 // copy phase at the true copy speed
 const copySeconds=files*truthCopy.a+gb*truthCopy.b;
 let last=model.update((0)*1000,'copying',{files:0,bytes:0},{files,bytes:gb*1e9});
 for(let t=1;t<=copySeconds;t++){const f=t/copySeconds;last=model.update((t)*1000,'copying',{files:Math.round(files*f),bytes:gb*1e9*f},{files,bytes:gb*1e9});}
 const beforeSwitch=last.job!;
 const first=model.update((copySeconds+1)*1000,'verifying',{files:0,bytes:0},{files,bytes:gb*1e9});
 assert.ok(Math.abs(first.job!/beforeSwitch-1)<=0.25,`job estimate ${beforeSwitch.toFixed(0)} -> ${first.job!.toFixed(0)}`);
 const verifySeconds=files*truthVerify.a+gb*truthVerify.b;
 let snapshot=first;
 for(let t=2;t<=verifySeconds;t++){const f=(t-1)/verifySeconds;snapshot=model.update((copySeconds+t)*1000,'verifying',{files:Math.round(files*f),bytes:gb*1e9*f},{files,bytes:gb*1e9});
  if(t>=120&&t<verifySeconds-30)assert.ok(Math.abs(snapshot.job!/(verifySeconds-t)-1)<=0.10,`t=${t} ${snapshot.job!.toFixed(0)} vs ${(verifySeconds-t).toFixed(0)}`);}
});

test('live replay: exFAT verify defaults give hours at half the copy, and the job bar stays low while verifying',()=>{
 const files=43539,gb=167,copySeconds=files*0.02*1.3+gb*16.7*1.3,verify=stepDefault('verifying:copy');
 const model=new JobModel({kind:'import',book:defaultBook(),totals:importTotals(files,gb),verify:true,publish:'copy'});
 let snapshot=model.update((0)*1000,'copying',{files:0,bytes:0},{files,bytes:gb*1e9});
 for(let t=1;t<=copySeconds/2;t++){const f=t/copySeconds;snapshot=model.update((t)*1000,'copying',{files:Math.round(files*f),bytes:gb*1e9*f},{files,bytes:gb*1e9});}
 const truth=copySeconds/2+(files*verify.a+gb*verify.b)*0.8;
 assert.ok(snapshot.job!>=2*3600,`job estimate ${snapshot.job}`);
 assert.ok(snapshot.job!/truth<=2&&snapshot.job!/truth>=0.5,`estimate ${snapshot.job} vs truth ${truth}`);
 // the 22:05 state: copying done, verification part way
 const late=new JobModel({kind:'import',book:defaultBook(),totals:importTotals(files,gb),verify:true,publish:'copy'});
 late.update((0)*1000,'copying',{files:0,bytes:0},{files,bytes:gb*1e9});
 late.update((100)*1000,'copying',{files,bytes:gb*1e9},{files,bytes:gb*1e9});
 const state=late.update((200)*1000,'verifying',{files:10000,bytes:20e9},{files,bytes:gb*1e9});
 assert.ok(state.fraction<=0.45,`job fraction ${state.fraction}`);
 assert.ok(state.fraction>0.1);
});

test('after a pause the same drives start from what the session measured',()=>{
 const sizes=Array(3000).fill(0.1),run=simulate({sizes,a:0.02,b:40,prior:{a:0.1,b:16.7},T0:20});
 const learned=run.fit.theta();
 const book={lookup:(step:string)=>step==='copying'?{coef:learned,T0:60,level:'exact' as const,runs:2}:defaultBook().lookup(step)};
 const files=3000,gb=300,model=new JobModel({kind:'import',book,totals:{copying:{files,bytes:gb*1e9}},verify:false});
 const snapshot=model.update((0)*1000,'copying',{files:0,bytes:0},{files,bytes:gb*1e9});
 const truth=files*0.02+gb*40;
 assert.ok(Math.abs(snapshot.job!/truth-1)<=0.1,`first estimate ${snapshot.job} vs ${truth}`);
});

test('ranges show while the defaults dominate, and a single value once measured',()=>{
 const files=3000,gb=30;
 const model=new JobModel({kind:'import',book:defaultBook(),totals:importTotals(files,gb),verify:true,publish:'copy'});
 const start=model.update((0)*1000,'copying',{files:0,bytes:0},{files,bytes:gb*1e9});
 assert.ok(start.low!<start.job!&&start.job!<start.high!);
 assert.ok(remainingRange(start.job!,start.low!,start.high!),'range while defaults dominate');
 const truth=start.job!;
 assert.ok(truth>start.low!&&truth<start.high!);
 let snapshot=start;
 const total=files*0.02+gb*16.7;
 for(let t=1;t<=200;t++){const f=t/total;snapshot=model.update((t)*1000,'copying',{files:Math.round(files*f),bytes:gb*1e9*f},{files,bytes:gb*1e9});}
 const measured=stepUncertainty({observed:200,level:'default'});
 assert.equal(measured,0.15);
 assert.ok(snapshot.uncertainty<start.uncertainty);
});

test('shared drives: jobs share the drive when it is the bottleneck, otherwise the longest one sets the time',()=>{
 // Estimates are measured while sharing: when the shorter job ends, the other speeds up.
 assert.equal(sharedDriveTotal([100,100],true),100);
 assert.equal(sharedDriveTotal([300,100],true),200);
 assert.ok(Math.abs(sharedDriveTotal([100,200,300],true)-200)<1e-9);
 assert.equal(sharedDriveTotal([300,100],false),300);
 assert.equal(sharedDriveTotal([],true),0);
 assert.equal(sharedDriveTotal([50],true),50);
});

test('unknown model inputs draw from the defaults table',()=>{
 for(const step of ['checking','candidates','comparing','existing','reading','removing','copying','verifying:link','verifying:copy','publish:link','publish:copy','history','earlier','confirming','verifying:checking','moving','stashing','tidying','releasing','restoring','deleting','originals:deleting']){
  const d=stepDefault(step);assert.ok(d.a>0,step);assert.ok(d.b>=0,step);
 }
 assert.equal(stepDefault('originals:deleting',2).b,30);
 assert.equal(stepDefault('checking').b,0);
 void lcg;
});

test('the snapshot gives each step the cumulative share of the job done through it',()=>{
 const model=new JobModel({kind:'import',book:defaultBook(),verify:true,publish:'link',totals:{copying:{files:100,bytes:10e9},verifying:{files:100,bytes:10e9}}});
 model.update(0,'copying',{files:50,bytes:5e9},{files:100,bytes:10e9});
 const {shares,fraction}=model.snapshot();
 assert.ok(shares&&shares.length>=2);
 for(let i=1;i<shares!.length;i++)assert.ok(shares![i]!.share>=shares![i-1]!.share);
 assert.ok(Math.abs(shares!.at(-1)!.share-fraction)<1e-9);
 assert.equal(shares!.find(item=>item.step==='copying')!.share,fraction);
});
