import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserPage,type BrowserAPI} from '../renderer/browser/BrowserPage';
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
 const scrollTo=(top:number)=>{const node=list();node.scrollTop=top;node.dispatchEvent(new Event('scroll',{bubbles:true}));};
 const button=(label:string)=>[...(column()?.querySelectorAll<HTMLButtonElement>('button')??[])].find(node=>node.textContent===label)!;
 const values=()=>latest?.filters.flatMap(filter=>filter.kind==='values'?filter.values:[])??[];
 await until(()=>!!row('Camera 1')&&list().getAttribute('aria-busy')==='false','Initial delayed facets did not render');
 // The fixture has no stylesheet: give the list the bounded, scrolling box the app's CSS gives it.
 Object.assign(list().style,{height:'336px',overflowY:'auto'});
 return {host,column,list,row,button,values,render,scrollTo,dispose:()=>{root.unmount();host.remove();}};
}
const checks:{name:string;passed:boolean;error?:string}[]=[];
async function run(name:string,body:()=>Promise<void>){try{await body();checks.push({name,passed:true});}catch(error){checks.push({name,passed:false,error:String(error)});}}
void (async()=>{
 await run('cross-page OR selection retains hidden choices and toggles them independently',async()=>{const ui=await mount();try{
  ui.row('Camera 1').dispatchEvent(new MouseEvent('click',{bubbles:true}));await delay(100);check(JSON.stringify(ui.values())==='["Camera 1"]','First-page selection missing');
  ui.scrollTo(ui.list().scrollHeight);await until(()=>!!ui.row('Camera 201'),'Second facet page not appended');
  ui.row('Camera 201').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));await delay(100);check(JSON.stringify(ui.values())==='["Camera 1","Camera 201"]',`Hidden selection lost: ${JSON.stringify(ui.values())}`);
  ui.scrollTo(0);await until(()=>!!ui.row('Camera 1'),'First rows not rendered after scrolling back');
  ui.row('Camera 1').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));await delay(100);check(JSON.stringify(ui.values())==='["Camera 201"]',`Toggle lost hidden second-page value: ${JSON.stringify(ui.values())}`);
 }finally{ui.dispose();}});
 await run('continuous ArrowDown survives delayed responses without refocus',async()=>{const ui=await mount();try{
  const list=ui.list();list.focus();list.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));await delay(100);
  check(document.activeElement===list&&ui.list()===list,`Focused list replaced after first response: ${document.activeElement?.tagName}`);
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));await delay(100);
  check(document.activeElement===list,'Focus lost after second response');check(JSON.stringify(ui.values())==='["Camera 3"]',`Second ArrowDown did not advance: ${JSON.stringify(ui.values())}`);
  const active=list.getAttribute('aria-activedescendant');check(active&&document.getElementById(active)&&list.contains(document.getElementById(active)),'Active descendant is missing from the live list');
 }finally{ui.dispose();}});
 await run('appending the next page keeps the scroll position and the listbox',async()=>{const ui=await mount();try{
  const list=ui.list();list.focus();ui.scrollTo(list.scrollHeight);const top=list.scrollTop;check(top>0,'Fixture list did not scroll');
  await until(()=>!!ui.row('Camera 202'),'Second page not appended');await delay(20);
  check(ui.list()===list,'Appending replaced listbox identity');check(list.scrollTop===top,`Appending moved the scroll position: ${top} -> ${list.scrollTop}`);
 }finally{ui.dispose();}});
 await run('a revision refresh keeps the scroll position and the selection',async()=>{const ui=await mount();try{
  ui.scrollTo(480);await until(()=>!!ui.row('Camera 12'),'Scrolled rows not rendered');ui.row('Camera 12').dispatchEvent(new MouseEvent('click',{bubbles:true}));await delay(100);
  ui.render(2);await delay(150);
  check(ui.list().scrollTop===480,`Refresh moved the scroll position: ${ui.list().scrollTop}`);check(ui.row('Camera 12')?.getAttribute('aria-selected')==='true','Refresh lost the selection');
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
