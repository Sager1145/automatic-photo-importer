import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider,createTranslator,languages,translationCatalogs} from '../renderer/i18n';
import {SidebarDestinations,destinationActivity} from '../renderer/RootApp';
import type {AppState,Job,Progress} from '../shared';

const GB=1e9;
const preferences={language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/BACKUP'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}} as AppState['preferences'];
const online=[{path:'/Volumes/BACKUP',available:true,total:2000*GB,free:800*GB}];
const source=(id:string,name:string)=>({id,name,path:`/Volumes/${name}`,transport:'storage' as const,selected:true,total:128*GB,free:40*GB});
const progress=(patch:Partial<Progress>={}):Progress=>({phase:'copying',completed:120,total:400,bytes:12*GB,totalBytes:40*GB,speed:150e6,file:'SECRET_NAME.NEF',...patch});
const job=(id:string,name:string,patch:Partial<Job>={}):Job=>({id,source:source(id,name),phase:'copying',errors:[],backup:false,progress:progress(),eta:600,...patch});
const stateOf=(patch:Partial<AppState>={}):AppState=>({preferences,sources:[],jobs:[],history:[],platform:'darwin',destinationStatus:online,...patch});
const render=(state:AppState,language:typeof languages[number]='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(SidebarDestinations,{state})}));
const status=(markup:string)=>markup.match(/data-testid="sidebar-destination-status"[^>]*>/)?.[0]??'';
const kindOf=(state:AppState)=>destinationActivity(state,'/Volumes/BACKUP').kind;

test('each destination shows one status, derived from existing state',()=>{
 const t=createTranslator('en');
 const folder={id:'o',name:'Library organization',path:'/Volumes/BACKUP/photobackup',transport:'folder' as const,selected:true};
 const cases:[string,AppState,string,string][]=[
  ['checking',stateOf({destinationStatus:[]}),'Checking…','checking'],
  ['offline',stateOf({destinationStatus:[{path:'/Volumes/BACKUP',available:false}]}),'Offline','offline'],
  ['idle',stateOf(),'Idle','idle'],
  ['receiving',stateOf({jobs:[job('a','CARD')]}),'Receiving files','receiving'],
  ['verifying',stateOf({jobs:[job('a','CARD',{phase:'verifying',progress:progress({phase:'verifying'})})]}),'Verifying','verifying'],
  ['folder-check',stateOf({misplacedProgress:{'/Volumes/BACKUP':progress({phase:'planning',step:'checking'})}}),'Checking folder layout','folder-check'],
  ['organizing',stateOf({jobs:[job('o','BACKUP',{organization:true,source:folder,progress:progress({renames:true,step:'moving'})})]}),'Organizing','organizing'],
  ['duplicates',stateOf({duplicates:{scopes:[],root:'/Volumes/BACKUP/photobackup',name:'photobackup',status:'removing',progress:progress({phase:'copying',step:'removing'}),revision:1,groups:1,files:2}}),'Organizing','organizing'],
  ['cleaning',stateOf({residue:{files:3,bytes:10,resumable:{files:0,bytes:0},progress:progress({phase:'copying',step:'deleting'})}}),'Cleaning up','cleaning'],
  ['tidying',stateOf({jobs:[job('a','CARD',{progress:progress({step:'tidying',renames:true})})]}),'Cleaning up','cleaning'],
 ];
 for(const [name,state,label,kind] of cases){
  assert.equal(kindOf(state),kind,name);
  const markup=render(state);
  assert.match(status(markup),new RegExp(`data-kind="${kind}"`),name);
  assert.ok(markup.includes(`>${t(label)}<`),`${name}: label ${label}`);
 }
});

test('only offline uses the danger colour; active states use step colours and nothing layers',()=>{
 const css=readFileSync(new URL('../renderer/styles.css',import.meta.url),'utf8');
 const rules=[...css.matchAll(/\.sidebar-dest[^{]*\{[^}]*\}/g)].map(match=>match[0]).join('\n');
 assert.ok(rules.length>0,'sidebar destination status rules exist');
 assert.match(rules,/data-kind=offline[^{]*\{[^}]*var\(--danger\)/);
 assert.equal([...rules.matchAll(/var\(--(danger|warning)\)/g)].length,1,'danger only for offline, never warning');
 assert.ok(!/z-index|transform|animation/.test(rules),'no layering-sensitive properties');
 for(const kind of ['copy','verify','folder-check','move','tidy'])assert.ok(css.includes(`--step-${kind}`),kind);
});

test('detail shows count, bytes, speed, time left and the source, but never a file name',()=>{
 const markup=render(stateOf({jobs:[job('a','photobackup')]}));
 assert.match(markup,/role="meter" aria-label="Destination progress"[^>]*aria-valuenow="30"/);
 assert.match(markup,/120 of 400 files · 12\.0 GB of 40\.0 GB/);
 assert.match(markup,/150 MB\/s/);
 assert.match(markup,/about 10 min left/);
 assert.match(markup,/from photobackup/);
 assert.ok(!markup.includes('SECRET_NAME'),'no file name');
 assert.ok(!/photobackup\s*\(\+/.test(markup),'one source has no "more"');
});

test('jobs writing to the same destination are added together',()=>{
 const state=stateOf({jobs:[
  job('a','photobackup',{progress:progress({completed:100,total:300,bytes:10*GB,totalBytes:30*GB,speed:100e6}),eta:300}),
  job('b','cardtwo',{progress:progress({completed:50,total:100,bytes:5*GB,totalBytes:10*GB,speed:50e6}),eta:900}),
  job('c','cardthree',{progress:progress({completed:0,total:100,bytes:0,totalBytes:10*GB,speed:0}),eta:1200}),
 ]});
 const activity=destinationActivity(state,'/Volumes/BACKUP');
 assert.equal(activity.kind,'receiving');
 assert.deepEqual({completed:activity.completed,total:activity.total,bytes:activity.bytes,totalBytes:activity.totalBytes,speed:activity.speed,eta:activity.eta},{completed:150,total:500,bytes:15*GB,totalBytes:50*GB,speed:150e6,eta:1200});
 assert.deepEqual(activity.sources,['photobackup','cardtwo','cardthree']);
 const markup=render(state);
 assert.match(markup,/150 of 500 files · 15\.0 GB of 50\.0 GB/);
 assert.match(markup,/from photobackup \(\+2 more\)/);
 assert.match(markup,/aria-valuenow="30"/);
});

test('an organization on one destination leaves the other idle',()=>{
 const two=stateOf({preferences:{...preferences,destinations:['/Volumes/BACKUP','/Volumes/SECOND'],copyMode:'mirror'},destinationStatus:[...online,{path:'/Volumes/SECOND',available:true}],jobs:[job('o','SECOND',{organization:true,source:{id:'o',name:'Library organization',path:'/Volumes/SECOND/photobackup',transport:'folder',selected:true}})]});
 assert.equal(destinationActivity(two,'/Volumes/BACKUP').kind,'idle');
 assert.equal(destinationActivity(two,'/Volumes/SECOND').kind,'organizing');
});

test('every new string is translated in all four locales',()=>{
 const keys=['Checking…','Receiving files','Checking folder layout','Cleaning up','Idle','Offline','Verifying','Organizing','from {name}','from {name} (+{count} more)','{completed} of {total} files','{completed} of {total} files · {size} of {totalSize}','Destination status','Destination progress'];
 for(const language of languages.filter(item=>item!=='en'))for(const key of keys){
  const value=translationCatalogs[language as 'zh-Hans'][key];
  assert.ok(value,`${language}: ${key}`);
  for(const placeholder of key.match(/\{\w+\}/g)??[])assert.ok(value.includes(placeholder),`${language}: ${key} keeps ${placeholder}`);
 }
 const markup=render(stateOf({jobs:[job('a','one'),job('b','two')]}),'ja');
 assert.ok(markup.includes(createTranslator('ja')('Receiving files')));
});

test('the smoke test checks that the destination status line exists',()=>{
 assert.match(readFileSync(new URL('../qa/codex-smoke.ts',import.meta.url),'utf8'),/sidebar-destination-status/);
});
