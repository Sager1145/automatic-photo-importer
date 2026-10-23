import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '../renderer/i18n';
import {Organization} from '../renderer/RootApp';
import type {AppState,Language,Progress} from '../shared';

const source={id:'card',name:'Untitled',path:'/Volumes/Untitled',transport:'storage' as const,selected:true,total:1e12,free:2e11};
const preferences:AppState['preferences']={language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A006'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}};
const progress:Progress={phase:'planning',step:'checking',completed:10,total:100,bytes:0,totalBytes:0,speed:0,file:'a.jpg'};
const render=(language:Language,checking:boolean)=>renderToStaticMarkup(createElement(I18nProvider,{language,children:createElement(Organization,{state:{preferences:{...preferences,language},sources:[source],jobs:[],history:[],platform:'darwin',...(checking?{misplacedProgress:{'/Volumes/A006':progress}}:{})},act:()=>{},busy:false})}));

test('the destination card names the folder check while it runs, in every language',()=>{
  const expected:Record<Language,string>={en:'Checking A006 folder layout','zh-Hans':'正在检查 A006 的文件夹结构','zh-Hant':'正在檢查 A006 的資料夾結構',ja:'A006 のフォルダー構成を確認中'};
  for(const language of Object.keys(expected) as Language[]) {
    const markup=render(language,true);
    assert.match(markup,/data-step="folder-check"/);
    assert.ok(markup.includes(expected[language]),`${language} label`);
  }
  assert.ok(!render('en',false).includes('folder-check'));
});

test('the label has its own colour with enough contrast and takes no layer of its own',()=>{
  const css=fs.readFileSync(path.join(__dirname,'../renderer/styles.css'),'utf8');
  const luminance=(hex:string)=>{const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.03928?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]!+.7152*c[1]!+.0722*c[2]!;};
  const ratio=(a:string,b:string)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  const colours=[...css.matchAll(/--step-folder-check:(#[0-9a-f]{6})/g)].map(match=>match[1]!);
  assert.equal(colours.length,2);
  assert.ok(ratio(colours[0]!,'#ffffff')>=4.5&&ratio(colours[0]!,'#f5f5f7')>=4.5);
  assert.ok(ratio(colours[1]!,'#2f2f33')>=4.5&&ratio(colours[1]!,'#1c1c1e')>=4.5);
  const rule=/\.folder-check-label\{([^}]*)\}/.exec(css)?.[1]??'';
  assert.ok(rule&&!/z-index|transform|translate|animation|transition|position|will-change|filter|opacity/.test(rule),rule);
});
