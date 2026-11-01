import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {plan,execute,configureOrganizationRecovery} from '../core/index';
import {deleteOriginals,libraryDuplicates,plannedLibraryDuplicates} from '../core/originals';
import type {DestinationOutcome} from '../core/destinations';
import {defaultPreferences,normalizePreferences,DUPLICATE_DEFAULTS_VERSION} from '../preferences';
import {duplicateRemovalDefaults,duplicateSetting,freshOrganizeOptions,importOperation,sourcePolicy} from '../run-policy';
import {acceptedPreferences,livePreferences} from '../settings-lock';
import {I18nProvider,languages,createTranslator} from '../renderer/i18n';
import {SettingsPage,duplicateRemovalText} from '../renderer/RootApp';
import type {AppState,Metadata,Review,Source} from '../shared';

configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');

test('Remove confirmed duplicates defaults: on for library organization and drive transfers, off for camera imports',()=>{
 assert.deepEqual({...duplicateRemovalDefaults},{organize:true,drive:true,camera:false});
 for(const prefs of [defaultPreferences,normalizePreferences(undefined),normalizePreferences({})]){
  assert.equal(prefs.removeDuplicatesOrganize,true);assert.equal(prefs.removeDuplicatesDrive,true);assert.equal(prefs.removeDuplicatesCamera,false);
  assert.equal(duplicateSetting(prefs,'organize'),true);assert.equal(duplicateSetting(prefs,'drive'),true);assert.equal(duplicateSetting(prefs,'camera'),false);
 }
 assert.equal(duplicateSetting(undefined,'drive'),true,'no settings: the default');
 assert.equal(freshOrganizeOptions().releaseDuplicates,true);
 assert.equal(freshOrganizeOptions({removeDuplicatesOrganize:false}).releaseDuplicates,false,'the Organize page starts from the setting');
 assert.equal(freshOrganizeOptions({removeDuplicatesOrganize:false}).removeEmptyFolders,true);
});

test('settings from before the per-run-kind switches get the new defaults once, whatever they held; a later choice is kept',()=>{
 // The old organization switch saved off (its old default), the old per-run choice was never saved: both give today's defaults.
 for(const old of [{releaseDuplicatesAfterOrganizing:false},{releaseDuplicatesAfterOrganizing:true},{removeDuplicatesDrive:false,removeDuplicatesOrganize:false,removeDuplicatesCamera:true},{}]){
  const migrated=normalizePreferences({...old,copyMode:'mirror'});
  assert.equal(migrated.copyMode,'mirror','the rest of the file loads');
  assert.deepEqual([migrated.removeDuplicatesOrganize,migrated.removeDuplicatesDrive,migrated.removeDuplicatesCamera],[true,true,false],JSON.stringify(old));
  assert.equal(migrated.duplicateDefaultsVersion,DUPLICATE_DEFAULTS_VERSION);
  assert.equal(Object.hasOwn(migrated,'releaseDuplicatesAfterOrganizing'),false);
 }
 // The user turns two off after updating: the interface sends a change on top of the loaded settings.
 const loaded=normalizePreferences({releaseDuplicatesAfterOrganizing:false});
 const changed=normalizePreferences({...loaded,...acceptedPreferences({removeDuplicatesDrive:false,removeDuplicatesOrganize:false,removeDuplicatesCamera:true},true)},loaded);
 assert.deepEqual([changed.removeDuplicatesOrganize,changed.removeDuplicatesDrive,changed.removeDuplicatesCamera],[false,false,true],'live settings: applied even while work runs');
 // Saved and read back (JSON, as settings.json), the choice holds: the migration does not run again.
 const reread=normalizePreferences(JSON.parse(JSON.stringify(changed)));
 assert.deepEqual([reread.removeDuplicatesOrganize,reread.removeDuplicatesDrive,reread.removeDuplicatesCamera],[false,false,true]);
 assert.equal(reread.duplicateDefaultsVersion,DUPLICATE_DEFAULTS_VERSION);
 // A malformed value keeps the saved one.
 assert.equal(normalizePreferences({removeDuplicatesDrive:'no'},changed).removeDuplicatesDrive,true,'no version: today\'s default');
 assert.equal(normalizePreferences({...changed,removeDuplicatesDrive:'no'},changed).removeDuplicatesDrive,false);
 for(const key of ['removeDuplicatesOrganize','removeDuplicatesDrive','removeDuplicatesCamera'])assert.ok(livePreferences.has(key),key);
});

const source=(transport:Source['transport'],extra:Partial<Source>={}):Source=>({id:transport,name:transport,path:'/x',transport,...extra});
test('camera imports are USB cameras and camera cards; every other import is a drive transfer',()=>{
 assert.equal(importOperation(source('folder'),false),'drive');
 assert.equal(importOperation(source('folder',{backup:true}),false),'drive');
 assert.equal(importOperation(source('folder'),true),'camera','a folder whose files are on a camera card (or reached through a link to one)');
 assert.equal(importOperation(source('camera'),false),'camera','a USB camera (MTP/PTP)');
 assert.equal(importOperation(source('storage'),false),'camera','a card in a reader, or removable flash');
 assert.equal(importOperation(source('storage',{camera:true,backup:true}),false),'camera','a card in Files & folders mode is still camera media');
 assert.equal(importOperation(source('folder',{drive:{volumeId:'v',name:'SD',mount:'/media/sd',kind:'card'}}),false),'camera');
});

