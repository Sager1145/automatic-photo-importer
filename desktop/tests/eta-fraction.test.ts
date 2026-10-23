import test from 'node:test';
import assert from 'node:assert/strict';
import {FractionHold,JobModel,defaultBook} from '../eta-model';
import type {Job} from '../shared';

const card={id:'card',name:'Card',path:'/Volumes/CARD',transport:'storage' as const};
const job=(over:Partial<Job>):Job=>({id:'j',source:card,phase:'copying',errors:[],backup:false,...over});

test('shown fractions never decrease and stay below 100% until the job finishes',()=>{
 const hold=new FractionHold();
 assert.equal(hold.next(undefined),undefined);
 assert.equal(hold.next(0.2),0.2);
 assert.equal(hold.next(0.1),0.2,'a lower value keeps the shown one');
 assert.equal(hold.next(0.5),0.5);
 assert.equal(hold.next(Number.NaN),0.5);
 assert.equal(hold.next(1.5),0.99,'capped until finished');
 assert.equal(hold.next(0.3,true),1);
});

test('job fraction is the cost of the work done over the cost of all the work',()=>{
 const files=1000,bytes=10e9;
 const model=new JobModel({kind:'import',book:defaultBook(),totals:{checking:{files,bytes:0},copying:{files,bytes},'verifying:link':{files,bytes}},publish:'link',verify:true});
 const at=(step:string,f:number,b:number,t:number)=>model.update(t*1000,step,{files:f,bytes:b},{files,bytes:step==='checking'?0:bytes});
 const start=at('checking',0,0,0);
 assert.equal(start.fraction,0);
 const checked=at('copying',0,0,10);
 assert.ok(checked.fraction>0&&checked.fraction<0.2,`after checking ${checked.fraction}`);
 const half=at('copying',500,5e9,100);
 assert.ok(half.fraction>checked.fraction&&half.fraction<0.6,`halfway through copying ${half.fraction}`);
 const verifying=at('verifying',0,0,200);
 assert.ok(verifying.fraction>=half.fraction);
 // The first step's share is exactly what it contributes to the total
 const nearly=at('verifying',990,9.9e9,300);
 assert.ok(nearly.fraction>0.9&&nearly.fraction<1,`nearly done ${nearly.fraction}`);
 assert.ok(nearly.stepFraction>0.95);
 assert.ok(nearly.cost.done<=nearly.cost.total);
});

test('the card bar and the overview use the same number',async()=>{
 const {cardFraction,importFraction,overviewFraction}=await import('../renderer/RootApp');
 const verifying=job({phase:'verifying',fraction:0.35,cost:{done:35,total:100},progress:{phase:'verifying',completed:34863,total:43539,bytes:0,totalBytes:167e9,speed:0,file:''}});
 assert.equal(cardFraction(verifying),0.35,'not the 98% the old weighting gave');
 assert.equal(importFraction(verifying),0.35);
 assert.equal(overviewFraction([verifying]),cardFraction(verifying));
});

test('the overview adds model seconds; a finished job keeps its final cost',async()=>{
 const {overviewFraction}=await import('../renderer/RootApp');
 const running=job({fraction:0.5,cost:{done:500,total:1000}}),finished=job({id:'k',phase:'complete',cost:{done:3000,total:3000}});
 assert.equal(overviewFraction([running,finished]),(500+3000)/(1000+3000));
 assert.equal(overviewFraction([finished]),1);
 const bigger=job({id:'m',cost:{done:10,total:9000},fraction:0.001});
 assert.ok(Math.abs(overviewFraction([running,bigger])!-510/10000)<1e-9,'weighted by cost, not by the number of jobs');
 const unmeasured=job({id:'n',progress:{phase:'planning',step:'listing',completed:1,total:0,bytes:0,totalBytes:0,speed:0,file:''}});
 assert.ok(overviewFraction([running,unmeasured])!==undefined,'a job without a cost yet falls back to the size weighting');
 assert.equal(overviewFraction([]),undefined);
});
