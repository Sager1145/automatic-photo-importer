// The standing user rules, checked on every page: no super-wide buttons, no clipping, file names only where they
// belong, stats that never move, stage and pause colours, counters that always move, every locale and both themes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {AppState,Job,Progress} from '../../../shared';
import {pages,settingsCategories,type Check,type Harness,type Page} from '../harness';
import {brokenText,clippedControls,latinPhrases,lowContrast,progressDisplays,statsGeometry,wideButtons} from '../probes';
import {groupedErrorJobs,LONG_NAME,syntheticJob} from '../synthetic';

const needsHook=async(h:Harness)=>h.hooks?undefined:'needs the QA injection hook';
const fixture=async(h:Harness,n:number)=>(await h.state()).sources.find(source=>source.id===`fixture:${n}`)!;
const card=(n:number)=>`article.source-row[data-source-id="fixture:${n}"]`;
/** Running, verifying and paused jobs on fixture cards and an organization in the overview, so every kind of bar is on screen. */
async function busyDesk(h:Harness):Promise<Job[]>{
 const jobs=[
  syntheticJob('copying',{phase:'copying',source:await fixture(h,2),file:LONG_NAME}),
  syntheticJob('verifying',{phase:'verifying',source:await fixture(h,3)}),
  syntheticJob('paused',{phase:'stopped',paused:true,source:await fixture(h,4)}),
  syntheticJob('organizing',{phase:'copying',organization:true,step:'moving',file:'2026/2026-10 October/Nikon Z6III/DSC_0042.NEF'}),
 ];
 for(const job of jobs)if(!job.organization)job.backup=job.source.backup===true;
 h.hooks!.addJobs(jobs);
 await h.js("document.querySelectorAll('details.workspace-details').forEach(details=>details.open=true)");
 // Real jobs may already show bars on these cards, so wait for what only the synthetic ones show.
 await h.until('synthetic jobs on the desk',`document.querySelector('${card(2)} [data-testid=progress-file]')?.title===${JSON.stringify(LONG_NAME)}&&document.querySelector('${card(4)} [data-state=paused]')&&Array.from(document.querySelectorAll('.import-dashboard .progress-job-place')).some(e=>e.textContent==='organizing')`);
 return jobs;
}
/** Every view: each page, and each Settings category. */
async function eachView(h:Harness,visit:(view:string,page:Page)=>Promise<void>){
 for(const page of pages){
  await h.nav(page);
  if(page!=='Settings'){await visit(page,page);continue;}
  for(const id of settingsCategories){await h.settingsTab(id);await visit(`Settings/${id}`,page);}
 }
}
/** Applies `tick` repeatedly and requires every listed counter to show a new value after each one. */
export async function assertLive(h:Harness,counters:Record<string,string>,tick:()=>void,ticks=6){
 const read=()=>h.js<Record<string,string|null>>(`Object.fromEntries(Object.entries(${JSON.stringify(counters)}).map(([k,s])=>[k,document.querySelector(s)?.textContent??null]))`);
 const latency:number[]=[];
 for(let i=0;i<ticks;i++){
  const before=await read(),started=Date.now();
  tick();
  await h.waitFor(`every counter shows update ${i+1} (${Object.keys(counters).join(', ')})`,async()=>{const now=await read();return Object.keys(counters).every(key=>now[key]!==null&&now[key]!==before[key]);},{timeoutMs:5000,seen:async()=>({before,now:await read()})});
  latency.push(Date.now()-started);
 }
 return latency;
}
const progressOf=(state:AppState,id:string)=>state.jobs.find(job=>job.id===id)!.progress!;
export const ruleChecks=():Check[]=>[
 {id:'rules-sweep',stage:'rules',title:'No button stretches far past its label and no bar or control is cut off, on every page, at every text size and window size',covers:['no super-wide buttons','bars shrink and never clip','UI scale 1, 1.25, 1.5, 1.6, 1.75, 2','windows 1000x720 to 1920x1200'],budgetMs:240000,run:async h=>{
  // Layout only: motion is emulated off so page switches do not wait for transitions.
  await h.media([{name:'prefers-reduced-motion',value:'reduce'}]);
  if(h.hooks)await busyDesk(h);
  const wide:Record<string,unknown>[]=[],clipped:Record<string,unknown>[]=[];
  for(const [w,height] of [[1000,720],[1440,940],[1920,1200]] as const){await h.size(w,height);
   for(const scale of [1,1.25,1.5,1.6,1.75,2]){await h.prefs({textScale:scale});
    await eachView(h,async(view,page)=>{
     if(scale===2&&(!view.includes('/')||view==='Settings/defaults'))await h.capture(path.join(h.report,`scale-200-${w}x${height}-${page.replace(/\s+/g,'-').toLowerCase()}.png`));
     for(const item of await h.probe(wideButtons))wide.push({window:`${w}x${height}`,scale,view,...item});
     for(const item of await h.probe(clippedControls))clipped.push({window:`${w}x${height}`,scale,view,...item});
    });
   }}
  await fs.writeFile(path.join(h.report,'button-widths.json'),JSON.stringify(wide,null,2));
  await fs.writeFile(path.join(h.report,'clipped-controls.json'),JSON.stringify(clipped,null,2));
  assert.deepEqual({wide:wide.slice(0,20),clipped:clipped.slice(0,20)},{wide:[],clipped:[]},`${wide.length} wide buttons and ${clipped.length} clipped controls (all in button-widths.json and clipped-controls.json)`);
 }},
 {id:'rules-dashboard-no-file-name',stage:'rules',title:'The overall import dashboard never shows a file name, while each card does',covers:['no file name in the overall dashboard'],skip:needsHook,run:async h=>{
  const jobs=await busyDesk(h);
  const names=jobs.map(job=>path.basename(job.progress!.file)).filter(Boolean);
  const dashboard=await h.js<{files:number;text:string}>("(()=>{const d=document.querySelector('.import-dashboard');return {files:d.querySelectorAll('[data-testid=progress-file]').length,text:d.textContent}})()");
  assert.equal(dashboard.files,0,'a file row in the dashboard');
  for(const name of names)assert.ok(!dashboard.text.includes(name.slice(0,24)),`the dashboard shows the file name ${name}`);
  assert.equal(await h.js<boolean>(`!!document.querySelector('${card(2)} [data-testid=progress-file]')`),true,'the job card names its file');
 }},
 {id:'rules-file-row-stable',stage:'rules',title:'The file-name row never moves the stats: the bar and the count, speed and time stay put whatever the file name',covers:['file-name row never moves the stats','long file names'],skip:needsHook,run:async h=>{
  const [copying]=await busyDesk(h);
  const geometry=()=>h.probe(statsGeometry,card(2));
  const setFile=async(file:string)=>{h.hooks!.mutate(state=>{progressOf(state,copying!.id).file=file;});await h.until('file row updated',file?`document.querySelector('${card(2)} [data-testid=progress-file]')?.title===${JSON.stringify(file)}`:`!document.querySelector('${card(2)} [data-testid=progress-file]')`);};
  await setFile('DSC_0001.ARW');const short=await geometry();
  await setFile(LONG_NAME);const long=await geometry();
  await setFile('');const none=await geometry();
  assert.ok(short,'progress display on the card');
  assert.deepEqual(long,short,'a long file name moved the stats');
  assert.deepEqual(none,short,'the file row appearing or going moved the stats');
  await setFile(LONG_NAME);
  assert.equal(await h.js<boolean>(`(()=>{const f=document.querySelector('${card(2)} [data-testid=progress-file]'),c=document.querySelector('${card(2)}');return f.getBoundingClientRect().right<=c.getBoundingClientRect().right+1&&f.textContent.length<${LONG_NAME.length}})()`),true,'a long file name is shortened inside its card');
 }},
 {id:'rules-paused-steps',stage:'rules',title:'A paused job marks its step in the warning colour',covers:['paused state is yellow'],skip:needsHook,run:async h=>{
  await busyDesk(h);
  const colours=await h.js<{mark:string;warning:string}>(`(()=>{const i=document.createElement('i');i.style.color='var(--warning)';document.body.append(i);const warning=getComputedStyle(i).color;i.remove();const mark=document.querySelector('${card(4)} [data-state=paused]');return {mark:mark?getComputedStyle(mark).color:'',warning};})()`);
  assert.equal(colours.mark,colours.warning,'paused step marker colour');
 }},
 {id:'rules-paused-bar',stage:'rules',title:'A paused job’s bar turns yellow',covers:['paused bars turn yellow'],skip:needsHook,run:async h=>{
  await busyDesk(h);
  const displays=(await h.probe(progressDisplays)).filter(display=>display.cardText.includes('Fixture card 4'));
  assert.ok(displays.length,'the paused card shows its bar');
  assert.ok(displays.every(display=>display.paused&&display.layers.length>0&&display.layers.every(layer=>layer.fill===display.warning)),`paused bar is not yellow: ${JSON.stringify(displays)}`);
 }},
 {id:'rules-stage-colours',stage:'rules',title:'Each step colours its bar with its own stage colour, in light and dark, and the passed steps stay layered beneath it',covers:['per-step colours','stage-coloured layered bars','light and dark mode'],skip:needsHook,run:async h=>{
  // An organization runs through every stage (an import card shows only scan, copy and verify), so its card is stepped through them.
  const organizing=(await busyDesk(h))[3]!;await h.nav('Jobs');const orgCard=`li.queue-row[data-source-id=${JSON.stringify(organizing.source.id)}]`;
  const steps:[Progress['phase'],Progress['step']|undefined,string][]=[['planning','listing','scan'],['planning','checking','read'],['planning','comparing','compare'],['copying','moving','move'],['copying',undefined,'copy'],['verifying',undefined,'verify'],['copying','tidying','tidy'],['copying','deleting','delete']];
  for(const appearance of ['light','dark'] as const){
   await h.prefs({appearance});
   const fills=new Map<string,string>();
   for(const [index,[phase,step,kind]] of steps.entries()){
    h.hooks!.mutate(state=>{const progress=progressOf(state,organizing.id);progress.phase=phase;if(step)progress.step=step;else delete progress.step;});
    await h.until(`step ${kind}`,`document.querySelector(${JSON.stringify(orgCard+' [data-progress-display]')})?.dataset.step===${JSON.stringify(kind)}`);
    const display=(await h.probe(progressDisplays)).find(item=>item.cardText.includes('QA synthetic/organizing'))!;
    const top=display.layers.at(-1);
    assert.ok(top&&top.step===kind&&top.fill===top.stepColor,`${appearance} ${kind}: the top layer is ${JSON.stringify(top)} (${JSON.stringify(display.layers)})`);
    assert.equal(display.layers.length,index+1,`${appearance} ${kind}: one layer per stage so far: ${JSON.stringify(display.layers)}`);
    fills.set(kind,top!.fill);
   }
   assert.equal(new Set(fills.values()).size,steps.length,`${appearance}: two steps share a colour ${JSON.stringify([...fills])}`);
  }
 }},
 {id:'rules-layered-bars',stage:'rules',title:'Layered bars stack one stage-coloured layer per step inside the track',covers:['stage-coloured layered bars'],skip:needsHook,run:async h=>{
  await busyDesk(h);
  // The verifying card stacks its copy and verify layers.
  const displays=await h.probe(progressDisplays),layered=displays.filter(display=>display.layers.length>1);
  assert.ok(layered.some(display=>display.cardText.includes('Fixture card 3')),`no layered bar on the verifying card: ${JSON.stringify(displays.map(display=>({card:display.cardText.slice(0,30),layers:display.layers})))}`);
  for(const display of layered){
   const stepped=display.layers.filter(layer=>layer.step);
   assert.equal(stepped.length,display.layers.length,`every layer carries its step: ${JSON.stringify(display)}`);
   if(!display.paused)for(const layer of stepped)assert.equal(layer.fill,layer.stepColor,`the ${layer.step} layer has its stage colour: ${JSON.stringify(display.layers)}`);
   if(!display.paused)assert.equal(new Set(stepped.map(layer=>layer.fill)).size,new Set(stepped.map(layer=>layer.step)).size,`each step layer has its own colour: ${JSON.stringify(display.layers)}`);
  }
  assert.deepEqual(await h.probe(clippedControls),[],'a layer spills out of its track');
 }},
 {id:'rules-live-counters',stage:'rules',title:'Every counter on screen moves with its job: card counts, the dashboard total and files, the organization, and the sidebar',covers:['everything must update (no frozen counters)'],skip:needsHook,run:async h=>{
  const [copying,,,organizing]=await busyDesk(h);
  const counters:Record<string,string>={'card count':`${card(2)} [data-testid=progress-count]`,'dashboard total':'[data-testid=total-progress] [data-testid=progress-count]','dashboard files':'.import-dashboard .dashboard-metrics>div:nth-child(4) dd','organization count':'.import-dashboard .progress-jobs [data-testid=progress-count]'};
  if(await h.js<boolean>("!!document.querySelector('.sidebar-dest-progress,.sidebar-dest-percent')"))counters['sidebar destination']='.sidebar-dest-progress,.sidebar-dest-percent';
  const latency=await assertLive(h,counters,()=>h.hooks!.mutate(state=>{for(const id of [copying!.id,organizing!.id]){const p=progressOf(state,id);p.completed+=23;p.bytes+=900e6;p.file=`DCIM/100MSDCF/DSC_${p.completed}.ARW`;}}));
  h.notes.qaLatency=latency;
 }},
 {id:'rules-locales',stage:'rules',title:'All four locales render every page and Settings category without missing translations, broken placeholders or overflow',covers:['4 locales','no missing keys','no clipping'],budgetMs:180000,run:async h=>{
  await h.media([{name:'prefers-reduced-motion',value:'reduce'}]);
  await h.size(1000,720);
  const s=await h.state();
  // User data is the same in every language: drive names, paths and folder names.
  const userData=[...s.sources.map(source=>source.name),...s.preferences.destinations,'Automatic Photo Importer','Nikon Z6III','Fixture'];
  // Known, reported: the main process names the library an organization reads 'Existing library' in English (main.ts previewOrganization).
  const knownUntranslated=['Existing library'];
  const english=new Map<string,Set<string>>(),problems:Record<string,unknown>[]=[];
  for(const scale of [1.25,1.6]){await h.prefs({textScale:scale});
   for(const language of ['en','zh-Hans','zh-Hant','ja'] as const){
    await h.prefs({language});
    await eachView(h,async view=>{
     for(const text of await h.probe(brokenText))problems.push({language,scale,view,kind:'broken text',text});
     for(const item of await h.probe(clippedControls))problems.push({language,scale,view,kind:'overflow',...item});
     const phrases=await h.probe(latinPhrases);
     if(language==='en'){english.set(view,new Set(phrases));return;}
     for(const text of phrases)if(english.get(view)?.has(text)&&!userData.some(data=>text.includes(data))&&!text.includes('/')&&!/\.\w{2,4}$/.test(text)&&!knownUntranslated.includes(text))problems.push({language,scale,view,kind:'untranslated',text});
    });
    if(scale===1.25)await h.capture(path.join(h.report,'locales',`${language}.png`));
   }}
  await fs.writeFile(path.join(h.report,'locale-problems.json'),JSON.stringify(problems,null,2));
  const unique=[...new Map(problems.map(item=>[`${item.language} ${item.kind} ${item.text??item.control}`,item])).values()];
  assert.deepEqual(unique.slice(0,25),[],`${unique.length} locale problems (all in locale-problems.json)`);
 }},
 {id:'rules-themes-gallery',stage:'rules',title:'Light and dark mode render every page legibly; a screenshot of each page, category and panel per theme goes to the gallery',covers:['light and dark mode','text contrast','screenshot set per page and theme'],budgetMs:180000,skip:needsHook,run:async h=>{
  const gallery=path.join(h.report,'gallery'),issues:Record<string,unknown>[]=[],index:string[]=[];
  for(const appearance of ['light','dark'] as const){
   await h.prefs({appearance});await h.until(`theme ${appearance}`,`document.documentElement.dataset.theme===${JSON.stringify(appearance)}`);
   const background=await h.js<number>("(()=>{const m=getComputedStyle(document.body).backgroundColor.match(/[\\d.]+/g).map(Number);return (m[0]*.2126+m[1]*.7152+m[2]*.0722)/255})()");
   assert.ok(appearance==='dark'?background<.3:background>.7,`${appearance} page background luminance ${background}`);
   // Normal text needs 4.5:1; the probe allows 3:1 for large text.
   const take=async(name:string)=>{await h.settle();for(const item of await h.probe(lowContrast,4.5))issues.push({appearance,view:name,...item});const file=path.join(appearance,name.replace(/[^\w-]+/g,'-').toLowerCase()+'.png');await h.capture(path.join(gallery,file));index.push(file);};
   await eachView(h,view=>take(view));
   await h.nav('Import desk');await busyDesk(h);await take('import-desk-busy');
   h.hooks!.addJobs(groupedErrorJobs(1200,3));await h.click('[data-testid=show-errors]');await h.until('issues list',"document.querySelector('[data-testid=activity-panel]')");await take('all-errors-grouped');
   await h.closeOverlays();h.hooks!.clear();
   await h.nav('Settings');await h.settingsTab('general');
   for(const accent of ['ocean','forest','coral'] as const){await h.prefs({accent});await take(`settings-general-${accent}`);}
  }
  await fs.writeFile(path.join(gallery,'index.html'),`<!doctype html><meta charset="utf-8"><title>QA gallery</title><style>body{font:14px system-ui;margin:16px;background:#888}figure{display:inline-block;margin:8px;width:420px}img{width:100%;border:1px solid #444}</style>${index.map(file=>`<figure><img src="${file}" loading="lazy"><figcaption>${file}</figcaption></figure>`).join('')}`);
  await fs.writeFile(path.join(h.report,'contrast.json'),JSON.stringify(issues,null,2));
  const unique=[...new Map(issues.map(item=>[`${item.appearance} ${item.text} ${item.color}`,item])).values()];
  const open=unique;
  assert.deepEqual(open.slice(0,25),[],`${open.length} texts below their required contrast (all in contrast.json)`);
 }},
];
