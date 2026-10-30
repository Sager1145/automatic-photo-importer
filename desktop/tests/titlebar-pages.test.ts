import { freshOrganizeOptions } from '../run-policy';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '../renderer/i18n';
import {Organization,TitlebarControls} from '../renderer/RootApp';
import type {AppState,Job,Language} from '../shared';
import { defaultPreferences } from '../preferences';

const source={id:'card',name:'Untitled',path:'/Volumes/Untitled/photobackup',transport:'folder' as const,selected:true};
const preferences:AppState['preferences']={...defaultPreferences, language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A','/Volumes/B'],copyMode:'mirror',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',unknownRules:{}};
const state=(extra:Partial<AppState>={}):AppState=>({preferences,sources:[source],jobs:[],history:[],platform:'darwin',organizeOptions:freshOrganizeOptions(),...extra});
type Props=Parameters<typeof TitlebarControls>[0];
const titlebar=(props:Partial<Props>,language:Language='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(TitlebarControls,{state:state(),act:()=>{},errorCount:2,onErrors:()=>{},...props})}));
const ids=(html:string)=>[...html.matchAll(/data-testid="([^"]+)"/g)].map(match=>match[1]);
const button=(html:string,id:string)=>html.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))![0];

test('each page shows its own top-bar buttons, and All errors on every page',()=>{
 assert.deepEqual(ids(titlebar({page:'desk'})),['global-start','global-stop','global-automatic','titlebar-overview','show-errors']);
 assert.deepEqual(ids(titlebar({page:'library'})),['show-errors']);
 assert.deepEqual(ids(titlebar({page:'settings'})),['show-errors']);
 assert.deepEqual(ids(titlebar({page:'activity'})),['show-errors']);
 assert.match(titlebar({page:'settings'}),/class="error-count" data-count="2"/);
});

test('the desk is the default page, so the import controls stay where they were',()=>{
 assert.equal(titlebar({}),titlebar({page:'desk'}));
 assert.match(titlebar({}),/Refresh connected sources/);
});

test('Library keeps execution below the destination scope and All errors in the top bar',()=>{
 for(const organizationDestination of [1,5]) {
  assert.deepEqual(ids(titlebar({page:'library',organizationDestination})),['show-errors']);
  const html=renderToStaticMarkup(createElement(I18nProvider,{...defaultPreferences, language:'en',children:createElement(Organization,{state:state(),act:()=>{},busy:false,selectedDestination:organizationDestination})}));
  assert.ok(html.indexOf('data-testid="organization-execute"')>html.indexOf('organization-scope'));
  assert.equal((html.match(/>Organize now</g)??[]).length,1);
 }
});

test('the content actions retain review locking and organization queue semantics',()=>{
 const render=(value:AppState)=>renderToStaticMarkup(createElement(I18nProvider,{...defaultPreferences, language:'en',children:createElement(Organization,{state:value,act:()=>{},busy:true})}));
 const importing:Job={id:'j',source,phase:'copying',errors:[],backup:false};
 const copying=render(state({jobs:[importing]}));
 assert.match(copying,/<button[^>]*disabled[^>]*>(?:<svg[\s\S]*?<\/svg>)?Review changes…/);
 assert.match(copying,/<button[^>]*class="button button-primary[^>]*>(?:<svg[\s\S]*?<\/svg>)?Organize now/);
 const queued=render(state({jobs:[{...importing,organization:true,phase:'queued'}]}));
 assert.match(queued,/<button[^>]*class="button button-primary[^>]*disabled/);
});

test('the desk top bar has an Overview toggle that follows and flips showDashboard',()=>{
 const toggle=(showDashboard?:boolean,act:(action:unknown)=>void=()=>{})=>titlebar({page:'desk',act:act as Props['act'],state:state({preferences:{...preferences,...(showDashboard===undefined?{}:{showDashboard})}})});
 for(const [shown,pressed] of [[undefined,'true'],[true,'true'],[false,'false']] as const) {
  const html=button(toggle(shown),'titlebar-overview');
  assert.match(html,new RegExp(`aria-pressed="${pressed}"`));
 }
 assert.match(toggle(true),/titlebar-overview[^>]*>(<svg.*?<\/svg>)?Overview</);
 assert.equal(ids(titlebar({page:'settings'})).includes('titlebar-overview'),false);
});
