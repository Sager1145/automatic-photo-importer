import { freshOrganizeOptions } from '../run-policy';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '../renderer/i18n';
import {ImportDashboard,SidebarDestinations,destinationReadiness} from '../renderer/RootApp';
import type {AppState} from '../shared';
import { defaultPreferences } from '../preferences';

const preferences:AppState['preferences']={...defaultPreferences, language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',unknownRules:{}};
const state=(destinationStatus:AppState['destinationStatus']):AppState=>({preferences,sources:[],jobs:[],history:[],platform:'darwin',organizeOptions:freshOrganizeOptions(),destinationStatus});
const dashboard=(value:AppState)=>renderToStaticMarkup(createElement(I18nProvider,{...defaultPreferences, language:'en',children:createElement(ImportDashboard,{state:value,act:()=>{}})}));
const offlineText='A destination is offline. Reconnect it to import.';

test('a destination whose first check is still pending is checking, not offline',()=>{
 const pending=state([]);
 assert.deepEqual({checking:destinationReadiness(pending).checking,offline:destinationReadiness(pending).offline},{checking:true,offline:false});
 const html=dashboard(pending);
 assert.ok(!html.includes(offlineText));
 assert.ok(html.includes('Checking destinations…'));
 assert.ok(!html.includes('Choose a backup destination'));
});

test('the offline error appears only after a finished check reports the destination unavailable',()=>{
 const offline=state([{path:'/Volumes/A',available:false} as NonNullable<AppState['destinationStatus']>[number]]);
 assert.equal(destinationReadiness(offline).offline,true);
 assert.equal(destinationReadiness(offline).checking,false);
 assert.ok(dashboard(offline).includes(offlineText));
});

test('a checked, available destination is ready and shows no banner',()=>{
 const ready=state([{path:'/Volumes/A',available:true,free:1e9,total:2e9} as NonNullable<AppState['destinationStatus']>[number]]);
 assert.equal(destinationReadiness(ready).ready.length,1);
 const html=dashboard(ready);
 assert.ok(!html.includes(offlineText)&&!html.includes('Checking destinations…'));
});

test('a job still checking files shows Checking files at the destination, never Verifying',()=>{
 const base=state([{path:'/Volumes/A',available:true,free:1e9,total:2e9} as NonNullable<AppState['destinationStatus']>[number]]);
 const job={id:'j',source:{id:'s',name:'Card',path:'/Volumes/CARD',transport:'storage',selected:true},phase:'verifying',errors:[],backup:false,progress:{phase:'planning',step:'comparing',completed:3,total:10,bytes:0,totalBytes:0,speed:0,file:''}} as unknown as AppState['jobs'][number];
 const html=renderToStaticMarkup(createElement(I18nProvider,{...defaultPreferences, language:'en',children:createElement(SidebarDestinations,{state:{...base,jobs:[job]}})}));
 assert.ok(html.includes('Checking files'));
 assert.ok(!html.includes('Verifying'));
 assert.ok(html.includes('data-kind="checking-files"'));
 assert.ok(!html.includes('data-step="copy"'),'no copy underlay while checking');
 const verifying=renderToStaticMarkup(createElement(I18nProvider,{...defaultPreferences, language:'en',children:createElement(SidebarDestinations,{state:{...base,jobs:[{...job,progress:{...job.progress!,phase:'verifying',step:undefined}}]}})}));
 assert.ok(verifying.includes('Verifying'));
});

test('a job without progress follows its phase, and progress left from an earlier run is ignored',()=>{
 const base=state([{path:'/Volumes/A',available:true,free:1e9,total:2e9} as NonNullable<AppState['destinationStatus']>[number]]);
 const make=(phase:string,progress?:unknown)=>({id:'j',source:{id:'s',name:'Card',path:'/Volumes/CARD',transport:'storage',selected:true},phase,errors:[],backup:false,progress} as unknown as AppState['jobs'][number]);
 const kindOf=(job:AppState['jobs'][number])=>renderToStaticMarkup(createElement(I18nProvider,{...defaultPreferences, language:'en',children:createElement(SidebarDestinations,{state:{...base,jobs:[job]}})})).match(/data-kind="([\w-]+)"/)?.[1];
 const planning={phase:'planning',step:'comparing',completed:3,total:10,bytes:0,totalBytes:0,speed:0,file:''};
 assert.equal(kindOf(make('verifying')),'checking-files','reading metadata, before any progress');
 assert.equal(kindOf(make('copying')),'receiving');
 assert.equal(kindOf(make('copying',planning)),'receiving','planning progress from an earlier run');
 assert.equal(kindOf(make('verifying',{...planning,phase:'verifying',step:undefined})),'verifying');
});
