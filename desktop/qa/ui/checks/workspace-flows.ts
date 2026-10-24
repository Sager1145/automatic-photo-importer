import assert from 'node:assert/strict';
import type {Action,Inventory} from '../../../shared';
import type {Check} from '../harness';
import {syntheticJob} from '../synthetic';

export const workspaceFlowChecks=():Check[]=>[
 {id:'import-activity-inventory',stage:'imports',title:'Activity keeps per-job inventory selection and opens the selected file metadata',covers:['information parity','Activity inventory selection','Activity metadata access'],skip:async h=>h.hooks?undefined:'needs QA state fixtures',run:async h=>{
  const sources=(await h.state()).sources.slice(0,2),previous=h.hooks!.inspect;
  const inventory=(index:number):Inventory=>({files:[{path:sources[index]!.path+'/'+(index?'payload.bin':'photo.png'),relative:index?'payload.bin':'photo.png',size:123,kind:index?'Other':'Images',included:true}],media:1,companions:0,unknown:0,unknownExtensions:{},bytes:123,elapsedMs:0});
  h.hooks!.addJobs(sources.map((source,index)=>({...syntheticJob('inventory-'+index,{phase:'complete',source}),backup:true,inventory:inventory(index)})));
  h.hooks!.inspect=()=>({camera:'QA Camera',date:'2026-10-23T12:00:00Z',fields:{'EXIF:Model':'QA Camera'}});
  try{
   // The Queue is compact; inventories open from the Import card.
   await h.nav('Files & folders');
   await h.click('article[data-source-id="'+sources[1]!.id+'"] [data-testid=drive-details-toggle]');await h.settle();
   await h.click('article[data-source-id="'+sources[1]!.id+'"] .inventory-open');await h.settle();
   await h.until('second job inventory selected',"document.querySelector('.inventory-panel')?.textContent.includes('payload.bin')");
   await h.click('.inventory-panel .file-preview-button');
   await h.until('metadata from selected Activity inventory',"document.querySelector('.metadata-dialog')?.open===true&&document.querySelector('#metadata-heading')?.textContent==='payload.bin'&&document.querySelector('.metadata-dialog').textContent.includes('QA Camera')");
   await h.shot('activity-inventory-metadata');
  }finally{
   if(await h.js<boolean>("!!document.querySelector('.metadata-dialog')")){await h.click('[data-testid=metadata-close]');await h.until('Activity metadata closed',"!document.querySelector('.metadata-dialog')");}
   h.hooks!.inspect=previous;
  }
 }},
 {id:'nav-workspace-ownership',stage:'navigation',title:'Import modes preserve review ownership and keyboard tabs; task links open the exact Settings category',covers:['review ownership','Import modes','keyboard task tabs','precise Settings links'],skip:async h=>h.hooks?undefined:'needs QA state fixtures',run:async h=>{
  const preferences=(await h.state()).preferences;
  const source=(await h.state()).sources[0]!;
  h.hooks!.set('review',{id:'qa:owned-review',kind:'import',source,backup:true,plans:[]});
  await h.nav('Import');
  assert.equal(await h.js<boolean>("!document.querySelector('.review-panel')&&!!document.querySelector('.pending-review')"),true);
  await h.click('.pending-review button');await h.settle();
  assert.equal(await h.js<boolean>("document.querySelector('[data-testid=import-mode-files]')?.getAttribute('aria-selected')==='true'&&!!document.querySelector('.review-panel')"),true);
  await h.nav('Organization');assert.equal(await h.js<boolean>("!document.querySelector('.review-panel')&&!!document.querySelector('.pending-review')"),true);
  assert.equal((await h.state()).review?.id,'qa:owned-review');
  assert.deepEqual((await h.state()).preferences,preferences,'navigation does not mutate preferences');
  h.hooks!.set('review',undefined);await h.nav('Import desk');
  await h.js("{const tab=document.querySelector('[data-testid=import-mode-files]');tab.focus();tab.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));}");await h.settle();
  assert.equal(await h.js<boolean>("document.querySelector('[data-testid=import-mode-media]')===document.activeElement&&document.activeElement.getAttribute('aria-selected')==='true'"),true);
  for(let repeat=0;repeat<2;repeat++){
   await h.nav('Import desk');await h.js("[...document.querySelectorAll('.destination-strip-policy button')].find(b=>b.textContent==='Change').click()");await h.settle();
   assert.equal(await h.js<boolean>("document.querySelector('[data-testid=settings-tab-storage]')?.getAttribute('aria-selected')==='true'&&document.activeElement.id==='settings-tab-storage'"),true,'destination link selects and focuses Storage');
   await h.settingsTab('files');
  }
  await h.nav('Organization');await h.js("[...document.querySelectorAll('.organization-action button')].find(b=>b.textContent==='Edit folder rules').click()");await h.settle();
  assert.equal(await h.js<boolean>("document.querySelector('[data-testid=settings-tab-folders]')?.getAttribute('aria-selected')==='true'"),true);
 }},
 {id:'nav-stop-scopes',stage:'navigation',title:'Import and Activity dispatch their named Stop scopes without changing job ownership',covers:['Stop imports UI scope','Stop all UI scope','mixed jobs'],skip:async h=>h.hooks&&'beforeAction' in h.hooks?undefined:'needs QA action guard',run:async h=>{
  const seen:Action[]=[],previous=h.hooks!.beforeAction;
  h.hooks!.beforeAction=action=>{if(action.type==='stop'){seen.push(action);return false;}return previous?.(action);};
  try{
   h.hooks!.addJobs([{...syntheticJob('scope-media',{phase:'stopped',paused:true}),backup:false},{...syntheticJob('scope-backup',{phase:'stopped',paused:true}),backup:true},syntheticJob('scope-library',{phase:'copying',organization:true})]);
   await h.nav('Import desk');await h.click('[data-testid=global-stop]');await h.waitFor('imports scope received',()=>seen.length===1);
   assert.deepEqual(seen[0],{type:'stop',scope:'imports'});
   await h.click('[data-testid=global-stop-menu] summary');await h.click('[data-testid=global-stop-everything]');await h.waitFor('everything scope received',()=>seen.length===2);
   assert.deepEqual(seen[1],{type:'stop'});
   await h.nav('Jobs');await h.click('[data-testid=activity-stop-all]');await h.waitFor('queue stop all received',()=>seen.length===3);
   assert.deepEqual(seen[2],{type:'stop'});
  }finally{h.hooks!.beforeAction=previous;}
 }},
];
