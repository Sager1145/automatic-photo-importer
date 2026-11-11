import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserPage} from '../renderer/browser/BrowserPage';
import type {BrowserAPI} from '../renderer/browser/api';
import {createBlock,defaultConfiguration} from '../renderer/browser/configuration';
import {I18nProvider} from '../renderer/i18n';
import type {CatalogLibrary,CatalogQuery,CatalogStatus} from '../catalog/types';

declare global {interface Window {browserDOMResult?:{passed:boolean;checks:{name:string;passed:boolean;error?:string}[]};}}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
async function until(predicate:()=>boolean,message:string){for(let attempt=0;attempt<100;attempt++){if(predicate())return;await delay(10);}throw new Error(message);}
const library:CatalogLibrary={libraryId:'l',volumeId:'v',trustedVolumeId:true,name:'Test library',relativeRoot:'photos',role:'photos',online:false,rulesScope:'r',revision:1};
const status:CatalogStatus={libraryId:'l',online:false,revision:1,dirty:false,state:'idle',total:202,checked:0,misplaced:0,unclassifiable:0,unchecked:202,progress:{discovered:202,read:202,failed:0}};
async function mount(){
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const configuration={...defaultConfiguration(),blocks:[createBlock('camera')]};let latest:CatalogQuery|undefined;
 const api:BrowserAPI={catalogStatus:async()=>status,catalogQuery:async query=>{latest=query;await delay(30);return {rows:[],total:0,revision:1};},catalogDirectories:async()=>({rows:[],revision:1}),catalogFacets:async(query,field)=>{await delay(30);return {field,rows:(query.cursor?[201,202]:Array.from({length:200},(_,i)=>i+1)).map(i=>({value:`Camera ${i}`,label:`Camera ${i}`,count:1})),nextCursor:query.cursor?undefined:'second',revision:1,total:202,knownCount:202,missingCount:0,pendingCount:0,errorCount:0};},catalogResolve:async()=>{throw new Error('No file in this fixture');},thumbnail:async()=>({via:'none'}),summary:async()=>({fields:{}}),exif:async()=>({fields:{}})};
 const render=(revision=1)=>root.render(createElement(I18nProvider,{language:'en',children:createElement(BrowserPage,{libraries:[library],statuses:{l:{...status,revision}},configuration,onConfiguration:()=>{},api,onRefresh:()=>{},onStop:()=>{},onOrganization:()=>{},onReveal:()=>{}})}));render();
 const column=()=>host.querySelector<HTMLElement>('[data-testid=facet-column]')!;
 const list=()=>column()?.querySelector<HTMLElement>('[role=listbox]')!;
 const row=(label:string)=>[...(column()?.querySelectorAll<HTMLElement>('[role=option]')??[])].find(node=>node.querySelector('span')?.textContent===label)!;
 /** A row's checkbox. */
 const box=(label:string)=>row(label).querySelector<HTMLInputElement>('[data-testid=row-check]')!;
 const master=()=>column().querySelector<HTMLInputElement>('[data-testid=column-check-all]')!;
 const click=(node:HTMLElement,options:MouseEventInit={})=>node.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,...options}));
 const key=(name:string,options:KeyboardEventInit={})=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:name,bubbles:true,...options}));
 const scrollTo=(top:number)=>{const node=list();node.scrollTop=top;node.dispatchEvent(new Event('scroll',{bubbles:true}));};
 /** What the files are filtered by, in any order: the column's checked rows and its picked row. */
 const values=()=>JSON.stringify((latest?.filters.flatMap(filter=>filter.kind==='values'?filter.values.map(String):[])??[]).sort());
 const picked=(label:string)=>row(label)?.getAttribute('data-picked')==='true';
 await until(()=>!!row('Camera 1')&&list().getAttribute('aria-busy')==='false','Initial delayed facets did not render');
 // The fixture has no stylesheet: give the list the bounded, scrolling box the app's CSS gives it.
 Object.assign(list().style,{height:'336px',overflowY:'auto'});
 return {host,column,list,row,box,master,click,key,values,picked,render,scrollTo,dispose:()=>{root.unmount();host.remove();}};
}
const checks:{name:string;passed:boolean;error?:string}[]=[];
async function run(name:string,body:()=>Promise<void>){try{await body();checks.push({name,passed:true});}catch(error){checks.push({name,passed:false,error:String(error)});}}
const sorted=(...labels:string[])=>JSON.stringify(labels.sort());
void (async()=>{
 await run('checked rows on two pages stay checked, and each unchecks on its own',async()=>{const ui=await mount();try{
  ui.box('Camera 1').click();await delay(100);check(ui.values()===sorted('Camera 1'),`First-page check missing: ${ui.values()}`);
  ui.scrollTo(ui.list().scrollHeight);await until(()=>!!ui.row('Camera 201'),'Second facet page not appended');
  ui.click(ui.row('Camera 201'),{ctrlKey:true});await delay(100);check(ui.values()===sorted('Camera 1','Camera 201'),`Hidden check lost: ${ui.values()}`);
  ui.scrollTo(0);await until(()=>!!ui.row('Camera 1'),'First rows not rendered after scrolling back');
  check(ui.box('Camera 1').checked,'The first-page checkbox is not checked after scrolling back');
  ui.box('Camera 1').click();await delay(100);check(ui.values()===sorted('Camera 201'),`Unchecking lost the second-page value: ${ui.values()}`);
 }finally{ui.dispose();}});
 await run('a click picks a row and the next click moves it; a checkbox checks a row until it is unchecked',async()=>{const ui=await mount();try{
  ui.click(ui.row('Camera 1'));await delay(100);check(ui.values()===sorted('Camera 1'),`Click did not pick: ${ui.values()}`);
  check(ui.picked('Camera 1')&&ui.row('Camera 1').getAttribute('aria-selected')==='true'&&!ui.box('Camera 1').checked,'A picked row is shown chosen, unchecked');
  ui.click(ui.row('Camera 2'));await delay(100);check(ui.values()===sorted('Camera 2')&&!ui.picked('Camera 1')&&ui.picked('Camera 2'),`The next click did not move the pick: ${ui.values()}`);
  ui.box('Camera 3').click();await delay(100);check(ui.values()===sorted('Camera 2','Camera 3'),`A check dropped the pick: ${ui.values()}`);check(!ui.picked('Camera 3')&&ui.picked('Camera 2'),'The checkbox picked its row');
  ui.click(ui.row('Camera 4'));await delay(100);check(ui.values()===sorted('Camera 3','Camera 4'),`A click dropped the check: ${ui.values()}`);check(ui.box('Camera 3').checked,'The checked row lost its checkbox');
  const header=ui.column().querySelector('header small')!;check(header.textContent!.startsWith('2/')&&header.getAttribute('title')==='2 selected',`Column header count: ${header.textContent}`);
  const bar=ui.host.querySelector('[data-testid=browser-selection]')?.textContent??'';check(bar.includes('Camera 3')&&bar.includes('Camera 4'),`Selection bar: ${bar}`);
  ui.click(ui.row('Camera 4'));await delay(100);check(ui.values()===sorted('Camera 3')&&!ui.picked('Camera 4'),`A second click did not drop the pick: ${ui.values()}`);
  ui.click(ui.row('Camera 5'),{ctrlKey:true});await delay(100);check(ui.values()===sorted('Camera 3','Camera 5')&&ui.box('Camera 5').checked,`Ctrl-click did not check: ${ui.values()}`);
  ui.box('Camera 5').click();await delay(100);check(ui.values()===sorted('Camera 3')&&!ui.box('Camera 5').checked,`The checkbox did not uncheck: ${ui.values()}`);
  ui.click(ui.row('Camera 7'),{shiftKey:true});await delay(100);check(ui.values()===sorted('Camera 3','Camera 5','Camera 6','Camera 7'),`Shift range: ${ui.values()}`);
  ui.click(ui.row('Camera 9'));await delay(100);ui.box('Camera 9').click();await delay(100);
  check(ui.box('Camera 9').checked&&!ui.picked('Camera 9'),'Checking the picked row did not lock it');check(ui.values()===sorted('Camera 3','Camera 5','Camera 6','Camera 7','Camera 9'),`After locking the pick: ${ui.values()}`);
 }finally{ui.dispose();}});
 await run('the column checkbox reads every page and checks each row; checked or half set, it clears the column',async()=>{const ui=await mount();try{
  check(!ui.master().checked&&!ui.master().indeterminate&&!ui.master().disabled,'Initial column checkbox');
  ui.click(ui.row('Camera 5'));await delay(100);check(!ui.master().checked&&!ui.master().indeterminate,'A pick alone sets the column checkbox');
  ui.master().click();await until(()=>JSON.parse(ui.values()).length===202,`Checking every row chose ${JSON.parse(ui.values()).length}`);await delay(50);
  check(ui.master().checked&&!ui.master().indeterminate,'The column checkbox is not checked after checking every row');check(ui.row('Camera 1')?.getAttribute('aria-selected')==='true'&&ui.box('Camera 1').checked,'Rows not shown checked');check(!ui.picked('Camera 5'),'The pick stayed although its row is checked');
  ui.master().click();await until(()=>JSON.parse(ui.values()).length===0,'Clearing the column left values');await delay(50);check(!ui.master().checked&&!ui.master().indeterminate,'Column checkbox after clearing');
  ui.box('Camera 2').click();ui.click(ui.row('Camera 8'));await delay(100);check(ui.master().indeterminate&&!ui.master().checked,'Some rows checked: the column checkbox is not half set');
  ui.master().click();await until(()=>JSON.parse(ui.values()).length===0,`Clearing a half-set column left ${ui.values()}`);check(!ui.picked('Camera 8'),'Clearing kept the pick');
  const files=ui.host.querySelector('[data-testid=browser-files]')!;check(!!files.querySelector('[data-testid=column-check-all]')&&!!files.querySelector('[data-testid=lightroom-drag]'),'The files lack their checkbox or the Lightroom drag handle');
 }finally{ui.dispose();}});
 await run('arrow keys move the pick and survive delayed responses without refocus; Space checks, Enter picks, Escape clears',async()=>{const ui=await mount();try{
  const list=ui.list();list.focus();ui.key('ArrowDown');await delay(100);
  check(document.activeElement===list&&ui.list()===list,`Focused list replaced after first response: ${document.activeElement?.tagName}`);
  ui.key('ArrowDown');await delay(100);
  check(document.activeElement===list,'Focus lost after second response');check(ui.values()===sorted('Camera 3'),`Second ArrowDown did not move the pick: ${ui.values()}`);
  const active=list.getAttribute('aria-activedescendant');check(active&&document.getElementById(active)&&list.contains(document.getElementById(active)),'Active descendant is missing from the live list');
  ui.box('Camera 1').click();await delay(100);ui.key('ArrowDown');await delay(100);check(ui.values()===sorted('Camera 1','Camera 2'),`ArrowDown after a check: ${ui.values()}`);
  ui.key('ArrowDown',{ctrlKey:true});await delay(100);check(ui.values()===sorted('Camera 1','Camera 2'),`Ctrl+ArrowDown moved the pick: ${ui.values()}`);
  ui.key('Enter');await delay(100);check(ui.values()===sorted('Camera 1','Camera 3')&&ui.picked('Camera 3'),`Enter did not pick the cursor row: ${ui.values()}`);
  ui.key(' ');await delay(100);check(ui.box('Camera 3').checked&&!ui.picked('Camera 3')&&ui.values()===sorted('Camera 1','Camera 3'),`Space did not check the cursor row: ${ui.values()}`);
  ui.key('ArrowDown',{shiftKey:true});await delay(100);check(ui.box('Camera 4').checked&&ui.values()===sorted('Camera 1','Camera 3','Camera 4'),`Shift+ArrowDown did not check: ${ui.values()}`);
  ui.key('Escape');await delay(100);check(ui.values()===sorted(),`Escape left ${ui.values()}`);
 }finally{ui.dispose();}});
 await run('appending the next page keeps the scroll position and the listbox',async()=>{const ui=await mount();try{
  const list=ui.list();list.focus();ui.scrollTo(list.scrollHeight);const top=list.scrollTop;check(top>0,'Fixture list did not scroll');
  await until(()=>!!ui.row('Camera 202'),'Second page not appended');await delay(20);
  check(ui.list()===list,'Appending replaced listbox identity');check(list.scrollTop===top,`Appending moved the scroll position: ${top} -> ${list.scrollTop}`);
 }finally{ui.dispose();}});
 await run('a revision refresh keeps the scroll position, the pick and the checks',async()=>{const ui=await mount();try{
  ui.scrollTo(480);await until(()=>!!ui.row('Camera 12'),'Scrolled rows not rendered');ui.click(ui.row('Camera 12'));ui.box('Camera 13').click();await delay(100);
  ui.render(2);await delay(150);
  check(ui.list().scrollTop===480,`Refresh moved the scroll position: ${ui.list().scrollTop}`);check(ui.picked('Camera 12')&&ui.row('Camera 12').getAttribute('aria-selected')==='true','Refresh lost the pick');check(ui.box('Camera 13').checked,'Refresh lost the check');
 }finally{ui.dispose();}});
 await run('a focused listbox remains mounted throughout a delayed revision refresh',async()=>{const ui=await mount();try{
  const list=ui.list();list.focus();ui.render(2);await delay(5);check(ui.list()===list&&document.activeElement===list,'Refresh replaced the focused list while loading');
  await delay(100);check(ui.list()===list&&document.activeElement===list,'Refresh replaced the focused list after the response');
  const active=list.getAttribute('aria-activedescendant');check(active&&!!document.getElementById(active),'Refresh left a stale active descendant');
 }finally{ui.dispose();}});
 await run('delayed refresh does not steal focus from a text editor',async()=>{const ui=await mount();try{
  ui.render(2);await delay(5);const search=ui.host.querySelector<HTMLInputElement>('.browser-search input')!;search.focus();await delay(100);check(document.activeElement===search,'Refresh stole focus from search');
 }finally{ui.dispose();}});
 window.browserDOMResult={passed:checks.every(item=>item.passed),checks};
})();
