import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPreferences,normalizePreferences} from '../preferences';
import {acceptedPreferences,jobPreferences,lockedPreferenceKeys} from '../settings-lock';

test('saved settings and live changes pass through the same rules',()=>{
 const loaded=normalizePreferences({textScale:9,parallel:'17',language:'fr',copyMode:'raid',backupMode:'x',verifyCopies:0,autoOrganizeBackup:'auto',unknownDefault:'never',sourceLayout:'table'});
 assert.equal(loaded.textScale,2);assert.equal(loaded.parallel,10);
 assert.equal(loaded.language,'en');assert.equal(loaded.copyMode,'single');assert.equal(loaded.backupMode,'additive');
 assert.equal(loaded.verifyCopies,true,'only an explicit false turns verification off');
 assert.ok(!('autoOrganizeBackup' in loaded),'retired: the folder check is a button, not a setting');assert.ok(!('autoOrganizeBackup' in defaultPreferences));assert.ok(!jobPreferences.has('autoOrganizeBackup'));assert.equal(loaded.unknownDefault,'skip');assert.equal(loaded.sourceLayout,'list');
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
 const result=normalizePreferences({destinations:['/Volumes/A/photos','/Volumes/B/photos'],destinationIds:[null,'UUID-B'],videoDestinations:['/Volumes/C/videos',7],videoDestinationIds:['UUID-C']});
 assert.deepEqual(result.destinations,['/Volumes/A/photos','/Volumes/B/photos']);
 assert.deepEqual(result.destinationIds,['','UUID-B'],'destination 2 keeps its identity');
 assert.deepEqual(result.videoDestinations,['/Volumes/C/videos','']);
 assert.deepEqual(result.videoDestinationIds,['UUID-C']);
});

test('settings saved with a drive and two folder names become the photo and video folders they named',()=>{
 const saved=normalizePreferences({destinations:['/Volumes/A','/Volumes/B'],destinationIds:['UUID-A','UUID-B'],basePath:'backup/photos',videoBasePath:'clips'});
 assert.deepEqual(saved.destinations,['/Volumes/A/backup/photos','/Volumes/B/backup/photos']);
 assert.deepEqual(saved.destinationIds,['UUID-A','UUID-B']);
 assert.deepEqual(saved.videoDestinations,['/Volumes/A/clips','/Volumes/B/clips'],'each video folder stays on its drive');
 assert.deepEqual(saved.videoDestinationIds,['UUID-A','UUID-B']);
 const defaults=normalizePreferences({destinations:['/Volumes/A'],destinationIds:['UUID-A']});
 assert.deepEqual([defaults.destinations,defaults.videoDestinations],[['/Volumes/A/photobackup'],['/Volumes/A/videobackup']],'the names older versions used by default');
 assert.deepEqual(normalizePreferences({destinations:['/Volumes/A'],basePath:''}).destinations,['/Volumes/A'],'an empty backup folder was the drive itself');
 assert.equal('basePath' in saved,false);
 // Saved again, the folders are kept as they are.
 assert.deepEqual(normalizePreferences(JSON.parse(JSON.stringify(saved))).destinations,saved.destinations);
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
 assert.deepEqual(defaultPreferences.videoDestinations,[]);assert.equal(defaultPreferences.videoTemplate,'');
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

test('the log level defaults to normal, persists, rejects unknown values, and is never locked by a running job',()=>{
 assert.equal(defaultPreferences.logLevel,'normal');
 assert.equal(normalizePreferences({}).logLevel,'normal');
 for(const level of ['off','normal','detailed','trace'] as const)assert.equal(normalizePreferences(JSON.parse(JSON.stringify({logLevel:level}))).logLevel,level);
 const detailed=normalizePreferences({logLevel:'detailed'});
 assert.equal(normalizePreferences({logLevel:'verbose'},detailed).logLevel,'detailed','an invalid value keeps the current choice');
 assert.equal(normalizePreferences({logLevel:7}).logLevel,'normal');
 assert.deepEqual(lockedPreferenceKeys({logLevel:'trace'}),[]);
 assert.deepEqual(acceptedPreferences({logLevel:'trace'},true),{logLevel:'trace'},'applies while jobs run');
});

test('unknown files default to a folder; a saved keep or fileDate stays, an invalid value falls back',()=>{
 assert.equal(defaultPreferences.noMetadataHandling,'folder');
 const bare={...defaultPreferences} as Record<string,unknown>;delete bare.noMetadataHandling;
 assert.equal(normalizePreferences({},bare as never).noMetadataHandling,'folder');
 assert.equal(normalizePreferences({noMetadataHandling:'bogus'},bare as never).noMetadataHandling,'folder');
 for(const mode of ['keep','fileDate'] as const)assert.equal(normalizePreferences({noMetadataHandling:mode},defaultPreferences).noMetadataHandling,mode);
});

test('eject and delete-original settings default safely and ignore invalid values',()=>{
 assert.equal(defaultPreferences.autoEject,false);assert.equal(defaultPreferences.deleteOriginalsFolders,true);assert.equal(defaultPreferences.deleteOriginalsCards,false);
 const loaded=normalizePreferences({autoEject:'yes',deleteOriginalsFolders:0,deleteOriginalsCards:1});
 assert.deepEqual([loaded.autoEject,loaded.deleteOriginalsFolders,loaded.deleteOriginalsCards],[false,true,false]);
 const set=normalizePreferences({autoEject:true,deleteOriginalsFolders:false,deleteOriginalsCards:true});
 assert.deepEqual([set.autoEject,set.deleteOriginalsFolders,set.deleteOriginalsCards],[true,false,true]);
 assert.equal(normalizePreferences({autoEject:'x'},set).autoEject,true,'an invalid value keeps the current one');
 const patch={autoEject:true,deleteOriginalsCards:true,deleteOriginalsFolders:false};
 assert.deepEqual(acceptedPreferences(patch,true),patch,'these apply even while jobs run');
});
