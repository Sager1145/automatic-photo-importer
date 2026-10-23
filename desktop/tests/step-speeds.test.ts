import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as core from '../core/index';
import {EtaTracker,stampEstimates} from '../eta';
import {I18nProvider,languages} from '../renderer/i18n';
import {ImportDashboard,ImportDesk,OrganizationCard} from '../renderer/RootApp';
import type {AppState,Job,Progress} from '../shared';

core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const preferences:AppState['preferences']={language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/b'],copyMode:'single',basePath:'p',template:'{year}',mediaLayout:'flat',videoBasePath:'v',videoTemplate:'',allowFolderSource:false,unknownRules:{}} as AppState['preferences'];
const card={id:'card',name:'Card',path:'/Volumes/CARD',transport:'storage' as const,selected:true,total:128e9,free:40e9};
const base:Progress={completed:0,total:1000,bytes:0,totalBytes:10e9,speed:0,file:'A.NEF'};

type Case={name:string;organization?:boolean;backup?:boolean;phase:Job['phase'];at:(second:number)=>Progress;unit:'bytes'|'files'};
const files=(second:number)=>({completed:second*20});
const cases:Case[]=[
 {name:'import copying',phase:'copying',unit:'bytes',at:s=>({...base,phase:'copying',bytes:s*100e6,completed:s*5})},
 {name:'drive backup copying',backup:true,phase:'copying',unit:'bytes',at:s=>({...base,phase:'copying',bytes:s*100e6,completed:s*5})},
 {name:'verifying (re-read) and publishing',phase:'verifying',unit:'bytes',at:s=>({...base,phase:'verifying',bytes:10e9,completed:s*20})},
 {name:'organization confirming',organization:true,phase:'verifying',unit:'files',at:s=>({...base,phase:'verifying',step:'confirming',...files(s),renames:true})},
 {name:'organization moving by rename',organization:true,phase:'copying',unit:'files',at:s=>({...base,phase:'copying',step:'moving',...files(s),renames:true})},
 {name:'organization moving by copy',organization:true,phase:'copying',unit:'bytes',at:s=>({...base,phase:'copying',step:'moving',bytes:s*100e6,completed:s*5})},
 {name:'organization releasing',organization:true,phase:'copying',unit:'files',at:s=>({...base,phase:'copying',step:'releasing',...files(s)})},
 {name:'organization restoring',organization:true,phase:'copying',unit:'files',at:s=>({...base,phase:'copying',step:'restoring',...files(s)})},
];
function run(item:Case){
 const job:Job={id:'j',source:card,phase:item.phase,errors:[],backup:!!item.backup,...(item.organization?{organization:true}:{}),progress:item.at(0)};
 const state:AppState={preferences,sources:[card],jobs:[job],history:[],platform:'darwin'};
 const tracker=new EtaTracker();
 for(let second=0;second<=6;second++){job.progress=item.at(second);stampEstimates(state,tracker,1_000_000+second*1000);}
 return {job,state};
}

for(const item of cases)test(`${item.name} reports a live ${item.unit==='bytes'?'byte':'file'} speed`,()=>{
 const {job}=run(item),progress=job.progress!;
 if(item.unit==='bytes'){assert.ok(progress.speed>0,`speed ${progress.speed}`);assert.ok(progress.fileRate!>0,`files/s beside the bytes ${progress.fileRate}`);}
 else{assert.equal(progress.speed,0);assert.ok(progress.fileRate!>0,`fileRate ${progress.fileRate}`);}
});

test('the speed follows a rolling window, not the average since the start',()=>{
 const job:Job={id:'j',source:card,phase:'copying',errors:[],backup:false,progress:{...base,phase:'copying'}};
 const state:AppState={preferences,sources:[card],jobs:[job],history:[],platform:'darwin'};
 const tracker=new EtaTracker();let bytes=0;
 for(let second=0;second<=40;second++){bytes+=second<20?200e6:20e6;job.progress={...base,phase:'copying',bytes};stampEstimates(state,tracker,1_000_000+second*1000);}
 assert.ok(job.progress!.speed<60e6,`window forgot the fast start: ${job.progress!.speed}`);
});

const sessionState=(jobs:Job[]):AppState=>({preferences,sources:[card],jobs,history:[],platform:'darwin'});
const render=(node:ReturnType<typeof createElement>,language:typeof languages[number]='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:node}));

test('the source card, organization card and dashboard show a speed while verifying and moving',()=>{
 for(const item of cases.filter(entry=>['verifying (re-read) and publishing','organization confirming','organization moving by rename','organization moving by copy','import copying'].includes(entry.name))){
  const {job,state}=run(item);
  const unit=item.unit==='bytes'?/[KMG]B\/s/:/files\/s/;
  const speedOf=(html:string)=>html.match(/data-testid="speed">(.*?)<\/span>/)?.[1]??'';
  if(!item.organization){
   const desk=render(createElement(ImportDesk,{state,act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}));
   assert.match(speedOf(desk),unit,`${item.name}: source card`);
  }
  const dashboard=render(createElement(ImportDashboard,{state,act:()=>{}})).match(/Transfer speed<\/dt><dd>([\s\S]*?)<\/dd>/)![1]!;
  assert.match(dashboard,unit,`${item.name}: dashboard ${dashboard}`);
  if(item.organization)assert.match(speedOf(render(createElement(OrganizationCard,{job,act:()=>{}}))),unit,`${item.name}: organization card`);
 }
});

test('an organization on a source card shows its speed too',()=>{
 const item=cases.find(entry=>entry.name==='organization confirming')!;
 const {job,state}=run(item);
 const onCard:AppState={...state,jobs:[{...job,organization:undefined}]};
 const desk=render(createElement(ImportDesk,{state:onCard,act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}));
 assert.match(desk.match(/data-testid="speed">(.*?)<\/span>/)?.[1]??'',/files\/s/);
});

test('the dashboard sums the byte speeds of every active job',()=>{
 const make=(id:string):Job=>({id,source:{...card,id},phase:'copying',errors:[],backup:false,progress:{...base,phase:'copying',speed:100e6}});
 const html=render(createElement(ImportDashboard,{state:sessionState([make('a'),make('b')]),act:()=>{}}));
 assert.match(html,/Transfer speed<\/dt><dd>200 MB\/s/);
});

test('a rename organization says moving, counts files moved and advances by files',()=>{
 const progress:Progress={phase:'copying',step:'moving',completed:1522,total:29145,bytes:0,totalBytes:539.1e9,speed:0,fileRate:310,file:'A.NEF',renames:true};
 const job:Job={id:'o',source:{id:'library:/Volumes/A006',name:'Backup organization',path:'/Volumes/A006',transport:'folder'},organization:true,phase:'copying',errors:[],backup:false,progress};
 const labels=[['Moving files','1,522 of 29,145 files moved'],['正在移动文件','已移动 1,522/29,145 个文件'],['正在移動檔案','已移動 1,522/29,145 個檔案'],['ファイルを移動中','29,145 件中 1,522 件を移動済み']];
 for(const [index,language] of languages.entries()){
  const html=render(createElement(OrganizationCard,{job,act:()=>{}}),language);
  assert.ok(html.includes(labels[index]![0]!),`${language} status`);
  assert.ok(html.includes(labels[index]![1]!),`${language} count`);
 }
 const dashboard=render(createElement(ImportDashboard,{state:sessionState([job]),act:()=>{}}));
 assert.ok(!dashboard.includes('0 B of'),'no byte total for renames');
 assert.ok(dashboard.includes('1,522 of 29,145 files moved'));
 assert.match(dashboard,/aria-valuenow="5"/,'the bar follows files moved');
 const onCard=render(createElement(ImportDesk,{state:sessionState([{...job,source:card,organization:undefined}]),act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}));
 assert.ok(onCard.includes('Moving files')&&onCard.includes('files moved'));
 const copying=render(createElement(OrganizationCard,{job:{...job,progress:{...progress,renames:undefined,bytes:1e9,speed:50e6}},act:()=>{}}));
 assert.ok(copying.includes('files organized')&&!copying.includes('Moving files'),'a copy keeps its wording');
 const imported=render(createElement(ImportDesk,{state:sessionState([{id:'i',source:card,phase:'copying',errors:[],backup:false,progress:{...progress,renames:undefined,step:undefined}}]),act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}));
 assert.ok(imported.includes('Copying files'),'an import keeps copying');
});

test('real transfers report bytes while copying and rename steps report files, not bytes',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'step-speeds-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),destination=path.join(root,'dest'),library=path.join(root,'library');
 await fs.mkdir(source);await fs.mkdir(destination);await fs.mkdir(path.join(library,'incoming'),{recursive:true});
 for(const name of ['A.JPG','B.JPG'])await fs.writeFile(path.join(source,name),Buffer.alloc(3e6,name));
 for(const name of ['C.JPG','D.JPG'])await fs.writeFile(path.join(library,'incoming',name),'original '+name);
 const metadata=async()=>({camera:'Sony',date:'2024-02-03',fields:{}});
 const events:Progress[]=[];
 const {plans}=await core.plan(source,[destination],{backup:false,template:'{camera}',layout:'flat',unknownRules:{}},metadata);
 await core.executeMany(plans,undefined,(_index,progress)=>events.push(progress));
 const copying=events.filter(event=>event.phase==='copying'&&event.bytes>0);
 assert.ok(copying.length>0&&copying.every(event=>event.speed>0),'copying events carry bytes and speed');
 assert.ok(events.some(event=>event.phase==='verifying'&&event.totalBytes>0&&event.bytes>0),'verifying events carry the bytes being re-read');
 const moves:Progress[]=[];
 const {plans:[organize]}=await core.plan(library,[library],{backup:false,template:'{year}/{camera}',layout:'format',unknownRules:{},reorganize:true},metadata);
 await core.executeReorganization(organize!,undefined,progress=>moves.push(progress));
 const steps=moves.filter(event=>event.step==='confirming'||event.step==='moving');
 assert.ok(steps.some(event=>event.step==='confirming')&&steps.some(event=>event.step==='moving'));
 assert.ok(steps.every(event=>event.renames&&event.bytes===0&&event.speed===0),'rename steps count files; no bytes move');
 assert.equal(steps.filter(event=>event.step==='moving').at(-1)!.completed,2);
});
