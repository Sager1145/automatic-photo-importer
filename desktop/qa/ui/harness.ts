// The QA harness: helpers every check uses, and the runner that gives each check a clean start, a time budget,
// a timing and a screenshot when it fails. Waits poll a condition; nothing sleeps for a fixed time.
import assert from 'node:assert/strict';
import {nativeTheme,screen,type BrowserWindow} from 'electron';
import {AsyncLocalStorage} from 'node:async_hooks';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {Action,AppState,Preferences} from '../../shared';
import {createStateReceiver,type StateUpdate} from '../../state-channel';
import {lockedPreferenceKeys,settingsLocked} from '../../settings-lock';
import {SYNTHETIC,type QaHooks} from '../hooks';
import {Heartbeat,pulses} from './heartbeat';
import {createStallWatch} from '../stall-watch';

export type Page='Import desk'|'Import'|'Files & folders'|'Drives'|'Library tools'|'Organization'|'Duplicates'|'Activity'|'Jobs'|'History'|'Issues'|'Recovery'|'Settings';
export const pages:Page[]=['Import','Files & folders','Organization','Duplicates','Jobs','History','Issues','Recovery','Settings'];
export const pageTitle=(page:Page)=>['Import desk','Import','Files & folders'].includes(page)?'Import':['Library tools','Organization','Duplicates','Recovery'].includes(page)?'Library tools':['Activity','Jobs','History','Issues'].includes(page)?'Activity':'Settings';
export const settingsCategories=['general','storage','folders','defaults','files','devices','performance','diagnostics'];
export const workspaceRoute=(page:Page):{page:string;tab?:string;mode?:string}=>{
 if(page==='Drives')return {page:'settings',tab:'settings-tab-devices'};
 if(page==='Settings')return {page:'settings'};
 if(['Import desk','Import','Files & folders'].includes(page))return {page:'desk',mode:page==='Import'?'import-mode-media':'import-mode-files'};
 if(['Library tools','Organization','Duplicates','Recovery'].includes(page))return {page:'library',tab:page==='Duplicates'?'library-duplicates':page==='Recovery'?'library-recovery':'library-organize'};
 return {page:'activity',tab:'activity-'+(({History:'history',Issues:'issues'} as Record<string,string>)[page]??'jobs')};
};
export type Stage='boot'|'navigation'|'imports'|'organization'|'duplicates'|'settings'|'errors'|'recovery'|'rules'|'stress'|'final';
export const stages:Stage[]=['boot','navigation','imports','organization','duplicates','settings','errors','recovery','rules','stress','final'];
/** ui: every run; import: real copies (not with --ui-only); organization: real organization runs (full and --organization-only). */
export type Suite='ui'|'import'|'organization';

export interface Check {
 id:string;stage:Stage;title:string;
 /** The behaviours and standing rules this check guards, for the report. */
 covers:string[];
 suite?:Suite;
 /** A reason to skip, for features that are not on this build yet. */
 skip?:(h:Harness)=>Promise<string|undefined>;
 budgetMs?:number;
 run:(h:Harness)=>Promise<void>;
}
export interface CheckResult {id:string;stage:Stage;title:string;covers:string[];status:'passed'|'failed'|'skipped';ms:number;at?:string;error?:string;reason?:string;screenshot?:string}

