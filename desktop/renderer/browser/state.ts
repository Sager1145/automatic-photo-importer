import type {CatalogQuery,Filter,PlacementStatus} from '../../catalog/types';
import {fieldForBlock,type HierarchyBlock} from './configuration';
export interface BrowserLocation {libraryId:string;mode:'folders'|'categories';selections:Record<string,Filter>;folders:string[];selectedFile?:string;placement?:PlacementStatus;}
export interface BrowserState extends BrowserLocation {blocks:HierarchyBlock[];sort:CatalogQuery['sort'];width:number;nameContains:string;past:BrowserLocation[];future:BrowserLocation[];}
export type BrowserAction={type:'library';libraryId:string}|{type:'mode';mode:BrowserLocation['mode']}|{type:'blocks';blocks:HierarchyBlock[]}|{type:'select';blockId:string;filter?:Filter}|{type:'folder';depth:number;path:string}|{type:'file';fileId?:string}|{type:'placement';status?:PlacementStatus}|{type:'sort';sort:CatalogQuery['sort']}|{type:'width';width:number}|{type:'search';value:string}|{type:'back'|'forward'|'clear'};
export function initialBrowserState(blocks:HierarchyBlock[]):BrowserState{return {blocks,libraryId:'',mode:'categories',selections:{},folders:[],sort:{field:'name',direction:'asc'},width:220,nameContains:'',past:[],future:[]};}
function location(s:BrowserState):BrowserLocation {return {libraryId:s.libraryId,mode:s.mode,selections:s.selections,folders:s.folders,selectedFile:s.selectedFile,placement:s.placement};}
export function browserReducer(s:BrowserState,a:BrowserAction):BrowserState {
 if(a.type==='sort')return {...s,sort:a.sort};if(a.type==='width')return {...s,width:Math.max(180,Math.min(420,a.width))};if(a.type==='file')return {...s,selectedFile:a.fileId};if(a.type==='search')return {...s,nameContains:a.value,selectedFile:undefined};
 if(a.type==='back'){const prev=s.past.at(-1);return prev?{...s,...prev,past:s.past.slice(0,-1),future:[location(s),...s.future]}:s;}
 if(a.type==='forward'){const next=s.future[0];return next?{...s,...next,past:[...s.past,location(s)],future:s.future.slice(1)}:s;}
 if(a.type==='blocks')return {...s,blocks:a.blocks,selections:{},selectedFile:undefined,past:[],future:[]};
 let patch:Partial<BrowserLocation>={selectedFile:undefined};
 if(a.type==='library')patch={...patch,libraryId:a.libraryId,selections:{},folders:[]};
 if(a.type==='mode')patch={...patch,mode:a.mode,selections:{},folders:[]};
 if(a.type==='clear')patch={...patch,selections:{},folders:[],placement:undefined};
 if(a.type==='placement')patch={...patch,placement:a.status};
 if(a.type==='folder')patch={...patch,folders:[...s.folders.slice(0,a.depth),a.path]};
 if(a.type==='select'){const index=s.blocks.findIndex(b=>b.id===a.blockId);const keep=new Set(s.blocks.slice(0,index).map(b=>b.id));const selections=Object.fromEntries(Object.entries(s.selections).filter(([id])=>keep.has(id)));if(a.filter)selections[a.blockId]=a.filter;patch={...patch,selections};}
 return {...s,...patch,past:[...s.past.slice(-49),location(s)],future:[]};
}
export function queryFor(s:BrowserState,depth?:number):CatalogQuery {const blocks=depth===undefined?s.blocks:s.blocks.slice(0,depth+1);return {libraryId:s.libraryId,filters:[...(s.mode==='categories'?blocks.flatMap(b=>s.selections[b.id]?[s.selections[b.id]!]:[]):[]),...(s.placement?[{kind:'placement' as const,status:s.placement}]:[])],...(s.mode==='folders'?{parentPath:s.folders.at(-1)??''}:{}),sort:s.sort,limit:200,...(depth!==undefined?{facetBlockId:s.blocks[depth]?.id}:{}),...(s.nameContains?{nameContains:s.nameContains}:{})};}
export function selectionFilter(block:HierarchyBlock,values:(string|number)[]):Filter {return {kind:'values',field:fieldForBlock(block),values,blockId:block.id};}
export class LatestRequest {private generation=0;begin(){return ++this.generation;}isCurrent(token:number){return token===this.generation;}cancel(){this.generation++;}}
export function keyboardIntent(key:string,editing:boolean,index:number,length:number):number|undefined {if(editing||length===0)return undefined;if(key==='ArrowDown')return Math.min(length-1,index+1);if(key==='ArrowUp')return Math.max(0,index-1);if(key==='Home')return 0;if(key==='End')return length-1;return undefined;}
export function virtualWindow(length:number,scrollTop:number,height:number,rowHeight:number){const start=Math.max(0,Math.floor(scrollTop/rowHeight)-2),end=Math.min(length,Math.ceil((scrollTop+height)/rowHeight)+2);return {start,end,paddingTop:start*rowHeight,paddingBottom:Math.max(0,(length-end)*rowHeight)};}
