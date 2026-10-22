// Bounded integration runner: enabled only by an explicit fixture QA launch.
import {ipcMain,nativeTheme, type BrowserWindow} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import type {Action,AppState,Metadata} from '../shared';
import {createStateReceiver,type StateUpdate} from '../state-channel';
import {formatMessage,type Message} from '../messages';
const english=(message?:Message)=>message?formatMessage(message,'en'):'';

export async function runCodexSmoke(window:BrowserWindow,root:string,uiOnly=false,organizationOnly=false):Promise<boolean>{
 const checks:{name:string;passed:boolean;error?:string}[]=[];
 const report=path.join(root,'artifacts');await fs.mkdir(report,{recursive:true});
 const js=<T>(source:string)=>window.webContents.executeJavaScript(source) as Promise<T>;
 const receiver=createStateReceiver();
 const state=async()=>receiver.apply(await js<StateUpdate>('window.importer.state()'))!;
 const action=async(value:Action)=>{await js<void>(`window.importer.action(${JSON.stringify(value)})`);return state();};
 const wait=async(test:()=>Promise<boolean>,label:string)=>{const end=Date.now()+60000;while(Date.now()<end){if(await test())return;await new Promise(r=>setTimeout(r,50));}throw new Error(`Timed out: ${label}`);};
 const theme=async(want:string)=>wait(()=>js<boolean>(`document.documentElement.dataset.theme===${JSON.stringify(want)}`),`theme ${want}`);
 // Waits until every finite animation and transition (page changes, disclosures, entrances) has finished; spinners and scroll-driven effects never finish and are ignored.
 const settle=async()=>{await new Promise(r=>setTimeout(r,50));await wait(()=>js<boolean>("!document.documentElement.dataset.transition&&document.getAnimations().every(a=>a.playState!=='running'||a.timeline!==document.timeline||a.effect?.getTiming().iterations===Infinity)"),'interface settled');};
 // capturePage cannot draw a View Transition mid-flight, so screenshots wait for the interface to settle.
 const shot=async(name:string)=>{await new Promise(r=>setTimeout(r,100));await settle();await fs.writeFile(path.join(report,name+'.png'),(await window.webContents.capturePage()).toPNG());};
 // An error toast suspends transitions (errors stay on top), so motion checks clear it first.
 const clearToast=async()=>{await js("document.querySelector('[data-testid=error-toast] button[aria-label=Dismiss],[data-testid=warning-toast] button[aria-label=Dismiss]')?.click();true");await wait(()=>js<boolean>("document.querySelector('[data-testid=error-toast],[data-testid=warning-toast]')===null"),'error toast dismissed');};
 // Settings shows one category panel at a time; open the one a check needs.
 const settingsTab=async(id:string)=>{await js(`document.querySelector('#settings-tab-${id}').click()`);await wait(()=>js<boolean>(`document.querySelector('#settings-tab-${id}')?.getAttribute('aria-selected')==='true'`),`settings category ${id}`);};
 const check=async(name:string,run:()=>Promise<void>)=>{try{await run();checks.push({name,passed:true});console.log(`QA PASS: ${name}`);}catch(e){console.error(e);checks.push({name,passed:false,error:String(e)});throw e;}};
 const digest=async(file:string)=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
 const originals=new Map<string,string>();
 for(let i=1;i<=6;i++)for(const name of await fs.readdir(path.join(root,`source-${i}`))){const file=path.join(root,`source-${i}`,name);originals.set(file,await digest(file));}
 const marker=path.join(root,'destination','photobackup','existing-marker.txt');originals.set(marker,await digest(marker));
 const secondMarker=path.join(root,'destination-2','existing-marker.txt');originals.set(secondMarker,await digest(secondMarker));
 const previousTheme=nativeTheme.themeSource;
 let failure:unknown;
 try{
  await check('Fresh launch follows System, Automatic is off, and only fixture sources are present',async()=>{const s=await state();assert.equal(s.preferences.appearance,'system');assert.equal(s.preferences.automatic,false);assert.equal(s.sources.length,6);assert.ok(s.sources.every(s=>s.id.startsWith('fixture:')&&s.path.startsWith(root+path.sep)));});
  await check('macOS uses native window controls instead of HTML replicas',async()=>{if(process.platform==='darwin'){assert.deepEqual(window.getWindowButtonPosition(),{x:18,y:15});assert.equal(window.isFullScreenable(),true);assert.equal(await js<boolean>("document.querySelector('.window-controls')!==null"),false);}});
  await check('System appearance responds live to OS light and dark changes',async()=>{nativeTheme.themeSource='dark';await theme('dark');nativeTheme.themeSource='light';await theme('light');await shot('system');});
  await check('Explicit Light and Dark controls override system appearance',async()=>{
   await js("Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()==='Settings').click()");await wait(()=>js<boolean>("document.querySelector('.window-titlebar h1').textContent==='Settings'"),'navigation committed');
   for(const mode of ['Dark','Light']){await js(`Array.from(document.querySelectorAll('.appearance-segments button')).find(b=>b.textContent.trim()===${JSON.stringify(mode)}).click()`);await wait(async()=>(await state()).preferences.appearance===mode.toLowerCase(),'appearance preference');await theme(mode.toLowerCase());await shot(mode.toLowerCase());}
   nativeTheme.themeSource='dark';await theme('light');
   await action({type:'preferences',patch:{appearance:'system'}});nativeTheme.themeSource='dark';await theme('dark');nativeTheme.themeSource='system';
   await js("Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()==='Import desk').click()");await wait(()=>js<boolean>("document.querySelector('.window-titlebar h1').textContent==='Import desk'"),'navigation committed');
  });
  await check('Each page has its own title-bar buttons, the desk shows the import dashboard and errors open only on request',async()=>{
   assert.equal(await js<boolean>("document.querySelector('[aria-label=\"Import dashboard\"]')!==null"),true);
   assert.equal(await js<boolean>("document.querySelector('[data-testid=show-progress]')===null"),true,'Total progress button has been removed');
   assert.equal(await js<boolean>("document.querySelector('.sidebar').getBoundingClientRect().top===0&&Math.abs(document.querySelector('.window-titlebar').getBoundingClientRect().left-document.querySelector('.sidebar').getBoundingClientRect().right)<1"),true,'Sidebar reaches the top beside the titlebar');
   for(const page of ['Organization','History','Settings','Import desk']){await js(`Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()===${JSON.stringify(page)}).click()`);// Each page has its own title-bar buttons; All errors is on every page.
    const expected:Record<string,string[]>={'Organization':['show-errors','titlebar-review-organization','titlebar-organize'],'History':['show-errors'],'Settings':['show-errors'],'Import desk':['show-errors','global-start','global-stop','global-automatic']};
    await wait(async()=>{const ids=await js<string[]>("Array.from(document.querySelectorAll('.window-titlebar [data-testid]')).map(e=>e.dataset.testid)");return expected[page]!.every(id=>ids.includes(id))&&(page==='Import desk'||!ids.includes('global-start'));},`title-bar buttons on ${page}`);await wait(()=>js<boolean>(`document.querySelector('.window-titlebar h1').textContent===${JSON.stringify(page==='History'?'Import history':page)}`),'page transition');assert.equal(await js<boolean>("document.querySelector('.command-bar')===null"),true);}
   assert.equal(await js<boolean>("document.querySelector('button[aria-label=\"Preview photo and metadata\"]')===null"),true);
   await js("document.querySelector('[data-testid=global-automatic]').click()");await wait(async()=>(await state()).preferences.automatic,'automatic button on');
   await wait(()=>js<boolean>("document.querySelector('[data-testid=global-automatic]').getAttribute('aria-pressed')==='true'"),'automatic button pressed');
   await js("document.querySelector('[data-testid=global-automatic]').click()");await wait(async()=>!(await state()).preferences.automatic,'automatic button off');
   await wait(()=>js<boolean>("document.querySelector('[data-testid=global-automatic]').getAttribute('aria-pressed')==='false'"),'automatic button unpressed');

   assert.equal(await js<string>("document.querySelector('.import-dashboard [data-metric=sources]').textContent"),'6');
   assert.equal(await js<string>("document.querySelector('.import-dashboard [data-metric=destinations]').textContent"),'1 / 1');
   assert.equal(await js<boolean>("Array.from(document.querySelectorAll('h2')).some(h=>h.textContent.includes('Ready for your next shoot'))"),false);
   await js("document.querySelector('[data-testid=show-errors]').click()");await wait(()=>js<boolean>("document.querySelector('.activity-dialog')?.open===true"),'errors panel');await shot('all-errors');await js("document.querySelector('[data-testid=activity-close]').click()");await wait(()=>js<boolean>("document.querySelector('.activity-dialog')===null"),'animated activity close');
  });
  await check('Read-only drive scanning exposes media formats without copying files',async()=>{
   await wait(()=>js<boolean>("document.querySelectorAll('details.source-disclosure').length===6"),'source card disclosures');
   assert.equal(await js<boolean>("Array.from(document.querySelectorAll('details.source-disclosure')).every(details=>!details.open)"),true,'Drive details must start collapsed');
   assert.equal(await js<boolean>("document.querySelector('#parallel-source-limit').closest('.section-heading').contains(document.querySelector('#source-heading'))&&document.querySelector('.concurrency-control')===null"),true,'Parallel limit belongs in the source heading row');
   const before=(await state()).jobs.length;await action({type:'scanSource',sourceId:'fixture:1'});await action({type:'stop'});await wait(async()=>!(await state()).scanningSources?.length,'scan cancellation');await action({type:'scanSource',sourceId:'fixture:1'});
   await wait(async()=>!!(await state()).sourceInventories?.['fixture:1'],'media scan');
   const scan=(await state()).sourceInventories!['fixture:1'];assert.equal(scan.media,2);assert.equal((await state()).jobs.length,before);
   await wait(()=>js<boolean>("document.querySelector('[data-testid=source-media-summary][data-source-id=\"fixture:1\"]')!==null"),'scanned card content');
   const layout:{label:string;rows:{sourceId:string;height:number;width:number;controlsFit:boolean}[]}[]=[];
   const measure=async(label:string)=>{const rows=await js<{sourceId:string;height:number;width:number;controlsFit:boolean}[]>(`Array.from(document.querySelectorAll('article.source-row')).map(card=>{const box=card.getBoundingClientRect();return {sourceId:card.dataset.sourceId,height:box.height,width:box.width,controlsFit:Array.from(card.querySelectorAll('button, details.source-disclosure > summary')).filter(control=>control.checkVisibility()).every(control=>{const bounds=control.getBoundingClientRect();return bounds.left>=box.left-1&&bounds.right<=box.right+1&&bounds.top>=box.top-1&&bounds.bottom<=box.bottom+1;}),outside:Array.from(card.querySelectorAll('button, details.source-disclosure > summary')).filter(control=>{if(!control.checkVisibility())return false;const bounds=control.getBoundingClientRect();return !(bounds.left>=box.left-1&&bounds.right<=box.right+1&&bounds.top>=box.top-1&&bounds.bottom<=box.bottom+1);}).map(control=>(control.getAttribute('aria-label')||control.textContent||'').trim().slice(0,40)+' '+JSON.stringify(control.getBoundingClientRect())+' card '+JSON.stringify(box))};})`);layout.push({label,rows});await fs.writeFile(path.join(report,'source-card-layout.json'),JSON.stringify({viewport:await js<{width:number;height:number}>('({width:innerWidth,height:innerHeight})'),measurements:layout},null,2));assert.ok(rows.every(row=>row.controlsFit),`Card controls overflow at ${label}: ${JSON.stringify(rows)}`);return rows;};
   const compact=await measure('compact-125');await shot('source-cards-compact');
   assert.equal(await js<boolean>("Array.from(document.querySelectorAll('article.source-row')).every((card,index,cards)=>{const style=getComputedStyle(card);return parseFloat(style.borderTopWidth)>0&&parseFloat(style.borderBottomWidth)>0&&(!index||card.getBoundingClientRect().top>cards[index-1].getBoundingClientRect().bottom);})"),true,'Each source has a separate bordered surface and gap');
   assert.equal(await js<boolean>("document.querySelector('[data-testid=source-media-summary][data-source-id=\"fixture:1\"]')?.checkVisibility()"),false);
   await js("document.querySelector('article[data-source-id=\"fixture:1\"] details.source-disclosure > summary').click()");
   assert.equal(await js<boolean>("Array.from(document.querySelectorAll('article.source-row')).every(card=>card.querySelector('details.source-disclosure').open===(card.dataset.sourceId==='fixture:1'))"),true,'Expanding one card must leave the others collapsed');
   await wait(()=>js<boolean>("document.querySelector('[data-testid=source-media-summary][data-source-id=\"fixture:1\"]')?.textContent.includes('PNG')&&document.querySelector('[data-testid=source-media-summary][data-source-id=\"fixture:1\"]')?.textContent.includes('MP4')"),'media format summary');
   await wait(()=>js<boolean>("document.querySelector('[data-testid=source-media-summary][data-source-id=\"fixture:1\"]')?.checkVisibility()===true"),'source details revealed');
   assert.equal(await js<boolean>("document.querySelector('[data-testid=media-pie]')===null"),true,'Pie chart has been removed');
   await settle();
   const expanded=await measure('expanded-125');assert.ok(expanded.find(row=>row.sourceId==='fixture:1')!.height>compact.find(row=>row.sourceId==='fixture:1')!.height);await shot('source-card-expanded');await shot('drive-details');
   const checked=(await state()).sourceCameraInfo?.['fixture:1']?.checked??0;
   await js("document.querySelector('article[data-source-id=\"fixture:1\"] details.source-disclosure > summary').click()");
   await settle();
   const collapsed=await measure('collapsed-125');assert.ok(collapsed.find(row=>row.sourceId==='fixture:1')!.height<expanded.find(row=>row.sourceId==='fixture:1')!.height);
   assert.equal((await state()).sourceInventories!['fixture:1'].media,2);assert.ok(((await state()).sourceCameraInfo?.['fixture:1']?.checked??0)>=checked,'Collapsing must retain camera scan progress');
   assert.equal(await js<boolean>("document.querySelector('[data-testid=source-media-summary][data-source-id=\"fixture:1\"]')?.textContent.includes('PNG')&&document.querySelector('[data-testid=source-media-summary][data-source-id=\"fixture:1\"]')?.textContent.includes('MP4')"),true,'Collapsing must retain scan results');
   try{await action({type:'preferences',patch:{textScale:1.5}});await wait(()=>js<boolean>("getComputedStyle(document.documentElement).getPropertyValue('--text-scale').trim()==='1.5'"),'150 percent text');await measure('compact-150');await shot('source-cards-compact-150');
    const beforeBounds=window.getBounds();try{window.setSize(1000,800);for(const language of ['en','zh-Hans','zh-Hant','ja'] as const){await action({type:'preferences',patch:{language}});await wait(()=>js<boolean>(`document.documentElement.lang===${JSON.stringify(language)}`),'titlebar language');const fit=await js<boolean>("Array.from(document.querySelectorAll('.titlebar-actions button,.titlebar-actions label,.titlebar-page-title')).every(control=>{const box=control.getBoundingClientRect(),bar=document.querySelector('.window-titlebar').getBoundingClientRect();return box.left>=104&&box.right<=bar.right&&box.bottom<=bar.bottom;})");assert.equal(fit,true,language+' titlebar controls must fit 1000px at150%');await shot('titlebar-1000-150-'+language);}}finally{window.setBounds(beforeBounds);await action({type:'preferences',patch:{language:'en'}});}}
   finally{await action({type:'preferences',patch:{textScale:1.25}});await wait(()=>js<boolean>("getComputedStyle(document.documentElement).getPropertyValue('--text-scale').trim()==='1.25'"),'restore 125 percent text');}
  });
  await check('Storage strips show continuous used/free segments and scanned media categories without overflow',async()=>{
   const valid=await js<boolean>("Array.from(document.querySelectorAll('.storage-track')).every(track=>{const total=Array.from(track.children).reduce((sum,item)=>sum+parseFloat(item.style.width),0);return Math.abs(total-100)<.001&&track.scrollWidth<=track.clientWidth+1&&!!track.getAttribute('aria-valuetext');})");
   assert.equal(valid,true);
   assert.equal(await js<number>("document.querySelectorAll('article.source-row [data-testid=storage-capacity]').length"),6);
   assert.equal(await js<boolean>("!!document.querySelector('article[data-source-id=\"fixture:1\"] [data-storage-kind=PNG]')&&!!document.querySelector('article[data-source-id=\"fixture:1\"] [data-storage-kind=MP4]')"),true);
   await shot('storage-capacity-strips');
  });
  await check('Unknown files are skipped quietly by default and appear in All errors only in Ask mode',async()=>{
   assert.equal(await js<boolean>("document.querySelector('.source-ledger [data-testid=unknown-files-prompt]')===null"),true);
   assert.equal((await state()).preferences.unknownDefault??'skip','skip');
   await wait(()=>js<boolean>("document.querySelector('[data-testid=skipped-files]')!==null"),'skipped files notice');
   await js("document.querySelector('[data-testid=show-errors]').click()");await wait(()=>js<boolean>("document.querySelector('.activity-dialog')?.open===true"),'errors panel');
   assert.equal(await js<boolean>("document.querySelector('.activity-dialog [data-testid=unknown-files-prompt]')===null"),true,'Default skip mode must not report unknown files as errors');
   await js("document.querySelector('[data-testid=activity-close]').click()");await wait(()=>js<boolean>("document.querySelector('.activity-dialog')===null"),'animated activity close');
   await action({type:'preferences',patch:{unknownDefault:'ask'}});
   await js("document.querySelector('[data-testid=show-errors]').click()");
   await wait(()=>js<boolean>("document.querySelector('.activity-dialog [data-testid=unknown-files-prompt]')!==null"),'format issues in error panel');
   assert.equal(await js<boolean>("document.querySelector('.activity-dialog').textContent.includes('Keep unknown files excluded')"),true);
   await shot('file-format-errors');
   await js("document.querySelector('[data-testid=activity-close]').click()");
   await wait(()=>js<boolean>("document.querySelector('.activity-dialog')===null"),'format panel close');
   await action({type:'preferences',patch:{unknownDefault:'skip'}});
  });
  await check('Source layout switches between a saved two-column grid and one-column list, adapting to narrow windows',async()=>{
   const bounds=window.getBounds();
   const rows=()=>js<{x:number;y:number;width:number}[]>("Array.from(document.querySelectorAll('article.source-row')).map(card=>{const r=card.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};})");
   try{
    window.setSize(1600,940);
    await js("document.querySelector('[data-testid=source-layout-grid]').click()");
    await wait(()=>js<boolean>("document.querySelector('[data-testid=source-layout-grid]').getAttribute('aria-pressed')==='true'"),'grid selected');
    await wait(async()=>{const r=await rows();return r.length===6&&Math.abs(r[0].y-r[1].y)<2&&r[1].x>r[0].x;},'two columns');
    await wait(async()=>JSON.parse(await fs.readFile(path.join(root,'user-data','settings.json'),'utf8')).preferences.sourceLayout==='grid','saved grid preference');
    await shot('sources-grid');
    await js("document.querySelector('article.source-row details.source-disclosure > summary').click()");
    assert.equal(await js<number>("document.querySelectorAll('details.source-disclosure[open]').length"),1);
    await shot('sources-grid-expanded');
    await js("document.querySelector('article.source-row details.source-disclosure > summary').click()");
    window.setSize(1000,800);
    await action({type:'preferences',patch:{textScale:1.5}});
    await wait(async()=>{const r=await rows();return r.length===6&&Math.abs(r[0].x-r[1].x)<2&&r[1].y>r[0].y;},'grid adapts to narrow workspace');
    assert.equal(await js<boolean>("document.querySelector('.main-content').scrollWidth<=document.querySelector('.main-content').clientWidth"),true,'No horizontal overflow with large text');
    await shot('sources-grid-narrow');
    window.setSize(1600,940);
    await js("document.querySelector('[data-testid=source-layout-list]').click()");
    await wait(async()=>{const r=await rows();return r.length===6&&Math.abs(r[0].x-r[1].x)<2&&r[1].y>r[0].y;},'one-column list');
    await wait(async()=>JSON.parse(await fs.readFile(path.join(root,'user-data','settings.json'),'utf8')).preferences.sourceLayout==='list','saved list preference');
    await shot('sources-list');
   }finally{window.setBounds(bounds);await action({type:'preferences',patch:{sourceLayout:'list',textScale:1.25}});}
  });
  await check('Motion follows the operating system preference and buttons retain immediate feedback',async()=>{
   const reduced=await js<boolean>("matchMedia('(prefers-reduced-motion: reduce)').matches");
   if(process.argv.includes('--force-prefers-reduced-motion'))assert.equal(reduced,true);
   const durations=await js<string>("getComputedStyle(document.querySelector('[data-testid=global-start]')).transitionDuration");
   assert.equal(durations.split(',').some(value=>parseFloat(value)>0),!reduced);
  });
  await check('Every page and Settings category switch animates through the motion helper, and reduced motion skips it',async()=>{
   const reduced=await js<boolean>("matchMedia('(prefers-reduced-motion: reduce)').matches");
   await clearToast();
   // Record the kind of each View Transition the renderer starts.
   await js("window.qaTransitions=[];window.qaStartViewTransition=document.startViewTransition;document.startViewTransition=function(update){window.qaTransitions.push(document.documentElement.dataset.transition);return window.qaStartViewTransition.call(document,update);};true");
   const go=async(label:string,title=label)=>{await js(`Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);await wait(()=>js<boolean>(`document.querySelector('.window-titlebar h1').textContent===${JSON.stringify(title)}`),`page ${label}`);};
   const categories=['importing','destinations','folders','organization','drives','general'];
   let seen:string[];
   try{
    await go('Import desk');await js('window.qaTransitions=[]');
    for(const [label,title] of [['Drives','Drives'],['Organization','Organization'],['History','Import history'],['Settings','Settings']])await go(label,title);
    await settingsTab('importing');
    for(const id of [...categories.slice(1),...categories.slice(0,-1).reverse()])await settingsTab(id);
    assert.equal(await js<boolean>("document.querySelectorAll('.settings-indicator').length===1&&document.querySelector('[aria-selected=true] .settings-indicator')!==null"),true,'One selection indicator, on the open category');
    await go('Import desk');
    seen=(await js<string[]>('window.qaTransitions')).filter(kind=>/^(forward|back|category-)/.test(kind));
   }finally{await js('document.startViewTransition=window.qaStartViewTransition;true');}
   assert.deepEqual(seen,reduced?[]:['forward','forward','forward','forward',...Array(5).fill('category-forward'),...Array(5).fill('category-back'),'back']);
  });
  await check('Transitions keep each layer in place: labels above selection capsules, an opaque titlebar, nothing under an open sheet',async()=>{
   const reduced=await js<boolean>("matchMedia('(prefers-reduced-motion: reduce)').matches");
   await clearToast();
   // While each transition runs, record what its layers look like.
   await js("window.qaLayers=[];window.qaStartViewTransition=document.startViewTransition;document.startViewTransition=function(update){const t=window.qaStartViewTransition.call(document,update);t.ready.then(()=>{const bar=document.querySelector('.window-titlebar');window.qaLayers.push({kind:document.documentElement.dataset.transition,labels:Array.from(document.querySelectorAll('.nav-item>:not(.nav-indicator)')).every(e=>getComputedStyle(e).viewTransitionName!=='none'),tabLabels:Array.from(document.querySelectorAll('.settings-nav [role=tab]>:not(.settings-indicator)')).every(e=>getComputedStyle(e).viewTransitionName!=='none'),titlebarOpaque:getComputedStyle(bar).backgroundColor.match(/[\\d.]+/g).length===3||parseFloat(getComputedStyle(bar).backgroundColor.match(/[\\d.]+/g)[3])===1,shadowHidden:getComputedStyle(bar,'::after').display==='none'});}).catch(()=>{});return t;};true");
   const go=async(label:string,title=label)=>{await js(`Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click();true`);await wait(()=>js<boolean>(`document.querySelector('.window-titlebar h1').textContent===${JSON.stringify(title)}`),`page ${label}`);await settle();};
   let layers:{kind:string;labels:boolean;tabLabels:boolean;titlebarOpaque:boolean;shadowHidden:boolean}[],underSheet:unknown[];
   try{
    await go('Import desk');await go('Settings');await settingsTab('destinations');await settle();await settingsTab('importing');await settle();await go('Import desk');
    layers=(await js<typeof layers>('window.qaLayers')).filter(layer=>/^(forward|back|category-)/.test(layer.kind));
    // A layout change while All errors is open must not lift the page above the sheet's backdrop.
    await js("window.qaLayers=[];document.querySelector('[data-testid=show-errors]').click();true");await wait(()=>js<boolean>("document.querySelector('.activity-dialog')?.open===true"),'errors panel');
    await action({type:'preferences',patch:{sourceLayout:'grid'}});await wait(()=>js<boolean>("document.querySelector('.source-ledger.source-layout-grid')!==null"),'grid under the sheet');
    underSheet=await js('window.qaLayers');
    await js("document.querySelector('[data-testid=activity-close]').click();true");await wait(()=>js<boolean>("document.querySelector('.activity-dialog')===null"),'errors panel closed');
   }finally{await js('document.startViewTransition=window.qaStartViewTransition;true');await action({type:'preferences',patch:{sourceLayout:'list'}});await settle();}
   assert.deepEqual(underSheet,[],'No transition runs under an open sheet');
   if(reduced){assert.deepEqual(layers,[]);return;}
   assert.deepEqual(layers.map(layer=>layer.kind),['forward','category-forward','category-back','back']);
   for(const layer of layers){assert.ok(layer.labels&&layer.titlebarOpaque&&layer.shadowHidden,JSON.stringify(layer));if(layer.kind.startsWith('category'))assert.ok(layer.tabLabels,JSON.stringify(layer));}
  });
  await check('Errors stay on top: at 200% the error toast is the topmost element at its centre, also on the frames after each page switch',async()=>{
   const original=(await state()).preferences.textScale,[width,height]=window.getContentSize();
   // The toast is hit first at its centre and sits in the top layer; no transition is running over it.
   const probe="(()=>{const t=document.querySelector('[data-testid=error-toast]');if(!t)return {present:false};const r=t.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {present:true,topLayer:t.matches(':popover-open'),topmost:!!hit&&t.contains(hit),transition:!!document.documentElement.dataset.transition};})()";
   // Switch pages and probe two frames later, when a transition would already be drawing.
   const go=async(label:string)=>js<Record<string,unknown>>(`(async()=>{Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return ${probe};})()`);
   const onTop={present:true,topLayer:true,topmost:true,transition:false};
   let settled:Record<string,unknown>,during:Record<string,unknown>[]=[];
   try{
    window.setContentSize(1000,720);await action({type:'preferences',patch:{textScale:2}});await wait(()=>js<boolean>("getComputedStyle(document.documentElement).getPropertyValue('--text-scale').trim()==='2'"),'200 percent text');
    await clearToast();await go('Import desk');await settle();
    await action({type:'preferences',patch:{unknownDefault:'ask'}});
    await wait(()=>js<boolean>("document.querySelector('[data-testid=error-toast]')?.matches(':popover-open')===true"),'error toast in the top layer');
    await settle();settled=await js(probe);await shot('error-toast-on-top-200');
    for(const page of ['Drives','Organization','Import desk'])during.push(await go(page));
   }finally{
    await action({type:'preferences',patch:{unknownDefault:'skip',textScale:original}});window.setContentSize(width,height);
    await js("Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()==='Import desk').click();true");await settle();
   }
   assert.deepEqual(settled,onTop);
   for(const item of during)if(item.present)assert.deepEqual(item,onTop);
   assert.ok(during.some(item=>item.present),'The toast was on screen while pages switched');
  });
  await check('Settings provides live, persistent text sizing with a readable default',async()=>{
   await js(`Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()==='Settings').click()`);await wait(()=>js<boolean>("document.querySelector('.window-titlebar h1').textContent==='Settings'"),'navigation committed');
   await settingsTab('destinations');
   assert.equal(await js<boolean>("document.querySelector('.settings-page input[placeholder=photobackup]')!==null&&document.querySelector('.settings-page #copy-policy')!==null"),true,'Backup folder and copy policy live in Settings → Destinations');
   await settingsTab('folders');
   assert.equal(await js<boolean>("document.querySelector('.settings-page [data-testid=folder-settings]')!==null"),true,'Folder paths live in Settings → Folders');
   await settingsTab('general');
   await wait(()=>js<boolean>("document.querySelector('input[aria-label=\"Text size\"]')!==null"),'text size in Settings → General');
   assert.equal((await state()).preferences.textScale,1.25);
   const original=await js<number>("parseFloat(getComputedStyle(document.querySelector('.settings-page .settings-section h3')).fontSize)");
   await js(`{const slider=document.querySelector('input[aria-label="Text size"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,'150');slider.dispatchEvent(new Event('input',{bubbles:true}));}`);
   await wait(async()=>(await state()).preferences.textScale===1.5,'text slider preference');
   await wait(()=>js<boolean>(`parseFloat(getComputedStyle(document.querySelector('.settings-page .settings-section h3')).fontSize)>${original}`),'larger text');
   await wait(async()=>JSON.parse(await fs.readFile(path.join(root,'user-data','settings.json'),'utf8')).preferences.textScale===1.5,'saved text size');
   await action({type:'preferences',patch:{textScale:1.25}});await shot('settings');
   await js(`Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()==='Import desk').click()`);await wait(()=>js<boolean>("document.querySelector('.window-titlebar h1').textContent==='Import desk'"),'navigation committed');
  });
  await check('All four interface languages switch live and persist',async()=>{
   for(const [language,label,details] of [['zh-Hans','设置','详细信息'],['zh-Hant','設定','詳細資訊'],['ja','設定','詳細情報'],['en','Settings','Drive details']] as const){await action({type:'preferences',patch:{language}});await wait(()=>js<boolean>(`document.documentElement.lang===${JSON.stringify(language)}&&Array.from(document.querySelectorAll('.nav-item')).some(item=>item.textContent.includes(${JSON.stringify(label)}))&&document.querySelectorAll('details.source-disclosure > summary').length===6&&Array.from(document.querySelectorAll('details.source-disclosure > summary')).every(summary=>summary.getAttribute('aria-label')===${JSON.stringify(details)}&&summary.querySelector('.source-disclosure-label').textContent===${JSON.stringify(details)})`),`language ${language}`);await shot('language-'+language);}
  });
  await check('Edited exports folder edits persist, update the preview and reject unsafe names',async()=>{
   await action({type:'stop'});await wait(async()=>!(await state()).scanningSources?.length,'finish read-only scans before editing organization settings');
   await js("Array.from(document.querySelectorAll('.nav-item')).find(button=>button.textContent.trim()==='Settings').click()");await wait(()=>js<boolean>("document.querySelector('.window-titlebar h1').textContent==='Settings'"),'navigation committed');
   await settingsTab('folders');
   await wait(()=>js<boolean>("document.querySelector('input[placeholder=\"editied\"]')?.value==='editied'"),'default edited exports folder');
   assert.equal((await state()).preferences.editedFolder,'editied');
   let editedFolderFailure:unknown;
   try{
    // executeJavaScript does not grant page focus. Without it Chromium may
    // emit input but no focus/blur events, so the real onBlur save never runs.
    // Focus emulation keeps focus/blur events flowing when another app holds OS focus.
    window.focus();window.webContents.focus();
    if(!window.webContents.debugger.isAttached())window.webContents.debugger.attach();
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    await js("document.querySelector('input[placeholder=\"editied\"]').focus()");
    await wait(()=>js<boolean>("document.hasFocus()&&document.activeElement===document.querySelector('input[placeholder=\"editied\"]')"),'edited exports field has browser focus');
    await js("{const input=document.querySelector('input[placeholder=\"editied\"]');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Finished');input.dispatchEvent(new Event('input',{bubbles:true}));}");
    await js("document.querySelector('input[placeholder=\"editied\"]').blur()");
    await wait(async()=>(await state()).preferences.editedFolder==='Finished','edited exports folder preference');
    await wait(async()=>JSON.parse(await fs.readFile(path.join(root,'user-data','settings.json'),'utf8')).preferences.editedFolder==='Finished','persisted edited exports folder');
    await wait(()=>js<boolean>("document.querySelector('[data-testid=edited-export-preview]')?.textContent.includes('2026202610FinishedNikon Z6III')"),'updated edited-export preview');
    await shot('edited-exports-folder');
    for(const [language,label] of [['zh-Hans','编辑导出文件夹'],['zh-Hant','編輯匯出資料夾'],['ja','編集済み書き出しフォルダー'],['en','Edited exports folder']] as const){
     await action({type:'preferences',patch:{language}});
     await wait(()=>js<boolean>(`document.documentElement.lang===${JSON.stringify(language)}&&document.querySelector('input[placeholder="editied"]')?.value==='Finished'&&document.querySelector('input[placeholder="editied"]').closest('label').textContent.trim()===${JSON.stringify(label)}`),`edited exports field in ${language}`);
    }
    // The UI bridge reports action failures in AppState.error rather than rejecting its promise.
    const rejected=await action({type:'preferences',patch:{editedFolder:'../escape'}});
    assert.equal(rejected.preferences.editedFolder,'Finished');assert.match(english(rejected.error),/safe folder name/i);
    assert.equal(await js<boolean>("document.querySelector('.error-banner,.job-errors,.source-camera-error,.recovery-error')===null&&document.querySelector('.activity-dialog')===null"),true,'Errors stay out of the main workspace');
    await js("document.querySelector('[data-testid=show-errors]').click()");await wait(()=>js<boolean>("document.querySelector('.all-errors')?.textContent.includes('safe folder name')"),'error appears in dedicated panel');await shot('all-errors-with-detail');await js("document.querySelector('[data-testid=activity-close]').click()");await wait(()=>js<boolean>("document.querySelector('.activity-dialog')===null"),'animated activity close');
    assert.equal(JSON.parse(await fs.readFile(path.join(root,'user-data','settings.json'),'utf8')).preferences.editedFolder,'Finished','An invalid folder must not be persisted');
   }catch(error){editedFolderFailure=error;console.error('Edited folder QA original failure:',error);throw error;}finally{
    try{
    await js("document.activeElement?.blur()");
    await action({type:'clearError'});await action({type:'preferences',patch:{editedFolder:'editied',language:'en'}});
    await wait(()=>js<boolean>("document.querySelector('input[placeholder=\"editied\"]')?.value==='editied'&&document.querySelector('[data-testid=edited-export-preview]')?.textContent.includes('2026202610editiedNikon Z6III')"),'restored edited exports folder');
    await js("Array.from(document.querySelectorAll('.nav-item')).find(button=>button.textContent.trim()==='Import desk').click()");await wait(()=>js<boolean>("document.querySelector('.window-titlebar h1').textContent==='Import desk'"),'navigation committed');
    }catch(cleanupError){if(editedFolderFailure)throw new AggregateError([editedFolderFailure,cleanupError],'Edited folder check and restoration both failed');throw cleanupError;}
   }
  });
  await check('Photo metadata is readable and collapsed; video summaries omit shutter count in every language',async()=>{
   // This process is explicitly fixture-only. Exercise the real preview UI via
   // its existing bridge, without opening native dialogs or accessing user files.
   const photo:Metadata={camera:'Fixture camera',date:'2025-06-26T13:50:35+08:00',exposure:{lens:'Fixture 24–70mm',aperture:2.8,iso:400,exposureTime:1/125,focalLength:35,exposureCompensation:0.3},shutterCount:'123',shutterNote:'Fixture shutter note',fields:{'EXIF:Model':'Fixture camera','EXIF:ISO':400}};
   let selected={path:path.join(root,'source-1','photo.png'),metadata:photo};
   ipcMain.removeHandler('importer:inspect');
   ipcMain.handle('importer:inspect',()=>selected.metadata);
   await action({type:'preview',sourceId:'fixture:1'});await wait(()=>js<boolean>("document.querySelector('.review-source-button')!==null"),'per-file review preview');
   const open=async()=>{await js("Array.from(document.querySelectorAll('.review-source-button')).find(button=>button.textContent.includes('photo.png')).click()");await wait(()=>js<boolean>("document.querySelector('.metadata-dialog')?.open===true"),'metadata dialog');};
   const close=async()=>{await js("document.querySelector('[data-testid=metadata-close]').click()");await wait(()=>js<boolean>("document.querySelector('.metadata-dialog')===null"),'animated metadata close');await wait(()=>js<boolean>("document.querySelector('.metadata-dialog')===null"),'close metadata dialog');};
   try{
    await open();
    assert.equal(await js<string>("document.querySelector('[data-testid=metadata-timezone]').textContent"),'UTC+08:00');
    const captured=await js<string>("document.querySelector('[data-testid=metadata-capture-time]').textContent");assert.equal(captured,'13:50:35');assert.ok(await js<boolean>("document.querySelector('.capture-summary').textContent.includes('Jun 26, 2025')"));
    const exposure=await js<string>("document.querySelector('[data-testid=metadata-exposure]').textContent");for(const expected of ['Fixture 24–70mm','2.8','400','1/125','35','+0.3'])assert.ok(exposure.includes(expected),exposure);
    assert.equal(await js<string>("document.querySelector('[data-testid=metadata-shutter-count]').textContent"),'123');
    assert.equal(await js<boolean>("document.querySelector('[data-testid=metadata-details]').open"),false);
    assert.equal(await js<boolean>("document.querySelector('.metadata-fields').checkVisibility()"),false,'Full metadata fields must not be visible before expanding');
    assert.equal(await js<boolean>("document.querySelector('[data-testid=metadata-details] summary').getBoundingClientRect().bottom<=document.querySelector('.metadata-inspector').getBoundingClientRect().bottom"),true,'The metadata disclosure must fit in the initial summary without scrolling');
    await shot('photo-metadata-collapsed');
    await js("document.querySelector('[data-testid=metadata-details] summary').click()");
    assert.equal(await js<boolean>("document.querySelector('[data-testid=metadata-details]').open"),true);
    await wait(()=>js<boolean>("document.querySelector('.metadata-fields').checkVisibility()"),'Full metadata fields visible after animated expansion');
    await shot('photo-metadata-expanded');await close();
    selected={path:path.join(root,'source-1','clip.mp4'),metadata:{...photo,shutterCount:'999',shutterNote:'Video shutter note'}};
    for(const language of ['en','zh-Hans','zh-Hant','ja'] as const){
     await action({type:'preferences',patch:{language}});
     // The command's accessible label follows the selected language.
     await js("Array.from(document.querySelectorAll('.review-source-button')).find(button=>button.textContent.includes('clip.mp4')).click()");await wait(()=>js<boolean>("document.querySelector('.metadata-dialog')?.open===true"),'localized video metadata');
     assert.equal(await js<boolean>("document.querySelector('[data-testid=metadata-details]').open"),false);
     assert.equal(await js<boolean>("document.querySelector('[data-testid=metadata-shutter-count]')===null"),true);
     assert.equal(await js<boolean>("document.querySelector('.shutter-note')===null"),true);
     assert.equal(await js<string>("document.querySelector('[data-testid=metadata-timezone]').textContent"),'UTC+08:00');
     await shot('video-metadata-'+language);await close();
    }
   }finally{ipcMain.removeHandler('importer:inspect');await action({type:'discardReview'});await action({type:'preferences',patch:{language:'en'}});}
  });
  await check('Changing an unknown-file rule invalidates a ready import review',async()=>{
   const ready=await action({type:'preview',sourceId:'fixture:1'});assert.ok(ready.review);const before=ready.jobs.length;const changed=await action({type:'unknownRule',extension:'dat',folder:null,remember:false});assert.equal(changed.review,undefined);assert.equal(changed.jobs.length,before);
  });
  // Swept with the button widths: bars and controls must shrink to fit, never be cut off by a clipping ancestor or spill out of their box.
  const clipped:Record<string,unknown>[]=[];
  await check('No button stretches far past its label at any text size or window size',async()=>{
   // A button may grow a little for alignment, never into a bar: rendered width is compared with the width its content needs.
   const measure=`(()=>{const out=[];for(const b of document.querySelectorAll('button,.button,[role=button]')){const r=b.getBoundingClientRect();if(!r.width||!r.height||b.closest('[hidden],dialog:not([open])'))continue;if(b.matches('.nav-item,.sidebar-item,[role=tab],[role=switch],[role=radio],.appearance-segments button,.segmented button')||b.closest('[role=tablist],[role=radiogroup],.segmented'))continue;const style=b.style.cssText;b.style.setProperty('width','max-content','important');b.style.setProperty('flex','none','important');b.style.setProperty('min-width','0','important');const need=b.getBoundingClientRect().width;b.style.cssText=style;if(r.width>need*1.5&&r.width-need>64)out.push({text:(b.textContent||b.getAttribute('aria-label')||'').trim().slice(0,40),cls:b.className,width:Math.round(r.width),need:Math.round(need)});}return out;})()`;
   const clipMeasure=`(()=>{const out=[];const name=e=>(e.getAttribute('aria-label')||e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,40)+' <'+e.tagName.toLowerCase()+(e.className&&typeof e.className==='string'?'.'+e.className.trim().split(/\\s+/).join('.'):'')+'>';
    const controls='button,.button,input:not([type=checkbox]),select,[role=progressbar],[role=meter],.storage-track,.segmented,.source-layout-switch,.titlebar-actions,.source-steps,.mini-steps,.status-pill,.selection-chip,.parallel-source-control,.dashboard-total,.organization-progress-line';
    // File tables scroll sideways by design; tracks clip their fill to the rounded bar.
    const scrollers='.file-table-scroll,.review-table-scroll';
    const tracks='.progress-track,.storage-track,.sidebar-capacity';
    // Any box that cuts its own content off, unless it says so with an ellipsis or a line clamp.
    for(const e of document.querySelectorAll('body *')){
     if(e.scrollWidth<=e.clientWidth+1&&e.scrollHeight<=e.clientHeight+1)continue;
     const s=getComputedStyle(e);if(s.overflowX==='visible'&&s.overflowY==='visible'||e.matches(scrollers+','+tracks)||e.clientWidth<=1||s.textOverflow==='ellipsis'||s.webkitLineClamp!=='none'&&s.webkitLineClamp)continue;
     if(e.closest('[hidden],dialog:not([open]),details:not([open])>:not(summary)')||!e.checkVisibility({visibilityProperty:true}))continue;
     const wide=e.scrollWidth>e.clientWidth+1,tall=(s.overflowY==='hidden'||s.overflowY==='clip')&&e.scrollHeight>e.clientHeight+1;
     if(wide||tall)out.push({kind:'content cut off',control:name(e),need:[e.scrollWidth,e.scrollHeight],box:[e.clientWidth,e.clientHeight]});
    }
    for(const e of document.querySelectorAll(controls)){
     if(e.closest('[hidden],dialog:not([open]),details:not([open])>:not(summary),.connection-screen')||!e.checkVisibility({visibilityProperty:true}))continue;
     const r=e.getBoundingClientRect();if(r.width<1||r.height<1)continue;
     const s=getComputedStyle(e);
     if(s.overflowX==='visible'&&s.textOverflow!=='ellipsis'&&e.scrollWidth>e.clientWidth+1&&e.clientWidth>0){out.push({kind:'content spills out',control:name(e),need:e.scrollWidth,width:e.clientWidth});continue;}
     for(let a=e.parentElement;a&&a!==document.body;a=a.parentElement){
      const c=getComputedStyle(a);if(c.display==='contents')continue;
      const b=a.getBoundingClientRect(),left=b.left+a.clientLeft,top=b.top+a.clientTop,right=left+a.clientWidth,bottom=top+a.clientHeight;
      const clipX=c.overflowX!=='visible'&&!a.matches(scrollers),clipY=c.overflowY==='hidden'||c.overflowY==='clip';
      if(clipX&&(r.left<left-1||r.right>right+1)||clipY&&(r.top<top-1||r.bottom>bottom+1)){out.push({kind:'clipped by ancestor',control:name(e),by:name(a).replace(/^.*</,'<'),control_box:[Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)],clip_box:[Math.round(left),Math.round(top),Math.round(right),Math.round(bottom)]});break;}
     }
    }return out;})()`;
   const pages=['Import desk','Drives','Organization','History','Settings'];
   const original=(await state()).preferences.textScale,[width,height]=window.getContentSize();
   const wide:Record<string,unknown>[]=[];
   try{
    for(const [w,h] of [[1000,720],[1440,940],[1920,1200]]){window.setContentSize(w,h);
     for(const scale of [1,1.25,1.5,1.75,2]){await action({type:'preferences',patch:{textScale:scale}});await wait(()=>js<boolean>(`getComputedStyle(document.documentElement).getPropertyValue('--text-scale').trim()===${JSON.stringify(String(scale))}`),`text scale ${scale}`);
      for(const page of pages){await js(`Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()===${JSON.stringify(page)}).click()`);await wait(()=>js<boolean>(`document.querySelector('.window-titlebar h1').textContent===${JSON.stringify(page==='History'?'Import history':page)}`),`page ${page}`);await new Promise(r=>setTimeout(r,250));
       const tabs=page==='Settings'?await js<string[]>("Array.from(document.querySelectorAll('[id^=settings-tab-]')).map(t=>t.id.slice('settings-tab-'.length))"):[''];
       if(scale===2)await shot(`scale-200-${w}x${h}-${page.replace(/\s+/g,'-').toLowerCase()}`);
       for(const tab of tabs){if(tab){await settingsTab(tab);await new Promise(r=>setTimeout(r,150));}
        for(const item of await js<Record<string,unknown>[]>(measure))wide.push({window:`${w}x${h}`,scale,page:tab?`Settings/${tab}`:page,...item});
        for(const item of await js<Record<string,unknown>[]>(clipMeasure))clipped.push({window:`${w}x${h}`,scale,page:tab?`Settings/${tab}`:page,...item});}
      }}}
   }finally{await action({type:'preferences',patch:{textScale:original}});window.setContentSize(width,height);await js("Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()==='Import desk').click()");}
   await fs.writeFile(path.join(report,'button-widths.json'),JSON.stringify(wide,null,2));
   if(wide.length)console.log(`WIDE BUTTONS ${JSON.stringify(wide)}`);
   assert.deepEqual(wide,[],'Buttons wider than their content needs');
  });
  await check('No bar or control is cut off by a clipping ancestor or spills out of its box at any text size or window size',async()=>{
   await fs.writeFile(path.join(report,'clipped-controls.json'),JSON.stringify(clipped,null,2));
   if(clipped.length)console.log(`CLIPPED CONTROLS ${clipped.length} ${JSON.stringify(clipped.slice(0,40))}`);
   assert.deepEqual(clipped,[],'Controls clipped or overflowing');
  });
  if(!uiOnly){
  await check('Five sources run and the sixth queues; Stop settles every job',async()=>{
   await action({type:'preferences',patch:{parallel:5}});const started=await action({type:'start'});
   assert.equal(started.jobs.filter(j=>['discovering','verifying','copying'].includes(j.phase)).length,5);assert.equal(started.jobs.filter(j=>j.phase==='queued').length,1);
   const queuedOrganization=await action({type:'organize',destinationIndex:0});assert.equal(queuedOrganization.jobs.find(job=>job.organization)?.phase,'queued','Organization waits behind existing imports');await js("Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()==='Import desk').click()");await wait(()=>js<boolean>("document.querySelector('.import-dashboard .progress-jobs')?.textContent.includes('Library organization')"),'queued organization in import dashboard');await shot('queued-organization-progress');
   await fs.writeFile(path.join(report,'queue.json'),JSON.stringify(started,null,2));await action({type:'stop'});
   await wait(async()=>(await state()).jobs.every(j=>['stopped','complete','error'].includes(j.phase)),'stop');assert.ok((await state()).jobs.some(j=>j.phase==='stopped'));
  });
  await check('Retry copies all source contents and a second run verifies duplicates',async()=>{
   const run=async()=>{const before=new Set((await state()).jobs.map(j=>j.id));await action({type:'start'});await wait(async()=>{const jobs=(await state()).jobs.filter(j=>!before.has(j.id));return jobs.length===6&&jobs.every(j=>['complete','error','stopped'].includes(j.phase));},'copy completion');const jobs=(await state()).jobs.filter(j=>!before.has(j.id));assert.ok(jobs.every(j=>j.phase==='complete'),JSON.stringify(jobs.map(j=>({phase:j.phase,detail:j.detail}))));return jobs;};
   await run();const output:string[]=[];const walk=async(dir:string)=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())output.push(await digest(file));}};await walk(path.join(root,'destination','photobackup'));for(const [file,hash] of originals)if(file.startsWith(path.join(root,'source-')))assert.ok(output.includes(hash),`Missing copied content: ${file}`);
   const copiedFiles=output.length;
   const repeated=await run();assert.ok(repeated.every(j=>j.alreadyImported||english(j.detail).startsWith('0 copied')),'Repeated imports must not copy duplicates');
   output.length=0;await walk(path.join(root,'destination','photobackup'));assert.equal(output.length,copiedFiles,'Repeated imports must not add files to the backup');
  });
  await check('Concurrent sources create a fresh nested backup folder without directory races',async()=>{
   const before=new Set((await state()).jobs.map(job=>job.id));
   const nested=path.join(root,'destination','fresh-backup','nested');
   assert.equal(await fs.stat(nested).then(()=>true,()=>false),false);
   await action({type:'preferences',patch:{basePath:'fresh-backup/nested',parallel:5}});
   assert.equal((await state()).preferences.basePath,'fresh-backup/nested');
   const started=await action({type:'start'});
   assert.equal(started.jobs.filter(job=>!before.has(job.id)&&['discovering','verifying','copying'].includes(job.phase)).length,5);
   await wait(async()=>{const jobs=(await state()).jobs.filter(job=>!before.has(job.id));return jobs.length===6&&jobs.every(job=>['complete','error','stopped'].includes(job.phase));},'concurrent new destination folders');
   const jobs=(await state()).jobs.filter(job=>!before.has(job.id));assert.ok(jobs.every(job=>job.phase==='complete'),JSON.stringify(jobs.map(job=>({phase:job.phase,errors:job.errors}))));
   assert.ok((await fs.stat(nested)).isDirectory());
   const hashes=new Set<string>();const walk=async(folder:string):Promise<void>=>{for(const entry of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())hashes.add(await digest(file));}};
   await walk(nested);for(const [file,hash] of originals)if(file.startsWith(path.join(root,'source-')))assert.ok(hashes.has(hash),`Concurrent import missing ${file}`);
   await action({type:'preferences',patch:{basePath:'photobackup'}});
  });

 }
 if(!uiOnly||organizationOnly){
  await check('A fixture organization review shows its progress with a file name, time left and speed',async()=>{
   const seen:{file:string;total:number;share?:number;eta?:number;speed:number;fileRate?:number}[]=[];
   const pending=action({type:'previewOrganization',destinationIndex:0});let done=false;void pending.finally(()=>{done=true;});
   while(!done){const progress=(await state()).reviewProgress;if(progress)seen.push({file:progress.file,total:progress.total,share:progress.share,eta:progress.eta,speed:progress.speed,fileRate:progress.fileRate});await new Promise(r=>setTimeout(r,5));}
   await pending;await wait(async()=>(await state()).review!==undefined,'organization review ready');
   // A fixture review is quick, so only what was observed is checked: every sample names a file, and a known total or estimate is a determinate bar.
   for(const sample of seen)if(sample.total>0||sample.share!==undefined||sample.file){assert.notEqual(sample.file,'','review progress names the file it is on');}
   const timed=seen.filter(sample=>sample.eta!==undefined||sample.speed>0||(sample.fileRate??0)>0);
   if(timed.length)assert.ok(timed.every(sample=>sample.file!==''),'progress with a speed or time left also names its file');
   await action({type:'discardReview'});
  });
  await check('Organization applies changed folder settings and can recheck its recovery journal',async()=>{
   if(organizationOnly){await fs.copyFile(path.join(root,'source-1','photo.png'),path.join(root,'destination','unorganized.png'));await fs.copyFile(path.join(root,'source-1','clip.mp4'),path.join(root,'destination','unorganized.mp4'));}
   await action({type:'preferences',patch:{basePath:'organized-library'}});
   const reviewed=await action({type:'previewOrganization',destinationIndex:0});assert.equal(reviewed.review?.kind,'reorganize');assert.ok(reviewed.review!.plans[0].entries.length>=2);assert.equal(reviewed.review!.plans[0].source,path.join(root,'destination'));assert.equal(reviewed.review!.plans[0].root,path.join(root,'destination','organized-library'));
   const previous=new Set((await state()).jobs.map(job=>job.id));await js("Promise.all([window.importer.action({type:'applyReview'}),window.importer.action({type:'applyReview'})])");await wait(async()=>!(await state()).jobs.some(job=>['queued','discovering','verifying','copying'].includes(job.phase)),'organization finish');
   assert.equal((await state()).jobs.filter(job=>!previous.has(job.id)).length,1,'Double Apply must create only one organization job');
   await action({type:'refreshOrganization'});const recovery=(await state()).organizationRecovery?.find(job=>job.status==='complete');assert.ok(recovery,JSON.stringify((await state()).jobs));
   const beforeResume=new Set((await state()).jobs.map(job=>job.id));await js(`Promise.all([window.importer.action(${JSON.stringify({type:'resumeOrganization',id:recovery.id,root:recovery.root})}),window.importer.action(${JSON.stringify({type:'resumeOrganization',id:recovery.id,root:recovery.root})})])`);await wait(async()=>!(await state()).jobs.some(job=>['queued','discovering','verifying','copying'].includes(job.phase)),'recheck finish');assert.equal((await state()).jobs[0].phase,'complete',english((await state()).jobs[0].detail));assert.equal((await state()).jobs.filter(job=>!beforeResume.has(job.id)).length,1,'Double Resume must create only one recovery job');await action({type:'clearError'});
  });
  await check('One-click organization executes through the public app action and writes real execution reports',async()=>{
   await action({type:'preferences',patch:{basePath:'oneclick-library'}});
   const before=new Set((await state()).jobs.map(job=>job.id));const started=await action({type:'organize',destinationIndex:0});
   const job=started.jobs.find(job=>!before.has(job.id)&&job.organization);assert.ok(job,'App must create an organization job');
   await wait(async()=>{const current=(await state()).jobs.find(item=>item.id===job.id);return !!current&&['complete','error','stopped'].includes(current.phase);},'one-click organization completion');
   const current=(await state()).jobs.find(item=>item.id===job.id)!;assert.equal(current.phase,'complete',english(current.detail));assert.equal(current.organization,true);
   const directory=path.join(root,'user-data','operation-reports',job.id),summary=JSON.parse(await fs.readFile(path.join(directory,'summary.json'),'utf8')),plan=JSON.parse(await fs.readFile(path.join(directory,'plan.json'),'utf8'));
   assert.equal(summary.producer,'desktop-app');assert.equal(summary.kind,'reorganize');assert.equal(summary.passed,true);assert.equal(summary.retainedOriginals,true);
   assert.deepEqual(plan.sourceFolders,(await state()).organizationFolders?.[path.join(root,'destination')]);assert.equal(plan.plans[0].source,path.join(root,'destination'));assert.equal(plan.plans[0].root,path.join(root,'destination','oneclick-library'));
   assert.equal(await digest(marker),originals.get(marker));
  });
  await check('Organization targets either selected destination using the same reviewed workflow',async()=>{
   const second=path.join(root,'destination-2');await fs.copyFile(path.join(root,'source-1','photo.png'),path.join(second,'unorganized.png'));
   const before=(await state()).preferences.destinations;
   await js("Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()==='Organization').click()");await wait(()=>js<boolean>("document.querySelector('.window-titlebar h1').textContent==='Organization'"),'navigation committed');
   await js("(()=>{const select=document.querySelector('.organization-destination-select select');select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
   await wait(()=>js<boolean>(`document.querySelector('.organization-paths').textContent.includes(${JSON.stringify(second)})`),'selected organization location');
   await action({type:'preferences',patch:{basePath:'second-organized'}});
   const reviewed=await action({type:'previewOrganization',destinationIndex:1});assert.equal(reviewed.review?.source.path,second);assert.equal(reviewed.review?.plans[0].root,path.join(second,'second-organized'));assert.deepEqual(reviewed.preferences.destinations,before);
   await action({type:'applyReview'});await wait(async()=>!(await state()).jobs.some(job=>['queued','discovering','verifying','copying'].includes(job.phase)),'second organization finish');assert.equal((await state()).jobs[0].phase,'complete',english((await state()).jobs[0].detail));
  });
 }
 }catch(error){failure=error;}
 finally{
  nativeTheme.themeSource=previousTheme;
  try{await check('Every source original and the existing destination marker retain their exact bytes',async()=>{for(const [file,hash] of originals)assert.equal(await digest(file),hash,file);});}catch(error){failure??=error;}
  await fs.writeFile(path.join(report,'state.json'),JSON.stringify(await state(),null,2));
  await fs.writeFile(path.join(report,'report.json'),JSON.stringify({suite:organizationOnly?'organization':uiOnly?'ui':'full',passed:!failure,checks,error:failure?String(failure):undefined},null,2));
 }
 return !failure;
}