class Cancelled extends Error {constructor(){super('Check cancelled after its time budget ran out');}}
/** Thrown by a check that finds the feature it tests is not on this build. */
export class SkipCheck extends Error {}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export class Harness {
 readonly report:string;
 /** Waits and budgets stretch with the machine's load (1 to 3 times). */
 get scale():number{return Math.min(3,Math.max(1,os.loadavg()[0]!/Math.max(1,os.cpus().length)));}
 readonly heartbeat=new Heartbeat(10000);
 /** The stall watch sees what the renderer receives, the heartbeat what the main process holds; both use a 10 s limit. */
 readonly stalls=createStallWatch();
 private receiver=createStateReceiver();
 /** Each check runs with its own token, carried through its awaits: a check abandoned after its budget stops at its
  * next harness call even while the next check runs. */
 private tokens=new AsyncLocalStorage<{cancelled:boolean}>();
 private initial!:{content:[number,number];theme:typeof nativeTheme.themeSource};
 private emulated=false;
 private metrics=false;
 /** The sidebar labels in English, in order: navigation clicks by position, so it works in every language. */
 private navLabels:string[]=[];
 /** Names of in-page values a check left behind, removed at the next baseline. */
 notes:Record<string,unknown>={};
 /** When the whole run must be over (epoch ms): checks get at most the time left, and the rest are not run once it is gone. */
 deadline=Infinity;
 constructor(readonly window:BrowserWindow,readonly root:string,readonly hooks?:QaHooks){
  this.report=path.join(root,'artifacts');
 }
 /** Call once the boot splash is gone. */
 async start(){
  await fs.mkdir(path.join(this.report,'failures'),{recursive:true});
  this.navLabels=await this.js<string[]>("Array.from(document.querySelectorAll('.nav-item')).map(b=>b.textContent.trim())");
  const [width,height]=this.window.getContentSize();this.initial={content:[width!,height!],theme:nativeTheme.themeSource};
 }
 private alive(){if(this.tokens.getStore()?.cancelled)throw new Cancelled();}
 /** Runs JavaScript in the page. A renderer that does not answer within 30 s (times the load scale) fails the check instead of hanging the run. */
 async js<T>(source:string):Promise<T>{
  this.alive();let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([this.window.webContents.executeJavaScript(source) as Promise<T>,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`The renderer did not answer within ${Math.round(30*this.scale)} s: ${source.slice(0,160)}`)),30000*this.scale);})]);}
  finally{clearTimeout(timer);this.alive();}
 }
 /** Runs a probe from probes.ts in the renderer. */
 probe<T,A extends unknown[]>(fn:(...args:A)=>T,...args:A):Promise<T>{return this.js<T>(`(${fn.toString()})(...${JSON.stringify(args)})`);}
 async state():Promise<AppState>{
  const current=this.receiver.apply(await this.js<StateUpdate>('window.importer.state()'))!;
  // Synthetic jobs stand still on purpose.
  this.stalls.observe({...current,jobs:current.jobs.filter(job=>!job.id.startsWith(SYNTHETIC))});
  return current;
 }
 async action(value:Action):Promise<AppState>{await this.js<void>(`window.importer.action(${JSON.stringify(value)})`);return this.state();}
 /** Polls `test` until it holds. The error names what was awaited and, when given, what was last seen. */
 async waitFor(label:string,test:()=>Promise<boolean>|boolean,options:{timeoutMs?:number;seen?:()=>Promise<unknown>|unknown;interval?:number}={}):Promise<void>{
  // No wait outlasts the run's deadline, so the report is always written in time.
  const end=Math.min(Date.now()+(options.timeoutMs??20000)*this.scale,this.deadline);
  for(;;){
   this.alive();
   if(await test())return;
   if(Date.now()>end){let seen='';try{seen=options.seen?' — last seen: '+JSON.stringify(await options.seen()).slice(0,600):'';}catch{}throw new Error(`Timed out after ${Math.round((options.timeoutMs??20000)*this.scale/1000)} s waiting for: ${label}${seen}`);}
   await sleep(options.interval??50);
  }
 }
 /** Waits until the page condition (a JavaScript expression) is true. */
 until(label:string,expression:string,timeoutMs?:number){return this.waitFor(label,()=>this.js<boolean>(`!!(${expression})`),{timeoutMs});}
 /** Two animation frames: layout and paint caught up with the last change. */
 frames(count=2){return this.js<void>(`new Promise(r=>{let n=${count};const f=()=>--n<=0?r():requestAnimationFrame(f);requestAnimationFrame(f);})`);}
 /** Every finite animation and View Transition has finished; spinners and scroll-driven effects never finish and are ignored. */
 async settle(){await this.frames(1);await this.until('interface settled',"!document.documentElement.dataset.transition&&document.getAnimations().every(a=>a.playState!=='running'||a.timeline!==document.timeline||a.effect?.getTiming().iterations===Infinity)");}
 /** capturePage can return the last composited frame, so two new frames are drawn first. */
 async capture(file:string){await this.frames(2);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,(await this.window.webContents.capturePage()).toPNG());}
 /** capturePage cannot draw a View Transition mid-flight, so screenshots wait for the interface to settle. */
 async shot(name:string){await this.settle();await this.capture(path.join(this.report,name+'.png'));}
 click(selector:string){return this.js<boolean>(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true;})()`);}
 async nav(page:Page){
  const route=workspaceRoute(page),selector=`.nav-item[data-page="${route.page}"]`;
  if(!await this.click(selector))throw new Error(`No navigation item ${page} (${selector})`);
  await this.until(`workspace ${page}`,`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-current')==='page'`);await this.settle();
  if(route.mode){if(!await this.click(`[data-testid=${route.mode}]`))throw new Error(`Missing import mode ${route.mode}`);await this.settle();}
  if(route.tab){if(!await this.click(`[data-testid=${route.tab}],#${route.tab}`))throw new Error(`Missing task tab ${route.tab}`);await this.settle();}
  if(await this.js<string>('document.documentElement.lang')==='en')assert.equal(await this.js<string>("document.querySelector('.window-titlebar h1')?.textContent"),pageTitle(page));
 }
 async settingsTab(id:string){
  const current=({importing:'defaults',destinations:'storage',organization:'files',drives:'devices'} as Record<string,string>)[id]??id;
  if(!await this.js<boolean>("!!document.querySelector('.settings-page')"))await this.nav('Settings');
  if(!await this.click(`#settings-tab-${current}`))throw new Error(`No Settings category ${current}`);
  await this.until(`settings category ${current}`,`document.querySelector('#settings-tab-${current}')?.getAttribute('aria-selected')==='true'`);await this.settle();
 }
 /** Applies a settings change and waits until the state shows it. Settings that jobs read are dropped while anything is
  * running or scanning, so those first wait for idle (stopping read-only scans) and are sent again until they hold. */
 async prefs(patch:Partial<Preferences>){
  const holds=(s:AppState)=>Object.entries(patch).every(([key,value])=>JSON.stringify(s.preferences[key as keyof Preferences])===JSON.stringify(value));
  if(holds(await this.state()))return;
  const locked=lockedPreferenceKeys(patch).length>0;
  await this.waitFor(`settings ${JSON.stringify(patch)} applied`,async()=>{
   let s=await this.state();
   if(locked&&settingsLocked(s)){if(s.scanningSources?.length&&!s.jobs.some(job=>['discovering','verifying','copying','queued'].includes(job.phase)))await this.action({type:'stop'});return false;}
   s=await this.action({type:'preferences',patch});return holds(s);
  },{interval:200,seen:async()=>{const s=await this.state();return {preferences:Object.fromEntries(Object.keys(patch).map(key=>[key,s.preferences[key as keyof Preferences]])),locked:settingsLocked(s),scanning:s.scanningSources};}});
  if('textScale' in patch)await this.until(`text scale ${patch.textScale}`,`getComputedStyle(document.documentElement).getPropertyValue('--text-scale').trim()===${JSON.stringify(String(patch.textScale))}`);
  if('language' in patch)await this.until(`language ${patch.language}`,`document.documentElement.lang===${JSON.stringify(patch.language)}`);
 }
 /** Waits until nothing locks the job settings, stopping read-only scans (never imports) on the way. */
 async idle(){
  await this.waitFor('nothing running or scanning',async()=>{
   const s=await this.state();if(!settingsLocked(s))return true;
   if(s.scanningSources?.length&&!s.jobs.some(job=>['discovering','verifying','copying','queued'].includes(job.phase)))await this.action({type:'stop'});
   return false;
  },{interval:200,seen:async()=>{const s=await this.state();return {jobs:s.jobs.map(job=>job.phase),scanning:s.scanningSources,review:!!s.review};}});
 }
 /** Sets the viewport: the window's content size when the screen has room, else an emulated viewport of that size
  * (a window cannot grow past the screen, so a large layout is checked through device metrics emulation). */
 async size(width:number,height:number){
  const area=screen.getDisplayMatching(this.window.getBounds()).workAreaSize;
  if(width<=area.width&&height<=area.height){if(this.metrics){await this.cdp('Emulation.clearDeviceMetricsOverride',{});this.metrics=false;}this.window.setContentSize(width,height);}
  else{await this.cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:0,mobile:false});this.metrics=true;}
  await this.until(`viewport ${width}x${height}`,`innerWidth===${width}&&innerHeight===${height}`);
 }
 private async cdp(method:string,params:Record<string,unknown>){const d=this.window.webContents.debugger;if(!d.isAttached())d.attach();return d.sendCommand(method,params);}
 /** Emulates media features (prefers-reduced-motion, prefers-color-scheme); an empty list restores the real ones. */
 async media(features:{name:string;value:string}[]){await this.cdp('Emulation.setEmulatedMedia',{features});this.emulated=features.length>0;}
 /** Keeps focus and blur events flowing while another app holds the OS focus. */
 focusEmulation(){return this.cdp('Emulation.setFocusEmulationEnabled',{enabled:true});}
 async closeOverlays(){
  await this.js(`(()=>{for(const id of ['activity-close','metadata-close'])document.querySelector('[data-testid='+id+']')?.click();document.querySelector('[data-testid=error-toast] button[aria-label=Dismiss],[data-testid=warning-toast] button[aria-label=Dismiss]')?.click();for(const d of document.querySelectorAll('dialog[open]:not(.activity-dialog):not(.metadata-dialog)'))d.dispatchEvent(new Event('cancel',{cancelable:true}));})()`);
  await this.until('sheets and error toasts closed',"!document.querySelector('dialog[open],[data-testid=error-toast],[data-testid=warning-toast]')");
 }
 /** Dismisses the error toast; transitions are suspended while it is up. */
 async clearToast(){await this.js("document.querySelector('[data-testid=error-toast] button[aria-label=Dismiss],[data-testid=warning-toast] button[aria-label=Dismiss]')?.click()");await this.until('error toast dismissed',"!document.querySelector('[data-testid=error-toast],[data-testid=warning-toast]')");}
 /** The state every check starts from: no synthetic state or emulation, the start-up window, English at 125%, the Import desk. */
 async baseline(){
  this.hooks?.clear();this.releaseHold?.();this.releaseHold=undefined;
  if(this.emulated)await this.media([]);
  await this.js(`(()=>{for(const key of ${JSON.stringify(Object.keys(this.notes))})delete window[key];})()`);this.notes={};
  const [width,height]=this.window.getContentSize();if(this.metrics||width!==this.initial.content[0]||height!==this.initial.content[1])await this.size(...this.initial.content);
  await this.closeOverlays();
  // Real work a failed check left running would change what the next check sees: stop it and wait.
  if((await this.state()).jobs.some(job=>!job.id.startsWith(SYNTHETIC)&&['queued','discovering','verifying','copying'].includes(job.phase))){
   await this.action({type:'stop'});
   await this.waitFor('leftover jobs stopped',async()=>!(await this.state()).jobs.some(job=>['queued','discovering','verifying','copying'].includes(job.phase)),{timeoutMs:30000});
  }
  const s=await this.state();
  if(s.review&&!s.busyReview)await this.action({type:'discardReview'});
  const want:Partial<Preferences>={language:'en',textScale:1.25,sourceLayout:'list',appearance:'system',showDashboard:true};
  const patch=Object.fromEntries(Object.entries(want).filter(([key,value])=>s.preferences[key as keyof Preferences]!==value));
  if(Object.keys(patch).length)await this.prefs(patch);
  if(nativeTheme.themeSource!==this.initial.theme)nativeTheme.themeSource=this.initial.theme;
  await this.nav('Import desk');
  await this.settle();
 }
 releaseHold?:()=>void;
 /** The check running now, for the heartbeat's report. */
 current?:string;
 /** Samples the main process counters for the heartbeat until stopped. */
 startHeartbeat(){
  // States are also polled each second, so quiet stretches between checks' own reads are seen by the stall watch.
  const poller=setInterval(()=>{void this.state().catch(()=>{});},1000);
  if(!this.hooks)return()=>clearInterval(poller);
  const hooks=this.hooks,timer=setInterval(()=>this.heartbeat.sample(pulses(hooks.peek(),hooks.held()),Date.now(),this.current),250);
  return()=>{clearInterval(timer);clearInterval(poller);};
 }
 /** Runs checks in order, each from the baseline, and records the outcome of every one. */
 async run(checks:Check[],selected:(check:Check)=>string|undefined):Promise<CheckResult[]>{
  const results:CheckResult[]=[];let baselineFailures=0;
  for(const check of checks){
   const base={id:check.id,stage:check.stage,title:check.title,covers:check.covers,at:new Date().toISOString()};
   const excluded=selected(check);if(excluded){results.push({...base,status:'skipped',ms:0,reason:excluded});continue;}
   if(baselineFailures>=2){results.push({...base,status:'skipped',ms:0,reason:'not run: the app could not be brought back to its start state'});continue;}
   // The final checks are quick and always run; others need time left before the deadline.
   const left=this.deadline-Date.now()-(check.stage==='final'?0:20000);
   if(left<5000){results.push({...base,status:'failed',ms:0,error:'Not run: the run ran out of time before this check'});console.error(`QA FAIL [${check.stage}] ${check.title}: not run, out of time`);continue;}
   console.log(`QA RUN  [${check.stage}] ${check.id}`);
   this.current=check.id;const token={cancelled:false};
   const started=Date.now();
   try{
    await this.baseline();baselineFailures=0;
    const reason=await this.tokens.run(token,()=>check.skip?.(this));
    if(reason){results.push({...base,status:'skipped',ms:Date.now()-started,reason});console.log(`QA SKIP [${check.stage}] ${check.title}: ${reason}`);continue;}
    const budget=Math.min((check.budgetMs??90000)*this.scale,left);let timer:NodeJS.Timeout|undefined;
    try{await Promise.race([this.tokens.run(token,()=>check.run(this)),new Promise((_,reject)=>{timer=setTimeout(()=>{token.cancelled=true;reject(new Error(`Exceeded its ${Math.round(budget/1000)} s budget`));},budget);})]);}
    finally{clearTimeout(timer);}
    const ms=Date.now()-started;results.push({...base,status:'passed',ms});console.log(`QA PASS [${check.stage}] ${check.title} (${(ms/1000).toFixed(1)} s)`);
   }catch(error){
    token.cancelled=true;
    if(error instanceof SkipCheck){results.push({...base,status:'skipped',ms:Date.now()-started,reason:error.message});console.log(`QA SKIP [${check.stage}] ${check.title}: ${error.message}`);try{await this.baseline();}catch{baselineFailures++;}continue;}
    const ms=Date.now()-started,screenshot=path.join('failures',check.id+'.png');
    console.error(`QA FAIL [${check.stage}] ${check.title} (${(ms/1000).toFixed(1)} s)`,error);
    try{await this.capture(path.join(this.report,screenshot));}catch{}
    try{await fs.writeFile(path.join(this.report,'failures',check.id+'.state.json'),JSON.stringify(await this.state(),null,1));}catch{}
    results.push({...base,status:'failed',ms,error:error instanceof Error?error.stack??error.message:String(error),screenshot});
    try{await this.baseline();}catch(cleanup){baselineFailures++;console.error('QA baseline after failure:',cleanup);}
   }
  }
  return results;
 }
}

