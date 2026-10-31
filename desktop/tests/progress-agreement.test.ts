import { freshOrganizeOptions } from '../run-policy';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTranslator} from '../renderer/i18n';
import {cardFraction,jobStageLayers,progressCount} from '../renderer/progress';
import {destinationActivity,overviewFraction,progressSkippedNote,totalStageLayers} from '../renderer/RootApp';
import type {AppState,Job,Progress} from '../shared';

// Hardware retest, 2026-10-24: the percent on a row must describe the work its counter counts, and so must the sidebar and the overview.
// Each job carries the whole-job share the main process logged at that moment; none of these rows may show it.
const t=createTranslator('en'),number=(value:number)=>value.toLocaleString('en');
const preferences={showDashboard:true,language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A006'],copyMode:'single',template:'{year}',mediaLayout:'flat',videoTemplate:'',unknownRules:{}} as AppState['preferences'];
const folder={id:'xxxx',name:'xxxx',path:'/Volumes/Untitled/xxxx',transport:'folder' as const,selected:true};
const library={id:'library',name:'Existing library',path:'/Volumes/A006',transport:'folder' as const,selected:true};
const stateOf=(job:Job):AppState=>({preferences,sources:[folder],jobs:[job],history:[],platform:'darwin',organizeOptions:freshOrganizeOptions(),destinationStatus:[{path:'/Volumes/A006',available:true}]});
const percent=(fraction:number|undefined)=>Math.floor(fraction!*100);
/** The counter's own share: the numbers its text shows. */
const counted=(text:string)=>{const [done,all]=text.match(/[\d,]+(?= of )|(?<= of )[\d,]+/g)!.map(item=>Number(item.replace(/,/g,'')));return done!/all!;};
function agree(job:Job,label:string){
 const text=progressCount(job.progress!,t,number,!!job.organization);
 const own=counted(text),card=cardFraction(job)!;
 assert.ok(Math.abs(card-own)<0.01,`${label}: card ${percent(card)}% next to "${text}"`);
 assert.ok(Math.abs(jobStageLayers(job).at(-1)!.fraction-card)<0.01,`${label}: the bar's top layer is the percent`);
 assert.equal(overviewFraction([job]),card,`${label}: the overview reads the card's number`);
 assert.ok(Math.abs(totalStageLayers([job]).at(-1)!.fraction-card)<0.01,`${label}: the overview bar is its percent`);
 const sidebar=destinationActivity(stateOf(job),'/Volumes/A006');
 assert.ok(Math.abs(sidebar.fraction!-card)<0.01,`${label}: sidebar ${percent(sidebar.fraction)}% vs card ${percent(card)}%`);
 return text;
}

test('checking metadata: the card, overview and sidebar read the files checked, not the job share or the bytes covered',()=>{
 const job:Job={id:'6c6bbd59',source:folder,phase:'verifying',errors:[],backup:false,fraction:0.023,
  progress:{phase:'planning',step:'checking',completed:1744,total:6759,bytes:16526200361,totalBytes:40890450976,speed:0,file:'_R6_1.jpg'}};
 assert.equal(agree(job,'checking'),'1,744 of 6,759 files checked');
});

test('a direct copy that confirms files already in the backup counts them in its counter, its percent and its rate',()=>{
 // 5 files to copy, 6,754 already in the backup and confirmed as the copy goes: the engine counts all 6,759.
 const progress:Progress={phase:'copying',completed:1762,total:6759,bytes:33398545,totalBytes:68711949,speed:0,fileRate:55.3,file:'_R6_8001.jpg',
  work:{files:1762,bytes:33398545,totalFiles:6759,totalBytes:68711949,direct:{files:6759,bytes:68711949,present:6754}}};
 const job:Job={id:'10e9e1c2',source:folder,phase:'copying',errors:[],backup:false,fraction:0.34,progress};
 const text=agree(job,'direct copy');
 assert.equal(text,'1,762 of 6,759 files copied or confirmed');
 assert.equal(progressSkippedNote(progress,t,number),'6,754 already in the backup');
 // Once the bytes are all written the counter still moves, and so does the percent.
 const later={...job,progress:{...progress,completed:3744,bytes:68711949,work:{...progress.work!,files:3744,bytes:68711949}}};
 assert.equal(percent(cardFraction(later)),55);
});

test('a staged copy counts only the files it copies: those already in the backup were confirmed before it began',()=>{
 const progress:Progress={phase:'copying',completed:2400,total:3000,skipped:2000,bytes:2e9,totalBytes:5e9,speed:0,file:'a.jpg'};
 const job:Job={id:'s',source:folder,phase:'copying',errors:[],backup:false,fraction:0.1,progress};
 assert.equal(progressCount(progress,t,number),'400 of 1,000 files copied');
 // Bytes measure a copy: 40% of the data, the same 40% of the files here.
 assert.equal(percent(cardFraction(job)),40);
});

test('an organization reads the files it has moved, not a job share held at 99% from its first step',()=>{
 const job:Job={id:'ee23f228',source:library,phase:'copying',organization:true,errors:[],backup:false,fraction:0.99,
  progress:{phase:'copying',step:'moving',renames:true,completed:687,total:799,bytes:0,totalBytes:0,speed:0,file:'_R6_6678.CR3'}};
 assert.equal(agree(job,'moving'),'687 of 799 files moved');
});

test('the overview percent describes the counter it shows, also beside a finished job of another source',async()=>{
 const {createElement}=await import('react');
 const {renderToStaticMarkup}=await import('react-dom/server');
 const {I18nProvider}=await import('../renderer/i18n');
 const {ImportDashboard}=await import('../renderer/RootApp');
 // 21:13: every file already in the backup, so nothing is transferred in bytes; another source's job finished a moment before.
 const other={id:'other',name:'Other',path:'/Volumes/Other',transport:'folder' as const,selected:true};
 const finished:Job={id:'933056a2',source:other,phase:'complete',errors:[],backup:false,progress:{phase:'verifying',step:'existing',completed:0,total:0,bytes:0,totalBytes:0,speed:0,file:''}};
 const running:Job={id:'4bc25cb7',source:folder,phase:'copying',errors:[],backup:false,startedAt:new Date().toISOString(),
  progress:{phase:'copying',completed:866,total:6759,bytes:0,totalBytes:0,speed:0,file:'_R6_1.jpg',work:{files:866,bytes:0,totalFiles:6759,totalBytes:0,direct:{files:6759,bytes:0,present:6759}}}};
 const state:AppState={...stateOf(running),sources:[folder,other],jobs:[running,finished]};
 const markup=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(ImportDashboard,{state,act:()=>{}})}));
 const total=markup.match(/data-testid="total-progress"[\s\S]*?progress-display-line[\s\S]*?<\/div>/)![0];
 assert.match(total,/866 of 6,759 files copied or confirmed/);
 assert.match(total,/>12%</,'the running job\'s 866 of 6,759, not an average with the finished job (56%)');
 assert.match(total,/aria-valuenow="13"/);
});
