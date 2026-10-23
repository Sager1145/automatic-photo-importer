import assert from 'node:assert/strict';
import {pages,pageTitle,type Check,type Harness} from '../harness';

const reduced=(h:Harness)=>h.js<boolean>("matchMedia('(prefers-reduced-motion: reduce)').matches");
/** Records the kind of each View Transition the renderer starts, and optionally what its layers look like once it is ready. */
const recordTransitions=(h:Harness,layers=false)=>{h.notes.qaTransitions=true;h.notes.qaLayers=true;return h.js(`(()=>{window.qaTransitions=[];window.qaLayers=[];const start=window.qaStartViewTransition??=document.startViewTransition;document.startViewTransition=function(update){window.qaTransitions.push(document.documentElement.dataset.transition);const t=start.call(document,update);${layers?"t.ready.then(()=>{const bar=document.querySelector('.window-titlebar');const bg=getComputedStyle(bar).backgroundColor.match(/[\\d.]+/g);window.qaLayers.push({kind:document.documentElement.dataset.transition,labels:Array.from(document.querySelectorAll('.nav-item>:not(.nav-indicator)')).every(e=>getComputedStyle(e).viewTransitionName!=='none'),tabLabels:Array.from(document.querySelectorAll('.settings-nav [role=tab]>:not(.settings-indicator)')).every(e=>getComputedStyle(e).viewTransitionName!=='none'),titlebarOpaque:bg.length===3||parseFloat(bg[3])===1,shadowHidden:getComputedStyle(bar,'::after').display==='none'});}).catch(()=>{});":''}return t;};return true;})()`);};
const stopRecording=(h:Harness)=>h.js('if(window.qaStartViewTransition)document.startViewTransition=window.qaStartViewTransition;true');

export const navigationChecks=():Check[]=>[
 {id:'nav-titlebar-buttons',stage:'navigation',title:'Every page opens from the sidebar with its own title-bar buttons; the command bar and old buttons are gone',covers:['navigation of every page','per-page title-bar actions'],run:async h=>{
  assert.equal(await h.js<boolean>("document.querySelector('[data-testid=show-progress]')===null"),true,'Total progress button has been removed');
  assert.equal(await h.js<boolean>("document.querySelector('.sidebar').getBoundingClientRect().top===0&&Math.abs(document.querySelector('.window-titlebar').getBoundingClientRect().left-document.querySelector('.sidebar').getBoundingClientRect().right)<1"),true,'Sidebar reaches the top beside the titlebar');
  const expected:Record<string,string[]>={'Organization':['show-errors','titlebar-review-organization','titlebar-organize'],'Duplicates':['show-errors','titlebar-duplicates-scan','titlebar-duplicates-stop'],'Drives':['show-errors'],'History':['show-errors'],'Settings':['show-errors'],'Import desk':['show-errors','global-start','global-stop','global-automatic']};
  for(const page of [...pages.slice(1),pages[0]!]){
   await h.nav(page);
   const ids=await h.js<string[]>("Array.from(document.querySelectorAll('.window-titlebar [data-testid]')).map(e=>e.dataset.testid)");
   assert.ok(expected[page]!.every(id=>ids.includes(id))&&(page==='Import desk'||!ids.includes('global-start')),`title-bar buttons on ${page}: ${ids}`);
   assert.equal(await h.js<boolean>("document.querySelector('.command-bar')===null"),true);
   assert.equal(await h.js<string>("document.querySelector('.window-titlebar h1').textContent"),pageTitle(page));
  }
  assert.equal(await h.js<boolean>("document.querySelector('button[aria-label=\"Preview photo and metadata\"]')===null"),true);
 }},
 {id:'nav-desk-dashboard',stage:'navigation',title:'The desk shows the import dashboard with live metrics and drive activity, Automatic toggles, and errors open only on request',covers:['import dashboard','drive activity meters','Automatic button'],run:async h=>{
  assert.equal(await h.js<boolean>("document.querySelector('[aria-label=\"Import dashboard\"]')!==null"),true);
  await h.click('[data-testid=global-automatic]');await h.waitFor('automatic on',async()=>(await h.state()).preferences.automatic);
  await h.until('automatic button pressed',"document.querySelector('[data-testid=global-automatic]').getAttribute('aria-pressed')==='true'");
  await h.click('[data-testid=global-automatic]');await h.waitFor('automatic off',async()=>!(await h.state()).preferences.automatic);
  await h.until('automatic button unpressed',"document.querySelector('[data-testid=global-automatic]').getAttribute('aria-pressed')==='false'");
  assert.equal(await h.js<string>("document.querySelector('.import-dashboard [data-metric=sources]').textContent"),'6');
  assert.equal(await h.js<string>("document.querySelector('.import-dashboard [data-metric=destinations]').textContent"),'1 / 1');
  // Fixture folders live on the internal disk, so utilization of that disk appears for the destination and in the UI.
  if(process.platform==='darwin'){
   await h.waitFor('drive activity for the destination',async()=>{const s=await h.state();const first=s.preferences.destinations[0];const entry=first?s.driveActivity?.[first]:undefined;return !!entry&&entry.utilization>=0&&entry.utilization<=100&&Array.isArray(entry.history);});
   await h.until('drive activity meters',"document.querySelector('[data-testid=sidebar-activity]')&&document.querySelector('[data-testid=drive-activity]')&&document.querySelector('.import-dashboard [data-metric=drive-activity]')");
  }
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
   for(const page of ['Drives','Organization','History','Settings'] as const)await h.nav(page);
   await h.settingsTab('importing');await h.js('window.qaTransitions=window.qaTransitions.filter(kind=>!kind?.startsWith("category"))');
   const categories=['importing','destinations','folders','organization','drives','general'];
   for(const id of [...categories.slice(1),...categories.slice(0,-1).reverse()])await h.settingsTab(id);
   assert.equal(await h.js<boolean>("document.querySelectorAll('.settings-indicator').length===1&&document.querySelector('[aria-selected=true] .settings-indicator')!==null"),true,'One selection indicator, on the open category');
   await h.nav('Import desk');
   seen=(await h.js<string[]>('window.qaTransitions')).filter(kind=>/^(forward|back|category-)/.test(kind??''));
  }finally{await stopRecording(h);}
  assert.deepEqual(seen,isReduced?[]:['forward','forward','forward','forward',...Array(5).fill('category-forward'),...Array(5).fill('category-back'),'back']);
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
