import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {CatalogQuery} from '../../../catalog/types';
import type {Preferences} from '../../../shared';
import type {Check,Harness} from '../harness';

const storageKey='photo-importer.browser.v1';
const config=(h:Harness)=>h.js<any>(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}))`);
const organizationKeys=['template','mediaLayout','videoTemplate','unknownRules','basePath','videoBasePath','editedFolder','noMetadataHandling','noMetadataFolder','conflictNaming','collectProblemFiles','removeAppleDouble'] as const;
const organizationPreferences=(p:Preferences)=>Object.fromEntries(organizationKeys.map(k=>[k,p[k]]));
async function mediaSnapshot(files:string[]){
 return Promise.all(files.map(async file=>{const s=await fs.stat(file,{bigint:true});return {path:file,size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs),sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')};}));
}
async function fixtureTree(root:string){
 const files:string[]=[],directories:string[]=[];
 const walk=async(dir:string):Promise<void>=>{directories.push(dir);for(const e of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())await walk(file);else if(e.isFile())files.push(file);}};
 for(const name of ['source-1','source-2','source-3','source-4','source-5','source-6','destination','destination-2'])await walk(path.join(root,name));
 return {directories:directories.sort(),files:await mediaSnapshot(files.sort())};
}
async function enter(h:Harness){
 assert.ok(await h.click('.nav-item[data-page="browser"]'),'Library browser navigation exists');
 await h.until('Library browser page',"document.querySelector('[data-testid=library-browser]')");await h.settle();
 await h.js("document.querySelector('[data-testid=browser-presets]').open=true;document.querySelector('[data-testid=hierarchy-editor]').open=true");
}
async function choosePreset(h:Harness,id:string){assert.ok(await h.click(`[data-preset-id="${id}"]`));await h.frames();await h.until('preset applied',`document.querySelector('[data-preset-id="${id}"]')?.getAttribute('aria-pressed')==='true'`);}
async function setField(h:Harness,label:string,value:string){
 assert.ok(await h.js<boolean>(`(()=>{const label=Array.from(document.querySelectorAll('label')).find(e=>e.firstChild?.textContent?.trim()===${JSON.stringify(label)});const e=label?.querySelector('input,select');if(!e)return false;Object.getOwnPropertyDescriptor(e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return true;})()`),`Field ${label} exists`);await h.frames();
}
async function button(h:Harness,text:string){assert.ok(await h.js<boolean>(`(()=>{const e=Array.from(document.querySelectorAll('button')).find(e=>e.textContent?.trim()===${JSON.stringify(text)});e?.click();return !!e;})()`),`Button ${text} exists`);await h.frames();}
async function press(h:Harness,keyCode:string,modifiers:('control'|'meta'|'shift')[]=[]){
 h.window.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});if(keyCode==='Enter')h.window.webContents.sendInputEvent({type:'char',keyCode:'\r',modifiers});h.window.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await h.frames();
}
async function key(h:Harness,selector:string,keyCode:string,modifiers:('control'|'meta'|'shift')[]=[]){
 assert.ok(await h.js<boolean>(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e?.focus();return !!e;})()`));await press(h,keyCode,modifiers);
}
const facetLabels=(h:Harness)=>h.js<string[]>("Array.from(document.querySelectorAll('[data-testid=facet-column][data-column-index=\"0\"] [role=option] > span')).map(e=>e.textContent.trim())");
/** Chromium intercepts its native drag data, then delivers trusted dragenter/over/drop through CDP. */
async function drag(h:Harness,source:string,target:string){
 await h.js(`(()=>{window.__browserDrag=[];for(const type of ['dragstart','drop'])document.addEventListener(type,e=>window.__browserDrag.push({type:e.type,trusted:e.isTrusted}),{once:true,capture:true});document.querySelector(${JSON.stringify(source)}).scrollIntoView({block:'nearest'});})()`);
 const points=await h.js<{sx:number;sy:number;tx:number;ty:number}>(`(()=>{const a=document.querySelector(${JSON.stringify(source)}).getBoundingClientRect(),b=document.querySelector(${JSON.stringify(target)}).getBoundingClientRect();return {sx:Math.round(a.x+a.width/2),sy:Math.round(a.y+a.height/2),tx:Math.round(b.x+b.width/2),ty:Math.round(b.y+b.height/2)};})()`);
 const debuggerClient=h.window.webContents.debugger;if(!debuggerClient.isAttached())debuggerClient.attach();
 let dragData:unknown;const intercepted=(_event:unknown,method:string,params:any)=>{if(method==='Input.dragIntercepted')dragData=params.data;};debuggerClient.on('message',intercepted);
 await debuggerClient.sendCommand('Input.setInterceptDrags',{enabled:true});
 try{
  h.window.webContents.sendInputEvent({type:'mouseMove',x:points.sx,y:points.sy});h.window.webContents.sendInputEvent({type:'mouseDown',x:points.sx,y:points.sy,button:'left',clickCount:1});
  for(let i=1;i<=6;i++){h.window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(points.sx+(points.tx-points.sx)*i/6),y:Math.round(points.sy+(points.ty-points.sy)*i/6),button:'left'});await h.frames(1);}
  await h.waitFor('native Chromium drag data intercepted',()=>!!dragData,{timeoutMs:3000});
  for(const type of ['dragEnter','dragOver','drop'])await debuggerClient.sendCommand('Input.dispatchDragEvent',{type,x:points.tx,y:points.ty,data:dragData});
  h.window.webContents.sendInputEvent({type:'mouseUp',x:points.tx,y:points.ty,button:'left',clickCount:1});await h.frames();
 }finally{await debuggerClient.sendCommand('Input.setInterceptDrags',{enabled:false});debuggerClient.off('message',intercepted);}
 const events=await h.js<{type:string;trusted:boolean}[]>('window.__browserDrag');assert.ok(events.some(e=>e.type==='dragstart'&&e.trusted),'Native trusted dragstart observed');assert.ok(events.some(e=>e.type==='drop'&&e.trusted),'Native trusted drop observed');await fs.appendFile(path.join(h.report,'browser-native-drags.jsonl'),JSON.stringify({source,target,events})+'\n');
}
async function assertKinds(h:Harness,kinds:string[]){await h.waitFor('hierarchy '+kinds.join(' → '),async()=>JSON.stringify((await config(h)).blocks.map((b:any)=>b.kind))===JSON.stringify(kinds));}
async function selectFirst(h:Harness,depth:number){const selector=`[data-testid=facet-column][data-column-index="${depth}"] [role=option]`;await h.until(`facet ${depth} populated`, `document.querySelector(${JSON.stringify(selector)})`);assert.ok(await h.click(selector));await h.frames();}

