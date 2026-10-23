import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ipcMain} from 'electron';
import type {Metadata} from '../../../shared';
import {formatMessage} from '../../../messages';
import type {Check,Harness} from '../harness';
import {digests,savedPreferences,type Context} from './context';

const english=(message?:Parameters<typeof formatMessage>[0])=>message?formatMessage(message,'en'):'';
const ended=(phase:string)=>['complete','error','stopped'].includes(phase);
/** Scans fixture:1 read-only unless its media summary is already known. */
export async function scanned(h:Harness,sourceId='fixture:1'){
 if((await h.state()).sourceInventories?.[sourceId])return;
 await h.action({type:'scan',sourceId});
 await h.waitFor(`media scan of ${sourceId}`,async()=>!!(await h.state()).sourceInventories?.[sourceId]);
}
type Row={sourceId:string;height:number;width:number;controlsFit:boolean;outside:string[]};
const cardRows=`Array.from(document.querySelectorAll('article.source-row')).map(card=>{const box=card.getBoundingClientRect();const outside=Array.from(card.querySelectorAll('button')).filter(control=>{if(!control.checkVisibility())return false;const b=control.getBoundingClientRect();return !(b.left>=box.left-1&&b.right<=box.right+1&&b.top>=box.top-1&&b.bottom<=box.bottom+1);}).map(control=>(control.getAttribute('aria-label')||control.textContent||'').trim().slice(0,40)+' '+JSON.stringify(control.getBoundingClientRect()));return {sourceId:card.dataset.sourceId,height:box.height,width:box.width,controlsFit:outside.length===0,outside};})`;

