import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as core from '../core/index';
import {findResidue,cleanResidue} from '../core/residue';
import {EtaTracker,stampEstimates} from '../eta';
import {I18nProvider,createTranslator,languages} from '../renderer/i18n';
import {ImportDashboard,ImportDesk,LeftoverFiles,Organization,OrganizationCard,PlanningProgress,ScanProgress,SidebarSources,SidebarDestinations,progressCount,progressFraction,ReviewPanel} from '../renderer/RootApp';
import type {AppState,Job,Progress} from '../shared';

core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const preferences:AppState['preferences']={language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A006'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}} as AppState['preferences'];
const card={id:'card',name:'Card',path:'/Volumes/CARD',transport:'storage' as const,selected:true,total:128e9,free:40e9};
const render=(node:ReturnType<typeof createElement>,language:typeof languages[number]='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:node}));
const base:Progress={completed:0,total:1000,bytes:0,totalBytes:10e9,speed:0,file:'A.NEF'};

// Every step the interface knows, with a sample progress, what its count says, and whether it moves data.
type Step=NonNullable<Progress['step']>;
type Operation={name:string;step?:Step;phase:NonNullable<Progress['phase']>;unit:'bytes'|'files';count:RegExp;at:(second:number)=>Progress;renames?:boolean;file:boolean};
const files=(second:number)=>({completed:second*20});
const operations:Operation[]=[
 {name:'drive scan listing',step:'listing',phase:'planning',unit:'files',count:/files found/,file:true,at:s=>({...base,phase:'planning',step:'listing',completed:s*100,total:0,totalBytes:0,bytes:s*1e8,share:Math.min(.9,s/10)})},
 {name:'import checking',step:'checking',phase:'planning',unit:'files',count:/files checked/,file:true,at:s=>({...base,phase:'planning',step:'checking',...files(s)})},
 {name:'import reading',step:'reading',phase:'planning',unit:'bytes',count:/files read/,file:true,at:s=>({...base,phase:'planning',step:'reading',bytes:s*100e6,completed:s*5})},
 {name:'import comparing',step:'comparing',phase:'planning',unit:'bytes',count:/Checking the destination/,file:true,at:s=>({...base,phase:'planning',step:'comparing',bytes:s*100e6,completed:s*5})},
 {name:'import existing',step:'existing',phase:'planning',unit:'files',count:/already on the destination/,file:true,at:s=>({...base,phase:'planning',step:'existing',...files(s)})},
 {name:'earlier organization',step:'earlier',phase:'verifying',unit:'files',count:/earlier organization/,file:true,at:s=>({...base,phase:'verifying',step:'earlier',...files(s)})},
 {name:'organization history',step:'history',phase:'verifying',unit:'files',count:/organization history/,file:true,at:s=>({...base,phase:'verifying',step:'history',...files(s)})},
 {name:'organization confirming',step:'confirming',phase:'verifying',unit:'files',count:/Confirming files before moving/,file:true,renames:true,at:s=>({...base,phase:'verifying',step:'confirming',...files(s),renames:true})},
 {name:'import copying',phase:'copying',unit:'bytes',count:/files copied/,file:true,at:s=>({...base,phase:'copying',bytes:s*100e6,completed:s*5})},
 {name:'import verifying',phase:'verifying',unit:'bytes',count:/files verified/,file:true,at:s=>({...base,phase:'verifying',bytes:10e9,completed:s*20})},
 {name:'organization moving by rename',step:'moving',phase:'copying',unit:'files',count:/files moved/,file:true,renames:true,at:s=>({...base,phase:'copying',step:'moving',...files(s),renames:true})},
 {name:'organization moving by copy',step:'moving',phase:'copying',unit:'bytes',count:/files organized/,file:true,at:s=>({...base,phase:'copying',step:'moving',bytes:s*100e6,completed:s*5})},
 {name:'duplicate metadata',step:'fingerprinting',phase:'planning',unit:'files',count:/Reading metadata/,file:true,at:s=>({...base,phase:'planning',step:'fingerprinting',...files(s)})},
 {name:'duplicate candidates',step:'candidates',phase:'planning',unit:'files',count:/Confirming possible duplicates/,file:true,at:s=>({...base,phase:'planning',step:'candidates',...files(s)})},
 {name:'duplicate collisions',step:'collisions',phase:'planning',unit:'files',count:/Looking for identical files/,file:true,at:s=>({...base,phase:'planning',step:'collisions',...files(s)})},
 {name:'setting aside duplicates',step:'stashing',phase:'copying',unit:'files',count:/Setting aside duplicates/,file:true,renames:true,at:s=>({...base,phase:'copying',step:'stashing',...files(s),renames:true})},
 {name:'closing the journal and folders',step:'tidying',phase:'copying',unit:'files',count:/Finishing up/,file:true,renames:true,at:s=>({...base,phase:'copying',step:'tidying',...files(s),renames:true})},
 {name:'finalize checking',step:'checking',phase:'verifying',unit:'files',count:/files verified/,file:true,at:s=>({...base,phase:'verifying',step:'checking',bytes:0,totalBytes:0,...files(s)})},
 {name:'finalize releasing',step:'releasing',phase:'copying',unit:'files',count:/files released/,file:true,at:s=>({...base,phase:'copying',step:'releasing',bytes:0,totalBytes:0,...files(s)})},
 {name:'undo restoring',step:'restoring',phase:'copying',unit:'files',count:/files put back/,file:true,at:s=>({...base,phase:'copying',step:'restoring',bytes:0,totalBytes:0,...files(s)})},
 {name:'delete recovery files',step:'deleting',phase:'copying',unit:'files',count:/files deleted/,file:true,at:s=>({...base,phase:'copying',step:'deleting',...files(s)})},
 {name:'mirror removals',step:'removing',phase:'copying',unit:'files',count:/extra files set aside/,file:true,renames:true,at:s=>({...base,phase:'copying',step:'removing',...files(s),renames:true})},
 {name:'camera download',step:'downloading',phase:'planning',unit:'files',count:/files downloaded/,file:false,at:s=>({...base,phase:'planning',step:'downloading',bytes:0,totalBytes:0,file:'',...files(s)})},
 {name:'leftover files look',step:'scanning',phase:'planning',unit:'files',count:/files looked at/,file:true,at:s=>({...base,phase:'planning',step:'scanning',completed:s*40,total:0,bytes:0,totalBytes:0,share:Math.min(.9,s/8)})},
];
const stepsOf=(source:string)=>source.match(/step\?:([^;]+);completed/)![1]!.split('|').map(item=>item.trim().replace(/'/g,''));

function stamp(item:Operation,where:'job'|'review'|'misplaced'|'residue'|'recovery'){
 const job:Job={id:'j',source:card,phase:item.phase==='verifying'?'verifying':'copying',errors:[],backup:false,progress:item.at(0)};
 const state:AppState={preferences,sources:[card],jobs:where==='job'?[job]:[],history:[],platform:'darwin'};
 const tracker=new EtaTracker();let progress=item.at(0);
 for(let second=0;second<=40;second++){
  progress=item.at(second);
  if(where==='job')job.progress=progress;
  else if(where==='review')state.reviewProgress=progress;
  else if(where==='misplaced')state.misplacedProgress={'/Volumes/A006':progress};
  else if(where==='residue')state.residue={files:0,bytes:0,resumable:{files:0,bytes:0},checking:true,progress};
  else state.organizationRecoveryProgress=progress;
  stampEstimates(state,tracker,1_000_000+second*1000);
 }
 return progress;
}

for(const item of operations)for(const where of ['job','review','misplaced','residue','recovery'] as const)if(!(where==='job'&&item.step==='scanning'))test(`${item.name} (${where}): determinate fraction, speed, time left, file`,()=>{
 const progress=stamp(item,where);
 assert.notEqual(progressFraction(progress),undefined,'a determinate fraction');
 assert.ok(progressFraction(progress)!<=.99+1e-9||progress.step==='checking','never full before the end');
 if(item.unit==='bytes'){assert.ok(progress.speed>0,`bytes/s ${progress.speed}`);assert.ok(progress.fileRate!>0,`files/s beside the bytes ${progress.fileRate}`);}
 else{assert.equal(progress.speed,0);assert.ok(progress.fileRate!>0,`files/s ${progress.fileRate}`);}
 assert.ok(progress.eta!==undefined&&progress.eta>0,`time left ${progress.eta}`);
 assert.ok(progress.eta! < 1e6);
 if(where!=='job')assert.ok(progress.startedAt,'a start time');
 if(item.file)assert.notEqual(progress.file,'');
});

test('every step the renderer knows has a label and a progress mapping',()=>{
 const known=stepsOf(readFileSync(new URL('../shared.ts',import.meta.url),'utf8'));
 const covered=new Set(operations.map(item=>item.step).filter(Boolean));
 for(const step of known)assert.ok(covered.has(step as Step),`step "${step}" has no row in the progress table: give it a label (progressCount), a fraction and a speed`);
 const t=createTranslator('en');
 for(const item of operations){
  const progress=item.at(3);
  const count=progressCount(progress,t,value=>String(value),!!item.step&&['moving'].includes(item.step),value=>`${value} B`);
  assert.match(count,item.count,`${item.name}: label ${count}`);
  assert.notEqual(progressFraction(progress),undefined,`${item.name}: fraction`);
 }
 // The label exists in every language, not only English.
 for(const language of languages){
  const tr=createTranslator(language);
  for(const item of operations){
   const count=progressCount(item.at(3),tr,value=>String(value),false,value=>`${value} B`);
   assert.ok(count.length>0&&!/^\{/.test(count),`${language}: ${item.name}`);
   if(language!=='en'&&item.step&&['stashing','tidying','releasing','restoring','deleting','removing','downloading','scanning'].includes(item.step))assert.notEqual(count,progressCount(item.at(3),t,value=>String(value),false,value=>`${value} B`),`${language}: ${item.name} is translated`);
  }
 }
});

// ---- the shared component ------------------------------------------------------------------

const org=(extra:Partial<Job>={}):Job=>({id:'o',source:{id:'library:/Volumes/A006/photobackup',name:'Existing library',path:'/Volumes/A006/photobackup',transport:'folder'},organization:true,phase:'copying',errors:[],backup:false,startedAt:new Date(Date.now()-60000).toISOString(),...extra});
const listing:Progress={phase:'planning',step:'listing',completed:10,total:0,bytes:1e9,totalBytes:0,speed:0,file:'a/b.jpg',share:.3,fileRate:50,eta:30,startedAt:new Date(0).toISOString()};
const stateWith=(extra:Partial<AppState>):AppState=>({preferences,sources:[card],jobs:[],history:[],platform:'darwin',...extra});
const shared=(html:string)=>(html.match(/data-progress-display/g)??[]).length;

test('every progress location renders the shared ProgressDisplay',()=>{
 const progress:Progress={phase:'copying',step:'moving',completed:50,total:100,bytes:0,totalBytes:1e9,speed:0,fileRate:20,file:'IMG.JPG',eta:20,startedAt:new Date(0).toISOString(),renames:true};
 const job=org({progress});
 const sourceJob:Job={id:'j',source:card,phase:'copying',errors:[],backup:false,startedAt:new Date(0).toISOString(),progress:{...progress,renames:false,bytes:5e8,speed:1e7}};
 const places:[string,string][]=[
  ['source card',render(createElement(ImportDesk,{state:stateWith({jobs:[sourceJob]}),act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}))],
  ['source card before the first event',render(createElement(ImportDesk,{state:stateWith({jobs:[{...sourceJob,phase:'discovering',progress:undefined}]}),act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}))],
  ['organization card',render(createElement(OrganizationCard,{job,act:()=>{}}))],
  ['dashboard total',render(createElement(ImportDashboard,{state:stateWith({jobs:[sourceJob]}),act:()=>{}}))],
  ['planning steps',render(createElement(PlanningProgress,{progress:listing,label:'x'}))],
  ['source scan',render(createElement(ScanProgress,{sourceName:'Card',listing:{files:5,bytes:1e9,fileRate:10},usedBytes:8e10}))],
  ['leftover files',render(createElement(LeftoverFiles,{state:stateWith({residue:{files:0,bytes:0,resumable:{files:0,bytes:0},checking:true,progress:{...listing,step:'scanning'}}}),act:()=>{},busy:false}))],
  ['backup folder check',render(createElement(Organization,{state:stateWith({misplacedProgress:{'/Volumes/A006':{...listing,step:'checking',total:100}}}),act:()=>{},busy:false}))],
  ['organization recovery listing',render(createElement(Organization,{state:stateWith({organizationRecoveryLoading:true,organizationRecoveryProgress:{...listing,step:'scanning'}}),act:()=>{},busy:false}))],
  ['review being built',render(createElement(ReviewPanel,{state:stateWith({busyReview:true,reviewProgress:listing}),act:()=>{},inspect:()=>{}}))],
 ];
 for(const [name,html] of places){assert.ok(shared(html)>=1,`${name} renders ProgressDisplay`);assert.ok(html.includes('role="progressbar"'),`${name} has a bar`);}
 const before=places[1]![1];
 assert.ok(before.includes('progress-discovering')&&before.includes('Starting…'),'indeterminate only before the first event, labelled Starting…');
 // The bar exists once, inside the shared component, so no operation can draw its own.
 const source=readFileSync(new URL('../renderer/RootApp.tsx',import.meta.url),'utf8');
 assert.equal((source.match(/<ProgressBar /g)??[]).length,1,'only ProgressDisplay draws a bar');
 assert.equal((source.match(/role="progressbar"/g)??[]).length,1);
});

test('the shared layout shows the bar, the count, the speed, the time and the file in that order',()=>{
 const progress:Progress={phase:'copying',step:'releasing',completed:7,total:20,bytes:0,totalBytes:0,speed:0,fileRate:12.5,file:'2024/IMG_0007.JPG',eta:90,startedAt:new Date(0).toISOString()};
 const html=render(createElement(PlanningProgress,{progress,label:'x'}));
 const order=['role="progressbar"','progress-count','data-testid="speed"','data-testid="timing"','data-testid="progress-file"'].map(marker=>html.indexOf(marker));
 assert.ok(order.every(position=>position>=0),html);
 assert.deepEqual([...order].sort((a,b)=>a-b),order);
 assert.match(html,/7 of 20 files released/);assert.match(html,/12\.5 files\/s/);assert.match(html,/elapsed/);assert.match(html,/left/);
});

// ---- interface fixes -----------------------------------------------------------------------

const renameJob=(extra:Partial<Progress>={}):Job=>({id:'r',source:{id:'library:/Volumes/A006/photobackup',name:'Existing library',path:'/Volumes/A006/photobackup',transport:'folder'},phase:'copying',errors:[],backup:false,startedAt:new Date(Date.now()-60000).toISOString(),
 progress:{phase:'copying',step:'moving',completed:29145,total:29145,bytes:0,totalBytes:539.1e9,speed:0,fileRate:85,file:'ZFC_8484.JPG',eta:5,startedAt:new Date(0).toISOString(),...extra}});
const desk=(state:AppState)=>render(createElement(ImportDesk,{state,act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}));
const bar=(html:string)=>Number(html.slice(html.indexOf('progress-in-card')).match(/aria-valuenow="(\d+)"/)?.[1]);

test('the card bar follows the count at the end of the moves, even when bytes planned are not moved',()=>{
 for(const renames of [true,false]){
  const html=desk(stateWith({jobs:[renameJob({renames})]}));
  assert.ok(bar(html)>=99,`bar ${bar(html)} for ${renames}`);
 }
});
test('the dashboard total agrees with the card for a rename job, and counts files, not bytes',()=>{
 const state=stateWith({jobs:[renameJob({renames:true})]});
 const total=render(createElement(ImportDashboard,{state,act:()=>{}}));
 const totalBlock=total.match(/data-testid="total-progress"[\s\S]*?<\/div><\/div>/)![0];
 assert.ok(/aria-valuenow="99"/.test(totalBlock),totalBlock);
 assert.ok(!/0 B of/.test(total),'no "0 B of … planned"');
 assert.ok(total.includes('29,145 of 29,145 files moved'),total);
 assert.ok(total.includes('Files moved'),'the files tile says what it counts');
 assert.ok(!total.includes('Files checked'));
});
test('the files tile follows the step: checked, verified, copied, moved',()=>{
 const label=(progress:Partial<Progress>,phase:Job['phase']='copying')=>render(createElement(ImportDashboard,{state:stateWith({jobs:[{...renameJob(progress),phase}]}),act:()=>{}}));
 assert.ok(label({phase:'planning',step:'checking',renames:false}).includes('Files checked'));
 assert.ok(label({phase:'verifying',step:undefined,renames:false},'verifying').includes('Files verified'));
 assert.ok(label({renames:false,step:undefined,bytes:5e8,totalBytes:1e9,completed:10,total:20}).includes('Files copied'));
});
test('warnings are counted apart from the sources that need attention',()=>{
 const quiet=render(createElement(ImportDashboard,{state:stateWith({jobs:[renameJob({renames:true})]}),act:()=>{}}));
 assert.ok(quiet.includes('0 sources complete · 0 need attention')&&!quiet.includes('warnings'));
 const noisy=render(createElement(ImportDashboard,{state:stateWith({jobs:[{...renameJob({renames:true}),errors:[{key:'job.skippedErrors',params:{count:3}} as never]}],sourceInventories:{}}),act:()=>{}}));
 void noisy;
});
test('the step tracker uses one style: done, the current step with its percent, and waiting, with Moving for renames',()=>{
 const html=desk(stateWith({sources:[],jobs:[renameJob({renames:true,completed:50,total:100})]}));
 const steps=html.match(/<ol class="source-steps"[\s\S]*?<\/ol>/)![0];
 assert.ok(steps.includes('Moving')&&!steps.includes('Copying'),steps);
 assert.ok(/step-percent">49%|step-percent">50%/.test(steps),steps);
 assert.ok(!/step-mark">\d/.test(steps),'no numbers in the marks');
 assert.equal((steps.match(/<li /g)??[]).length,3);
 assert.ok(desk(stateWith({sources:[],jobs:[{...renameJob({renames:false,bytes:1,totalBytes:2,completed:1,total:2})}]})).includes('Copying'));
});
test('a library on a mounted drive shows that drive\'s capacity',()=>{
 const drive={id:'a006',name:'A006',path:'/Volumes/A006',transport:'storage' as const,selected:true,total:2e12,free:342.7e9};
 const html=desk(stateWith({sources:[drive],jobs:[renameJob({renames:true})]}));
 assert.ok(!html.includes('Capacity unavailable'),'no unavailable note');
 assert.ok(html.includes('342.7 GB free of 2.00 TB'));
 assert.ok(html.includes('A006'));
});
test('the card and the sidebar word capacity the same way, in every language',()=>{
 const drive={id:'a006',name:'A006',path:'/Volumes/A006',transport:'storage' as const,selected:true,total:2e12,free:342.7e9};
 for(const language of languages){
  const state=stateWith({sources:[drive],jobs:[],destinationStatus:[{path:'/Volumes/A006',available:true,total:2e12,free:342.7e9}]});
  const card=render(createElement(ImportDesk,{state,act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}),language);
  const sidebar=render(createElement(SidebarDestinations,{state}),language);
  const cardText=card.match(/storage-heading"><span>([^<]+)</)?.[1]?.trim(),sideText=sidebar.match(/capacity-full">([^<]+)</)?.[1];
  assert.ok(cardText&&sideText&&cardText===sideText,`${language}: "${cardText}" vs "${sideText}"`);
 }
});
test('a running library is listed under Sources in the sidebar',()=>{
 const html=render(createElement(SidebarSources,{state:stateWith({sources:[],jobs:[org({progress:{...base,phase:'copying',step:'moving',renames:true}})]}),onOpen:()=>{}}));
 assert.ok(html.includes('Existing library'));assert.ok(!html.includes('No sources connected'));
});
test('the destination label shows only with several destinations',()=>{
 const source=readFileSync(new URL('../main.ts',import.meta.url),'utf8');
 assert.ok(source.includes("plans.length>1?message('job.destinationLabel'"));
});

// ---- backend: the steps after the moves ----------------------------------------------------

const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'format' as const,unknownRules:{},reorganize:true};
const metadata=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});

test('stashing the duplicates, closing the journal and releasing report their own steps with counts and files',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'stash-progress-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(let index=0;index<6;index++){const file=path.join(root,'incoming',`A${index}.JPG`);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,`original ${index}`);}
 const plan=(await core.plan(root,[root],options,metadata)).plans[0]!;
 const events:Progress[]=[];
 const result=await core.executeReorganization(plan,undefined,value=>events.push({...value}),{strategy:'copy',releaseDuplicates:true});
 assert.deepEqual(result.errors,[]);
 const of=(step:string)=>events.filter(event=>event.step===step);
 const stash=of('stashing');
 assert.ok(stash.length>=2,'stashing reports');
 assert.equal(stash[0]!.completed,0);assert.equal(stash.at(-1)!.completed,6);assert.ok(stash.every(event=>event.total===6));
 assert.ok(stash.slice(1).every(event=>event.file!==''),'each names its file');
 assert.ok(stash.every((event,index)=>index===0||event.completed>=stash[index-1]!.completed));
 const tidy=of('tidying');
 assert.ok(tidy.length>=2);assert.equal(tidy.at(-1)!.completed,tidy.at(-1)!.total);assert.equal(tidy[0]!.completed,0);
 const released=of('releasing');
 assert.ok(released.length>0&&released.at(-1)!.completed===released.at(-1)!.total,'the release after organizing reports');
 assert.ok(events.filter(event=>event.step==='moving').every(event=>event.phase==='copying'),'moves carry their phase');
});

test('the leftover check and Clean up report progress',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'residue-progress-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const folder of ['2024','2025','2026']){await fs.mkdir(path.join(root,folder),{recursive:true});await fs.writeFile(path.join(root,folder,'a.jpg'),'x');}
 await fs.writeFile(path.join(root,'2025','.import-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.partial'),'partial');
 const scans:{looked:number;done:number;total:number;file:string}[]=[];
 const found=await findResidue([root],{onProgress:scan=>scans.push(scan)});
 assert.ok(scans.length>=3);assert.ok(scans.every(scan=>scan.total===scans[0]!.total&&scan.done<=scan.total));
 assert.equal(scans.at(-1)!.done,scans.at(-1)!.total);assert.ok(scans.at(-1)!.looked>=4);
 const steps:[number,number][]=[];
 await cleanResidue(found,{onProgress:(done,total)=>steps.push([done,total])});
 assert.deepEqual(steps.at(0),[0,found.items.length]);assert.deepEqual(steps.at(-1),[found.items.length,found.items.length]);
});

test('the recovery listing reports its share as it reads',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'listing-progress-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(let index=0;index<3;index++){const file=path.join(root,'incoming',`A${index}.JPG`);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,`original ${index}`);}
 await core.executeReorganization((await core.plan(root,[root],options,metadata)).plans[0]!,undefined,undefined,{strategy:'rename'});
 const updates:{share:number;looked:number}[]=[];
 await core.getOrganizationRecovery(root,{includeEnded:true,onProgress:update=>updates.push(update)});
 assert.ok(updates.length>=2&&updates.every(update=>update.share>=0&&update.share<=1));
 assert.ok(updates.at(-1)!.looked>=1);
});
