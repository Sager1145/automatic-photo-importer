import test from 'node:test';
import assert from 'node:assert/strict';
import {stopOperations} from '../stop-scope';
import type {Job,Source} from '../shared';

const source:Source={id:'card',name:'Card',path:'/card',transport:'storage'};
const job=(id:string,extra:Partial<Job>={}):Job=>({id,source:{...source,id},phase:'copying',backup:false,errors:[],...extra});
function fixture(){
 const jobs=[job('media'),job('backup',{backup:true,phase:'queued'}),job('paused',{phase:'stopped',paused:true}),job('organization',{organization:true}),job('duplicates',{organization:true,source:{...source,id:'duplicates:/library'}}),job('done',{phase:'complete'}),job('failed',{phase:'error'}),job('stopped',{phase:'stopped'})];
 const active=new Map(['media','organization','duplicates'].map(id=>[id,new AbortController()]));
 const originalsControls=new Map([['done',new AbortController()]]),scanControls=new Map([['independent',new AbortController()]]);
 const seen=new Set(['already-seen']),pausing=new Set(['media','organization']);
 const state={review:{id:'review'},scanProgress:{independent:{files:12}},sourceInventories:{independent:{media:12}},duplicates:{status:'scanning'}};
 return {jobs,active,originalsControls,scanControls,seen,pausing,sources:[source],state,discardReview:async()=>{state.review=undefined as never;}};
}
test('Stop imports stops media, backup and paused queue entries while preserving independent work and counters',async()=>{
 const f=fixture(),before=structuredClone(f.state);
 await stopOperations({type:'stop',scope:'imports'},f);
 assert.equal(f.active.get('media')!.signal.aborted,true);
 assert.equal(f.jobs[0].stopping,'stop');
 assert.deepEqual(f.jobs.slice(1,3).map(j=>[j.phase,j.paused]),[['stopped',false],['stopped',false]]);
 for(const id of ['organization','duplicates'])assert.equal(f.active.get(id)!.signal.aborted,false,id);
 assert.equal(f.pausing.has('organization'),true);assert.equal(f.pausing.has('media'),false);
 assert.equal(f.originalsControls.get('done')!.signal.aborted,false);
 assert.equal(f.scanControls.get('independent')!.signal.aborted,false);
 assert.deepEqual(f.state,before);assert.deepEqual([...f.seen],['already-seen']);
 for(const j of f.jobs.slice(3))assert.equal(j.stopping,undefined,j.id);
});
test('legacy Stop all still discards review, aborts scans/originals and marks connected sources seen',async()=>{
 const f=fixture();await stopOperations({type:'stop'},f);
 assert.equal(f.state.review,undefined);assert.equal(f.scanControls.get('independent')!.signal.aborted,true);assert.equal(f.originalsControls.get('done')!.signal.aborted,true);
 for(const control of f.active.values())assert.equal(control.signal.aborted,true);
 assert.deepEqual([...f.seen],['already-seen','card']);
});
test('job-targeted Stop cancels only the named organization and its originals operation',async()=>{
 const f=fixture();f.originalsControls.set('organization',new AbortController());const before=structuredClone(f.state);
 await stopOperations({type:'stop',jobId:'organization'},f);
 assert.equal(f.active.get('organization')!.signal.aborted,true);assert.equal(f.originalsControls.get('organization')!.signal.aborted,true);
 assert.equal(f.active.get('media')!.signal.aborted,false);assert.equal(f.active.get('duplicates')!.signal.aborted,false);assert.equal(f.scanControls.get('independent')!.signal.aborted,false);
 assert.deepEqual(f.state,before);assert.deepEqual([...f.seen],['already-seen']);
});
test('malformed or ambiguous Stop input is rejected before any cancellation',async()=>{
 for(const input of [{type:'stop',scope:'all'},{type:'stop',scope:'imports',jobId:'media'},{type:'stop',jobId:''},{type:'stop',jobId:42},{type:'stop',scope:null}]){
  const f=fixture();await assert.rejects(stopOperations(input as never,f),/Invalid stop/);
  for(const control of [...f.active.values(),...f.scanControls.values(),...f.originalsControls.values()])assert.equal(control.signal.aborted,false);
  assert.ok(f.state.review);assert.deepEqual([...f.seen],['already-seen']);
 }
});

test('an applied organization review tracked outside Job.organization is preserved by Stop imports',async()=>{
 const f=fixture(),reviewed=job('reviewed-library');f.jobs.push(reviewed);f.active.set(reviewed.id,new AbortController());
 await stopOperations({type:'stop',scope:'imports'},{...f,organizationJobIds:new Set([reviewed.id])});
 assert.equal(f.active.get(reviewed.id)!.signal.aborted,false);assert.equal(reviewed.stopping,undefined);
});
test('all running import phases stop, and a job id resembling a scope never widens targeted cancellation',async()=>{
 for(const phase of ['discovering','verifying','copying'] as const){const f=fixture();f.jobs[0].phase=phase;await stopOperations({type:'stop',scope:'imports'},f);assert.equal(f.active.get('media')!.signal.aborted,true,phase);}
 for(const id of ['all','none']){const f=fixture();f.jobs.push(job(id));f.originalsControls.set(id,new AbortController());await stopOperations({type:'stop',jobId:id},f);assert.equal(f.originalsControls.get(id)!.signal.aborted,true);assert.equal(f.originalsControls.get('done')!.signal.aborted,false);}
});
