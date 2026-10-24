import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '../renderer/i18n';
import {ImportDesk,SettingsPage} from '../renderer/RootApp';
import {defaultPreferences,normalizePreferences} from '../preferences';
import {jobPreferences} from '../settings-lock';
import type {AppState} from '../shared';

const state=(extra:Partial<AppState['preferences']>={}):AppState=>({preferences:{...defaultPreferences,destinations:['/Volumes/A'],...extra},sources:[],jobs:[],history:[],platform:'darwin'} as AppState);
const html=(node:React.ReactElement)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:node}));
const desk=(value:AppState)=>html(createElement(ImportDesk,{state:value,act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}}));
const choose=(markup:string)=>markup.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Add folder…/)![0];

test('Add folder needs no preference: the button is enabled and there is no gate switch',()=>{
 for(const extra of [{},{allowFolderSource:false}]) {
  const markup=desk(state(extra));
  assert.doesNotMatch(choose(markup),/disabled/);assert.doesNotMatch(markup,/Enable media folder selection/);
 }
 assert.match(choose(desk(state({destinations:[]}))),/disabled/);
 assert.doesNotMatch(html(createElement(SettingsPage,{state:state(),act:()=>{},busy:false})),/Enable media folder selection/);
});

test('the retired preference is no longer written, locked or checked by the main process',()=>{
 assert.ok(!('allowFolderSource' in defaultPreferences));
 assert.ok(!('allowFolderSource' in normalizePreferences({allowFolderSource:true})));
 assert.ok(!jobPreferences.has('allowFolderSource'));
});
