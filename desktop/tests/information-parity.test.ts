import { freshOrganizeOptions } from '../run-policy';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ActivityJobs,EjectAll,ImportDesk,OrganizationRecoveryPanel,SidebarSources} from '../renderer/RootApp';
import {I18nProvider,createTranslator,languages} from '../renderer/i18n';
import {defaultPreferences} from '../preferences';
import type {AppState,Inventory,Job,Source} from '../shared';
import {withFigures} from '../core/inventory';

const source:Source={id:'card',name:'Camera card',path:'/card',transport:'storage',total:100e9,free:40e9,selected:true};
const inventory:Inventory=withFigures({files:[{path:'/card/PHOTO.NEF',relative:'PHOTO.NEF',size:24e6,kind:'RAW',included:true}],media:1,companions:0,unknown:0,unknownExtensions:{},bytes:24e6,elapsedMs:10});
const job:Job={id:'queued',source,phase:'queued',backup:true,errors:[],inventory};
const state:AppState={preferences:{...defaultPreferences,destinations:['/backup']},sources:[source],jobs:[job],history:[],platform:'darwin',organizeOptions:freshOrganizeOptions(),queueOrder:['other','queued'],sourceInventories:{card:inventory},driveActivity:{card:{utilization:37,readBps:10e6,writeBps:2e6,iops:5,history:[20,37]}},sourceCameraInfo:{card:{status:'complete',hints:[],checked:1,total:1,unknown:0,models:[{name:'Nikon Z6III',files:1,bytes:24e6}],lenses:[{name:'24–70 mm',files:1,bytes:24e6}]}}};
const render=(language:typeof languages[number],children:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language,children}));

const escape=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
test('Import retains visible stage and capacity information and backup media scanning',()=>{
 for(const language of languages){
  const t=createTranslator(language),markup=render(language,createElement(ImportDesk,{state,mode:'files',act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}));
  const card=markup.split('<article data-source-id="card"')[1]?.split('</article>')[0]??'';
  assert.match(card.split('<details class="source-disclosure"')[0]??'',/data-testid="source-steps"/,'stages remain outside the disclosure');
  const summary=(card.split('<details class="source-disclosure"')[1]??'').match(/<summary[^>]*>[\s\S]*?<\/summary>/)?.[0]??'';
  assert.match(summary,/data-testid="storage-capacity"/);assert.doesNotMatch(summary,/<summary[^>]*hidden/);
  for(const text of [t('Queue position {count}',{count:2}),t('Scan media'),t('Drive details'),'37%'])assert.ok(card.includes(text),`${language}: ${text}`);
  const parallel=markup.match(/<span[^>]*data-testid="parallel-summary"[^>]*>/)?.[0]??'';assert.ok(parallel.includes(escape(t('Current copies finish before a lower limit takes effect.'))),`${language}: lower-limit note`);assert.ok(markup.includes(escape(t('Drives at once: {count}/10',{count:state.preferences.parallel}))),`${language}: drives at once`);
  assert.match(markup,/data-testid="parallel-summary"/);assert.match(markup,/class="import-dashboard"/);assert.doesNotMatch(markup,/class="workspace-details import-overview"/);
 }
});

test('The Queue lists each job compactly and leaves inventory, camera and drive details to the Import card',()=>{
 for(const language of languages){
  const t=createTranslator(language),markup=render(language,createElement(ActivityJobs,{state,act:()=>{},onShow:()=>{}}));
  for(const text of [t('Queue position {count}',{count:2}),'Camera card',t('Show')])assert.ok(markup.includes(escape(text)),`${language}: ${text}`);
  assert.match(markup,/class="queue-row/);assert.doesNotMatch(markup,/class="inventory-panel"|class="source-row|source-steps/);
 }
});

test('duplicate recovery displays its library path when Activity combines roots',()=>{
 const value={...state,organizationRecovery:[{id:'removed',kind:'duplicates' as const,root:'/backup/another-library',status:'complete' as const,files:4,completed:4,retainedFiles:4,retainedBytes:100,undoable:true}]};
 assert.match(render('en',createElement(OrganizationRecoveryPanel,{state:value,act:()=>{},busy:false})),/class="recovery-root">\/backup\/another-library</);
});


test('The Import card keeps the completed run snapshot after an independent rescan',()=>{
 const newer:Inventory={...inventory,files:[{...inventory.files[0]!,path:'/card/LATER-SCAN.NEF',relative:'LATER-SCAN.NEF'}]};
 const markup=render('en',createElement(ImportDesk,{state:{...state,sourceInventories:{card:newer}},mode:'files',act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}));
 assert.match(markup,/PHOTO.NEF/);assert.doesNotMatch(markup,/LATER-SCAN.NEF/);
});

test('drives and folders offer Eject or Remove from app, and Eject all done counts finished ones, in every language',()=>{
 const folder:Source={id:'folder',name:'Shoot',path:'/shoot',transport:'folder',selected:true};
 const done:Job={id:'done',source,phase:'complete',backup:true,errors:[]},folderDone:Job={id:'folder-done',source:folder,phase:'complete',backup:true,errors:[]};
 const finished:AppState={...state,sources:[source,folder],jobs:[done,folderDone],queueOrder:[]};
 for(const language of languages){
  const t=createTranslator(language);
  const desk=render(language,createElement(ImportDesk,{state:finished,mode:'files',act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}));
  const card=desk.split('<article data-source-id="card"')[1]?.split('</article>')[0]??'',row=desk.split('<article data-source-id="folder"')[1]?.split('</article>')[0]??'';
  assert.ok(card.includes(`aria-label="${escape(t('Eject'))}: Camera card"`),`${language}: drive Eject`);
  assert.ok(row.includes(`aria-label="${escape(t('Remove from app'))}: Shoot"`),`${language}: folder Remove from app`);
  assert.match(desk,/data-testid="eject-all"[^>]*>[\s\S]*?2/,`${language}: Eject all done count`);
  assert.ok(desk.includes(escape(t('Eject all done ({count})',{count:'2'}))),`${language}: Eject all done label`);
  assert.match(render(language,createElement(SidebarSources,{state:finished,onOpen:()=>{},act:()=>{}})),/data-testid="eject-source"/);
 }
 const busy=render('en',createElement(ImportDesk,{state:{...finished,jobs:[{...done,phase:'copying'},folderDone]},mode:'files',act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}));
 assert.match(busy.split('<article data-source-id="card"')[1]!.split('</article>')[0]!,/<button[^>]*data-testid="eject-source"[^>]*disabled/,'disabled while the drive is in use');
 assert.match(busy,/Eject all done \(1\)/,'a busy drive is not counted');
 const none=render('en',createElement(ImportDesk,{state,mode:'files',act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}));
 assert.doesNotMatch(none,/data-testid="eject-all"/,'hidden when nothing is done');
 assert.match(render('en',createElement(EjectAll,{sources:[source,folder],act:()=>{}})),/Eject all done \(2\)/);
});

test('eject confirmations and settings carry text in every language',()=>{
 for(const language of languages){
  const t=createTranslator(language);
  for(const key of ['Eject {name}?','Remove {name} from the app?','The folder and its files stay where they are.','Ejected drives can be unplugged safely.','Eject drives automatically after a clean import','Offer for folders','Offer for SD cards and drives','Eject all done ({count})'])
   if(language!=='en')assert.notEqual(t(key,{name:'X',count:1}),key.replace('{name}','X').replace('{count}','1'),`${language}: ${key}`);
 }
});
