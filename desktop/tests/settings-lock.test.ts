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

test('the preferences handler drops locked keys while busy, paused or queued, and keeps the stored value', async () => {
  const { acceptedPreferences } = await import('../settings-lock');
  const { normalizePreferences } = await import('../preferences');
  const before = normalizePreferences({ template: '{year}', mediaLayout: 'flat', parallel: 2, language: 'en' });
  const patch = { template: '{camera}', mediaLayout: 'year', parallel: 4, language: 'ja' } as unknown as Partial<typeof before>;
  for (const jobs of [[job('copying')], [job('queued')], [job('stopped', { paused: true })]]) {
    const accepted = acceptedPreferences(patch, settingsLocked(state(jobs)));
    assert.deepEqual(accepted, { parallel: 4, language: 'ja' });
    const after = normalizePreferences({ ...before, ...accepted }, before);
    assert.equal(after.template, before.template);
    assert.equal(after.mediaLayout, before.mediaLayout);
    assert.equal(after.parallel, 4);
  }
  assert.deepEqual(acceptedPreferences(patch, settingsLocked(state([]))), patch);
});
