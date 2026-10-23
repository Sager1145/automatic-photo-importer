import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider,createTranslator,languages} from '../renderer/i18n';
import {NoMetadataNotice,groupInfo} from '../renderer/RootApp';
import type {NoMetadataSummary,Review} from '../shared';

const files=(count:number)=>Array.from({length:count},(_,index)=>({path:`/x/f${index}.png`,relative:`DCIM/f${index}.png`,reason:index%2?'noCamera' as const:'noDate' as const}));
const summary=(extra:Partial<NoMetadataSummary>={}):NoMetadataSummary=>({handling:'keep',folder:'Unknown files',count:2324,counts:{noDate:500,noCamera:1804,unreadable:20},files:files(8),...extra});
const review=(noMetadata?:NoMetadataSummary,kind:Review['kind']='reorganize'):Pick<Review,'kind'|'source'|'noMetadata'|'destinationIndex'|'collectProblemFiles'>=>({kind,source:{id:'s',name:'Card',path:'/Volumes/Card',transport:'storage'} as Review['source'],noMetadata,destinationIndex:0});
const render=(value:ReturnType<typeof review>,language:'en'|'zh-Hans'|'zh-Hant'|'ja'='en',open=false)=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(NoMetadataNotice,{review:value,act:()=>{},defaultOpen:open})}));

test('the prompt shows the count, the count per reason and its three buttons as a warning',()=>{
  const html=render(review(summary()));
  assert.match(html,/2,324 unknown files will be left where they are\./);
  assert.match(html,/500 without a date, 1,804 without a camera, 20 unreadable/);
  for(const label of ['Show files','Use file date instead','Continue'])assert.match(html,new RegExp(`>${label}<`));
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
    assert.doesNotMatch(html,/Show files|Use file date instead|without a date|unknown files will/,language);
  }
  const t=(language:typeof languages[number])=>createTranslator(language);
  for(const language of languages.filter(item=>item!=='en')){
    for(const key of ['Show files','Use file date instead','{count} without a camera','Files with unknown metadata','Unknown files folder name','Leave where they are','Move to a folder','Use file date'])assert.notEqual(t(language)(key,{count:1}),key.replace('{count}','1'),`${language}: ${key}`);
  }
  const info=(code:string)=>groupInfo(code,3,'Card',createTranslator('ja'),String);
  assert.match(info('kept-no-metadata').title,/3/);assert.notEqual(info('kept-no-metadata').title,'3 issues need attention');
  assert.match(info('filed-no-metadata').title,/3/);
});

test('the setting control exists in Settings and the prompt layers below error layers',()=>{
  const source=readFileSync(new URL('../renderer/RootApp.tsx',import.meta.url),'utf8');
  assert.match(source,/<NoMetadataSettings preferences=\{p\}/);
  const css=readFileSync(new URL('../renderer/styles.css',import.meta.url),'utf8');
  const block=css.match(/\.no-metadata-notice\{[^}]*\}/)![0];
  assert.doesNotMatch(block,/z-index|position:(fixed|absolute)/);
});
