import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider,createTranslator,languages} from '../renderer/i18n';
import {NoMetadataNotice,NoMetadataSettings,groupInfo,noMetadataChoiceAction} from '../renderer/RootApp';
import {defaultPreferences} from '../preferences';
import type {NoMetadataSummary,Review} from '../shared';

const files=(count:number)=>Array.from({length:count},(_,index)=>({path:`/x/f${index}.png`,relative:`DCIM/f${index}.png`,reason:index%2?'noCamera' as const:'noDate' as const}));
const summary=(extra:Partial<NoMetadataSummary>={}):NoMetadataSummary=>({handling:'keep',folder:'Unknown files',count:2324,counts:{noDate:500,noCamera:1804,unreadable:20},files:files(8),...extra});
const review=(noMetadata?:NoMetadataSummary,kind:Review['kind']='reorganize'):Pick<Review,'kind'|'source'|'noMetadata'|'destinationIndex'|'collectProblemFiles'|'noMetadataHandling'|'fileDated'>=>({kind,source:{id:'s',name:'Card',path:'/Volumes/Card',transport:'storage'} as Review['source'],noMetadata,destinationIndex:0});
const render=(value:ReturnType<typeof review>,language:'en'|'zh-Hans'|'zh-Hant'|'ja'='en',open=false)=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(NoMetadataNotice,{review:value,act:()=>{},defaultOpen:open})}));

test('the prompt shows the count, the count per reason and its two buttons as a warning, with no apply of its own',()=>{
  const html=render(review(summary()));
  assert.match(html,/2,324 unknown files will be left where they are\./);
  assert.match(html,/500 without a date, 1,804 without a camera, 20 unreadable/);
  for(const label of ['Show files','Move to Unknown files','Leave where they are','Use file date'])assert.match(html,new RegExp(`>${label}<`));
  assert.doesNotMatch(html,/>Continue</);
  assert.match(html,/class="no-metadata-notice"/);assert.doesNotMatch(html,/error/i);
  assert.match(html,/data-testid="no-metadata-notice"/);
});

test('the wording follows the choice and the kind of job',()=>{
  assert.match(render(review(summary({handling:'folder',folder:'Not dated'}))),/will be moved to Not dated\./);
  assert.match(render(review(summary({handling:'folder',folder:'Not dated'}),'import')),/will be copied to Not dated\./);
  assert.match(render(review(summary(),'import')),/will not be copied; they stay on the source\./);
  assert.match(render(review(summary({counts:{noDate:3,noCamera:0,unreadable:0},count:3}))),/3 without a date</);
  assert.equal(render(review(undefined)),'');
});

test('the file list is virtualized and capped',()=>{
  const html=render(review(summary({files:files(5000),count:7000})),'en',true);
  const rows=html.match(/role="listitem"/g)?.length??0;
  assert.ok(rows>0&&rows<40,`only the visible rows are drawn (${rows})`);
  assert.match(html,/DCIM\/f0\.png/);assert.doesNotMatch(html,/DCIM\/f4999\.png/);
  assert.match(html,/and 2,000 more/);
});

test('the prompt and the warning groups are translated in all four languages',()=>{
  for(const language of languages.filter(item=>item!=='en')){
    const html=render(review(summary()),language);
    assert.doesNotMatch(html,/Show files|Move to|Use file date|without a date|unknown files will/,language);
  }
  const t=(language:typeof languages[number])=>createTranslator(language);
  for(const language of languages.filter(item=>item!=='en')){
    for(const key of ['Show files','Move to {folder}','What to do with these files','{count} unknown files will be filed by their file date.','{count} without a camera','Files with unknown metadata','Unknown files folder name','Leave where they are','Move to a folder','Use file date'])assert.notEqual(t(language)(key,{count:1}),key.replace('{count}','1'),`${language}: ${key}`);
  }
  const info=(code:string)=>groupInfo(code,3,'Card',createTranslator('ja'),String);
  assert.match(info('kept-no-metadata').title,/3/);assert.notEqual(info('kept-no-metadata').title,'3 issues need attention');
  assert.match(info('filed-no-metadata').title,/3/);
});

test('the Settings control renders its three choices and folder name in every language',()=>{
  const settings=(language:'en'|'zh-Hans'|'zh-Hant'|'ja',folder?:string)=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(NoMetadataSettings,{preferences:{...defaultPreferences,...(folder?{noMetadataFolder:folder}:{})},act:()=>{}})}));
  const html=settings('en');
  for(const label of ['Leave where they are','Move to a folder','Use file date','Unknown files folder name'])assert.match(html,new RegExp(label));
  assert.match(html,/aria-pressed="true">Move to a folder/);assert.match(html,/value="Unknown files"/);assert.doesNotMatch(html,/no-metadata-folder-error/);
  assert.match(settings('en','2024'),/data-testid="no-metadata-folder-error"/);
  for(const language of languages.filter(item=>item!=='en'))assert.doesNotMatch(settings(language),/Leave where they are|Move to a folder|Unknown files folder name/,language);
});

test('the prompt layers below error layers',()=>{
  const css=readFileSync(new URL('../renderer/styles.css',import.meta.url),'utf8');
  const block=css.match(/\.no-metadata-notice\{[^}]*\}/)![0];
  assert.doesNotMatch(block,/z-index|position:(fixed|absolute)/);
});

test('the notice offers three choices for this review, marks the active one and dispatches reviewNoMetadata',()=>{
  const pressed=(html:string)=>[...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)].filter(item=>/Move to|Copy to|Leave where|Use file date/.test(item[2]!)).map(item=>`${item[1]}:${item[2]}`);
  assert.deepEqual(pressed(render(review(summary({handling:'folder',folder:'Not dated'})))),['true:Move to Not dated','false:Leave where they are','false:Use file date']);
  assert.deepEqual(pressed(render(review(summary()))),['false:Move to Unknown files','true:Leave where they are','false:Use file date']);
  assert.deepEqual(pressed(render(review(summary(),'import'))),['false:Copy to Unknown files','true:Leave where they are','false:Use file date']);
  assert.deepEqual(pressed(render({...review(undefined),fileDated:summary(),noMetadataHandling:'fileDate'})),['false:Move to Unknown files','false:Leave where they are','true:Use file date']);
  assert.match(render({...review(undefined),fileDated:summary(),noMetadataHandling:'fileDate'}),/2,324 unknown files will be filed by their file date\./);
  assert.match(render({...review(summary(),'import'),noMetadataHandling:'folder'}),/aria-pressed="true">Copy to Unknown files/);
  for(const handling of ['folder','keep','fileDate'] as const)assert.deepEqual(noMetadataChoiceAction(handling),{type:'reviewNoMetadata',handling});
  const source=readFileSync(new URL('../renderer/RootApp.tsx',import.meta.url),'utf8');
  assert.match(source,/noMetadataChoiceAction\(choice\.handling\)/);assert.doesNotMatch(source,/type: 'reviewFileDate'/);
});
