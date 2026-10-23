import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {listingEstimate,scopeHint} from '../listing-estimate';
import {EtaTracker,type EtaInput} from '../eta';
import {I18nProvider} from '../renderer/i18n';
import {ImportDashboard,ImportDesk} from '../renderer/RootApp';
import type {AppState,Language,Progress} from '../shared';

test('a listing that passes its estimate keeps moving and never reaches 100%',()=>{
 // The real count passed an estimate of about 20k files: 19,693 then 22,812 found.
 let last=0;
 for(let files=15000;files<=40000;files+=250){
  const {share,total}=listingEstimate({files:20000},{files,bytes:files*30e6});
  assert.ok(share!>last,`share rises at ${files}: ${share} > ${last}`);assert.ok(share!<1);assert.ok(total>files,'the estimate stays ahead of what was found');
  last=share!;
 }
 const before=listingEstimate({files:20000},{files:19693,bytes:0}).share!,after=listingEstimate({files:20000},{files:22812,bytes:0}).share!;
 assert.ok(after>before&&after<1);
 // The byte fallback (used bytes of the volume) behaves the same way.
 let bytes=0;
 for(let found=700e9;found<=1600e9;found+=10e9){
  const {share,totalBytes}=listingEstimate({bytes:800e9},{files:1,bytes:found});
  assert.ok(share!>bytes&&share!<1);assert.ok(totalBytes>found);bytes=share!;
 }
});

test('the size of the selected folders comes from an earlier listing, not the whole drive',()=>{
 const files=[{relative:'DCIM/a.jpg',size:10},{relative:'DCIM/sub/b.jpg',size:20},{relative:'other/c.jpg',size:1000},{relative:'DCIMX/d.jpg',size:5}];
 assert.deepEqual(scopeHint(files,['DCIM']),{files:2,bytes:30});
 assert.deepEqual(scopeHint(files),{files:4,bytes:1035});
 assert.equal(scopeHint(files,['missing']),undefined);
 assert.equal(scopeHint(undefined,['DCIM']),undefined);
});

test('past the estimate the time left stays sane and then gives way to estimating',()=>{
 const tracker=new EtaTracker(),context={kind:'import' as const,destinations:1,verify:true};
 const hint={files:20000};
 const shown:{files:number;eta?:number}[]=[];
 for(let second=0,files=15000;files<=30000;second+=5,files+=200){
  const estimate=listingEstimate(hint,{files,bytes:files*30e6});
  const progress:EtaInput={phase:'planning',step:'listing',completed:files,total:estimate.total,bytes:files*30e6,totalBytes:estimate.totalBytes,...(estimate.share!==undefined?{share:estimate.share}:{})};
  shown.push({files,eta:tracker.observe('review',progress,context,second*1000).step});
 }
 const values=shown.filter(item=>item.eta!==undefined);
 assert.ok(values.length>5,'an estimate is shown while the count is within the estimate');
 for(const item of values)assert.ok(Number.isFinite(item.eta!)&&item.eta!>=0&&item.eta!<3600,`sane time left at ${item.files}: ${item.eta}`);
 for(let index=1;index<values.length;index++)assert.ok(values[index]!.eta!<=Math.max(values[index-1]!.eta!*2,values[index-1]!.eta!+60),'no sudden jump');
 for(const item of shown.filter(item=>item.files>=22812))assert.equal(item.eta,undefined,`no number once past the estimate (${item.files})`);
});

test('the byte fallback never claims days left when the count runs past the estimate',()=>{
 const tracker=new EtaTracker(),context={kind:'import' as const,destinations:1,verify:true,listingTotalBytes:800e9};
 let seen=0;
 for(let second=0,bytes=400e9;bytes<=1200e9;second+=5,bytes+=5e9){
  const eta=tracker.observe('review',{phase:'planning',step:'listing',completed:bytes/30e6,total:0,bytes,totalBytes:0},context,second*1000).step;
  if(eta!==undefined){seen++;assert.ok(Number.isFinite(eta)&&eta<24*3600,`sane time left at ${bytes}: ${eta}`);}
 }
 assert.ok(seen>0);
});

const source={id:'card',name:'Untitled',path:'/Volumes/Untitled',transport:'storage' as const,selected:true,total:1e12,free:2e11};
const preferences:AppState['preferences']={language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A006'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}};
const state=(extra:Partial<AppState>={}):AppState=>({preferences,sources:[source],jobs:[],history:[],platform:'darwin',...extra});
const render=(node:Parameters<typeof renderToStaticMarkup>[0],language:Language='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:node}));
const desk=(value:AppState,language:Language='en')=>render(createElement(ImportDesk,{state:value,act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}),language);
const building:Progress={phase:'planning',step:'listing',completed:19693,total:0,bytes:5e11,totalBytes:0,speed:0,file:'a/b.jpg',share:.68};

test('while a review is built the source card says so and its first step is at work',()=>{
 const idle=desk(state());
 assert.ok(idle.includes('Ready to import'));assert.ok(!idle.includes('Building review…'));
 const busy=desk(state({busyReview:true,reviewSourceId:'card',reviewProgress:building}));
 assert.ok(busy.includes('Building review…'),'the card shows Building review…');
 assert.ok(!busy.includes('Ready to import'));
 assert.ok(busy.includes('19,693 files found'),'the review step is shown on the card');
 assert.match(busy,/data-testid="source-steps"[\s\S]*?data-state="active"/);
 // Another source's review does not change this card.
 assert.ok(desk(state({busyReview:true,reviewSourceId:'other',reviewProgress:building})).includes('Ready to import'));
 for(const [language,text] of [['zh-Hans','正在生成审核…'],['zh-Hant','正在產生審核…'],['ja','確認を準備中…']] as const)assert.ok(desk(state({busyReview:true,reviewSourceId:'card',reviewProgress:building}),language).includes(text),language);
});

test('with nothing planned the total progress shows no percentage',()=>{
 const total=(value:AppState)=>render(createElement(ImportDashboard,{state:value,act:()=>{}})).match(/data-testid="total-progress"[\s\S]*?progress-display-line[\s\S]*?<\/div><\/div>/)?.[0]??'';
 const empty=total(state());
 assert.ok(empty.includes('No transfer planned'));
 assert.ok(!empty.includes('progress-percent'));assert.ok(!/\d+%/.test(empty),empty);
});