export const importChecks=(ctx:Context):Check[]=>[
 {id:'import-scan',stage:'imports',title:'Read-only drive scanning exposes media formats without copying files, and drive cards expand and collapse in place',covers:['scan flow','card disclosure','cancel and rescan'],run:async h=>{
  await h.until('source card disclosures',"document.querySelectorAll('details.source-disclosure').length===6");
  assert.equal(await h.js<boolean>("Array.from(document.querySelectorAll('details.source-disclosure')).every(details=>!details.open)"),true,'Drive details must start collapsed');
  assert.equal(await h.js<boolean>("document.querySelector('#parallel-source-limit').closest('.section-heading').contains(document.querySelector('#source-heading'))&&document.querySelector('.concurrency-control')===null"),true,'Parallel limit belongs in the source heading row');
  const before=(await h.state()).jobs.length;
  await h.action({type:'scan',sourceId:'fixture:1'});await h.action({type:'stop'});await h.waitFor('scan cancellation',async()=>!(await h.state()).scanningSources?.length);
  await h.action({type:'scan',sourceId:'fixture:1'});await h.waitFor('media scan',async()=>!!(await h.state()).sourceInventories?.['fixture:1']);
  const scan=(await h.state()).sourceInventories!['fixture:1']!;assert.equal(scan.media,2);assert.equal((await h.state()).jobs.length,before,'Scanning starts no job');
  await h.until('scanned card content',"document.querySelector('[data-testid=source-media-summary][data-source-id=\"fixture:1\"]')");
  const layout:{label:string;rows:Row[]}[]=[];
  const measure=async(label:string)=>{const rows=await h.js<Row[]>(cardRows);layout.push({label,rows});await fs.writeFile(path.join(h.report,'source-card-layout.json'),JSON.stringify({measurements:layout},null,2));assert.ok(rows.every(row=>row.controlsFit),`Card controls overflow at ${label}: ${JSON.stringify(rows.filter(row=>!row.controlsFit))}`);return rows;};
  const compact=await measure('compact-125');await h.shot('source-cards-compact');
  assert.equal(await h.js<boolean>("Array.from(document.querySelectorAll('article.source-row')).every((card,index,cards)=>{const style=getComputedStyle(card);return parseFloat(style.borderTopWidth)>0&&parseFloat(style.borderBottomWidth)>0&&(!index||card.getBoundingClientRect().top>cards[index-1].getBoundingClientRect().bottom);})"),true,'Each source has a separate bordered surface and gap');
  assert.equal(await h.js<boolean>("document.querySelector('[data-testid=source-media-summary][data-source-id=\"fixture:1\"]')?.checkVisibility()"),false);
  await h.click('article[data-source-id="fixture:1"] .source-step-row > .source-disclosure-toggle');
  assert.equal(await h.js<boolean>("Array.from(document.querySelectorAll('article.source-row')).every(card=>card.querySelector('details.source-disclosure').open===(card.dataset.sourceId==='fixture:1'))"),true,'Expanding one card must leave the others collapsed');
  const summary="document.querySelector('[data-testid=source-media-summary][data-source-id=\"fixture:1\"]')";
  await h.until('media format summary',`${summary}?.textContent.includes('PNG')&&${summary}?.textContent.includes('MP4')&&${summary}?.checkVisibility()`);
  assert.equal(await h.js<boolean>("document.querySelector('[data-testid=media-pie]')===null"),true,'Pie chart has been removed');
  await h.settle();
  const expanded=await measure('expanded-125');assert.ok(expanded.find(row=>row.sourceId==='fixture:1')!.height>compact.find(row=>row.sourceId==='fixture:1')!.height);await h.shot('source-card-expanded');await h.shot('drive-details');
  const checked=(await h.state()).sourceCameraInfo?.['fixture:1']?.checked??0;
  await h.click('article[data-source-id="fixture:1"] .source-step-row > .source-disclosure-toggle');await h.settle();
  const collapsed=await measure('collapsed-125');assert.ok(collapsed.find(row=>row.sourceId==='fixture:1')!.height<expanded.find(row=>row.sourceId==='fixture:1')!.height);
  assert.equal((await h.state()).sourceInventories!['fixture:1']!.media,2);assert.ok(((await h.state()).sourceCameraInfo?.['fixture:1']?.checked??0)>=checked,'Collapsing must retain camera scan progress');
  assert.equal(await h.js<boolean>(`${summary}?.textContent.includes('PNG')&&${summary}?.textContent.includes('MP4')`),true,'Collapsing must retain scan results');
  await h.prefs({textScale:1.5});await measure('compact-150');await h.shot('source-cards-compact-150');
  await h.size(1000,760);
  for(const language of ['en','zh-Hans','zh-Hant','ja'] as const){
   await h.prefs({language});
   const fit=await h.js<boolean>("Array.from(document.querySelectorAll('.titlebar-actions button,.titlebar-actions label,.titlebar-page-title')).every(control=>{const box=control.getBoundingClientRect(),bar=document.querySelector('.window-titlebar').getBoundingClientRect();return box.left>=104&&box.right<=bar.right&&box.bottom<=bar.bottom;})");
   assert.equal(fit,true,language+' titlebar controls must fit 1000px at 150%');await h.shot('titlebar-1000-150-'+language);
  }
 }},
 {id:'import-storage-strips',stage:'imports',title:'Storage strips show continuous used/free segments and scanned media categories without overflow',covers:['capacity bars','bars never clip'],run:async h=>{
  await scanned(h);
  await h.until('media categories in the strip',"document.querySelector('article[data-source-id=\"fixture:1\"] [data-storage-kind=PNG]')&&document.querySelector('article[data-source-id=\"fixture:1\"] [data-storage-kind=MP4]')");
  const valid=await h.js<boolean>("Array.from(document.querySelectorAll('.storage-track')).every(track=>{const total=Array.from(track.children).reduce((sum,item)=>sum+parseFloat(item.style.width),0);return Math.abs(total-100)<.001&&track.scrollWidth<=track.clientWidth+1&&!!track.getAttribute('aria-valuetext');})");
  assert.equal(valid,true);
  assert.equal(await h.js<number>("document.querySelectorAll('article.source-row [data-testid=storage-capacity]').length"),6);
  await h.shot('storage-capacity-strips');
 }},
 {id:'import-source-layout',stage:'imports',title:'Source layout switches between a saved two-column grid and one-column list, adapting to narrow windows',covers:['grid and list layout','persisted layout','no horizontal overflow at large text'],run:async h=>{
  const rows=()=>h.js<{x:number;y:number;width:number}[]>("Array.from(document.querySelectorAll('article.source-row')).map(card=>{const r=card.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};})");
  const columns=async(two:boolean)=>{const r=await rows();return r.length===6&&(two?Math.abs(r[0]!.y-r[1]!.y)<2&&r[1]!.x>r[0]!.x:Math.abs(r[0]!.x-r[1]!.x)<2&&r[1]!.y>r[0]!.y);};
  await h.size(1600,940);
  await h.click('[data-testid=source-layout-grid]');
  await h.until('grid selected',"document.querySelector('[data-testid=source-layout-grid]').getAttribute('aria-pressed')==='true'");
  await h.waitFor('two columns',()=>columns(true),{seen:rows});
  await h.waitFor('saved grid preference',async()=>(await savedPreferences(ctx.root)).sourceLayout==='grid');
  await h.shot('sources-grid');
  await h.click('article.source-row .source-step-row > .source-disclosure-toggle');
  assert.equal(await h.js<number>("document.querySelectorAll('details.source-disclosure[open]').length"),1);
  await h.shot('sources-grid-expanded');
  await h.click('article.source-row .source-step-row > .source-disclosure-toggle');
  await h.size(1000,760);await h.prefs({textScale:1.5});
  await h.waitFor('grid adapts to narrow workspace',()=>columns(false),{seen:rows});
  assert.equal(await h.js<boolean>("document.querySelector('.main-content').scrollWidth<=document.querySelector('.main-content').clientWidth"),true,'No horizontal overflow with large text');
  await h.shot('sources-grid-narrow');
  await h.size(1600,940);
  await h.click('[data-testid=source-layout-list]');
  await h.waitFor('one-column list',()=>columns(false),{seen:rows});
  await h.waitFor('saved list preference',async()=>(await savedPreferences(ctx.root)).sourceLayout==='list');
  await h.shot('sources-list');
 }},
 {id:'import-metadata',stage:'imports',title:'Photo metadata is readable and collapsed; video summaries omit shutter count in every language',covers:['per-file review preview','metadata sheet','4 locales'],run:async h=>{
  // Fixture-only: the real preview UI runs through its bridge, without native dialogs or user files.
  const photo:Metadata={camera:'Fixture camera',date:'2025-06-26T13:50:35+08:00',exposure:{lens:'Fixture 24–70mm',aperture:2.8,iso:400,exposureTime:1/125,focalLength:35,exposureCompensation:0.3},shutterCount:'123',shutterNote:'Fixture shutter note',fields:{'EXIF:Model':'Fixture camera','EXIF:ISO':400}};
  let selected={path:path.join(ctx.root,'source-1','photo.png'),metadata:photo};
  // Through the QA hook when there is one, so the real handler stays for later checks; else replaced for the rest of the run.
  if(h.hooks)h.hooks.inspect=()=>selected.metadata;else{ipcMain.removeHandler('importer:inspect');ipcMain.handle('importer:inspect',()=>selected.metadata);}
  const open=async(name:string)=>{await h.js(`Array.from(document.querySelectorAll('.review-source-button')).find(button=>button.textContent.includes(${JSON.stringify(name)})).click()`);await h.until('metadata dialog',"document.querySelector('.metadata-dialog')?.open===true");};
  const close=async()=>{await h.click('[data-testid=metadata-close]');await h.until('animated metadata close',"document.querySelector('.metadata-dialog')===null");};
  try{
   await h.action({type:'preview',sourceId:'fixture:1'});await h.until('per-file review preview',"document.querySelector('.review-source-button')");
   await open('photo.png');
   assert.equal(await h.js<string>("document.querySelector('[data-testid=metadata-timezone]').textContent"),'UTC+08:00');
   assert.equal(await h.js<string>("document.querySelector('[data-testid=metadata-capture-time]').textContent"),'13:50:35');assert.ok(await h.js<boolean>("document.querySelector('.capture-summary').textContent.includes('Jun 26, 2025')"));
   const exposure=await h.js<string>("document.querySelector('[data-testid=metadata-exposure]').textContent");for(const expected of ['Fixture 24–70mm','2.8','400','1/125','35','+0.3'])assert.ok(exposure.includes(expected),exposure);
   assert.equal(await h.js<string>("document.querySelector('[data-testid=metadata-shutter-count]').textContent"),'123');
   assert.equal(await h.js<boolean>("document.querySelector('[data-testid=metadata-details]').open"),false);
   assert.equal(await h.js<boolean>("document.querySelector('.metadata-fields').checkVisibility()"),false,'Full metadata fields must not be visible before expanding');
   assert.equal(await h.js<boolean>("document.querySelector('[data-testid=metadata-details] summary').getBoundingClientRect().bottom<=document.querySelector('.metadata-inspector').getBoundingClientRect().bottom"),true,'The metadata disclosure must fit in the initial summary without scrolling');
   await h.shot('photo-metadata-collapsed');
   await h.click('[data-testid=metadata-details] summary');
   assert.equal(await h.js<boolean>("document.querySelector('[data-testid=metadata-details]').open"),true);
   await h.until('full metadata fields after animated expansion',"document.querySelector('.metadata-fields').checkVisibility()");
   await h.shot('photo-metadata-expanded');await close();
   selected={path:path.join(ctx.root,'source-1','clip.mp4'),metadata:{...photo,shutterCount:'999',shutterNote:'Video shutter note'}};
   for(const language of ['en','zh-Hans','zh-Hant','ja'] as const){
    await h.prefs({language});await open('clip.mp4');
    assert.equal(await h.js<boolean>("document.querySelector('[data-testid=metadata-details]').open"),false);
    assert.equal(await h.js<boolean>("document.querySelector('[data-testid=metadata-shutter-count]')===null"),true);
    assert.equal(await h.js<boolean>("document.querySelector('.shutter-note')===null"),true);
    assert.equal(await h.js<string>("document.querySelector('[data-testid=metadata-timezone]').textContent"),'UTC+08:00');
    await h.shot('video-metadata-'+language);await close();
   }
  }finally{if(h.hooks)h.hooks.inspect=undefined;}
 }},
 {id:'import-rule-invalidates-review',stage:'imports',title:'Changing an unknown-file rule invalidates a ready import review',covers:['review invalidation'],run:async h=>{
  const ready=await h.action({type:'preview',sourceId:'fixture:1'});assert.ok(ready.review);const before=ready.jobs.length;
  const changed=await h.action({type:'unknownRule',extension:'dat',folder:null,remember:false});assert.equal(changed.review,undefined);assert.equal(changed.jobs.length,before);
 }},
 {id:'import-review-footer',stage:'imports',title:'Review actions Copy reviewed files and Discard review stay fully inside the viewport at every window and text size',covers:['sticky review footer','no clipping'],run:async h=>{
  const bad:Record<string,unknown>[]=[];
  await h.action({type:'preview',sourceId:'fixture:1'});await h.until('review footer',"document.querySelector('.review-footer button')");
  for(const [w,height] of [[1000,720],[1440,940]] as const){await h.size(w,height);
   for(const scale of [1,2]){await h.prefs({textScale:scale});await h.settle();
    const found=await h.js<Record<string,unknown>[]>("Array.from(document.querySelectorAll('.review-footer button')).map(b=>{const r=b.getBoundingClientRect();return {text:b.textContent.trim(),top:r.top,bottom:r.bottom,height:r.height,vh:window.innerHeight,ok:r.top>=0&&r.bottom<=window.innerHeight+0.5&&r.height>=28};})");
    if(found.length<2)bad.push({window:`${w}x${height}`,scale,found});for(const f of found)if(!f.ok)bad.push({window:`${w}x${height}`,scale,...f});}}
  assert.deepEqual(bad,[],'Review actions not fully visible');
 }},
 {id:'import-stop',stage:'imports',suite:'import',title:'Five sources run and the sixth queues; an organization queues behind them; Stop stops every one of them',covers:['parallel limit','queue','Stop','organization queue'],skip:async h=>h.hooks?undefined:'needs the QA hook (unpackaged --codex-test build)',run:async h=>{
  // Imports wait at the QA gate, so Stop always meets running and queued jobs, however fast or slow the machine is.
  await h.prefs({parallel:5});
  const earlier=new Set((await h.state()).jobs.map(j=>j.id));
  h.releaseHold=h.hooks!.hold();
  await h.action({type:'start'});
  await h.waitFor('five imports held at the start',()=>h.hooks!.held().size===5,{seen:async()=>(await h.state()).jobs.map(j=>j.phase)});
  const started=await h.state(),fresh=started.jobs.filter(j=>!earlier.has(j.id));
  assert.equal(fresh.filter(j=>['discovering','verifying','copying'].includes(j.phase)).length,5,JSON.stringify(fresh.map(j=>j.phase)));assert.equal(fresh.filter(j=>j.phase==='queued').length,1);
  const queued=await h.action({type:'organize',destinationIndex:0});assert.equal(queued.jobs.find(job=>job.organization&&!earlier.has(job.id))?.phase,'queued','Organization waits behind existing imports');
  await fs.writeFile(path.join(h.report,'queue.json'),JSON.stringify(queued,null,2));
  await h.action({type:'stop'});h.releaseHold();h.releaseHold=undefined;
  await h.waitFor('every job settles after Stop',async()=>(await h.state()).jobs.every(j=>ended(j.phase)),{seen:async()=>(await h.state()).jobs.map(j=>j.phase)});
  const settled=(await h.state()).jobs.filter(j=>!earlier.has(j.id));
  assert.equal(settled.length,7,'six imports and the organization');
  assert.deepEqual(settled.map(j=>j.phase),Array(7).fill('stopped'),'Stop stops running and queued jobs alike');
  await h.until('organization listed in import dashboard',"document.querySelector('.import-dashboard .progress-jobs')?.textContent.includes('Library organization')");await h.shot('queued-organization-progress');
 }},
 {id:'import-retry-duplicates',stage:'imports',suite:'import',title:'Importing copies all source contents and a second run verifies duplicates without copying',covers:['import flow end to end','duplicate detection on re-import'],budgetMs:150000,run:async h=>{
  await h.prefs({parallel:5});
  const run=async()=>{const before=new Set((await h.state()).jobs.map(j=>j.id));await h.action({type:'start'});
   await h.waitFor('copy completion',async()=>{const jobs=(await h.state()).jobs.filter(j=>!before.has(j.id));return jobs.length===6&&jobs.every(j=>ended(j.phase));},{timeoutMs:60000,seen:async()=>(await h.state()).jobs.filter(j=>!before.has(j.id)).map(j=>j.phase)});
   const jobs=(await h.state()).jobs.filter(j=>!before.has(j.id));assert.ok(jobs.every(j=>j.phase==='complete'),JSON.stringify(jobs.map(j=>({phase:j.phase,detail:j.detail,errors:j.errors.slice(0,2)}))));return jobs;};
  await run();
  const backup=path.join(ctx.root,'destination','photobackup');
  const copied=await digests(backup);for(const [file,hash] of ctx.originals)if(file.startsWith(path.join(ctx.root,'source-')))assert.ok(copied.includes(hash),`Missing copied content: ${file}`);
  const repeated=await run();assert.ok(repeated.every(j=>j.alreadyImported||english(j.detail).startsWith('0 copied')),'Repeated imports must not copy duplicates');
  assert.equal((await digests(backup)).length,copied.length,'Repeated imports must not add files to the backup');
 }},
 {id:'import-nested-folder',stage:'imports',suite:'import',title:'Concurrent sources create a fresh nested backup folder without directory races',covers:['parallel imports into a new folder'],budgetMs:120000,run:async h=>{
  const before=new Set((await h.state()).jobs.map(job=>job.id));
  const nested=path.join(ctx.root,'destination','fresh-backup','nested');
  assert.equal(await fs.stat(nested).then(()=>true,()=>false),false);
  try{
   await h.prefs({basePath:'fresh-backup/nested',parallel:5});
   await h.action({type:'start'});
   await h.waitFor('concurrent new destination folders',async()=>{const jobs=(await h.state()).jobs.filter(job=>!before.has(job.id));return jobs.length===6&&jobs.every(job=>ended(job.phase));},{timeoutMs:60000});
   const jobs=(await h.state()).jobs.filter(job=>!before.has(job.id));assert.ok(jobs.every(job=>job.phase==='complete'),JSON.stringify(jobs.map(job=>({phase:job.phase,errors:job.errors.slice(0,2)}))));
   assert.ok((await fs.stat(nested)).isDirectory());
   const hashes=new Set(await digests(nested));for(const [file,hash] of ctx.originals)if(file.startsWith(path.join(ctx.root,'source-')))assert.ok(hashes.has(hash),`Concurrent import missing ${file}`);
  }finally{await h.prefs({basePath:'photobackup'});}
 }},
];
