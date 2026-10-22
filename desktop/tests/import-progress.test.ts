import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {plan,executeMany,type PlanProgress} from '../core';
import {I18nProvider} from '../renderer/i18n';
import {ImportDashboard,ImportDesk,importFraction} from '../renderer/RootApp';
import type {AppState,Job,Progress} from '../shared';

const options={backup:false,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
const metadata=async()=>({camera:'Sony A7',date:'2024-02-03T12:00:00Z',fields:{}});
async function fixture(t:test.TestContext){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'import-progress-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),roots=[path.join(base,'first'),path.join(base,'second')];
 await Promise.all([source,...roots].map(folder=>fs.mkdir(folder)));
 for(const name of ['A.JPG','B.JPG','C.MOV'])await fs.writeFile(path.join(source,name),name.repeat(10));
 return {source,roots};
}

test('after the metadata check, planning reports the destination comparison up to its end',async t=>{
 const {source,roots}=await fixture(t);
 const events:{step:string;count:number;total:number}[]=[];
 const onProgress:PlanProgress=(count,_file,detail)=>{if(detail)events.push({step:detail.step,count,total:detail.total});};
 const {plans}=await plan(source,roots,options,metadata,undefined,onProgress);
 const lastChecking=events.map(event=>event.step).lastIndexOf('checking');
 const comparing=events.slice(lastChecking+1);
 // Before the fix nothing followed the last metadata check, so the card stayed at 100%.
 assert.ok(comparing.length>0,'the destination comparison reports progress');
 assert.ok(comparing.every(event=>event.step==='comparing'));
 const total=plans.reduce((sum,item)=>sum+item.entries.length,0);
 assert.ok(comparing.every(event=>event.total===total));
 assert.equal(comparing[0]!.count,0);assert.equal(comparing.at(-1)!.count,total);
 for(let index=1;index<comparing.length;index++)assert.ok(comparing[index]!.count>=comparing[index-1]!.count);
});

test('comparing reports the bytes it reads when a same-size file already sits at the destination',async t=>{
 const {source,roots}=await fixture(t);
 // Same size, other bytes: the source must be hashed before the plan can decide.
 const taken=path.join(roots[0]!,'2024/202402/Sony A7/A.JPG');await fs.mkdir(path.dirname(taken),{recursive:true});await fs.writeFile(taken,'X'.repeat(50));
 const events:{step:string;bytes:number}[]=[];
 await plan(source,roots,options,metadata,undefined,(_count,_file,detail)=>{if(detail)events.push({step:detail.step,bytes:detail.bytes});});
 // Only the one source file was read; files with no same-size neighbour are not.
 assert.equal(events.filter(event=>event.step==='comparing').at(-1)!.bytes,50);
});

test('the copy first reports the check of existing destination files, then copies',async t=>{
 const {source,roots}=await fixture(t);
 const {plans}=await plan(source,roots,options,metadata);
 const events:Progress[]=[];
 await executeMany(plans,undefined,(_index,progress)=>events.push(progress));
 const firstCopy=events.findIndex(event=>event.phase==='copying');
 const before=events.slice(0,firstCopy);
 assert.ok(before.length>0,'the preflight reports progress before copying');
 assert.ok(before.every(event=>event.phase==='planning'&&event.step==='existing'));
 assert.equal(before.at(-1)!.completed,before.at(-1)!.total);
});

const source={id:'card',name:'Untitled',path:'/Volumes/Untitled/photobackup',transport:'folder' as const,selected:true};
const preferences:AppState['preferences']={language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A006'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}};
const job=(progress:Progress,phase:Job['phase']='verifying'):Job=>({id:'j',source,phase,errors:[],backup:false,progress});
const state=(value:Job):AppState=>({preferences,sources:[source],jobs:[value],history:[],platform:'darwin'});
const desk=(value:Job)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(ImportDesk,{state:state(value),act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}})}));
const dashboard=(value:Job)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(ImportDashboard,{state:state(value),act:()=>{}})})).match(/data-testid="total-progress"[\s\S]*?<\/small>/)?.[0]??'';
const checked:Progress={phase:'planning',step:'checking',completed:64832,total:64832,bytes:834e9,totalBytes:834e9,speed:0,file:'DSC1.JPG'};
const comparing:Progress={phase:'planning',step:'comparing',completed:3000,total:64832,bytes:36e9,totalBytes:0,speed:0,file:'DSC2.JPG'};

test('the source card names the step it is on and its own progress',()=>{
 const reading=desk(job({...checked,completed:100}));
 assert.ok(reading.includes('Reading metadata'));assert.ok(reading.includes('100 of 64,832 files checked'));
 const destination=desk(job(comparing));
 assert.ok(destination.includes('Checking existing files'));
 assert.ok(destination.includes('Checking the destination: 3,000 of 64,832 files · 36.0 GB read'));
 assert.ok(destination.includes('aria-valuenow="5"'),'the bar shows the comparison, not the finished metadata check');
 const verifying=desk(job({phase:'verifying',completed:5,total:10,bytes:0,totalBytes:0,speed:0,file:''}));
 assert.ok(verifying.includes('Verifying copied files'));
});

test('total progress covers the whole import and is not full right after scanning',()=>{
 assert.ok(importFraction(job(checked))!<=.2,'the metadata check is only the start of an import');
 assert.ok(importFraction(job(comparing))!>importFraction(job(checked))!);
 const copying=importFraction(job({phase:'copying',completed:10,total:64832,bytes:417e9,totalBytes:834e9,speed:1,file:''},'copying'))!;
 assert.ok(copying>.4&&copying<.8,`half copied: ${copying}`);
 const verifying=importFraction(job({phase:'verifying',completed:32416,total:64832,bytes:0,totalBytes:0,speed:0,file:''}))!;
 assert.ok(verifying>copying&&verifying<1);
 assert.equal(importFraction(job(checked,'complete')),1);
 const total=dashboard(job(checked));
 assert.ok(!total.includes('99%')&&!total.includes('100%'));
 assert.ok(total.includes('10%'));
 assert.ok(total.includes('Reading metadata'));
});

test('with several files compared at once, the file count rises while they are still being read',async t=>{
 const {source,roots}=await fixture(t);
 // Same size, other bytes at the first destination: every one is read to compare.
 for(let index=0;index<8;index++){
  const name=`P${index}.JPG`;await fs.writeFile(path.join(source,name),Buffer.alloc(3*1024*1024,index+1));
  const taken=path.join(roots[0]!,'2024/202402/Sony A7',name);await fs.mkdir(path.dirname(taken),{recursive:true});await fs.writeFile(taken,Buffer.alloc(3*1024*1024,200));
 }
 const events:{step:string;count:number;bytes:number}[]=[];
 await plan(source,[roots[0]!],options,metadata,undefined,(count,_file,detail)=>{if(detail?.step==='comparing')events.push({step:detail.step,count,bytes:detail.bytes});});
 const read=events.at(-1)!.bytes;
 assert.equal(read,8*3*1024*1024,'every source byte read to compare is counted');
 assert.ok(events.some(event=>event.count>0&&event.bytes<read),'files are counted as each comparison finishes, not only after all reading');
});
