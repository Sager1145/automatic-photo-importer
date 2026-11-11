import type {CatalogQuery,Filter,PlacementStatus} from '../../catalog/types';
import {fieldForBlock,type HierarchyBlock} from './configuration';
import {filterIncludes,unionFilters} from './selection';
export {selectionFilter} from './selection';
/** Files checked in the Files column: the listed ids, or with `all` every file the columns show except the listed ids. */
export interface FileSelection {all:boolean;ids:string[];}
export const noFiles:FileSelection={all:false,ids:[]};
/** `selections` are each column's checked rows, which stay until unchecked; `picks` the one row clicked in a column, which
 * the next click in that column replaces. A column shows and filters by both. */
export interface BrowserLocation {libraryId:string;mode:'folders'|'categories';selections:Record<string,Filter>;picks:Record<string,Filter>;folders:string[];/** The file clicked: the preview shows it, and it counts as chosen with the checked files. */selectedFile?:string;files:FileSelection;placement?:PlacementStatus;}
export interface BrowserState extends BrowserLocation {blocks:HierarchyBlock[];sort:CatalogQuery['sort'];width:number;nameContains:string;combinePairs:boolean;past:BrowserLocation[];future:BrowserLocation[];}
export type BrowserAction={type:'library';libraryId:string}|{type:'mode';mode:BrowserLocation['mode']}|{type:'blocks';blocks:HierarchyBlock[]}|/** A column's checked rows; without a filter the column is cleared, its click too unless `keepPick` (the last checked row unchecked). */{type:'select';blockId:string;filter?:Filter;keepPick?:boolean}|/** The row clicked in a column (one row's filter), or none. */{type:'pick';blockId:string;filter?:Filter}|{type:'folder';depth:number;path:string}|/** The file clicked: shown in the preview; the same file again lets it go. */{type:'file';fileId?:string}|{type:'preview';fileId?:string}|{type:'toggleFile';fileId:string}|{type:'addFiles';fileIds:string[]}|{type:'allFiles';select:boolean}|{type:'placement';status?:PlacementStatus}|{type:'sort';sort:CatalogQuery['sort']}|{type:'width';width:number}|{type:'search';value:string}|{type:'pairs';combine:boolean}|{type:'back'|'forward'|'clear'};
export function initialBrowserState(blocks:HierarchyBlock[]):BrowserState{return {blocks,libraryId:'',mode:'categories',selections:{},picks:{},folders:[],files:noFiles,sort:{field:'name',direction:'asc'},width:220,nameContains:'',combinePairs:true,past:[],future:[]};}
function location(s:BrowserState):BrowserLocation {return {libraryId:s.libraryId,mode:s.mode,selections:s.selections,picks:s.picks,folders:s.folders,selectedFile:s.selectedFile,files:s.files,placement:s.placement};}
/** The checks and clicks of the columns before `blockId`; a change in a column drops those of the columns after it. */
function before(s:BrowserState,blockId:string){const index=s.blocks.findIndex(b=>b.id===blockId);const keep=new Set(s.blocks.slice(0,index).map(b=>b.id));const only=(record:Record<string,Filter>)=>Object.fromEntries(Object.entries(record).filter(([id])=>keep.has(id)));return {selections:only(s.selections),picks:only(s.picks)};}
export function browserReducer(s:BrowserState,a:BrowserAction):BrowserState {
 if(a.type==='sort')return {...s,sort:a.sort};if(a.type==='width')return {...s,width:Math.max(180,Math.min(420,a.width))};if(a.type==='preview')return {...s,selectedFile:a.fileId};
 // A click on a file only shows it (and counts it as chosen); clicking it again lets it go. Checking files never moves the preview.
 if(a.type==='file')return {...s,selectedFile:a.fileId===s.selectedFile?undefined:a.fileId};
 if(a.type==='toggleFile'){const ids=s.files.ids.includes(a.fileId)?s.files.ids.filter(id=>id!==a.fileId):[...s.files.ids,a.fileId];return {...s,files:{all:s.files.all,ids}};}
 if(a.type==='addFiles'){const files=s.files.all?{all:true,ids:s.files.ids.filter(id=>!a.fileIds.includes(id))}:{all:false,ids:[...new Set([...s.files.ids,...a.fileIds])]};return {...s,files};}
 if(a.type==='allFiles')return {...s,files:a.select?{all:true,ids:[]}:noFiles,selectedFile:undefined};
 if(a.type==='search')return {...s,nameContains:a.value,selectedFile:undefined,files:noFiles};if(a.type==='pairs')return {...s,combinePairs:a.combine};
 if(a.type==='back'){const prev=s.past.at(-1);return prev?{...s,...prev,past:s.past.slice(0,-1),future:[location(s),...s.future]}:s;}
 if(a.type==='forward'){const next=s.future[0];return next?{...s,...next,past:[...s.past,location(s)],future:s.future.slice(1)}:s;}
 // Reordering or editing the hierarchy keeps each check and click whose block still groups by the same field; every column is narrowed by the choices in the columns before it, whatever their order.
 if(a.type==='blocks'){const valid=(record:Record<string,Filter>)=>Object.fromEntries(Object.entries(record).filter(([id,filter])=>{const block=a.blocks.find(b=>b.id===id);return !!block&&(filter.kind==='placement'||filter.field===fieldForBlock(block));}));const selections=valid(s.selections),picks=valid(s.picks);const kept=Object.keys(selections).length===Object.keys(s.selections).length&&Object.keys(picks).length===Object.keys(s.picks).length;return {...s,blocks:a.blocks,selections,picks,selectedFile:kept?s.selectedFile:undefined,files:kept?s.files:noFiles,past:[],future:[]};}
 let patch:Partial<BrowserLocation>={selectedFile:undefined,files:noFiles};
 if(a.type==='library')patch={...patch,libraryId:a.libraryId,selections:{},picks:{},folders:[]};
 if(a.type==='mode')patch={...patch,mode:a.mode,selections:{},picks:{},folders:[]};
 if(a.type==='clear')patch={...patch,selections:{},picks:{},folders:[],placement:undefined};
 if(a.type==='placement')patch={...patch,placement:a.status};
 if(a.type==='folder')patch={...patch,folders:[...s.folders.slice(0,a.depth),a.path]};
 // Checking the clicked row keeps it as a checked row only; other checks leave the click as it is. One action, one step back.
 if(a.type==='select'){const {selections,picks}=before(s,a.blockId);const pick=s.picks[a.blockId];if(a.filter)selections[a.blockId]=a.filter;if(pick&&(a.filter||a.keepPick)&&!filterIncludes(a.filter,pick))picks[a.blockId]=pick;patch={...patch,selections,picks};}
 if(a.type==='pick'){const {selections,picks}=before(s,a.blockId);const checked=s.selections[a.blockId];if(checked)selections[a.blockId]=checked;if(a.filter)picks[a.blockId]=a.filter;patch={...patch,selections,picks};}
 return {...s,...patch,past:[...s.past.slice(-49),location(s)],future:[]};
}
/** What each column filters by: its checked rows and its clicked row together. */
export function effectiveSelections(s:Pick<BrowserState,'blocks'|'selections'|'picks'>):Record<string,Filter> {const result={...s.selections};for(const [id,pick] of Object.entries(s.picks)){const block=s.blocks.find(b=>b.id===id);result[id]=(block?unionFilters(block,result[id],pick):pick)??pick;}return result;}
/** The files chosen: the checked files and the clicked one (with `all`, a clicked file that was unchecked counts again). */
export function effectiveFiles(s:Pick<BrowserLocation,'files'|'selectedFile'>):FileSelection {const file=s.selectedFile;if(!file||fileSelected(s.files,file))return s.files;return s.files.all?{all:true,ids:s.files.ids.filter(id=>id!==file)}:{all:false,ids:[...s.files.ids,file]};}
export function queryFor(s:BrowserState,depth?:number):CatalogQuery {const blocks=depth===undefined?s.blocks:s.blocks.slice(0,depth+1);const chosen=effectiveSelections(s);return {libraryId:s.libraryId,filters:[...(s.mode==='categories'?blocks.flatMap(b=>chosen[b.id]?[chosen[b.id]!]:[]):[]),...(s.placement?[{kind:'placement' as const,status:s.placement}]:[])],...(s.mode==='folders'?{parentPath:s.folders.at(-1)??''}:{}),sort:s.sort,limit:200,...(depth!==undefined?{facetBlockId:s.blocks[depth]?.id}:{}),...(s.nameContains?{nameContains:s.nameContains}:{}),...(s.combinePairs?{combinePairs:true}:{})};}
export function fileSelected(selection:FileSelection,fileId:string):boolean {return selection.all!==selection.ids.includes(fileId);}
/** How many files the selection holds when the columns show `total`; none chosen is zero. */
export function fileSelectionCount(selection:FileSelection,total:number):number {return selection.all?Math.max(0,total-selection.ids.length):selection.ids.length;}
export class LatestRequest {private generation=0;begin(){return ++this.generation;}isCurrent(token:number){return token===this.generation;}cancel(){this.generation++;}}
export function keyboardIntent(key:string,editing:boolean,index:number,length:number):number|undefined {if(editing||length===0)return undefined;if(key==='ArrowDown')return Math.min(length-1,index+1);if(key==='ArrowUp')return Math.max(0,index-1);if(key==='Home')return 0;if(key==='End')return length-1;return undefined;}
export function virtualWindow(length:number,scrollTop:number,height:number,rowHeight:number){const start=Math.max(0,Math.floor(scrollTop/rowHeight)-2),end=Math.min(length,Math.ceil((scrollTop+height)/rowHeight)+2);return {start,end,paddingTop:start*rowHeight,paddingBottom:Math.max(0,(length-end)*rowHeight)};}
