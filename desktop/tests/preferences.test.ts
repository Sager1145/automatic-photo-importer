import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPreferences,normalizePreferences} from '../preferences';

test('saved settings and live changes pass through the same rules',()=>{
 const loaded=normalizePreferences({textScale:9,parallel:'7',language:'fr',copyMode:'raid',backupMode:'x',verifyCopies:0,autoOrganizeBackup:'sometimes',unknownDefault:'never',sourceLayout:'table'});
 assert.equal(loaded.textScale,2);assert.equal(loaded.parallel,5);
 assert.equal(loaded.language,'en');assert.equal(loaded.copyMode,'single');assert.equal(loaded.backupMode,'additive');
 assert.equal(loaded.verifyCopies,true,'only an explicit false turns verification off');
 assert.equal(loaded.autoOrganizeBackup,'ask');assert.equal(loaded.unknownDefault,'skip');assert.equal(loaded.sourceLayout,'list');
});

test('an invalid change keeps the current value rather than resetting it',()=>{
 const current={...defaultPreferences,language:'ja' as const,parallel:4,copyMode:'mirror' as const};
 const next=normalizePreferences({...current,language:'xx',parallel:'many',copyMode:'??'},current);
 assert.equal(next.language,'ja');assert.equal(next.parallel,4);assert.equal(next.copyMode,'mirror');
 assert.equal(normalizePreferences({...current,parallel:2.6},current).parallel,3);
});

test('remembered and ignored devices keep only well-formed records',()=>{
 const result=normalizePreferences({rememberedDevices:{a:{name:'Card',lastSelected:'2026-10-21'},b:{name:1},c:null},ignoredDevices:{d:{name:'SSD',ignoredAt:'2026-10-21'},e:'x'}});
 assert.deepEqual(Object.keys(result.rememberedDevices!),['a']);assert.deepEqual(Object.keys(result.ignoredDevices!),['d']);
});

test('a missing settings file yields the defaults',()=>{
 assert.deepEqual(normalizePreferences(undefined),defaultPreferences);
});

test('one unreadable destination entry keeps the others and their positions',()=>{
 const result=normalizePreferences({destinations:['/Volumes/A','/Volumes/B'],destinationIds:[null,'UUID-B']});
 assert.deepEqual(result.destinations,['/Volumes/A','/Volumes/B']);
 assert.deepEqual(result.destinationIds,['','UUID-B'],'destination 2 keeps its identity');
});
