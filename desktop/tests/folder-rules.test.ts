import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {gzipSync} from 'node:zlib';
import {plan} from '../core/index';
import {checkFolderSettings,ruleOptions,rulesScope} from '../routing-options';
import {validFolderName} from '../folder-template';
import {validNoMetadataFolder} from '../no-metadata';
import {routingChanged,rememberRouting} from '../platform/routing-memory';
import {loadPlacement,placementId,rememberEntries} from '../platform/placement-memory';
import {libraryRoots} from '../platform/destination-roots';
import {defaultPreferences} from '../preferences';
import {MessageError} from '../messages';
import type {Metadata,Preferences} from '../shared';

const prefs:Preferences={...defaultPreferences,unknownRules:{}};
async function temporary(t:test.TestContext){const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'folder-rules-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));return base;}

test('one rules scope: every rule that decides a folder changes it, folders a layout does not use do not',()=>{
  const scope=rulesScope(ruleOptions(prefs));
  assert.equal(rulesScope(ruleOptions({...prefs})),scope);
  for(const changed of [{template:'{camera}'},{mediaLayout:'flat' as const},{videoTemplate:'{year}'},{editedFolder:'Finished'},{noMetadataHandling:'keep' as const},{noMetadataFolder:'Other'},{unknownRules:{dat:'other' as const}},{unknownDefault:'other' as const}])
    assert.notEqual(rulesScope(ruleOptions({...prefs,...changed})),scope,JSON.stringify(changed));
  assert.notEqual(rulesScope(ruleOptions(prefs,true)),scope);
  const elsewhere:Preferences={...prefs,mediaLayout:'format',videoBasePath:'elsewhere'};
  assert.equal(rulesScope(ruleOptions(elsewhere)),rulesScope(ruleOptions({...prefs,mediaLayout:'format'})));
});

test('routing and placement memories miss when only the unknown-file rules change',async t=>{
  const store=await temporary(t),root=path.join(store,'library');await fs.mkdir(root);
  const before=rulesScope(ruleOptions(prefs)),after=rulesScope(ruleOptions({...prefs,unknownRules:{dat:'other'}}));
  await rememberRouting(store,['a'],before);
  assert.equal(await routingChanged(store,['a'],before),false);
  assert.equal(await routingChanged(store,['a'],after),true);
  await fs.writeFile(path.join(root,'A.JPG'),'bytes');
  const id=placementId('volume',root);
  await rememberEntries(store,id,before,root,[root],[{destination:path.join(root,'A.JPG'),size:5}]);
  assert.equal((await loadPlacement(store,id,before))?.size,1);
  assert.equal(await loadPlacement(store,id,after),undefined);
});

test('a placement memory written under the earlier scope formula misses once',async t=>{
  const store=await temporary(t),id=placementId('volume','/library');
  // The formula before one rules scope: the folder rules and the backup folder names, without the unknown-file rules.
  const {createHash}=await import('node:crypto');
  const r=ruleOptions(prefs),old=createHash('sha256').update(JSON.stringify([r.template,r.layout,r.videoTemplate??'',r.editedFolder??'',['photobackup'],r.noMetadata,r.noMetadataFolder])).digest('hex').slice(0,32);
  await fs.mkdir(path.join(store,'placement-memory'),{recursive:true});
  await fs.writeFile(path.join(store,'placement-memory',`${id}.json.gz`),gzipSync(JSON.stringify({v:5,kind:'placement',scope:old,dirs:[''],d:[0],n:['A.JPG'],s:[5],m:['1'],i:['2']})));
  assert.notEqual(rulesScope(r),old);
  assert.equal(await loadPlacement(store,id,rulesScope(r)),undefined);
});

test('remembered entries count only files beneath a library root, not the root itself',async t=>{
  const store=await temporary(t),root=path.join(store,'library');await fs.mkdir(root);
  await fs.writeFile(path.join(root,'A.JPG'),'bytes');await fs.writeFile(path.join(store,'B.JPG'),'bytes');
  const id=placementId('volume',root),scope=rulesScope(ruleOptions(prefs));
  await rememberEntries(store,id,scope,root,[root],[{destination:path.join(root,'A.JPG'),size:5},{destination:path.join(store,'B.JPG'),size:5},{destination:root,size:0}]);
  assert.deepEqual([...(await loadPlacement(store,id,scope))!.keys()],['A.JPG']);
});

test('library roots: one per backup folder, the video one only in the video-root layout',()=>{
  assert.deepEqual(libraryRoots('/Volumes/A',{...prefs,basePath:'photos',mediaLayout:'format',videoBasePath:'videos'}),['/Volumes/A/photos']);
  assert.deepEqual(libraryRoots('/Volumes/A',{...prefs,basePath:'photos',mediaLayout:'video-root',videoBasePath:'videos'}),['/Volumes/A/photos','/Volumes/A/videos']);
  assert.deepEqual(libraryRoots('/Volumes/A',{...prefs,basePath:'',mediaLayout:'format'}),['/Volumes/A']);
});

test('one folder name rule: unknown-files folder and edited folder share it',()=>{
  for(const bad of ['','CON','a/b','..','x.','{camera}',' x','a:b','nul.txt'])assert.equal(validFolderName(bad),false,bad);
  for(const good of ['Finished','editied','Unknown files','Résumé','Re\u0301sume\u0301'])assert.equal(validFolderName(good),true,good);
  assert.equal(validNoMetadataFolder('CON'),false);assert.equal(validNoMetadataFolder('Unsorted'),true);
});

test('folder names are checked when saved: what saves can be planned',()=>{
  const error=(changed:Partial<Preferences>)=>{try{checkFolderSettings({...prefs,...changed});return undefined;}catch(thrown){assert.ok(thrown instanceof MessageError);return thrown.key;}};
  assert.equal(error({}),undefined);
  assert.equal(error({mediaLayout:'format',basePath:''}),undefined,'an empty backup folder is the destination itself');assert.equal(error({basePath:'backups/photos'}),undefined);
  assert.equal(error({basePath:'../out'}),'error.backupFolderPath');assert.equal(error({basePath:'CON'}),'error.backupFolderPath');assert.equal(error({basePath:'Photo Importer Data'}),'error.backupFolderPath');
  assert.equal(error({mediaLayout:'video-root',videoBasePath:'a//b'}),'error.videoFolderPath');
  assert.equal(error({mediaLayout:'video-root',basePath:'photobackup',videoBasePath:'photobackup/videos'}),'error.videoFolderPath','a video folder inside the photo folder');
  assert.equal(error({mediaLayout:'video-root',basePath:'',videoBasePath:'videobackup'}),'error.videoFolderPath','the video layout needs a photo folder');
  assert.equal(error({mediaLayout:'format',videoBasePath:''}),undefined,'a video folder the layout does not use');
  assert.equal(error({editedFolder:'CON'}),'error.editedFolderName');assert.equal(error({editedFolder:'a/b'}),'error.editedFolderName');
  assert.equal(error({noMetadataFolder:'2024'}),'error.noMetadataFolderName');
  assert.equal(error({noMetadataFolder:'Finished',editedFolder:'Finished'}),'error.noMetadataFolderName');
});

test('the planner refuses an unsafe edited folder with the same message the settings show',async t=>{
  const base=await temporary(t),source=path.join(base,'card'),root=path.join(base,'backup');
  await fs.mkdir(source);await fs.mkdir(root);await fs.writeFile(path.join(source,'A.JPG'),'bytes');
  const metadata=async():Promise<Metadata>=>({camera:'Cam',date:'2024-02-03T12:00:00Z',fields:{}});
  await assert.rejects(plan(source,[root],{backup:false as const,template:'{year}/{camera}',layout:'flat',unknownRules:{},editedFolder:'CON'},metadata),(error:unknown)=>error instanceof MessageError&&error.key==='error.editedFolderName');
});