export const browserChecks=():Check[]=>[{
 id:'browser-real-library-read-only',stage:'navigation',title:'Real tagged library supports composed hierarchy, presets and previews without changing media or organization rules',covers:['real catalogRefresh/query','native drag and keyboard composition','numeric OR and ranges','custom date/name/format settings','presets persist after reload','actual thumbnails','read-only media and organization preferences'],budgetMs:180000,
 skip:async h=>{try{await fs.access(path.join(h.root,'browser-fixtures.json'));return undefined;}catch{return 'needs --browser-fixtures (automatically enabled by --only=browser)';}},
 run:async h=>{
  const manifest=JSON.parse(await fs.readFile(path.join(h.root,'browser-fixtures.json'),'utf8')) as {files:string[]};
  assert.equal(manifest.files.length,24);await h.idle();const beforeMedia=await fixtureTree(h.root),beforeState=await h.state(),beforePreferences=organizationPreferences(beforeState.preferences),beforeJobs=beforeState.jobs.map(j=>[j.id,j.phase]);
  await fs.writeFile(path.join(h.report,'browser-media-before.json'),JSON.stringify(beforeMedia,null,2));
  await h.waitFor('configured photo library available',async()=>!!(await h.state()).catalogLibraries?.some(l=>l.role==='photos'&&l.online&&l.destinationIndex===0));
  const library=(await h.state()).catalogLibraries?.find(l=>l.role==='photos'&&l.online&&l.destinationIndex===0);assert.ok(library,'Real configured photo library exists');
  await h.action({type:'catalogRefresh',libraryId:library.libraryId});
  const query:CatalogQuery={libraryId:library.libraryId,filters:[],nameContains:'BROWSER_',sort:{field:'name',direction:'asc'},limit:200};
  await h.waitFor('real tagged files indexed',async()=>{const page=await h.js<any>(`window.importer.catalogQuery(${JSON.stringify(query)})`);return page.total===24&&page.rows.every((r:any)=>r.values.metadataStatus==='ready'&&r.values.fNumber>0);},{timeoutMs:60000,seen:()=>h.js(`window.importer.catalogQuery(${JSON.stringify(query)})`)});
  await enter(h);await h.focusEmulation();
  const photographic=[];
  for(const [kind,label,nominal] of [['aperture','≥ f/2.8 – < f/4',2.8],['iso','≥ ISO 400 – < ISO 800',400],['shutter','≥ 1/60 s – < 1/30 s',1/60]] as const){
   await choosePreset(h,`builtin-${kind}`);await assertKinds(h,[kind]);const block=(await config(h)).blocks[0];assert.equal(block.numericMode,'buckets',`${kind} defaults to photographic buckets`);assert.ok(block.boundaries.some((n:number)=>Math.abs(n-nominal)<1e-12));
   await h.waitFor(`${kind} photographic default labels`,async()=>(await facetLabels(h)).includes(label),{seen:()=>facetLabels(h)});
   const boundaries=await h.js<string>("Array.from(document.querySelectorAll('label')).find(e=>e.firstChild?.textContent?.trim()==='Bucket boundaries')?.querySelector('input')?.value??''");assert.ok(boundaries.includes(kind==='shutter'?'1/60 s':kind==='iso'?'ISO 400':'f/2.8'),`${kind} boundary editor uses photographic units`);
   photographic.push({kind,mode:block.numericMode,boundaries,labels:await facetLabels(h)});
   await setField(h,'Numeric grouping','exact');const exact=kind==='aperture'?'f/1.8':kind==='iso'?'ISO 125':'1/60 s';await h.waitFor(`${kind} real intermediate exact label`,async()=>(await facetLabels(h)).includes(exact),{seen:()=>facetLabels(h)});photographic.push({kind,mode:'exact',labels:await facetLabels(h)});
  }
  const indexed=await h.js<any>(`window.importer.catalogQuery(${JSON.stringify(query)})`);const oneSixtieth=indexed.rows.find((r:any)=>r.name==='BROWSER_023.jpg');assert.ok(oneSixtieth);assert.ok(Math.abs(oneSixtieth.values.exposureSeconds-1/60)<1e-9);assert.equal(oneSixtieth.values.iso,125);assert.equal(oneSixtieth.values.fNumber,1.8);
  await fs.writeFile(path.join(h.report,'browser-photographic-defaults.json'),JSON.stringify({photographic,realOneSixtieth:oneSixtieth.values},null,2));
  await choosePreset(h,'builtin-aperture');await setField(h,'Numeric grouping','exact');await h.until('exact aperture rows ready',"document.querySelector('[data-testid=facet-column] [role=listbox]')?.getAttribute('aria-busy')==='false'");
  await key(h,'[data-testid=facet-column] [role=listbox]','Home');await press(h,'Down');await press(h,'Down');
  assert.equal(await h.js<string>("(()=>{const e=document.activeElement;return document.getElementById(e.getAttribute('aria-activedescendant'))?.querySelector('span')?.textContent;})()"),'f/2.8','Continuous arrows retain focus and move active row without refocusing');
  await choosePreset(h,'builtin-aperture');await assertKinds(h,['aperture']);await setField(h,'Numeric grouping','exact');await selectFirst(h,0);
  await h.until('aperture directly exposes files',"document.querySelector('[data-testid=browser-files] [role=option]')");
  await key(h,'[data-testid=browser-files] [role=listbox]','Space');
  await h.until('actual browser thumbnail decoded',"(()=>{const i=document.querySelector('[data-testid=browser-preview] img');return i?.complete&&i.naturalWidth>0;})()",30000);
  await h.shot('browser-aperture-preview');await key(h,'[data-testid=browser-files] [role=listbox]','Escape');
  // Keyboard equivalent: palette focused then Enter inserts; reorder and remove use focused buttons.
  await key(h,'[data-block-kind=date]','Enter');await assertKinds(h,['aperture','date']);
  await setField(h,'Date granularity','day');await setField(h,'Date display','DD / MM / YYYY');
  await key(h,'[data-block-kind=format]','Enter');await assertKinds(h,['aperture','date','format']);await setField(h,'Group formats by','kind');
  await key(h,'[data-block-kind=camera]','Enter');await assertKinds(h,['aperture','date','format','camera']);
  await key(h,'[data-block-kind=aperture]','Enter');await assertKinds(h,['aperture','date','format','camera','aperture']);
  await key(h,'button[aria-label="Move earlier"]','Enter');await assertKinds(h,['aperture','date','format','aperture','camera']);
  await key(h,'button[aria-label="Move later"]','Enter');await key(h,'button[aria-label="Remove block"]','Enter');await assertKinds(h,['aperture','date','format','camera']);
  await choosePreset(h,'builtin-name');await h.click('[data-testid=hierarchy-block]');await setField(h,'Group names by','exact');assert.equal((await config(h)).blocks[0].nameMode,'exact');
  await choosePreset(h,'builtin-aperture');await h.js("document.querySelector('.browser-range').open=true");await setField(h,'Minimum','f/2');await setField(h,'Maximum','f/4');await button(h,'Use range');await h.until('entered numeric range applied',"document.querySelector('.browser-selection-bar')?.textContent.includes('≥ f/2 – ≤ f/4')");
  // Clear to a single block, then physically drag the required blocks into the path.
  await choosePreset(h,'builtin-aperture');await drag(h,'[data-block-kind=date]','.browser-path-slot:has(.browser-files-leaf)');await assertKinds(h,['aperture','date']);
  await drag(h,'[data-block-kind=camera]','.browser-path-slot:has(.browser-files-leaf)');await assertKinds(h,['aperture','date','camera']);
  const cameraId=(await config(h)).blocks[2].id;await drag(h,'[data-block-kind=format]',`.browser-path-slot:has([data-block-id="${cameraId}"])`);await assertKinds(h,['aperture','date','format','camera']);
  // A new format dropped before a block is observed through persisted full configuration.
  const afterDrop=(await config(h)).blocks.map((b:any)=>b.kind);assert.equal(afterDrop.filter((kind:string)=>kind==='format').length,1);
  // Use the complete built-in as a known order; custom options then survive saving/reload.
  await choosePreset(h,'builtin-aperture-date-format-camera');await assertKinds(h,['aperture','date','format','camera']);
  const apertureId=(await config(h)).blocks[0].id;await h.click(`[data-block-id="${apertureId}"]`);await setField(h,'Numeric grouping','buckets');await setField(h,'Bucket boundaries','2, 3, 5, 9');await button(h,'Apply boundaries');
  await h.until('numeric buckets',"document.querySelectorAll('[data-testid=facet-column][data-column-index="+'"0"'+"] [role=option]').length>=3");
  await h.js("document.querySelectorAll('[data-testid=facet-column][data-column-index=\"0\"] [role=option]')[1].click()");await h.frames();
  await h.js("document.querySelectorAll('[data-testid=facet-column][data-column-index=\"0\"] [role=option]')[2].dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))");
  await h.until('OR range selections',"document.querySelectorAll('[data-testid=facet-column][data-column-index="+'"0"'+"] [role=option][aria-selected=true]').length===2");
  await selectFirst(h,1);await selectFirst(h,2);
  await h.js("(()=>{const e=document.querySelector('.browser-columns');e.scrollLeft=1000;e.dispatchEvent(new Event('scroll',{bubbles:true}));})()");await selectFirst(h,3);await h.until('composed hierarchy matching files',"document.querySelector('[data-testid=browser-files] [role=option]')");
  const dateId=(await config(h)).blocks[1].id;await h.click(`[data-block-id="${dateId}"]`);await setField(h,'Date granularity','day');await setField(h,'Date display','DD / MM / YYYY');
  const formatId=(await config(h)).blocks[2].id;await h.click(`[data-block-id="${formatId}"]`);await setField(h,'Group formats by','kind');
  await setField(h,'Preset name','QA custom view');await button(h,'Save current view');const saved=(await config(h)).presets.find((p:any)=>p.name==='QA custom view');assert.ok(saved);
  await h.click('button[aria-label="Rename: QA custom view"]');await h.js("(()=>{const e=document.querySelector('input[aria-label=\"Preset name\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'QA renamed view');e.dispatchEvent(new Event('input',{bubbles:true}));})()");await button(h,'Save');
  await choosePreset(h,'builtin-camera');await assertKinds(h,['camera']);await choosePreset(h,saved.id);await assertKinds(h,['aperture','date','format','camera']);
  const savedConfiguration=await config(h);h.window.webContents.reload();await h.until('reload boot done',"document.documentElement.dataset.boot==='done'",40000);await enter(h);assert.deepEqual(await config(h),savedConfiguration,'Complete browser configuration persists across renderer reload');
  await h.click('button[aria-label="Delete preset: QA renamed view"]');assert.equal((await config(h)).presets.some((p:any)=>p.id===saved.id),false);
  await button(h,'Real folders');await h.until('real folder mode',"document.querySelector('[data-testid=directory-column] [role=option]')");await h.click('[data-testid=directory-column] [role=option]');await h.until('real folder child file list',"document.querySelector('[data-testid=browser-files] [role=option]')");
  await button(h,'Categories');await choosePreset(h,'builtin-aperture');await selectFirst(h,0);await h.click('[data-testid=browser-files] [role=option]');
  await h.until('preview reminder',"document.querySelector('[data-testid=browser-preview] .browser-placement button')");await button(h,'Open organization tool');await h.until('independent organization tool',"document.querySelector('.nav-item[data-page=library]')?.getAttribute('aria-current')==='page'");
  const afterState=await h.state();assert.equal(!!afterState.review,false,'Reminder navigation starts no review');assert.equal(!!afterState.busyReview,false);assert.deepEqual(afterState.jobs.map(j=>[j.id,j.phase]),beforeJobs,'Browser creates no organizing/import jobs');assert.deepEqual(organizationPreferences(afterState.preferences),beforePreferences);
  const afterMedia=await fixtureTree(h.root);assert.deepEqual(afterMedia,beforeMedia,'Browsing must preserve bytes, paths, size, mtime and ctime');await fs.writeFile(path.join(h.report,'browser-media-after.json'),JSON.stringify(afterMedia,null,2));
  await fs.writeFile(path.join(h.report,'browser-read-only.json'),JSON.stringify({organizationPreferencesBefore:beforePreferences,organizationPreferencesAfter:organizationPreferences(afterState.preferences),jobsBefore:beforeJobs,jobsAfter:afterState.jobs.map(j=>[j.id,j.phase]),files:manifest.files.length,atimeExcluded:true},null,2));
 }
},
{
 id:'browser-layout-gallery',stage:'navigation',title:'Library browser stays bounded in narrow, long, light, dark and large-text layouts',covers:['1000px width','200% text','light/dark screenshots','long repeated hierarchy','≤500 active DOM rows'],budgetMs:90000,
 skip:async h=>{try{await fs.access(path.join(h.root,'browser-fixtures.json'));return undefined;}catch{return 'needs --browser-fixtures';}},
 run:async h=>{
  await enter(h);await choosePreset(h,'builtin-aperture');
  for(let i=0;i<30;i++)await h.click(`[data-block-kind=${['date','camera','format','aperture'][i%4]}]`);
  const measurements=[];
  for(const appearance of ['light','dark'] as const)for(const textScale of [1.25,2]){
   await h.prefs({appearance,textScale});await h.size(1000,800);await h.settle();
   const measured=await h.js<any>("({width:innerWidth,bodyWidth:document.body.scrollWidth,rows:document.querySelectorAll('[data-testid=library-browser] [role=option]').length,blocks:document.querySelectorAll('[data-testid=hierarchy-block]').length,columns:document.querySelectorAll('[data-testid=facet-column]').length,heap:performance.memory?.usedJSHeapSize})");
   assert.ok(measured.rows<=500,`${measured.rows} active rows`);assert.ok(measured.blocks<31,'Long path is horizontally virtualized');assert.ok(measured.bodyWidth<=measured.width,'No document horizontal overflow');measurements.push({appearance,textScale,...measured});await h.shot(`browser-${appearance}-1000-${Math.round(textScale*100)}`);await h.js("document.querySelector('.browser-columns').scrollIntoView({block:'start'})");await h.shot(`browser-columns-${appearance}-1000-${Math.round(textScale*100)}`);
  }
  await fs.writeFile(path.join(h.report,'browser-layout.json'),JSON.stringify(measurements,null,2));
 }
},
{
 id:'browser-four-locales',stage:'navigation',title:'Photographic browser labels render in all four locales',covers:['English/Simplified Chinese/Traditional Chinese/Japanese','new photographic bucket labels','locale screenshots'],budgetMs:90000,
 skip:async h=>{try{await fs.access(path.join(h.root,'browser-fixtures.json'));return undefined;}catch{return 'needs --browser-fixtures';}},
 run:async h=>{
  const labels=[];await enter(h);
  for(const [language,title,grouping] of [['en','Library browser','Numeric grouping'],['zh-Hans','分类预览','数值分类'],['zh-Hant','分類預覽','數值分類'],['ja','ライブラリブラウザ','数値の分類']] as const){
   await h.prefs({language});await choosePreset(h,'builtin-shutter');await h.waitFor(`${language} shutter rows ready`,async()=>(await facetLabels(h)).some(label=>label.includes('1/60 s')));
   const text=await h.js<string>("document.querySelector('[data-testid=library-browser]').textContent");assert.ok(text.includes(title));assert.ok(text.includes(grouping));assert.ok(!text.includes('undefined'));assert.ok(!text.includes('NaN'));
   labels.push({language,title,labels:await facetLabels(h)});await h.js("document.querySelector('.browser-columns').scrollIntoView({block:'start'})");await h.shot(`browser-locale-${language}`);
  }
  await h.prefs({language:'en'});await fs.writeFile(path.join(h.report,'browser-locales.json'),JSON.stringify(labels,null,2));
 }
}];