/** The human-readable report: every check, its outcome and what it covers. */
export function markdownReport(suite:string,results:CheckResult[],extra:{seconds:number;load:number;heartbeat:{samples:number;starvedMs:number;freezes:number}}):string{
 const icon={passed:'PASS',failed:'FAIL',skipped:'SKIP'};
 const lines=[`# UI QA report (${suite} suite)`,'',`${results.filter(r=>r.status==='passed').length} passed, ${results.filter(r=>r.status==='failed').length} failed, ${results.filter(r=>r.status==='skipped').length} skipped in ${extra.seconds.toFixed(0)} s (load average ${extra.load.toFixed(0)}).`,`Heartbeat: ${extra.heartbeat.samples} samples, ${extra.heartbeat.freezes} frozen counters, ${(extra.heartbeat.starvedMs/1000).toFixed(1)} s of sampler starvation ignored.`,''];
 for(const stage of stages){
  const rows=results.filter(r=>r.stage===stage);if(!rows.length)continue;
  lines.push(`## ${stage[0]!.toUpperCase()+stage.slice(1)}`,'','| | Check | Covers | Time |','|---|---|---|---|');
  for(const r of rows)lines.push(`| ${icon[r.status]} | ${r.title.replace(/\|/g,'\\|')}${r.reason?` _(${r.reason.replace(/\|/g,'\\|')})_`:''}${r.error?`<br>\`${r.error.split('\n')[0]!.replace(/\|/g,'\\|').slice(0,300)}\``:''} | ${r.covers.join('; ').replace(/\|/g,'\\|')} | ${r.status==='skipped'&&!r.ms?'':(r.ms/1000).toFixed(1)+' s'} |`);
  lines.push('');
 }
 return lines.join('\n');
}
