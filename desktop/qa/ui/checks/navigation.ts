import assert from 'node:assert/strict';
import {pages,pageTitle,settingsCategories,type Check,type Harness} from '../harness';

const reduced=(h:Harness)=>h.js<boolean>("matchMedia('(prefers-reduced-motion: reduce)').matches");
/** Records the kind of each View Transition the renderer starts, and optionally what its layers look like once it is ready. */
const recordTransitions=(h:Harness,layers=false)=>{h.notes.qaTransitions=true;h.notes.qaLayers=true;return h.js(`(()=>{window.qaTransitions=[];window.qaLayers=[];const start=window.qaStartViewTransition??=document.startViewTransition;document.startViewTransition=function(update){window.qaTransitions.push(document.documentElement.dataset.transition);const t=start.call(document,update);${layers?"t.ready.then(()=>{const bar=document.querySelector('.window-titlebar');const bg=getComputedStyle(bar).backgroundColor.match(/[\\d.]+/g);window.qaLayers.push({kind:document.documentElement.dataset.transition,labels:Array.from(document.querySelectorAll('.nav-item>:not(.nav-indicator)')).every(e=>getComputedStyle(e).viewTransitionName!=='none'),tabLabels:Array.from(document.querySelectorAll('.settings-nav [role=tab]>:not(.settings-indicator)')).every(e=>getComputedStyle(e).viewTransitionName!=='none'),titlebarOpaque:bg.length===3||parseFloat(bg[3])===1,shadowHidden:getComputedStyle(bar,'::after').display==='none'});}).catch(()=>{});":''}return t;};return true;})()`);};
const stopRecording=(h:Harness)=>h.js('if(window.qaStartViewTransition)document.startViewTransition=window.qaStartViewTransition;true');

