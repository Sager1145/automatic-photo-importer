import test from 'node:test';
import assert from 'node:assert/strict';
import {keepAwake,type Blocker} from '../keep-awake';
import type {Job} from '../shared';

function fake(){const started=new Set<number>();let next=1;const calls:string[]=[];
 const blocker:Blocker={start(type){calls.push(`start ${type}`);started.add(next);return next++;},stop(id){calls.push(`stop ${id}`);started.delete(id);},isStarted:id=>started.has(id)};
 return {blocker,calls,started};}
const job=(phase:Job['phase'])=>({id:phase,phase} as Job);

test('the display stays awake from the first queued job until every job has settled',()=>{
 const {blocker,calls,started}=fake(),update=keepAwake(blocker);
 update([]);assert.deepEqual(calls,[]);
 update([job('queued')]);update([job('copying'),job('queued')]);update([job('verifying')]);
 assert.deepEqual(calls,['start prevent-display-sleep'],'one hold covers the whole run');
 update([job('complete'),job('stopped'),job('error')]);
 assert.deepEqual(calls,['start prevent-display-sleep','stop 1']);assert.equal(started.size,0);
 update([job('complete')]);assert.equal(calls.length,2,'nothing to release twice');
});

test('a hold the system dropped is taken again while work continues',()=>{
 const {blocker,calls,started}=fake(),update=keepAwake(blocker);
 update([job('copying')]);started.clear();update([job('copying')]);
 assert.deepEqual(calls,['start prevent-display-sleep','start prevent-display-sleep']);
});
