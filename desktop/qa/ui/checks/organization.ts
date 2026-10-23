import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {formatMessage} from '../../../messages';
import type {Check,Harness} from '../harness';
import {digest,type Context} from './context';

const english=(message?:Parameters<typeof formatMessage>[0])=>message?formatMessage(message,'en'):'';
const running=['queued','discovering','verifying','copying'];
let seeded=0;
/** Puts a photo and a video loose in the destination, so every organization check has files to file. */
async function seed(ctx:Context,folder=path.join(ctx.root,'destination')){
 seeded++;
 await fs.copyFile(path.join(ctx.root,'source-1','photo.png'),path.join(folder,`unorganized-${seeded}.png`));
 await fs.copyFile(path.join(ctx.root,'source-1','clip.mp4'),path.join(folder,`unorganized-${seeded}.mp4`));
}
/** Every check leaves the backup folder (and the unknown-files choice) where imports expect them. The seeded files carry no metadata, so these checks file them by file date; by default they would be left in place. */
async function withBasePath(h:Harness,basePath:string,run:()=>Promise<void>){try{await h.prefs({basePath,noMetadataHandling:'fileDate'});await run();}finally{await h.prefs({basePath:'photobackup',noMetadataHandling:'keep'});}}
const idle=(h:Harness,label:string)=>h.waitFor(label,async()=>!(await h.state()).jobs.some(job=>running.includes(job.phase)),{timeoutMs:60000});

