import { freshOrganizeOptions } from '../run-policy';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {plan,executeMany,type PlanProgress} from '../core';
import {I18nProvider} from '../renderer/i18n';
import {ImportDashboard,ImportDesk} from '../renderer/RootApp';
import {cardFraction} from '../renderer/progress';
import type {AppState,Job,Progress} from '../shared';
import {configureOrganizationRecovery} from '../core/index';
import { defaultPreferences } from '../preferences';
configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');

const options={backup:false as const,template:'{year}/{yyyymm}/{camera}',layout:'flat' as const,unknownRules:{}};
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
 // Preparing the destinations (and loading an index, comparing with a drive folder) report in between; this is about the comparison.
 const comparing=events.slice(lastChecking+1).filter(event=>event.step==='comparing');
 // Before the fix nothing followed the last metadata check, so the card stayed at 100%.
 assert.ok(comparing.length>0,'the destination comparison reports progress');
 assert.ok(comparing.every(event=>event.step==='comparing'||event.step==='locating'));
 const total=plans.reduce((sum,item)=>sum+item.entries.length,0);
 assert.ok(comparing.every(event=>event.step==='locating'||event.total===total));
 const counted=comparing.filter(event=>event.step==='comparing');
 assert.equal(counted[0]!.count,0);assert.equal(counted.at(-1)!.count,total);
 for(let index=1;index<counted.length;index++)assert.ok(counted[index]!.count>=counted[index-1]!.count);
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

test('comparing reports the bytes it will read from the start, and the files found identical',async t=>{
 const {source,roots}=await fixture(t);
 const different=path.join(roots[0]!,'2024/202402/Sony A7/A.JPG'),same=path.join(roots[0]!,'2024/202402/Sony A7/B.JPG');
 await fs.mkdir(path.dirname(different),{recursive:true});await fs.writeFile(different,'X'.repeat(50));await fs.writeFile(same,'B.JPG'.repeat(10));
 const events:{totalBytes:number;matched?:number;matchedBytes?:number}[]=[];
 await plan(source,roots,options,metadata,undefined,(_count,_file,detail)=>{if(detail?.step==='comparing')events.push(detail);});
 assert.ok(events.length>0);
 const sized=events.filter(event=>event.totalBytes>0);
 assert.ok(sized.length>0&&sized.length<=events.length);
 assert.ok(sized.every(event=>event.totalBytes===100),'two same-size files of 50 bytes, known before any is read');
 assert.equal(events.at(-1)!.totalBytes,100);
 assert.ok(events.slice(0,events.length-sized.length).every(event=>event.totalBytes===0));
 assert.deepEqual([events.at(-1)!.matched,events.at(-1)!.matchedBytes],[1,50]);
 for(let index=1;index<events.length;index++)assert.ok(events[index]!.matched!>=events[index-1]!.matched!);
});

for(const cached of [false,true]) {
 test(`comparing bytes reach the total with two destinations${cached?' and a source digest already known':''}`,async t=>{
  const {source,roots}=await fixture(t);
  for(const root of roots){const taken=path.join(root,'2024/202402/Sony A7/A.JPG');await fs.mkdir(path.dirname(taken),{recursive:true});await fs.writeFile(taken,'X'.repeat(50));}
  const events:{bytes:number;totalBytes:number}[]=[];
  const known=cached?{sourceDigest:(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex')}:{};
  await plan(source,roots,{...options,...known},metadata,undefined,(_count,_file,detail)=>{if(detail?.step==='comparing')events.push(detail);});
  const last=events.at(-1)!;
  assert.equal(last.totalBytes,50,'the source file is read once however many destinations hold a same-size file');
  assert.equal(last.bytes,50);
  for(const event of events)assert.ok(event.totalBytes===0||event.bytes<=event.totalBytes);
 });
}

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
const preferences:AppState['preferences']={...defaultPreferences, language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A006'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',unknownRules:{}};
const job=(progress:Progress,phase:Job['phase']='verifying'):Job=>({id:'j',source,phase,errors:[],backup:false,progress});
const state=(value:Job):AppState=>({preferences,sources:[source],jobs:[value],history:[],platform:'darwin',organizeOptions:freshOrganizeOptions()});
const desk=(value:Job)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(ImportDesk,{state:state(value),act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}})}));
const dashboard=(value:Job)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(ImportDashboard,{state:state(value),act:()=>{}})})).match(/data-testid="total-progress"[\s\S]*?progress-display-line[\s\S]*?<\/div><\/div>/)?.[0]??'';
const checked:Progress={phase:'planning',step:'checking',completed:64832,total:64832,bytes:834e9,totalBytes:834e9,speed:0,file:'DSC1.JPG'};
const comparing:Progress={phase:'planning',step:'comparing',completed:3000,total:64832,bytes:36e9,totalBytes:0,speed:0,file:'DSC2.JPG'};

test('the source card names the step it is on and its own progress',()=>{
 const reading=desk(job({...checked,completed:100}));
 assert.ok(reading.includes('Reading metadata'));assert.ok(reading.includes('100 of 64,832 files checked'));
 const destination=desk(job(comparing));
 assert.ok(destination.includes('Checking existing files'));
 assert.ok(destination.includes('Checking the destination: 3,000 of 64,832 files · 36.0 GB read'));
 assert.ok(!destination.includes('progress-in-card')||!/progress-in-card[^>]*aria-valuenow/.test(destination),'without a measured share the card bar is indeterminate');
 const verifying=desk(job({phase:'verifying',completed:5,total:10,bytes:0,totalBytes:0,speed:0,file:''}));
 assert.ok(verifying.includes('Verifying copied files'));
});

test('total progress reads the step its counter counts, and nothing is guessed before a total is known',()=>{
 const listing=dashboard(job({phase:'planning',step:'listing',completed:500,total:0,bytes:1e9,totalBytes:0,speed:0,file:''}));
 assert.ok(!listing.includes('progress-percent')&&!listing.includes('aria-valuenow'),'no hard-coded share of the import');
 // The whole-job share the main process sends is not the number shown: 6,483 of 64,832 files checked is 10%.
 const measured=dashboard({...job({...checked,completed:6483}),fraction:.5});
 assert.ok(measured.includes('6,483 of 64,832 files checked'));
 assert.ok(measured.includes('10%'));
 assert.equal(cardFraction(job(checked,'complete')),1);
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
