import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '../renderer/i18n';
import {ImportDashboard,Organization,SidebarSources,TitlebarControls} from '../renderer/RootApp';
import type {AppState,Job,Language} from '../shared';

const source={id:'card',name:'Untitled',path:'/Volumes/Untitled/photobackup',transport:'folder' as const,selected:true};
const preferences:AppState['preferences']={language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A','/Volumes/B'],copyMode:'mirror',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}};
const state=(extra:Partial<AppState>={}):AppState=>({preferences,sources:[source],jobs:[],history:[],platform:'darwin',...extra});
type Props=Parameters<typeof TitlebarControls>[0];
const titlebar=(props:Partial<Props>,language:Language='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(TitlebarControls,{state:state(),act:()=>{},errorCount:2,onErrors:()=>{},...props})}));
const ids=(html:string)=>[...html.matchAll(/data-testid="([^"]+)"/g)].map(match=>match[1]);
const button=(html:string,id:string)=>html.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))![0];

test('every page shows the same run controls, and All errors',()=>{
 for(const page of ['desk','library','activity','settings'] as const) assert.deepEqual(ids(titlebar({page})),['global-start','global-stop','global-stop-menu','global-stop-everything','show-errors'],page);
 assert.doesNotMatch(titlebar({page:'settings'}),/global-automatic|titlebar-overview|refresh-button/);
 assert.match(titlebar({page:'settings'}),/class="error-count" data-count="2"/);
});

test('the desk is the default page, and refresh lives in the sidebar Sources heading',()=>{
 assert.equal(titlebar({}),titlebar({page:'desk'}));
 assert.doesNotMatch(titlebar({}),/Refresh connected sources/);
 const sidebar=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(SidebarSources,{state:state(),onOpen:()=>{},act:()=>{}})}));
 assert.match(sidebar,/<h2 id="sidebar-sources">Sources<\/h2><button[^>]*data-testid="refresh-sources"[^>]*aria-label="Refresh connected sources"/);
});

test('Library keeps execution below the destination scope and the same run controls and All errors in the top bar',()=>{
 for(const organizationDestination of [1,5]) {
  assert.deepEqual(ids(titlebar({page:'library',organizationDestination})),['global-start','global-stop','global-stop-menu','global-stop-everything','show-errors']);
  const html=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(Organization,{state:state(),act:()=>{},busy:false,selectedDestination:organizationDestination})}));
  assert.ok(html.indexOf('data-testid="organization-execute"')>html.indexOf('organization-scope'));
  assert.equal((html.match(/>Organize now</g)??[]).length,1);
 }
});

test('the content actions retain review locking and organization queue semantics',()=>{
 const render=(value:AppState)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(Organization,{state:value,act:()=>{},busy:true})}));
 const importing:Job={id:'j',source,phase:'copying',errors:[],backup:false};
 const copying=render(state({jobs:[importing]}));
 assert.match(copying,/<button[^>]*disabled[^>]*>(?:<svg[\s\S]*?<\/svg>)?Review changes…/);
 assert.match(copying,/<button[^>]*class="button button-primary[^>]*>(?:<svg[\s\S]*?<\/svg>)?Organize now/);
 const queued=render(state({jobs:[{...importing,organization:true,phase:'queued'}]}));
 assert.match(queued,/<button[^>]*class="button button-primary[^>]*disabled/);
});

test('the import overview has one toggle that follows showDashboard and collapses to a slim header',()=>{
 const dashboard=(showDashboard?:boolean)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(ImportDashboard,{state:state({preferences:{...preferences,...(showDashboard===undefined?{}:{showDashboard})}}),act:()=>{}})}));
 for(const shown of [undefined,true]) {
  const html=dashboard(shown);
  assert.match(button(html,'dashboard-toggle'),/aria-expanded="true"[^>]*aria-label="Hide the import overview"|aria-label="Hide the import overview"[^>]*aria-expanded="true"/);
  assert.match(html,/dashboard-metrics/);
  assert.match(html,/data-testid="parallel-summary"/);
 }
 const collapsed=dashboard(false);
 assert.match(button(collapsed,'dashboard-toggle'),/aria-label="Show the import overview"/);
 assert.match(collapsed,/import-dashboard-collapsed/);
 assert.match(collapsed,/Import overview/);
 assert.doesNotMatch(collapsed,/dashboard-metrics|parallel-summary/);
});

test('every overview metric note carries its full text as a tooltip, so a clamped note loses nothing',()=>{
 const html=renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(ImportDashboard,{state:state({destinationStatus:[{path:'/Volumes/A',available:true,total:2e12,free:427.1e9}]}),act:()=>{}})}));
 const notes=[...html.matchAll(/<small([^>]*)>([\s\S]*?)<\/small>/g)];
 assert.ok(notes.length>=4);
 for(const [,attributes,inner] of notes){
  const text=inner!.replace(/<[^>]+>/g,'');
  assert.ok(attributes!.includes(`title="${text}"`)||attributes!.includes('title="Whole disk'),`tooltip for "${text}"`);
 }
});