export const organizationChecks=(ctx:Context):Check[]=>[
 {id:'organization-review-progress',stage:'organization',suite:'organization',title:'A fixture organization review shows its progress in the shared layout with the count, file name, time left and speed',covers:['organization review','live progress counter','shared progress layout'],run:async h=>{
  await seed(ctx);
  const seen:{file:string;total:number;share?:number;eta?:number;speed:number;fileRate?:number}[]=[];
  const shown:{speed:boolean;file:boolean;count:boolean}[]=[];
  // A state sample and the bar drawn right after it: what the backend reported must be on screen.
  const paired:{timed:boolean;named:boolean;layout:{speed:boolean;file:boolean;count:boolean}}[]=[];
  let done=false;const pending=h.action({type:'previewOrganization',destinationIndex:0}).finally(()=>{done=true;});
  while(!done){
   const progress=(await h.state()).reviewProgress;
   // The review's own bar (the overview above it has no file row by design).
   const layout=progress?await h.js<{speed:boolean;file:boolean;count:boolean}|null>("(()=>{const d=document.querySelector('[data-testid=planning-progress]');return d?{speed:!!d.querySelector('[data-testid=speed]'),file:!!d.querySelector('[data-testid=progress-file]'),count:!!d.querySelector('[data-testid=progress-count]')}:null})()"):null;
   if(layout)shown.push(layout);
   if(progress){seen.push({file:progress.file,total:progress.total,share:progress.share,eta:progress.eta,speed:progress.speed,fileRate:progress.fileRate});if(layout)paired.push({timed:progress.speed>0||(progress.fileRate??0)>0,named:!!progress.file,layout});}
   await h.frames(1);
  }
  await pending;await h.waitFor('organization review ready',async()=>(await h.state()).review!==undefined);
  // A fixture review is quick, so only what was observed is checked: every sample names a file.
  for(const sample of seen)if(sample.total>0||sample.share!==undefined||sample.file)assert.notEqual(sample.file,'','review progress names the file it is on');
  const timed=seen.filter(sample=>sample.eta!==undefined||sample.speed>0||(sample.fileRate??0)>0);
  if(timed.length)assert.ok(timed.every(sample=>sample.file!==''),'progress with a speed or time left also names its file');
  assert.ok(shown.every(layout=>layout.count),'every progress display shows its count');
  for(const pair of paired){if(pair.timed)assert.ok(pair.layout.speed,`a reported speed is shown: ${JSON.stringify(paired)}`);if(pair.named)assert.ok(pair.layout.file,`a reported file is shown: ${JSON.stringify(paired)}`);}
 }},
 {id:'organization-apply',stage:'organization',suite:'organization',title:'Organization applies changed folder settings once, even when Apply is clicked twice',covers:['organization flow end to end','double-click safety'],budgetMs:120000,run:async h=>withBasePath(h,'organized-library',async()=>{
  await seed(ctx);
  const reviewed=await h.action({type:'previewOrganization',destinationIndex:0});assert.equal(reviewed.review?.kind,'reorganize');
  const plan=reviewed.review!.plans[0]!;
  // Video-root is the default layout, so videos are planned into their own folder.
  assert.ok(plan.entries.length+(plan.videos?.entries.length??0)>=2,JSON.stringify({photos:plan.entries.length,videos:plan.videos?.entries.length}));
  assert.equal(plan.source,path.join(ctx.root,'destination'));assert.equal(plan.root,path.join(ctx.root,'destination','organized-library'));
  const previous=new Set((await h.state()).jobs.map(job=>job.id));
  await h.js("Promise.all([window.importer.action({type:'applyReview'}),window.importer.action({type:'applyReview'})])");
  await idle(h,'organization finish');
  const created=(await h.state()).jobs.filter(job=>!previous.has(job.id));
  assert.equal(created.length,1,'Double Apply must create only one organization job');
  assert.equal(created[0]!.phase,'complete',english(created[0]!.detail));
 })},
 {id:'organization-one-click',stage:'organization',suite:'organization',title:'One-click organization executes through the public app action and writes real execution reports',covers:['one-click organization','operation reports','destination marker untouched'],budgetMs:120000,run:async h=>withBasePath(h,'oneclick-library',async()=>{
  await seed(ctx);
  const before=new Set((await h.state()).jobs.map(job=>job.id));const started=await h.action({type:'organize',destinationIndex:0});
  const job=started.jobs.find(job=>!before.has(job.id)&&job.organization);assert.ok(job,'App must create an organization job');
  await h.waitFor('one-click organization completion',async()=>{const current=(await h.state()).jobs.find(item=>item.id===job.id);return !!current&&['complete','error','stopped'].includes(current.phase);},{timeoutMs:60000});
  const current=(await h.state()).jobs.find(item=>item.id===job.id)!;assert.equal(current.phase,'complete',english(current.detail));assert.equal(current.organization,true);
  const directory=path.join(ctx.root,'user-data','operation-reports',job.id),summary=JSON.parse(await fs.readFile(path.join(directory,'summary.json'),'utf8')),written=JSON.parse(await fs.readFile(path.join(directory,'plan.json'),'utf8'));
  assert.equal(summary.producer,'desktop-app');assert.equal(summary.kind,'reorganize');assert.equal(summary.passed,true);assert.equal(summary.retainedOriginals,true);
  assert.deepEqual(written.sourceFolders,(await h.state()).organizationFolders?.[path.join(ctx.root,'destination')]);assert.equal(written.plans[0].source,path.join(ctx.root,'destination'));assert.equal(written.plans[0].root,path.join(ctx.root,'destination','oneclick-library'));
  assert.equal(await digest(ctx.marker),ctx.originals.get(ctx.marker));
 })},
 {id:'organization-second-destination',stage:'organization',suite:'organization',title:'Organization targets either selected destination using the same reviewed workflow',covers:['destination picker on the Organization page'],budgetMs:120000,run:async h=>withBasePath(h,'second-organized',async()=>{
  const second=path.join(ctx.root,'destination-2');await seed(ctx,second);
  const before=(await h.state()).preferences.destinations;
  await h.nav('Organization');
  await h.js("(()=>{const select=document.querySelector('.organization-destination-select select');select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await h.until('selected organization location',`document.querySelector('.organization-paths').textContent.includes(${JSON.stringify(second)})`);
  const reviewed=await h.action({type:'previewOrganization',destinationIndex:1});assert.equal(reviewed.review?.source.path,second);assert.equal(reviewed.review?.plans[0]!.root,path.join(second,'second-organized'));assert.deepEqual(reviewed.preferences.destinations,before);
  const previous=new Set((await h.state()).jobs.map(job=>job.id));
  await h.action({type:'applyReview'});await idle(h,'second organization finish');
  const job=(await h.state()).jobs.find(item=>!previous.has(item.id));assert.equal(job?.phase,'complete',english(job?.detail));
 })},
];