export const navigationChecks=():Check[]=>[
 {id:'nav-settings-highlight-order',stage:'navigation',title:'Every Settings category icon and text stays above its highlight; navigation and panel snapshots remain in separate layers',covers:['Settings upward highlight layering','category snapshot ordering','contained category navigation'],run:async h=>{
  if(await reduced(h))return;
  await h.nav('Settings');await h.settingsTab('general');
  await h.js(`(()=>{window.qaCategoryPaint=[];const start=window.qaStartViewTransition??=document.startViewTransition;document.startViewTransition=function(update){const t=start.call(document,update);t.ready.then(()=>{const root=document.documentElement;window.qaCategoryPaint.push({kind:root.dataset.transition,navigation:getComputedStyle(root,'::view-transition-group(settings-navigation)').zIndex,panel:getComputedStyle(root,'::view-transition-group(settings-panel)').zIndex,contain:getComputedStyle(document.querySelector('.settings-nav')).viewTransitionGroup,indicator:getComputedStyle(root,'::view-transition-group(settings-indicator)').zIndex,labels:${JSON.stringify(settingsCategories)}.flatMap(id=>['text','icon'].map(part=>({name:'settings-'+id+'-'+part,z:getComputedStyle(root,'::view-transition-group(settings-'+id+'-'+part+')').zIndex})))})}).catch(()=>{});return t;};})()`);
  try{
   await h.settingsTab('performance');for(const id of settingsCategories.slice(0,-1).reverse())await h.settingsTab(id);
   const frames=await h.js<{kind:string;navigation:string;panel:string;contain:string;indicator:string;labels:{name:string;z:string}[]}[]>('window.qaCategoryPaint');assert.ok(frames.filter(frame=>frame.kind==='category-back').length>=6);
   for(const frame of frames){assert.equal(frame.contain,'contain');assert.ok(Number(frame.navigation)>Number(frame.panel));for(const label of frame.labels)assert.ok(Number(label.z)>Number(frame.indicator),`${label.name}: ${JSON.stringify(frame)}`);}
  }finally{await stopRecording(h);await h.js('delete window.qaCategoryPaint');}
 }},
 {id:'nav-highlight-text-order',stage:'navigation',title:'Bottom-to-top navigation keeps every sidebar text and icon snapshot above the moving highlight',covers:['upward highlight layering','sidebar text above highlight','anchored Settings transition'],run:async h=>{
  if(await reduced(h))return;
  await h.js(`(()=>{window.qaNavPaint=[];const start=window.qaStartViewTransition??=document.startViewTransition;document.startViewTransition=function(update){const t=start.call(document,update);t.ready.then(()=>{const root=document.documentElement;window.qaNavPaint.push({kind:root.dataset.transition,indicator:getComputedStyle(root,'::view-transition-group(nav-indicator)').zIndex,devices:getComputedStyle(root,'::view-transition-group(sidebar-devices)').zIndex,brand:getComputedStyle(root,'::view-transition-group(sidebar-brand)').zIndex,labels:['desk','library','activity','settings'].flatMap(id=>['text','icon'].map(part=>({name:'nav-'+id+'-'+part,z:getComputedStyle(root,'::view-transition-group(nav-'+id+'-'+part+')').zIndex})))})}).catch(()=>{});return t;};})()`);
  try{
   for(const page of ['Settings','Activity','Library tools','Import','Library tools','Activity','Settings','Import'] as const)await h.nav(page);
   const paint=await h.js<{kind:string;indicator:string;devices:string;brand:string;labels:{name:string;z:string}[]}[]>('window.qaNavPaint');
   const moves=paint.filter(frame=>frame.kind==='forward'||frame.kind==='back');assert.ok(moves.filter(frame=>frame.kind==='back').length>=4,'upward transitions sampled');
   for(const frame of moves){assert.ok(Number(frame.devices)>Number(frame.indicator)&&Number(frame.brand)>Number(frame.indicator),'device and brand text remain above the travelling highlight');for(const label of frame.labels)assert.ok(Number.isFinite(Number(label.z))&&Number(label.z)>Number(frame.indicator),`${label.name} must paint above highlight: ${JSON.stringify(frame)}`);}
  }finally{await stopRecording(h);await h.js('delete window.qaNavPaint');}
 }},
 {id:'nav-titlebar-buttons',stage:'navigation',title:'Task navigation has Import, Library tools and Activity with anchored Settings; workflow actions are not duplicated in the titlebar',covers:['navigation of every page','per-page title-bar actions','four primary navigation items','workflow action ownership'],run:async h=>{
  assert.deepEqual(await h.js<string[]>("[...document.querySelectorAll('.sidebar .nav-item')].map(e=>e.textContent.trim())"),['Import','Library tools','Activity','Settings']);
  assert.equal(await h.js<boolean>("document.querySelector('[data-testid=show-progress]')===null&&document.querySelector('.command-bar')===null"),true);
  for(const page of pages){
   await h.nav(page);
   assert.equal(await h.js<string>("document.querySelector('.window-titlebar h1').textContent"),pageTitle(page));
   const ids=await h.js<string[]>("[...document.querySelectorAll('.window-titlebar [data-testid]')].map(e=>e.dataset.testid)");
   assert.ok(ids.includes('show-errors'),`issues remain accessible on ${page}`);
   assert.ok(!ids.some(id=>/^titlebar-(review-organization|organize|duplicates-scan|duplicates-stop)$/.test(id)),`duplicate workflow execution controls on ${page}: ${ids}`);
  }
  await h.nav('Import desk');
  assert.equal(await h.js<boolean>("document.querySelector('.sidebar').getBoundingClientRect().top===0&&Math.abs(document.querySelector('.window-titlebar').getBoundingClientRect().left-document.querySelector('.sidebar').getBoundingClientRect().right)<1"),true);
 }},
 {id:'nav-desk-dashboard',stage:'navigation',title:'The desk shows the import dashboard with live metrics and drive activity, Automatic toggles in Settings, and errors open only on request',covers:['import dashboard','drive activity meters','Automatic switch in Settings'],run:async h=>{
  await h.js("document.querySelectorAll('details.workspace-details').forEach(details=>details.open=true)");
  assert.equal(await h.js<boolean>("document.querySelector('[aria-label=\"Import dashboard\"]')!==null"),true);
  // Automatic lives in Settings > Importing; the Import empty state's line opens it, and the titlebar no longer has the button.
  assert.equal(await h.js<boolean>("document.querySelector('[data-testid=global-automatic]')===null&&document.querySelector('[data-testid=titlebar-overview]')===null"),true,'no Automatic or Overview button in the titlebar');
  const automatic="[data-testid=settings-panel-defaults] input[type=checkbox]";
  await h.nav('Settings');await h.settingsTab('defaults');
  await h.click(automatic);await h.waitFor('automatic on',async()=>(await h.state()).preferences.automatic);
  await h.until('automatic switch on',`document.querySelector('${automatic}').checked===true`);
  await h.click(automatic);await h.waitFor('automatic off',async()=>!(await h.state()).preferences.automatic);
  await h.until('automatic switch off',`document.querySelector('${automatic}').checked===false`);
  await h.nav('Import desk');
  assert.equal(await h.js<string>("document.querySelector('.import-dashboard [data-metric=sources]').textContent"),'6');
  assert.equal(await h.js<string>("document.querySelector('.import-dashboard [data-metric=destinations]').textContent"),'1 / 1');
  // Fixture folders live on the internal disk, so utilization of that disk appears for the destination and in the UI.
  if(process.platform==='darwin'){
   await h.waitFor('drive activity for the destination',async()=>{const s=await h.state();const first=s.preferences.destinations[0];const entry=first?s.driveActivity?.[first]:undefined;return !!entry&&entry.utilization>=0&&entry.utilization<=100&&Array.isArray(entry.history);});
   await h.until('drive activity meters',"document.querySelector('[data-testid=sidebar-activity]')&&document.querySelector('[data-testid=drive-activity]')&&document.querySelector('.import-dashboard [data-metric=drive-activity]')");
  }
  await h.until('the sidebar destination status line',"[...document.querySelectorAll('[data-testid=sidebar-destination]')].every(row=>row.querySelector('[data-testid=sidebar-destination-status]')?.textContent.trim().length>0)&&document.querySelector('[data-testid=sidebar-destination-status]')");
  assert.equal(await h.js<boolean>("Array.from(document.querySelectorAll('h2')).some(h=>h.textContent.includes('Ready for your next shoot'))"),false);
  assert.equal(await h.js<boolean>("document.querySelector('.activity-dialog')===null"),true,'All errors stays closed until asked for');
  await h.click('[data-testid=show-errors]');await h.until('errors panel',"document.querySelector('.activity-dialog')?.open===true");await h.shot('all-errors');
  await h.click('[data-testid=activity-close]');await h.until('animated activity close',"document.querySelector('.activity-dialog')===null");
 }},
 {id:'nav-motion-preference',stage:'navigation',title:'Motion follows the operating system preference and buttons retain immediate feedback',covers:['reduced motion (OS)'],run:async h=>{
  const isReduced=await reduced(h);
  if(process.argv.includes('--force-prefers-reduced-motion'))assert.equal(isReduced,true);
  const durations=await h.js<string>("getComputedStyle(document.querySelector('[data-testid=global-start]')).transitionDuration");
  assert.equal(durations.split(',').some(value=>parseFloat(value)>0),!isReduced);
 }},
 {id:'nav-transitions',stage:'navigation',title:'Every page and Settings category switch animates through the motion helper, and reduced motion skips it',covers:['page transitions','Settings category transitions','single selection indicator'],run:async h=>{
  const isReduced=await reduced(h);
  let seen:string[];
  try{
   await recordTransitions(h);
   for(const page of ['Library tools','Activity','Settings'] as const)await h.nav(page);
   await h.settingsTab('general');await h.js('window.qaTransitions=window.qaTransitions.filter(kind=>!kind?.startsWith("category"))');
   const categories=settingsCategories;
   for(const id of [...categories.slice(1),...categories.slice(0,-1).reverse()])await h.settingsTab(id);
   assert.equal(await h.js<boolean>("document.querySelectorAll('.settings-indicator').length===1&&document.querySelector('[aria-selected=true] .settings-indicator')!==null"),true,'One selection indicator, on the open category');
   await h.nav('Import desk');
   seen=(await h.js<string[]>('window.qaTransitions')).filter(kind=>/^(forward|back|category-)/.test(kind??''));
  }finally{await stopRecording(h);}
  assert.deepEqual(seen,isReduced?[]:['forward','forward','forward',...Array(6).fill('category-forward'),...Array(6).fill('category-back'),'back']);
 }},
 {id:'nav-transition-layers',stage:'navigation',title:'Transitions keep each layer in place: labels above selection capsules, an opaque titlebar, nothing under an open sheet',covers:['animation layering during transitions','sheets suspend transitions'],run:async h=>{
  const isReduced=await reduced(h);
  type Layer={kind:string;labels:boolean;tabLabels:boolean;titlebarOpaque:boolean;shadowHidden:boolean};
  let layers:Layer[],underSheet:unknown[];
  try{
   await recordTransitions(h,true);
   await h.nav('Settings');await h.settingsTab('destinations');await h.settingsTab('importing');await h.nav('Import desk');
   layers=(await h.js<Layer[]>('window.qaLayers')).filter(layer=>/^(forward|back|category-)/.test(layer.kind));
   // A layout change while All errors is open must not lift the page above the sheet's backdrop.
   await h.js('window.qaLayers=[];window.qaTransitions=[]');await h.click('[data-testid=show-errors]');await h.until('errors panel',"document.querySelector('.activity-dialog')?.open===true");
   await h.prefs({sourceLayout:'grid'});await h.until('grid under the sheet',"document.querySelector('.source-ledger.source-layout-grid')");
   underSheet=await h.js('window.qaTransitions');
  }finally{await stopRecording(h);}
  assert.deepEqual(underSheet,[],'No transition runs under an open sheet');
  if(isReduced){assert.deepEqual(layers,[]);return;}
  // Settings opened on its last category, so the first switch may go either way.
  assert.deepEqual(layers.map(layer=>layer.kind.replace(/^category-(forward|back)$/,'category')),['forward','category','category','back']);
  for(const layer of layers){assert.ok(layer.labels&&layer.titlebarOpaque&&layer.shadowHidden,JSON.stringify(layer));if(layer.kind.startsWith('category'))assert.ok(layer.tabLabels,JSON.stringify(layer));}
 }},
 {id:'nav-transition-containment',stage:'navigation',title:'Page snapshots contain their children and stay below the fixed chrome throughout page and category motion',covers:['nested transition layers','fixed chrome stacking','snapshot clipping','animation duration budget'],run:async h=>{
  if(await reduced(h))return;
  await h.js(`(()=>{window.qaContainment=[];const start=window.qaStartViewTransition??=document.startViewTransition;document.startViewTransition=function(update){const t=start.call(document,update);t.ready.then(()=>window.qaContainment.push({parents:['.main-content','.sidebar','.window-titlebar'].map(s=>getComputedStyle(document.querySelector(s)).viewTransitionGroup),page:Number(getComputedStyle(document.documentElement,'::view-transition-group(page)').zIndex),chrome:Number(getComputedStyle(document.documentElement,'::view-transition-group(titlebar)').zIndex),clips:['sidebar','titlebar'].map(name=>getComputedStyle(document.documentElement,'::view-transition-group-children('+name+')').overflowX),durations:document.getAnimations().filter(a=>a.timeline===document.timeline&&a.effect?.getTiming().iterations!==Infinity).map(a=>Number(a.effect.getTiming().duration))})).catch(()=>{});return t;};})()`);
  try{
   await h.nav('Settings');await h.settingsTab('destinations');await h.nav('Import desk');
   const records=await h.js<{parents:string[];page:number;chrome:number;clips:string[];durations:number[]}[]>('window.qaContainment');
   assert.ok(records.length>=2,'transitions reached ready');
   for(const record of records){assert.deepEqual(record.parents,['contain','contain','contain']);assert.ok(record.chrome>record.page,JSON.stringify(record));assert.deepEqual(record.clips,['clip','clip'],'chrome snapshots must preserve scroll/text clipping');assert.ok(record.durations.length>0&&record.durations.every(ms=>ms>=0&&ms<=300),`interaction duration exceeds 300ms: ${JSON.stringify(record.durations)}`);}
  }finally{await stopRecording(h);await h.js('delete window.qaContainment');}
 }},
 {id:'nav-rapid-timing',stage:'navigation',title:'Rapid navigation and opening a sheet mid-transition leave the last page selected and no click-blocking snapshots',covers:['animation interruption','rapid navigation timing','sheet during transition'],run:async h=>{
  await h.js("for(const index of [1,2,3])document.querySelectorAll('.nav-item')[index].click()");
  await h.until('last navigation wins',"document.querySelectorAll('.nav-item')[3].getAttribute('aria-current')==='page'");
  await h.settle();
  assert.equal(await h.js<string>("document.querySelector('.window-titlebar h1').textContent"),'Settings','the last navigation remains selected after all callbacks finish');
  await h.click('.nav-item');
  await h.click('[data-testid=show-errors]');
  await h.until('sheet opened during navigation',"document.querySelector('.activity-dialog')?.open===true");
  await h.settle();
  assert.equal(await h.js<boolean>("(()=>{const b=document.querySelector('[data-testid=activity-close]'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))&&!document.documentElement.dataset.transition;})()"),true,'sheet accepts clicks after interrupting navigation');
 }},
 {id:'nav-reduced-motion-emulated',stage:'navigation',title:'With reduced motion on, pages and sheets change without View Transitions or animated closes, in every run',covers:['reduced motion'],run:async h=>{
  await h.media([{name:'prefers-reduced-motion',value:'reduce'}]);
  await h.until('reduced motion emulated',"matchMedia('(prefers-reduced-motion: reduce)').matches");
  try{
   await recordTransitions(h);
   for(const page of ['Settings','Organization','Import desk'] as const)await h.nav(page);
   assert.deepEqual(await h.js('window.qaTransitions'),[],'a View Transition ran with reduced motion');
   const durations=await h.js<string>("getComputedStyle(document.querySelector('[data-testid=global-start]')).transitionDuration");
   assert.ok(durations.split(',').every(value=>parseFloat(value)===0),`button transitions still animate: ${durations}`);
   // The sheet closes in the same frame: nothing is left animating out.
   await h.click('[data-testid=show-errors]');await h.until('errors panel',"document.querySelector('.activity-dialog')?.open===true");
   // Crossfades stay (the app's reduced motion keeps short fades, like the boot); nothing may move or scale.
   assert.deepEqual(await h.js<string[]>("document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity).filter(a=>a.transitionProperty?a.transitionProperty!=='opacity':a.effect.getKeyframes().some(k=>Object.keys(k).some(p=>!['offset','easing','composite','computedOffset','opacity'].includes(p)))).map(a=>(a.animationName||a.transitionProperty||'script')+' on '+(a.effect?.target?.className||a.effect?.target?.tagName)+(a.effect?.pseudoElement??'')+' '+a.effect?.getTiming().duration+' ms')"),[],'something moves with reduced motion');
   await h.click('[data-testid=activity-close]');await h.frames(2);
   assert.equal(await h.js<boolean>("document.querySelector('.activity-dialog')===null"),true,'the sheet animated its close');
  }finally{await stopRecording(h);}
 }},
];
