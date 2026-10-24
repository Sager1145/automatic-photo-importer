import assert from 'node:assert/strict';
import {text} from '../../../messages';
import {MAX_GROUP_ITEMS} from '../../../shared';
import {errorLayers} from '../probes';
import type {Check,Harness} from '../harness';
import {manyRunningJobs,syntheticJob} from '../synthetic';
import {scanned} from './imports';

let fresh=0;
/** A new app error, so a new error toast opens (each toast stays 7 s). */
const raise=(h:Harness)=>{h.hooks!.set('error',text(`QA synthetic error ${++fresh}`));return h.until('error toast in the top layer',"document.querySelector('[data-testid=error-toast]')?.matches(':popover-open')");};
const openPanel=async(h:Harness)=>{await h.click('[data-testid=show-errors]');await h.until('issues list',"document.querySelector('[data-testid=activity-panel]')");};
const closePanel=async(h:Harness)=>{await h.nav('Import desk');await h.until('issues list closed',"document.querySelector('[data-testid=activity-panel]')===null");};
const needsHook=async(h:Harness)=>h.hooks?undefined:'needs the QA injection hook';

export const errorChecks=():Check[]=>[
 {id:'errors-unknown-files',stage:'errors',title:'Unknown files are skipped quietly by default and appear in All errors only in Ask mode',covers:['format warnings','skipped files notice'],run:async h=>{
  await scanned(h);
  assert.equal(await h.js<boolean>("document.querySelector('.source-ledger [data-testid=unknown-files-prompt]')===null"),true);
  assert.equal((await h.state()).preferences.unknownDefault??'skip','skip');
  await h.until('skipped files notice',"document.querySelector('[data-testid=skipped-files]')");
  await openPanel(h);
  assert.equal(await h.js<boolean>("document.querySelector('[data-testid=activity-panel] [data-testid=unknown-files-prompt]')===null"),true,'Default skip mode must not report unknown files as errors');
  await closePanel(h);
  // Ask is a job setting: it is dropped while a scan runs, so prefs() waits for idle and confirms it took.
  try{
   await h.prefs({unknownDefault:'ask'});
   await openPanel(h);
   await h.until('format issues in the error panel',"document.querySelector('[data-testid=activity-panel] [data-testid=unknown-files-prompt]')");
   assert.equal(await h.js<boolean>("document.querySelector('[data-testid=activity-panel]').textContent.includes('Keep unknown files excluded')"),true);
   await h.shot('file-format-errors');
   await closePanel(h);
  }finally{await h.prefs({unknownDefault:'skip'});}
 }},
 {id:'errors-on-top-200',stage:'errors',title:'Errors stay on top: at 200% the error toast is the topmost element everywhere on it, also on the frames after each page switch',covers:['error toasts always on top','UI scale 2','transitions suspended under errors'],run:async h=>{
  type Layer={testid:string;topLayer:boolean;misses:string[];transition:boolean};
  // Switch pages and probe two frames later, when a transition would already be drawing.
  const go=(page:string)=>h.js<Layer[]>(`(async()=>{Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()===${JSON.stringify(page)}).click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return (${errorLayers.toString()})();})()`);
  await h.size(1000,720);await h.prefs({textScale:2});
  let settled:Layer[]=[];const during:Layer[][]=[];
  if(h.hooks){await raise(h);}
  else{await scanned(h);await h.prefs({unknownDefault:'ask'});await h.until('warning toast in the top layer',"document.querySelector('[data-error-layer]')?.matches(':popover-open')");}
  try{
   await h.settle();settled=await h.probe(errorLayers);await h.shot('error-toast-on-top-200');
   for(const page of ['Library tools','Activity','Import']){if(h.hooks)await raise(h);during.push(await go(page));}
  }finally{if(!h.hooks)await h.prefs({unknownDefault:'skip'});}
  assert.equal(settled.length,1,'one error surface is open');
  assert.deepEqual(settled[0],{...settled[0],topLayer:true,misses:[],transition:false});
  if(h.hooks)assert.ok(during.every(layers=>layers.length===1),'The toast was on screen while pages switched');
  for(const layers of during)for(const layer of layers)assert.deepEqual(layer,{...layer,topLayer:true,misses:[],transition:false});
 }},
 {id:'errors-above-sheets-and-animations',stage:'errors',title:'Running animations never paint above an error toast, and the toast stays above a sheet opened before or after it',covers:['animation layering','error toasts always on top','popovers and sheets'],skip:needsHook,run:async h=>{
  // The review for the sheet is built first: a real preview would wait behind synthetic jobs that never finish.
  await h.action({type:'preview',sourceId:'fixture:1'});await h.until('per-file review preview',"document.querySelector('.review-source-button')");
  // Spinners, indeterminate bars and meters animate on the desk while the toast is up.
  h.hooks!.addJobs([...manyRunningJobs(4),syntheticJob('discovering',{phase:'discovering'})]);
  // With reduced motion nothing animates; the toast must still win every hit test.
  if(!await h.js<boolean>("matchMedia('(prefers-reduced-motion: reduce)').matches"))await h.until('animations running on the desk',"document.getAnimations().filter(a=>a.playState==='running').length>0");
  await raise(h);
  const desk=await h.probe(errorLayers);
  assert.deepEqual(desk.map(layer=>layer.misses),[[]],'Something animated above the toast: '+JSON.stringify(desk));
  // Check both actual pointer hit testing and top-layer paint order, in both opening orders.
  h.notes.qaTopLayer=true;
  try{for(const order of ['toast first','sheet first']){
   await h.closeOverlays();
   await h.js("(()=>{window.qaTopLayer=[];const track=(proto,name,add)=>{const original=proto['qa_'+name]??=proto[name];proto[name]=function(...args){const result=original.apply(this,args);window.qaTopLayer=window.qaTopLayer.filter(e=>e!==this);if(add)window.qaTopLayer.push(this);return result;};};track(HTMLElement.prototype,'showPopover',true);track(HTMLElement.prototype,'hidePopover',false);track(HTMLDialogElement.prototype,'showModal',true);track(HTMLDialogElement.prototype,'close',false);return true;})()");
   if(order==='toast first')await raise(h);
   await h.js("Array.from(document.querySelectorAll('.review-source-button')).find(button=>button.textContent.includes('photo.png')).click()");await h.until('metadata sheet',"document.querySelector('.metadata-dialog')?.open===true");
   if(order==='sheet first')await raise(h);
   const top=await h.js<string[]>("window.qaTopLayer.filter(e=>e.isConnected&&(e.matches(':popover-open')||e.open)).map(e=>e.dataset.testid||e.className)");
   assert.equal(top.at(-1),'error-toast',`${order}: top layer from bottom to top is ${JSON.stringify(top)}`);
   assert.ok(top.some(name=>String(name).includes('metadata-dialog')),`${order}: the sheet is open: ${JSON.stringify(top)}`);
   await h.shot(`error-toast-over-sheet-${order.replace(' ','-')}`);
   const hits=await h.probe(errorLayers);
   assert.deepEqual(hits.find(layer=>layer.testid==='error-toast')?.misses,[],`${order}: toast must accept pointer input above a modal`);
   const pointerClick=async(selector:string)=>{
    const point=await h.js<{x:number;y:number}>(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    h.window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    h.window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
   };
   if(order==='toast first'){
    h.hooks!.set('newDevices',['fixture:2']);
    await h.until('new drive opens above metadata',"document.querySelector('[data-testid=new-drive-prompt]')?.open===true");await h.settle();
    assert.deepEqual((await h.probe(errorLayers)).find(layer=>layer.testid==='error-toast')?.misses,[],'toast stays interactive when a newer modal precedes metadata in DOM order');
   }
   await pointerClick('[data-testid=error-toast] button[aria-label=Dismiss]');
   await h.until('toast dismissed by real pointer',"!document.querySelector('[data-testid=error-toast]')");
   assert.equal(await h.js<boolean>("document.querySelector('.metadata-dialog')?.open"),true,'Dismissing toast keeps metadata open');
   if(order==='toast first'){
    await h.click('[data-testid=new-drive-close]');await h.until('new drive prompt closed',"!document.querySelector('[data-testid=new-drive-prompt]')");h.hooks!.set('newDevices',[]);
   }
   await raise(h);await h.settle();
   await pointerClick('[data-testid=error-toast] button:not([aria-label])');
   await h.until('View opens Activity › Issues by real pointer',"document.querySelector('[data-testid=activity-panel]')");
   await h.nav('Import desk');await h.until('issues list closed',"!document.querySelector('[data-testid=activity-panel]')");
   await raise(h);await h.click('[data-testid=metadata-close]');
   await h.until('metadata closed with toast alive',"!document.querySelector('.metadata-dialog')&&document.querySelector('[data-testid=error-toast]')?.matches(':popover-open')");
   assert.deepEqual((await h.probe(errorLayers)).find(layer=>layer.testid==='error-toast')?.misses,[],'toast moves back to the document after modal unmount');


  }}finally{await h.js("for(const [proto,name] of [[HTMLElement.prototype,'showPopover'],[HTMLElement.prototype,'hidePopover'],[HTMLDialogElement.prototype,'showModal'],[HTMLDialogElement.prototype,'close']])if(proto['qa_'+name])proto[name]=proto['qa_'+name];true");}
 }},
 {id:'errors-grouped-skip',stage:'errors',title:'Grouped errors and warnings show one row per kind with counts, paged paths and skip buttons; Skip these clears the group',covers:['grouped errors and warnings','skip buttons','All errors panel'],skip:needsHook,run:async h=>{
  const job={...syntheticJob('grouped',{phase:'error'}),retryable:true,groups:[
   {code:'copy-failed',severity:'error' as const,count:350,items:Array.from({length:MAX_GROUP_ITEMS},(_,i)=>({path:`/Volumes/QA synthetic/grouped/DCIM/IMG_${i}.CR3`,detail:'EIO'}))},
   {code:'unreadable',severity:'warning' as const,count:12,items:Array.from({length:12},(_,i)=>({path:`/Volumes/QA synthetic/grouped/DCIM/IMG_${i}.HIF`}))}]};
  h.hooks!.addJobs([job]);
  await openPanel(h);
  const row=(code:string)=>`document.querySelector('[data-testid=activity-panel] [data-testid=error-group][data-code=${code}]')`;
  await h.until('grouped error row',`${row('copy-failed')}&&${row('unreadable')}`);
  assert.equal(await h.js<string>(`${row('copy-failed')}.dataset.count`),'350');
  assert.match(await h.js<string>(`${row('copy-failed')}.querySelector('[data-testid=error-group-title]').textContent`),/350 files could not be copied/);
  assert.equal(await h.js<boolean>(`${row('unreadable')}.closest('[data-testid=warnings-section]')!==null&&${row('copy-failed')}.closest('[data-testid=errors-section]')!==null`),true,'Warnings and errors are listed apart');
  assert.equal(await h.js<boolean>(`!!${row('copy-failed')}.querySelector('[data-testid=error-group-skip]')&&!!document.querySelector('[data-testid=activity-panel] [data-testid=job-skip-all]')&&!${row('unreadable')}.querySelector('[data-testid=error-group-skip]')`),true,'Errors have Skip these and Skip all; warnings have no skip');
  await h.click(`[data-testid=activity-panel] [data-testid=error-group][data-code=copy-failed] [data-testid=error-group-toggle]`);
  await h.until('affected files',`${row('copy-failed')}.querySelectorAll('[data-testid=error-group-item]').length===${MAX_GROUP_ITEMS}`);
  assert.match(await h.js<string>(`${row('copy-failed')}.querySelector('[data-testid=error-group-remaining]').textContent`),/150 more/);
  await h.shot('grouped-errors');
  await h.click(`[data-testid=activity-panel] [data-testid=error-group][data-code=copy-failed] [data-testid=error-group-skip]`);
  await h.until('skipped group leaves the errors',`!${row('copy-failed')}`);
  const skipped=(await h.state()).jobs.find(item=>item.id===job.id);
  assert.deepEqual(skipped?.acknowledged?.codes,['copy-failed']);
  assert.equal(skipped?.phase,'complete','Skipping every error marks the job done');
  assert.equal((await h.state()).error,undefined,'Skipping raised an error');
 }},
];
