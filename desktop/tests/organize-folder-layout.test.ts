import { freshOrganizeOptions } from '../run-policy';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider,createTranslator,languages} from '../renderer/i18n';
import {Organization,SameDriveNotice} from '../renderer/RootApp';
import {defaultPreferences} from '../preferences';
import type {AppState,Language} from '../shared';

const NOTE="Organizing a folder in place cannot be used with a separate video folder. Change the media layout in Settings → Folders.";
const state=(mediaLayout:'video-root'|'flat'):AppState=>({preferences:{...defaultPreferences,destinations:['/Volumes/A'],mediaLayout},sources:[],jobs:[],history:[],platform:'darwin',organizeOptions:freshOrganizeOptions()} as AppState);
const page=(mediaLayout:'video-root'|'flat',language:Language='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(Organization,{state:state(mediaLayout),act:()=>{},busy:false})}));
const section=(html:string)=>html.match(/<section[^>]*data-testid="organize-folder"[\s\S]*?<\/section>/)![0];
const choose=(html:string)=>section(html).match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Choose folder…/)![0];
const notice=(organizeBlocked:boolean,language:Language='en')=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(SameDriveNotice,{sourceId:'x',act:()=>{},organizeBlocked})}));
const instead=(html:string)=>html.match(/<button[^>]*data-testid="organize-instead"[^>]*>/)![0];

test('Organize a folder is disabled with a reason under the separate video folder layout',()=>{
 const blocked=page('video-root');
 assert.match(choose(blocked),/disabled/);assert.match(section(blocked),/data-testid="organize-folder-layout-note"/);assert.ok(section(blocked).includes(NOTE));
 const free=page('flat');
 assert.doesNotMatch(choose(free),/disabled/);assert.doesNotMatch(free,/organize-folder-layout-note/);
});

test('Organize instead in the same-drive notice follows the same rule',()=>{
 assert.match(instead(notice(true)),/disabled/);assert.ok(notice(true).includes(NOTE));
 assert.doesNotMatch(instead(notice(false)),/disabled/);assert.doesNotMatch(notice(false),/organize-folder-layout-note/);
});

test('the layout reason is translated in every language',()=>{
 for(const language of languages.filter(l=>l!=='en'))assert.notEqual(createTranslator(language)(NOTE),NOTE,language);
 assert.ok(page('video-root','ja').includes(createTranslator('ja')(NOTE)));
});