test('only a drive transfer with its setting on deletes source duplicates; a camera import never does',()=>{
 const on=normalizePreferences({duplicateDefaultsVersion:1,removeDuplicatesDrive:true,removeDuplicatesCamera:true});
 assert.equal(sourcePolicy('import',undefined,on,'drive').removeSourceDuplicates,true);
 assert.equal(sourcePolicy('import',undefined,on,'camera').removeSourceDuplicates,false,'the camera setting on still deletes nothing on a camera');
 assert.equal(sourcePolicy('import',undefined,on).removeSourceDuplicates,false,'an import of unknown kind counts as a camera import');
 assert.equal(sourcePolicy('import',undefined,{...on,removeDuplicatesDrive:false},'drive').removeSourceDuplicates,false);
 assert.equal(sourcePolicy('reorganize',undefined,on).removeSourceDuplicates,false);
 const policy=sourcePolicy('import',undefined,on,'drive');
 assert.equal(policy.sourceAction,'copy');assert.equal(policy.releaseDuplicates,false);assert.equal(policy.removeEmptySourceFolders,false);
});

const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{}};
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}});
/** A folder imported once; then a new file is added and it is imported again: three files are already in the library. */
async function reimport(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'source-duplicates-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const folder=path.join(base,'source'),root=path.join(base,'library');await fs.mkdir(path.join(folder,'DCIM'),{recursive:true});await fs.mkdir(root);
 for(const name of ['A','B','C'])await fs.writeFile(path.join(folder,'DCIM',name+'.JPG'),name.repeat(100+name.charCodeAt(0)));
 await execute((await plan(folder,[root],options,metadata)).plans[0]!);
 await fs.writeFile(path.join(folder,'DCIM','D.JPG'),'D'.repeat(300));
 const {plans}=await plan(folder,[root],options,metadata);
 const outcomes=new Map<string,DestinationOutcome[]>();
 await execute(plans[0]!,undefined,undefined,{onFileOutcome:outcome=>{const list=outcomes.get(outcome.source)??[];list.push({...outcome,destinationSlot:0});outcomes.set(outcome.source,list);}});
 return {folder,root,plans,outcomes};
}

test('a drive transfer deletes from the source only the files already in the library, each read again on both sides',async t=>{
 const {folder,plans,outcomes}=await reimport(t);
 assert.equal(plannedLibraryDuplicates(plans).files,3,'the review counts the files already in the library');
 const files=libraryDuplicates(outcomes,plans);
 assert.deepEqual(files.map(file=>path.basename(file.source)).sort(),['A.JPG','B.JPG','C.JPG'],'D was copied by this import: not a duplicate');
 assert.ok(files.every(file=>file.identity===undefined),'a duplicate is always read again at the source');
 // B's library copy changes after the import: it can no longer be matched, so B stays.
 const b=files.find(file=>file.source.endsWith('B.JPG'))!;await fs.writeFile(b.destinations[0]!,'X'.repeat(b.size));
 const result=await deleteOriginals(folder,files,{purpose:'duplicates'});
 assert.deepEqual(result.deleted.map(item=>path.basename(item.source)).sort(),['A.JPG','C.JPG']);
 assert.deepEqual(result.kept.map(item=>[path.basename(item.source),item.reason]),[['B.JPG','destination-differs']]);
 assert.deepEqual((await fs.readdir(path.join(folder,'DCIM'))).sort(),['B.JPG','D.JPG']);
 assert.equal(result.folders,0,'emptied folders are not removed by this');
});

const state=(preferences=defaultPreferences):AppState=>({preferences,sources:[],jobs:[],history:[],platform:'win32',organizeOptions:freshOrganizeOptions(preferences)});
test('Settings shows one switch per kind of run with its default, in every language',()=>{
 for(const language of languages){
  const t=createTranslator(language),markup=renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(SettingsPage,{state:state({...defaultPreferences,language}),act:()=>{},busy:false})}));
  const row=(id:string)=>markup.slice(markup.indexOf(`data-testid="${id}"`),markup.indexOf('</div>',markup.indexOf(`data-testid="${id}"`)));
  for(const id of ['duplicates-organize','duplicates-drive','duplicates-camera'])assert.ok(markup.includes(`data-testid="${id}"`),`${language}: ${id}`);
  assert.match(row('duplicates-organize'),/checked=""/);assert.match(row('duplicates-drive'),/checked=""/);assert.doesNotMatch(row('duplicates-camera'),/checked=""/);
  for(const label of ['Library organization','Drive transfers','Camera imports'])assert.ok(markup.includes(t(label)),`${language}: ${label}`);
  if(language!=='en')assert.notEqual(t('Camera imports'),'Camera imports',`${language} is translated`);
 }
});

test('the import review says which setting applies and what it deletes',()=>{
 const t=createTranslator('en'),n=(value:number)=>String(value);
 const review=(duplicateRemoval:Review['duplicateRemoval'])=>({source:source('folder',{name:'Archive'}),duplicateRemoval});
 assert.equal(duplicateRemovalText(review({operation:'drive',enabled:true,files:3,bytes:9}),t,n),'Drive transfer: 3 source files already in the library will be deleted from Archive after a clean import');
 assert.equal(duplicateRemovalText(review({operation:'drive',enabled:true,files:0}),t,n),'Drive transfer: none of these files is already in the library');
 assert.equal(duplicateRemovalText(review({operation:'drive',enabled:false}),t,n),'Drive transfer: files already in the library stay on the source');
 assert.equal(duplicateRemovalText(review({operation:'camera',enabled:true,files:5}),t,n),'Camera import: nothing on the camera or card is deleted');
 for(const language of languages)assert.ok(duplicateRemovalText(review({operation:'drive',enabled:true,files:2}),createTranslator(language),n).includes('Archive'),language);
});
