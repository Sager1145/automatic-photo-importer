import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '../renderer/i18n';
import {TitlebarControls} from '../renderer/RootApp';
import type {AppState,Job,Language} from '../shared';

const source={id:'card',name:'Untitled',path:'/Volumes/Untitled/photobackup',transport:'folder' as const,selected:true};
const preferences:AppState['preferences']={language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A','/Volumes/B'],copyMode:'mirror',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}};
const state=(extra:Partial<AppState>={}):AppState=>({preferences,sources:[source],jobs:[],history:[],platform:'darwin',...extra});
type Props=Parameters<typeof TitlebarControls>[0];
const titlebar=(props:Partial<Props>,language:Language='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(TitlebarControls,{state:state(),act:()=>{},errorCount:2,onErrors:()=>{},...props})}));
const ids=(html:string)=>[...html.matchAll(/data-testid="([^"]+)"/g)].map(match=>match[1]);
const button=(html:string,id:string)=>html.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))![0];

test('each page shows its own top-bar buttons, and All errors on every page',()=>{
 assert.deepEqual(ids(titlebar({page:'desk'})),['global-start','global-stop','global-automatic','titlebar-overview','show-errors']);
 assert.deepEqual(ids(titlebar({page:'drives'})),['show-errors','refresh-drives']);
 assert.deepEqual(ids(titlebar({page:'organization'})),['titlebar-review-organization','titlebar-organize','show-errors']);
 assert.deepEqual(ids(titlebar({page:'settings'})),['show-errors']);
 assert.deepEqual(ids(titlebar({page:'history'})),['show-errors']);
 assert.match(titlebar({page:'settings'}),/class="error-count" data-count="2"/);
});

test('the desk is the default page, so the import controls stay where they were',()=>{
 assert.equal(titlebar({}),titlebar({page:'desk'}));
 assert.match(titlebar({}),/Refresh connected sources/);
});

test('the organization buttons stay available for any chosen destination, even one since removed',()=>{
 for(const organizationDestination of [1,5]) {
  const html=titlebar({page:'organization',organizationDestination});
  assert.doesNotMatch(button(html,'titlebar-review-organization'),/disabled/);
  assert.doesNotMatch(button(html,'titlebar-organize'),/disabled/);
 }
});

test('the organization buttons are disabled when the page disables them',()=>{
 const scanning=titlebar({page:'organization',state:state({scanningSources:['card']})});
 assert.match(button(scanning,'titlebar-review-organization'),/disabled/);
 assert.match(button(scanning,'titlebar-organize'),/disabled/);
 const importing:Job={id:'j',source,phase:'copying',errors:[],backup:false};
 const copying=titlebar({page:'organization',state:state({jobs:[importing]})});
 assert.match(button(copying,'titlebar-review-organization'),/disabled/,'review waits for the import');
 assert.doesNotMatch(button(copying,'titlebar-organize'),/disabled/,'organize queues behind the import');
 const none=titlebar({page:'organization',state:state({preferences:{...preferences,destinations:[]}})});
 assert.match(button(none,'titlebar-organize'),/disabled/);
});

test('the new top-bar labels are translated',()=>{
 assert.match(titlebar({page:'drives'},'ja'),/ドライブを更新/);
 assert.match(titlebar({page:'organization'},'zh-Hans'),/整理控制/);
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

test('the narrowest title bar still collapses Organize now but keeps the labels of Start and Pause',()=>{
 const css=readFileSync(new URL('../renderer/styles.css',import.meta.url),'utf8');
 const rule=css.match(/@container titlebar \(max-width:36rem\)\{[^\n]*/)![0];
 assert.match(rule,/titlebar-organize/);assert.doesNotMatch(rule,/global-start/);
});
