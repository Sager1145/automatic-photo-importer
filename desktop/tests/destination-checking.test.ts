import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '../renderer/i18n';
import {ImportDashboard,destinationReadiness} from '../renderer/RootApp';
import type {AppState} from '../shared';

const preferences:AppState['preferences']={language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}};
const state=(destinationStatus:AppState['destinationStatus']):AppState=>({preferences,sources:[],jobs:[],history:[],platform:'darwin',destinationStatus});
const dashboard=(value:AppState)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:createElement(ImportDashboard,{state:value,act:()=>{}})}));
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
