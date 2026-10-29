import assert from 'node:assert/strict';
import path from 'node:path';
import {threadpoolExceeds} from '../../thread-pool';
import type {Check} from '../harness';
import type {Context} from './context';

export const bootChecks=(ctx:Context):Check[]=>[
 {id:'boot-overview-checking',stage:'boot',title:'At startup the overview never calls a destination offline before its first check has finished',covers:['destination status at first paint'],run:async h=>{
  // Sampled before anything else runs: while a destination has no status yet the page must not show the offline error.
  const s=ctx.firstState;const unchecked=s.preferences.destinations.some(d=>!s.destinationStatus?.some(x=>x.path===d));
  if(unchecked)assert.ok(!ctx.firstBanner.includes('offline'),`offline banner while checking: ${ctx.firstBanner}`);
  else assert.ok(!ctx.firstBanner.includes('offline')||s.destinationStatus!.some(x=>x.available===false),`offline banner although every destination is available: ${ctx.firstBanner}`);
  assert.ok(h.scale>=1);
 }},
 {id:'boot-thread-pool',stage:'boot',title:'The main process runs with a libuv thread pool sized by the CPU thread limit (twice it, 4 to 16; 16 without a saved limit)',covers:['file reads and lstat do not queue behind fsync'],run:async()=>{
  const size=Number(process.env.UV_THREADPOOL_SIZE);assert.ok(size>=4&&size<=16,'UV_THREADPOOL_SIZE is '+process.env.UV_THREADPOOL_SIZE);if(process.platform!=='win32')assert.equal(await threadpoolExceeds(size-1),true);
 }},
 {id:'boot-fresh-launch',stage:'boot',title:'Fresh launch follows System, Automatic is off, and only fixture sources are present',covers:['QA isolation from real drives','default preferences'],run:async h=>{
  const s=await h.state();assert.equal(s.preferences.appearance,'system');assert.equal(s.preferences.automatic,false);assert.equal(s.sources.length,6);assert.ok(s.sources.every(source=>source.id.startsWith('fixture:')&&source.path.startsWith(ctx.root+path.sep)));
 }},
 {id:'boot-native-controls',stage:'boot',title:'macOS uses native window controls instead of HTML replicas',covers:['traffic lights position','full screen'],run:async h=>{
  if(process.platform!=='darwin')return;
  assert.deepEqual(h.window.getWindowButtonPosition(),{x:18,y:15});assert.equal(h.window.isFullScreenable(),true);assert.equal(await h.js<boolean>("document.querySelector('.window-controls')!==null"),false);
 }},
 {id:'boot-splash-gone',stage:'boot',title:'After boot nothing of the splash lingers: no node, animation, z-index or transform layer, and the sidebar logo, nav items and a popover are hit first',covers:['boot splash data-boot=done','animation layering after boot'],run:async h=>{
  const result=await h.js<{boot:number;animations:number;stacked:string[];logo:boolean;nav:boolean[];popover:boolean}>(`(()=>{
   const inside=(point,element)=>!!point&&!!element&&element.contains(point);
   const centre=element=>{const r=element.getBoundingClientRect();return[r.left+r.width/2,r.top+r.height/2]};
   const hitAt=element=>document.elementFromPoint(...centre(element));
   const leftovers=[...document.querySelectorAll('.app-shell,.main-content,.sidebar,.brand,.brand-logo,.nav-item')].filter(element=>{const s=getComputedStyle(element);return /boot-/.test(s.animationName)||(s.transform!=='none'&&element.matches('.app-shell,.brand-logo'))||(!!element.style.transform)}).map(element=>element.className||element.tagName);
   const logo=document.querySelector('.brand-logo');
   const navItems=[...document.querySelectorAll('.sidebar .nav-item')];
   // A popover in the top layer over a nav item must still win the hit test.
   const pop=document.createElement('div');pop.popover='manual';pop.setAttribute('data-error-layer','');pop.style.cssText='position:fixed;margin:0;inset:auto;left:'+(navItems[1].getBoundingClientRect().left+4)+'px;top:'+(navItems[1].getBoundingClientRect().top+4)+'px;width:60px;height:20px';document.body.append(pop);pop.showPopover();
   const popover=document.elementFromPoint(...centre(pop))===pop;pop.remove();
   return{boot:document.querySelectorAll('.boot,[data-boot-splash]').length,animations:document.getAnimations().filter(a=>String(a.animationName??'').startsWith('boot-')).length,stacked:leftovers,logo:inside(hitAt(logo),logo),nav:navItems.map(item=>inside(hitAt(item),item)),popover}})()`);
  assert.equal(result.boot,0,'splash node still in the document');
  assert.equal(result.animations,0,'a boot animation is still running');
  assert.deepEqual(result.stacked,[],'boot left an animation or transform on the app');
  assert.ok(result.logo,'the sidebar logo is not the topmost element at its centre');
  assert.ok(result.nav.length===5&&result.nav.every(Boolean),'a nav item is covered by another element: '+JSON.stringify(result.nav));
  assert.ok(result.popover,'a popover is not above the sidebar');
 }},
 {id:'boot-logo-text-sizes',stage:'boot',title:'The sidebar logo sits left of its title with a gap and overlaps neither the title nor any navigation item, at every text size',covers:['UI scale 1, 1.25, 1.6, 2'],run:async h=>{
  const probe=`(()=>{const r=e=>{const b=e.getBoundingClientRect();return{l:b.left,t:b.top,r:b.right,b:b.bottom}};const logo=document.querySelector('.brand-logo'),title=document.createRange();title.selectNodeContents(document.querySelector('.brand strong'));const l=r(logo),t=title.getBoundingClientRect(),hit=(a,b)=>a.l<b.right&&a.r>b.left&&a.t<b.bottom&&a.b>b.top;return{visible:getComputedStyle(logo).visibility==='visible',gap:t.left-l.r,width:l.r-l.l,height:l.b-l.t,title:hit(l,t),nav:[...document.querySelectorAll('.sidebar .nav-item')].some(n=>hit(l,n.getBoundingClientRect()))}})()`;
  try{for(const scale of [1,1.25,1.6,2]){
   await h.js(`document.documentElement.style.setProperty('--text-scale','${scale}')`);await h.frames(2);
   const p=await h.js<{visible:boolean;gap:number;width:number;height:number;title:boolean;nav:boolean}>(probe);
   assert.ok(p.visible,`logo visible at ${scale}`);assert.ok(!p.title&&!p.nav,`logo overlaps the title or a nav item at ${scale}`);assert.ok(p.gap>=4,`gap ${p.gap} at ${scale}`);assert.ok(Math.abs(p.width-p.height)<1&&p.width>20,`logo size ${p.width}x${p.height} at ${scale}`);
  }}finally{await h.js("document.documentElement.style.removeProperty('--text-scale')");}
 }},
];
