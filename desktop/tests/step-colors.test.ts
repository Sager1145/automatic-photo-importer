import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '../renderer/i18n';
import {ImportDashboard,ImportDesk,PlanningProgress,SidebarSources} from '../renderer/RootApp';
import {stepKind} from '../renderer/progress';
import type {AppState,Job,Progress} from '../shared';

const preferences:AppState['preferences']={language:'en',appearance:'system',textScale:1.25,accent:'coral',automatic:false,parallel:2,destinations:['/Volumes/A006'],copyMode:'single',basePath:'photobackup',template:'{year}',mediaLayout:'flat',videoBasePath:'videobackup',videoTemplate:'',allowFolderSource:false,unknownRules:{}} as AppState['preferences'];
const card={id:'card',name:'Card',path:'/Volumes/CARD',transport:'storage' as const,selected:true,total:128e9,free:40e9};
const stateWith=(extra:Partial<AppState>):AppState=>({preferences,sources:[card],jobs:[],history:[],platform:'darwin',...extra});
const render=(node:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(I18nProvider,{language:'en',children:node}));
const renameJob=(extra:Partial<Progress>={}):Job=>({id:'r',source:{id:'library:/Volumes/A006/photobackup',name:'Existing library',path:'/Volumes/A006/photobackup',transport:'folder'},phase:'copying',errors:[],backup:false,startedAt:new Date(Date.now()-60000).toISOString(),
 progress:{phase:'copying',step:'moving',completed:29145,total:29145,bytes:0,totalBytes:539.1e9,speed:0,fileRate:85,file:'ZFC_8484.JPG',eta:5,startedAt:new Date(0).toISOString(),renames:true,...extra}});
const css=readFileSync(new URL('../renderer/styles.css',import.meta.url),'utf8');

test('each step kind has one distinct color per theme, and the progress parts carry it',()=>{
 const kinds=['scan','read','compare','copy','verify','move','tidy','delete'];
 const light=css.slice(css.indexOf(':root{'),css.indexOf(':root[data-theme=dark]{')),dark=css.slice(css.indexOf(':root[data-theme=dark]{'));
 for(const block of [light,dark]){
  const found=kinds.map(kind=>block.match(new RegExp(`--step-${kind}:(#[0-9a-f]{6})`))?.[1]);
  assert.ok(found.every(Boolean),'every kind is defined');assert.equal(new Set(found).size,kinds.length,'colors are distinct');
 }
 const steps:[Pick<Progress,'phase'|'step'|'renames'>,string][]=[[{phase:'planning',step:'listing'},'scan'],[{phase:'planning',step:'checking'},'read'],[{phase:'planning',step:'comparing'},'compare'],[{phase:'copying'},'copy'],[{phase:'verifying'},'verify'],[{phase:'copying',step:'moving',renames:true},'move'],[{phase:'copying',step:'releasing'},'tidy'],[{phase:'copying',step:'deleting'},'delete']];
 for(const [progress,kind] of steps)assert.equal(stepKind(progress),kind);
 const job=renameJob();
 assert.match(render(createElement(ImportDesk,{state:stateWith({jobs:[job]}),act:()=>{},inspect:()=>{},onOrganization:()=>{},onSettings:()=>{}})),/data-step="move"/);
 assert.match(render(createElement(SidebarSources,{state:stateWith({jobs:[job]}),onOpen:()=>{}})),/<i [^>]*data-step="verify"/);
});

test('the file name sits on its own line below the stats and never in the overall dashboard',()=>{
 const html=(file:string)=>render(createElement(PlanningProgress,{progress:{phase:'copying',step:'releasing',completed:7,total:20,bytes:0,totalBytes:0,speed:0,fileRate:12.5,file,eta:90,startedAt:new Date(0).toISOString()},label:'x'}));
 const short=html('a.jpg'),long=html('2024/'+'very-long-folder-name/'.repeat(20)+'IMG_0007.JPG');
 const line=(markup:string)=>{const start=markup.indexOf('progress-display-line');return markup.slice(start,markup.indexOf('</div>',start));};
 assert.ok(short.includes('data-testid="progress-file"')&&long.includes('data-testid="progress-file"'));
 assert.ok(!line(short).includes('progress-file')&&!line(long).includes('progress-file'),'the file is outside the stats line');
 assert.equal(line(short),line(long),'the stats line is identical for a short and a very long file name');
 assert.match(css,/\.progress-display>\.progress-file\{[^}]*width:100%[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/);
 const dashboard=render(createElement(ImportDashboard,{state:stateWith({jobs:[renameJob()]}),act:()=>{}}));
 assert.ok(!dashboard.includes('progress-file')&&!dashboard.includes('ZFC_8484'),'the overall dashboard shows no file');
});
