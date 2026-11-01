import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {plan,execute,configureOrganizationRecovery} from '../core/index';
import {deleteOriginals,deletableFromSource,libraryDuplicates,plannedLibraryDuplicates,verifiedOriginals} from '../core/originals';
import type {DestinationOutcome} from '../core/destinations';
import {defaultPreferences,normalizePreferences,DUPLICATE_DEFAULTS_VERSION} from '../preferences';
import {duplicateRemovalDefaults,duplicateSetting,freshOrganizeOptions,importDuplicateRemoval,importOperation,reviewConfirmsDeletion,sourcePolicy} from '../run-policy';
import {acceptedPreferences,livePreferences} from '../settings-lock';
import {I18nProvider,languages,createTranslator} from '../renderer/i18n';
import {SettingsPage,DuplicateRemovalChoice,duplicateRemovalText} from '../renderer/RootApp';
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

test('only a drive transfer has its setting tick the review box; a camera import never does',()=>{
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
 assert.equal(duplicateRemovalText(review({operation:'drive',enabled:true,files:3,bytes:9}),t,n),'3 files already in the library will be deleted from Archive after the import');
 assert.equal(duplicateRemovalText(review({operation:'drive',enabled:true,files:0}),t,n),'Drive transfer: none of these files is already in the library');
 assert.equal(duplicateRemovalText(review({operation:'camera',enabled:true,files:5}),t,n),'Camera import: nothing on the camera or card is deleted');
 for(const language of languages)assert.ok(duplicateRemovalText(review({operation:'drive',enabled:true,files:2}),createTranslator(language),n).includes('Archive'),language);
});

const reviewOf=(duplicateRemoval:Review['duplicateRemoval'],kind:Review['kind']='import')=>({kind,duplicateRemoval});
test('a drive transfer review asks once with a box ticked from Settings; a camera import is never asked',()=>{
 const on=normalizePreferences({duplicateDefaultsVersion:1,removeDuplicatesDrive:true,removeDuplicatesCamera:true}),off={...on,removeDuplicatesDrive:false};
 const planned={files:3,bytes:900};
 assert.deepEqual(importDuplicateRemoval('drive',sourcePolicy('import',undefined,on,'drive'),on,planned),{operation:'drive',enabled:true,files:3,bytes:900,remove:true},'ticked by default');
 assert.deepEqual(importDuplicateRemoval('drive',sourcePolicy('import',undefined,off,'drive'),off,planned),{operation:'drive',enabled:false,files:3,bytes:900,remove:false},'setting off: counted, unticked');
 assert.equal(importDuplicateRemoval('drive',sourcePolicy('import',undefined,on,'drive'),on,{files:0,bytes:0}).remove,false,'nothing to delete: nothing to tick');
 const camera=importDuplicateRemoval('camera',sourcePolicy('import',undefined,on,'camera'),on,planned);
 assert.equal(camera.remove,undefined);assert.equal(camera.files,0);assert.equal(reviewConfirmsDeletion(reviewOf(camera)),false,'camera setting on: still nothing deleted');
});

test('only a drive transfer review applied with its box ticked lets an import delete; unticked, missing or unreviewed never does',()=>{
 assert.equal(reviewConfirmsDeletion(reviewOf({operation:'drive',enabled:true,files:3,remove:true})),true,'ticked and confirmed');
 assert.equal(reviewConfirmsDeletion(reviewOf({operation:'drive',enabled:true,files:3,remove:false})),false,'the user unticked it');
 assert.equal(reviewConfirmsDeletion(reviewOf({operation:'drive',enabled:true,files:3})),false,'never asked: no box state');
 assert.equal(reviewConfirmsDeletion(reviewOf({operation:'drive',enabled:false,files:3,remove:true})),true,'setting off, ticked by hand for this import');
 assert.equal(reviewConfirmsDeletion(reviewOf({operation:'drive',enabled:true,files:0,remove:true})),false,'nothing was shown to delete');
 assert.equal(reviewConfirmsDeletion(reviewOf(undefined)),false);
 assert.equal(reviewConfirmsDeletion(reviewOf({operation:'drive',enabled:true,files:3,remove:true},'reorganize')),false,'an organization is not an import');
});

