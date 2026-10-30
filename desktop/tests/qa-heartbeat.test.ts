import { freshOrganizeOptions } from '../run-policy';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Heartbeat,pulses} from '../qa/ui/heartbeat';
import {syntheticJob,groupedErrorJobs} from '../qa/ui/synthetic';
import type {AppState} from '../shared';

/** A job as the app makes it: synthetic ones (qa: ids) are never watched. */
const real=(name:string,shape:Parameters<typeof syntheticJob>[1])=>({...syntheticJob(name,shape),id:'job-'+name});
const state=(jobs:AppState['jobs'],extra:Partial<AppState>={}):AppState=>({preferences:{} as AppState['preferences'],sources:[],jobs,history:[],platform:'darwin',organizeOptions:freshOrganizeOptions(),...extra});

test('a running job whose counter stays the same for more than the limit is a freeze, once',()=>{
 const beat=new Heartbeat(10000,1500),job=real('a',{phase:'copying',completed:3});
 for(let t=0;t<=12000;t+=500)beat.sample(pulses(state([job])),t);
 assert.equal(beat.freezes.length,1);
 assert.match(beat.freezes[0]!.key,/job/);
});

test('a counter that keeps moving never freezes, and finished or held jobs are not watched',()=>{
 const beat=new Heartbeat(10000,1500),job=real('a',{phase:'copying',completed:0}),held=real('b',{phase:'discovering'}),done=real('c',{phase:'complete'});
 for(let t=0;t<=30000;t+=500){job.progress!.completed++;beat.sample(pulses(state([job,held,done]),new Set([held.id])),t);}
 assert.deepEqual(beat.freezes,[]);
});

test('a file name or share change counts as movement; a stopping job is not watched',()=>{
 const beat=new Heartbeat(10000,1500),job=real('a',{phase:'verifying'}),stopping={...real('b',{phase:'copying'}),stopping:'stop' as const};
 for(let t=0;t<=20000;t+=1000){job.progress!.file=`file-${t}.jpg`;beat.sample(pulses(state([job,stopping])),t);}
 assert.deepEqual(beat.freezes,[]);
});

test('synthetic jobs injected by checks are never watched',()=>{
 const beat=new Heartbeat(10000,1500),job=syntheticJob('a',{phase:'copying'});
 for(let t=0;t<=20000;t+=500)beat.sample(pulses(state([job])),t);
 assert.deepEqual(beat.freezes,[]);
});

test('a blocked main thread counts as frozen time: a long gap between samples is a freeze, and is totalled as starved',()=>{
 const beat=new Heartbeat(10000,1500),job=real('a',{phase:'copying'});
 beat.sample(pulses(state([job])),0);beat.sample(pulses(state([job])),20000);
 assert.equal(beat.freezes.length,1);
 assert.equal(beat.starved,20000);
});

test('a counter that moved across a long gap is not frozen',()=>{
 const beat=new Heartbeat(10000,1500),job=real('a',{phase:'copying',completed:1});
 beat.sample(pulses(state([job])),0);job.progress!.completed++;beat.sample(pulses(state([job])),20000);
 assert.deepEqual(beat.freezes,[]);
});

test('reviews, scans, duplicate scans, leftover checks, the recovery list and recovery size are watched too',()=>{
 const keys=pulses(state([],{busyReview:true,scanningSources:['s'],duplicates:{scopes:[],status:'scanning',revision:0,groups:0,files:0},residue:{files:0,bytes:0,resumable:{files:0,bytes:0},checking:true},organizationRecoveryLoading:true,recoverySize:{root:'/r',id:'x'}})).map(item=>item.key);
 assert.deepEqual(keys,['review','scan s','duplicates','leftover files','recovery list','recovery size']);
 assert.deepEqual(pulses(state([],{organizationRecoveryLoading:true,organizationRecoveryPaused:true})),[],'a paused listing is waiting, not stuck');
});

test('grouped error jobs carry fifty thousand grouped errors with paths capped per group',()=>{
 const jobs=groupedErrorJobs(50000);
 assert.equal(jobs.reduce((sum,job)=>sum+job.groups!.reduce((n,group)=>n+group.count,0),0),50000);
 assert.ok(jobs.every(job=>job.phase==='error'&&job.id.startsWith('qa:')&&job.groups!.every(group=>group.items.length<=200)));
});
