import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ActivityJobs,ImportDesk,OrganizationRecoveryPanel} from '../renderer/RootApp';
import {I18nProvider,createTranslator,languages} from '../renderer/i18n';
import {defaultPreferences} from '../preferences';
import type {AppState,Inventory,Job,Source} from '../shared';

const source:Source={id:'card',name:'Camera card',path:'/card',transport:'storage',total:100e9,free:40e9,selected:true};
const inventory:Inventory={files:[{path:'/card/PHOTO.NEF',relative:'PHOTO.NEF',size:24e6,kind:'RAW',included:true}],media:1,companions:0,unknown:0,unknownExtensions:{},bytes:24e6,elapsedMs:10};
const job:Job={id:'queued',source,phase:'queued',backup:true,errors:[],inventory};
const state:AppState={preferences:{...defaultPreferences,destinations:['/backup']},sources:[source],jobs:[job],history:[],platform:'darwin',queueOrder:['other','queued'],sourceInventories:{card:inventory},driveActivity:{card:{utilization:37,readBps:10e6,writeBps:2e6,iops:5,history:[20,37]}},sourceCameraInfo:{card:{status:'complete',hints:[],checked:1,total:1,unknown:0,models:[{name:'Nikon Z6III',files:1,bytes:24e6}],lenses:[{name:'24–70 mm',files:1,bytes:24e6}]}}};
const render=(language:typeof languages[number],children:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language,children}));

const escape=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
test('Import retains visible stage and capacity information and backup media scanning',()=>{
 for(const language of languages){
  const t=createTranslator(language),markup=render(language,createElement(ImportDesk,{state,mode:'files',act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}));
  const card=markup.split('<article data-source-id="card"')[1]?.split('</article>')[0]??'';
  assert.match(card.split('<details')[0]??'',/data-testid="source-steps"/,'stages remain outside the disclosure');
  const summary=card.match(/<summary[^>]*>[\s\S]*?<\/summary>/)?.[0]??'';
  assert.match(summary,/data-testid="storage-capacity"/);assert.doesNotMatch(summary,/<summary[^>]*hidden/);
  for(const text of [t('Queue position {count}',{count:2}),t('Scan media'),t('Drive details'),'37%'])assert.ok(card.includes(text),`${language}: ${text}`);
  const parallel=markup.match(/<span[^>]*data-testid="parallel-summary"[^>]*>/)?.[0]??'';assert.ok(parallel.includes(escape(t('Current copies finish before a lower limit takes effect.'))),`${language}: lower-limit note`);assert.ok(markup.includes(escape(t('Drives at once: {count}/10',{count:state.preferences.parallel}))),`${language}: drives at once`);
  assert.match(markup,/data-testid="parallel-summary"/);assert.match(markup,/class="import-dashboard"/);assert.doesNotMatch(markup,/class="workspace-details import-overview"/);
 }
});

test('Activity supplies the same queue, activity, camera and inventory context as Import',()=>{
 for(const language of languages){
  const t=createTranslator(language),markup=render(language,createElement(ActivityJobs,{state,act:()=>{},inspect:()=>{}}));
  for(const text of [t('Queue position {count}',{count:2}),'37%','Nikon Z6III','24–70 mm','PHOTO.NEF',t('Drive path')])assert.ok(markup.includes(text),`${language}: ${text}`);
  assert.match(markup,/class="inventory-open"/);assert.match(markup,/class="file-preview-button"/);assert.match(markup,/class="inventory-panel"/);
 }
});

test('duplicate recovery displays its library path when Activity combines roots',()=>{
 const value={...state,organizationRecovery:[{id:'removed',kind:'duplicates' as const,root:'/backup/another-library',status:'complete' as const,files:4,completed:4,retainedFiles:4,retainedBytes:100,undoable:true}]};
 assert.match(render('en',createElement(OrganizationRecoveryPanel,{state:value,act:()=>{},busy:false})),/class="recovery-root">\/backup\/another-library</);
});


test('Activity job inventory remains the completed run snapshot after an independent rescan',()=>{
 const newer:Inventory={...inventory,files:[{...inventory.files[0]!,path:'/card/LATER-SCAN.NEF',relative:'LATER-SCAN.NEF'}]};
 const markup=render('en',createElement(ActivityJobs,{state:{...state,sourceInventories:{card:newer}},act:()=>{},inspect:()=>{}}));
 assert.match(markup,/PHOTO.NEF/);assert.doesNotMatch(markup,/LATER-SCAN.NEF/);
});