test('automatic, queued and unreviewed imports never delete: only applying a review grants it',async()=>{
 // Every run that is not an applied review (Automatic import, Start all selected, queued and retried runs) plans through
 // prepare() and reaches run() with a request; the permission is a field of the plan that applyReview alone sets.
 const main=await fs.readFile(path.join(import.meta.dirname,'..','main.ts'),'utf8');
 const grants=[...main.matchAll(/deleteSourceDuplicates=true/g)];
 assert.equal(grants.length,1,'one place grants the deletion');
 const apply=main.indexOf('async function applyReview(');
 // The function's closing brace, whatever line endings the checkout uses (CRLF on Windows).
 const end=apply+main.slice(apply).search(/\r?\n\}\r?\n/);
 assert.ok(apply>=0&&end>apply&&grants[0]!.index>apply&&grants[0]!.index<end,'and it is applyReview');
 assert.match(main.slice(apply,grants[0]!.index+40),/if\(reviewConfirmsDeletion\(prepared\.review\)\)prepared\.deleteSourceDuplicates=true/);
 const gate=main.indexOf("purpose:'duplicates'");
 assert.equal(main.indexOf("purpose:'duplicates'",gate+1),-1,'one deletion of source duplicates');
 assert.match(main.slice(main.lastIndexOf('if(!reorganize&&',gate),gate),/operation==='drive'&&prepared\.deleteSourceDuplicates===true/,'which needs the grant');
});

test('only photos and videos are ever deleted from a source; other files, hidden files and "._" files stay',async t=>{
 for(const name of ['A.JPG','b.arw','clip.MP4','photo.png','x.heic'])assert.equal(deletableFromSource(path.join('src',name)),true,name);
 for(const name of ['.hidden-note','notes.txt','archive.zip','A.xmp','._A.JPG','.secret.jpg','README'])assert.equal(deletableFromSource(path.join('src',name)),false,name);
 const {folder,root,plans,outcomes}=await reimport(t);
 // Non-media files the same import found already in the library (a Files & folders import copies them too).
 const extra=['notes.txt','.hidden-note','._A.JPG'];
 const sample=[...outcomes.values()][0]![0]!;
 for(const name of extra){
  const from=path.join(folder,'DCIM',name),to=path.join(root,'Other',name),body=name.repeat(20);
  await fs.writeFile(from,body);await fs.mkdir(path.dirname(to),{recursive:true});await fs.writeFile(to,body);
  const sha256=createHash('sha256').update(body).digest('hex');
  plans[0]!.entries.push({id:name,source:from,destination:to,size:body.length,kind:'Other',digest:sha256,skip:true,family:name});
  outcomes.set(from,[{...sample,source:from,destination:to,entryId:name,size:body.length,sha256,disposition:'existing'}]);
 }
 assert.equal(plannedLibraryDuplicates(plans).files,3,'the review counts the photos only');
 const files=libraryDuplicates(outcomes,plans);
 assert.deepEqual(files.map(file=>path.basename(file.source)).sort(),['A.JPG','B.JPG','C.JPG']);
 assert.deepEqual(verifiedOriginals(outcomes,plans).withheld.filter(item=>item.reason==='not-media').map(item=>path.basename(item.source)).sort(),[...extra].sort(),'Delete originals never offers them either');
 // Even handed one directly, the deletion keeps it.
 const forced=[...files,{source:path.join(folder,'DCIM','notes.txt'),size:180,sha256:'0'.repeat(64),destinations:[path.join(root,'Other','notes.txt')]}];
 const result=await deleteOriginals(folder,forced,{purpose:'duplicates'});
 assert.deepEqual(result.deleted.map(item=>path.basename(item.source)).sort(),['A.JPG','B.JPG','C.JPG'],'photos confirmed by the review are deleted');
 assert.deepEqual(result.kept,[{source:forced.at(-1)!.source,reason:'not-media'}]);
 assert.deepEqual((await fs.readdir(path.join(folder,'DCIM'))).sort(),['.hidden-note','D.JPG','._A.JPG','notes.txt'].sort());
});

test('the review shows the box with its count and state, in every language',()=>{
 const review={source:source('folder',{name:'Archive'}),duplicateRemoval:{operation:'drive' as const,enabled:true,files:2,bytes:9,remove:true}};
 const detail='Only photos and videos are deleted, each read again at the source and in the library first. Other files stay.';
 for(const language of languages){
  const render=(value:Pick<Review,'source'|'duplicateRemoval'>)=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(DuplicateRemovalChoice,{review:value,act:()=>{}})}));
  const ticked=render(review),unticked=render({...review,duplicateRemoval:{...review.duplicateRemoval,remove:false}});
  assert.match(ticked,/data-testid="review-duplicates-choice"/);assert.ok(ticked.includes('Archive'),language);
  assert.match(ticked,/checked=""/,language);assert.doesNotMatch(unticked,/checked=""/,language);
  if(language!=='en')assert.notEqual(createTranslator(language)(detail),detail,language);
 }
 const camera=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(DuplicateRemovalChoice,{review:{...review,duplicateRemoval:{operation:'camera',enabled:true,files:0}},act:()=>{}})}));
 assert.equal(camera,'','a camera import is never asked');
});
