import { freshOrganizeOptions } from '../run-policy';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createStallWatch} from '../qa/stall-watch';
import type {AppState,Job,Progress} from '../shared';

const progress=(extra:Partial<Progress>={}):Progress=>({phase:'planning',step:'comparing',completed:5,total:100,bytes:0,totalBytes:0,speed:0,file:'a.jpg',...extra});
const job=(phase:Job['phase'],value?:Progress,organization=false):Job=>({id:'j1',source:{id:'s',name:'S',path:'/s',transport:'folder'},phase,errors:[],backup:false,...(organization?{organization:true}:{}),...(value?{progress:value}:{})});
const state=(extra:Partial<AppState>):AppState=>({preferences:{} as AppState['preferences'],sources:[],jobs:[],history:[],platform:'darwin',organizeOptions:freshOrganizeOptions(),...extra});

test('a running job whose progress stays the same for more than 10 s is a stall',()=>{
 const watch=createStallWatch({limitMs:10_000});
 watch.observe(state({jobs:[job('discovering',progress())]}),0);
 watch.observe(state({jobs:[job('discovering',progress())]}),9_000);watch.assertNone();
 watch.observe(state({jobs:[job('discovering',progress())]}),10_500);
 assert.throws(()=>watch.assertNone(),/job j1.*for 1[01] s/);
});

test('any change in completed, bytes, file or share counts as moving',()=>{
 for(const change of [{completed:6},{bytes:1},{file:'b.jpg'},{share:.5}]){
  const watch=createStallWatch({limitMs:10_000});
  watch.observe(state({jobs:[job('copying',progress())]}),0);
  watch.observe(state({jobs:[job('copying',progress(change))]}),8_000);
  watch.observe(state({jobs:[job('copying',progress(change))]}),15_000);
  watch.assertNone();
 }
});

test('a job in a final state, or not yet running, is never a stall',()=>{
 const watch=createStallWatch({limitMs:10_000});
 for(const phase of ['queued','complete','stopped','error'] as const){watch.observe(state({jobs:[job(phase,progress())]}),0);watch.observe(state({jobs:[job(phase,progress())]}),60_000);}
 watch.assertNone();
});

test('the organization listing and a recheck are watched; a paused listing is not',()=>{
 const listing=state({organizationRecoveryLoading:true,organizationRecoveryProgress:progress({step:'records'})});
 const watch=createStallWatch({limitMs:10_000});
 watch.observe(listing,0);watch.observe(listing,11_000);
 assert.match(watch.stalls().map(stall=>stall.what).join(),/organization listing/);
 const paused=createStallWatch({limitMs:10_000});
 const waiting=state({...listing,organizationRecoveryPaused:true});
 paused.observe(waiting,0);paused.observe(waiting,60_000);paused.assertNone();
 const recheck=createStallWatch({limitMs:10_000});
 const checking=state({jobs:[job('verifying',progress({phase:'verifying',step:'history'}),true)]});
 recheck.observe(checking,0);recheck.observe(checking,12_000);
 assert.match(recheck.stalls()[0]!.what,/recheck/);
});

test('progress that ended and starts again is measured from its new start',()=>{
 const watch=createStallWatch({limitMs:10_000});
 watch.observe(state({jobs:[job('verifying',progress())]}),0);
 watch.observe(state({}),9_000);
 watch.observe(state({jobs:[job('verifying',progress())]}),12_000);
 watch.observe(state({jobs:[job('verifying',progress())]}),20_000);
 watch.assertNone();
});
