import { freshOrganizeOptions } from '../run-policy';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '../renderer/i18n';
import {TitlebarControls,ImportDesk,OrganizationCard} from '../renderer/RootApp';
import type {AppState,Job,Language} from '../shared';
import { defaultPreferences } from '../preferences';

const source={id:'card',name:'Untitled',path:'/Volumes/Untitled/photobackup',transport:'folder' as const,selected:true};
const preferences:AppState['preferences']={...defaultPreferences, language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A006'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',unknownRules:{}};
const progress={phase:'copying' as const,completed:3,total:10,bytes:1e6,totalBytes:4e6,speed:1e6,file:'A.JPG'};
const job=(stopping?:Job['stopping'],extra:Partial<Job>={}):Job=>({id:'j',source,phase:'copying',errors:[],backup:false,progress,...(stopping?{stopping}:{}),...extra});
const state=(jobs:Job[]):AppState=>({preferences,sources:[source],jobs,history:[],platform:'darwin',organizeOptions:freshOrganizeOptions()});
const render=<P extends object>(element:(props:P)=>ReturnType<typeof createElement>,props:P,language:Language='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(element,props)}));
const titlebar=(jobs:Job[],language:Language='en')=>render(TitlebarControls,{state:state(jobs),act:()=>{},errorCount:0,onErrors:()=>{}},language);
/** The opening tag of the element with this test id. */
const tag=(html:string,id:string)=>html.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>([\\s\\S]*?)</button>`))!;

test('while every running job winds down after Stop, the global controls say Stopping and are disabled',()=>{
 const html=titlebar([job('stop')]);
 const stop=tag(html,'global-stop'),pause=tag(html,'global-start');
 assert.match(stop[0]!,/disabled/);assert.match(stop[1]!,/Stopping…/);
 assert.match(pause[0]!,/disabled/);assert.match(pause[1]!,/Stopping…/);
});

test('after Pause the global Pause shows Pausing and Stop stays available to stop instead',()=>{
 const html=titlebar([job('pause')]);
 const stop=tag(html,'global-stop'),pause=tag(html,'global-start');
 assert.match(pause[0]!,/disabled/);assert.match(pause[1]!,/Pausing…/);
 assert.doesNotMatch(stop[0]!,/disabled/);assert.match(stop[1]!,/>Stop imports$/);assert.match(stop[0]!,/title="Stops queued, paused and running media imports and file backups. Scans, reviews and library tools continue."/);
});

test('the global controls stay active while any job is still running normally or queued',()=>{
 for(const jobs of [[job('stop'),job(undefined,{id:'k',source:{...source,id:'other'}})],[job('stop'),job(undefined,{id:'q',phase:'queued',source:{...source,id:'later'}})]]) {
  const html=titlebar(jobs);
  assert.doesNotMatch(tag(html,'global-stop')[0]!,/disabled/);assert.match(tag(html,'global-start')[1]!,/Pause imports/);
 }
});

test('a stopping source card and organization card say so and disable their buttons, in every language',()=>{
 const words:Record<Language,[string,string]>={en:['Stopping…','Pausing…'],'zh-Hans':['正在停止…','正在暂停…'],'zh-Hant':['正在停止…','正在暫停…'],ja:['停止しています…','一時停止しています…']};
 for(const [language,[stopping,pausing]] of Object.entries(words) as [Language,[string,string]][]) {
  const desk=render(ImportDesk,{state:state([job('stop')]),act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}},language);
  assert.ok(desk.includes(stopping),`${language} source card`);
  assert.ok(titlebar([job('pause')],language).includes(pausing),`${language} title bar`);
  const card=render(OrganizationCard,{job:job('pause',{organization:true}),act:()=>{}},language);
  assert.ok(card.includes(pausing),`${language} organization card`);
  assert.match(card,/<button[^>]*disabled[^>]*aria-label="[^"]*"/,`${language} organization buttons disabled`);
 }
});
