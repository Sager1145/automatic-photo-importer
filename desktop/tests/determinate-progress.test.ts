import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as core from '../core/index';
import {listingEstimate} from '../listing-estimate';
import {loadListingHint,rememberListing} from '../platform/listing-memory';
import {EtaTracker} from '../eta';
import {I18nProvider} from '../renderer/i18n';
import {OrganizationCard,ScanProgress} from '../renderer/RootApp';
import {truncateMiddle} from '../renderer/progress';
import type {Job,Metadata} from '../shared';

core.configureOrganizationRecovery('fixture-only-host-recovery-secret-32bytes');
const metadata=async():Promise<Metadata>=>({camera:'Sony A7',date:'2026-10-03T12:00:00',fields:{}});
const base={backup:false as const,template:'{year}/{yyyymm}/{camera}',unknownRules:{}};
const render=(node:Parameters<typeof renderToStaticMarkup>[0])=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:node}));

test('a remembered file count sizes the listing and never reaches 100% early',()=>{
 const half=listingEstimate({files:1000,bytes:5e9},{files:500,bytes:2e9});
 assert.equal(half.total,1000);assert.equal(half.share,.5);
 // More files than remembered: the estimate stays ahead, the share stays below 1.
 const grown=listingEstimate({files:1000},{files:1500,bytes:0});
 assert.ok(grown.total>1500);assert.ok(grown.share!<1);
 assert.ok(listingEstimate({files:10},{files:10,bytes:0}).share!<1);
});
test('without a remembered count the used bytes, then top-level folders, estimate the listing',()=>{
 const bytes=listingEstimate({bytes:100e9},{files:10,bytes:25e9});
 assert.equal(bytes.total,0);assert.equal(bytes.share,.25);
 assert.ok(listingEstimate({bytes:100e9},{files:10,bytes:300e9}).share!<1);
 assert.equal(listingEstimate(undefined,{files:5,bytes:1},{done:1,total:4}).share,.25);
 assert.ok(listingEstimate(undefined,{files:5,bytes:1},{done:4,total:4}).share!<1);
 assert.equal(listingEstimate(undefined,{files:5,bytes:1}).share,undefined);
});
test('the last listing of a scope is remembered across restarts',async t=>{
 const store=await fs.mkdtemp(path.join(os.tmpdir(),'listing-memory-'));t.after(()=>fs.rm(store,{recursive:true,force:true}));
 assert.equal(await loadListingHint(store,'/Volumes/A',['x'],false),undefined);
 await rememberListing(store,'/Volumes/A',['x'],false,1234,5e9);
 assert.deepEqual(await loadListingHint(store,'/Volumes/A',['x'],false),{files:1234,bytes:5e9});
 assert.equal(await loadListingHint(store,'/Volumes/A',['y'],false),undefined);
});

async function tree(t:test.TestContext){
 const drive=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'determinate-')));
 t.after(()=>fs.rm(drive,{recursive:true,force:true}));
 const photos=path.join(drive,'photobackup');
 for(const folder of ['2025','2026','2027']){await fs.mkdir(path.join(drive,folder),{recursive:true});for(const name of ['A.JPG','B.JPG'])await fs.writeFile(path.join(drive,folder,name),'bytes of '+folder+name);}
 await fs.mkdir(photos,{recursive:true});
 return {drive,photos};
}
test('every planning step names its file and carries a total once known; listing stays below 100%',async t=>{
 const {drive,photos}=await tree(t);
 const events:{count:number;file:string;step:string;total:number;share?:number}[]=[];let listed=0;
 await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,listingHint:{files:6,bytes:100},onListed:files=>{listed=files;}},metadata,undefined,(count,file,detail)=>{events.push({count,file,step:detail?.step??'',total:detail?.total??0,share:detail?.share});});
 assert.equal(listed,6);
 const steps=new Set(events.map(event=>event.step));
 assert.ok(steps.has('listing')&&steps.has('checking'));
 for(const event of events){
  assert.notEqual(event.file,'',`${event.step} reports a file`);
  if(event.step==='listing'){assert.ok(event.total>=event.count);assert.ok(event.share!==undefined&&event.share<1);}
  else assert.ok(event.total>0);
 }
});
test('without anything remembered the listing reports top-level folders finished',async t=>{
 const {drive,photos}=await tree(t);
 const shares:number[]=[];
 await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true},metadata,undefined,(_c,_f,detail)=>{if(detail?.step==='listing'&&detail.share!==undefined)shares.push(detail.share);});
 assert.ok(shares.length>0);assert.ok(shares.every(share=>share<1));assert.ok(shares.some(share=>share>0));
});
test('reading a journal reports the history step with the event file it is on',async t=>{
 const {drive,photos}=await tree(t);
 const plan=(await core.plan(drive,[photos],{...base,layout:'flat',reorganize:true,sourceFolders:['2025']},metadata)).plans[0]!;
 const controller=new AbortController();
 await assert.rejects(core.executeReorganization(plan,controller.signal,value=>{if(value.step==='moving'&&value.completed>=1)controller.abort();}),{name:'AbortError'});
 const [journal]=await core.getOrganizationRecovery(photos);
 const seen:{completed:number;total:number;file:string}[]=[];
 await core.resumeOrganization(photos,journal!.id,undefined,value=>{if(value.step==='history')seen.push(value);});
 assert.ok(seen.length>0);
 for(const value of seen){assert.ok(value.total>0);assert.ok(value.completed<=value.total);assert.notEqual(value.file,'');}
 assert.equal(seen.at(-1)!.completed,seen.at(-1)!.total);
});

