import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPreferences,normalizePreferences} from '../preferences';

test('saved settings and live changes pass through the same rules',()=>{
 const loaded=normalizePreferences({textScale:9,parallel:'17',language:'fr',copyMode:'raid',backupMode:'x',verifyCopies:0,autoOrganizeBackup:'sometimes',unknownDefault:'never',sourceLayout:'table'});
 assert.equal(loaded.textScale,2);assert.equal(loaded.parallel,10);
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

test('the former media-type switch becomes a media layout',()=>{
 assert.equal(normalizePreferences({separateMedia:true}).mediaLayout,'format');
 // The old switch was off by default, which never meant a choice: it gets today's default.
 assert.equal(normalizePreferences({separateMedia:false}).mediaLayout,'video-root');
 assert.equal(normalizePreferences({separateMedia:true,mediaLayout:'video-root'}).mediaLayout,'video-root','a saved layout wins');
 assert.equal(normalizePreferences({mediaLayout:'sideways'}).mediaLayout,'video-root');
 assert.equal(normalizePreferences({mediaLayout:'flat'}).mediaLayout,'flat','a layout chosen in Settings is kept');
 assert.equal('separateMedia' in normalizePreferences({layout:'format' as const}),false);
 const current={...defaultPreferences,mediaLayout:'type-format' as const};
 assert.equal(normalizePreferences({...current,mediaLayout:'??'},current).mediaLayout,'type-format');
 assert.equal(defaultPreferences.videoBasePath,'videobackup');assert.equal(defaultPreferences.videoTemplate,'');
});

test('the Import overview is shown unless the user hides it, and the choice persists',()=>{
 assert.equal(defaultPreferences.showDashboard,true);
 const hidden=normalizePreferences({showDashboard:false});
 assert.equal(hidden.showDashboard,false);
 assert.equal(normalizePreferences({showDashboard:'no'},hidden).showDashboard,false,'an invalid value keeps the current choice');
 assert.equal(normalizePreferences(JSON.parse(JSON.stringify(hidden))).showDashboard,false);
});

test('up to ten drives import in parallel, five by default, and a saved choice is kept',()=>{
 assert.equal(defaultPreferences.parallel,5);
 assert.equal(normalizePreferences({}).parallel,5);
 assert.equal(normalizePreferences({parallel:8}).parallel,8);
 assert.equal(normalizePreferences({parallel:2}).parallel,2,'a saved value is not migrated');
 assert.equal(normalizePreferences({parallel:0.2}).parallel,1);
});

test('photos and videos go to separate photobackup and videobackup folders by default',()=>{
 assert.equal(defaultPreferences.mediaLayout,'video-root');
 assert.equal(normalizePreferences(undefined).mediaLayout,'video-root');
 assert.equal(normalizePreferences({}).mediaLayout,'video-root');
});
