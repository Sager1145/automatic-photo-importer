import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsLocked, lockedPreferenceKeys } from '../settings-lock';
import type { Job } from '../shared';

const job=(phase:Job['phase'],extra:Partial<Job>={}):Job=>({id:phase,source:{id:'s',name:'Card',path:'/Volumes/Card',transport:'storage'},phase,detail:{key:'job.stopped'},errors:[],backup:false,...extra} as Job);
const state=(jobs:Job[],extra={})=>({jobs,...extra});

test('job settings are unlocked only when nothing is running, queued, paused or under review',()=>{
 assert.equal(settingsLocked(state([])),false);
 assert.equal(settingsLocked(state([job('complete'),job('error'),job('stopped')])),false);
 for(const phase of ['discovering','verifying','copying','queued'] as const)assert.equal(settingsLocked(state([job(phase)])),true,phase);
});

test('a paused job keeps its settings locked until it is stopped completely',()=>{
 assert.equal(settingsLocked(state([job('stopped',{paused:true})])),true);
});

test('an open review, a review being built or a source scan locks job settings',()=>{
 assert.equal(settingsLocked(state([],{review:{}})),true);
 assert.equal(settingsLocked(state([],{busyReview:true})),true);
 assert.equal(settingsLocked(state([],{scanningSources:['s']})),true);
 assert.equal(settingsLocked(state([],{scanningSources:[]})),false);
});

test('only settings a job depends on are locked; display and queue settings never are',()=>{
 assert.deepEqual(lockedPreferenceKeys({template:'{year}',language:'ja',parallel:3,mediaLayout:'flat'}),['template','mediaLayout']);
 assert.deepEqual(lockedPreferenceKeys({language:'ja',textScale:1.5,automatic:true}),[]);
});