test('the tracker measures files per second',()=>{
 const tracker=new EtaTracker();
 assert.equal(tracker.measure('x','planning:listing',0,0),undefined);
 assert.equal(tracker.measure('x','planning:listing',500,1000),undefined,'a rate needs 2 s of history');
 assert.ok((tracker.measure('x','planning:listing',1000,2000)??0)>0);
});
test('a long path is cut in the middle',()=>{
 const long='2026/'+'folder/'.repeat(20)+'IMG_0001.NEF';
 const cut=truncateMiddle(long,40);
 assert.equal(cut.length,40);assert.ok(cut.endsWith('IMG_0001.NEF'));assert.ok(cut.includes('…'));
 assert.equal(truncateMiddle('a/b.jpg'),'a/b.jpg');
});
test('the scanning card shows the file, speed and time left',()=>{
 const markup=render(createElement(ScanProgress,{sourceName:'A006',listing:{files:1200,bytes:3e9,file:'DCIM/100NIKON/DSC_0001.NEF',fileRate:850,eta:120,startedAt:new Date(0).toISOString(),share:.25}}));
 assert.ok(markup.includes('DCIM/100NIKON/DSC_0001.NEF'),markup);
 assert.ok(markup.includes('850'),markup);assert.ok(/left/.test(markup),markup);assert.ok(markup.includes('25%')&&markup.includes('aria-valuenow="25"'));
});
test('an organization reading its history shows a bar, file, speed and time left',()=>{
 const job:Job={id:'o',source:{id:'library:/V/A',name:'Org',path:'/V/A',transport:'folder'},organization:true,phase:'verifying',startedAt:new Date(0).toISOString(),errors:[],backup:false,fraction:.25,progress:{phase:'verifying',step:'history',completed:500,total:2000,bytes:0,totalBytes:0,speed:0,fileRate:300,eta:90,file:'event-0001.json'}};
 const markup=render(createElement(OrganizationCard,{job,act:()=>{}}));
 assert.ok(markup.includes('Reading organization history: 500 of 2,000 files'),markup);
 assert.ok(markup.includes('Reading history'));assert.ok(markup.includes('25%'));assert.ok(markup.includes('event-0001.json'));assert.ok(markup.includes('300'));
 assert.ok(!markup.includes('progress-discovering'));
});
test('a job that is listing shows its file and speed, and no share of the job until one is measured',()=>{
 const job:Job={id:'o',source:{id:'library:/V/A',name:'Org',path:'/V/A',transport:'folder'},organization:true,phase:'verifying',errors:[],backup:false,progress:{phase:'planning',step:'listing',completed:400,total:1000,bytes:1e9,totalBytes:0,share:.4,speed:0,fileRate:200,file:'2026/IMG_1.NEF'}};
 const markup=render(createElement(OrganizationCard,{job,act:()=>{}}));
 // The listing's estimated total says nothing of the job's share done; a bar that then fell back at the next step would mislead.
 assert.ok(!markup.includes('40%'),markup);assert.ok(markup.includes('progress-discovering'));assert.ok(markup.includes('2026/IMG_1.NEF'));assert.ok(markup.includes('200'));
});
