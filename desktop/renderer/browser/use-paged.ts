import {useCallback,useEffect,useRef,useState} from 'react';
import type {CatalogQuery,CategoryField,FacetResult} from '../../catalog/types';
import type {BrowserAPI} from './api';
export interface PageData<T>{rows:T[];revision:number;nextCursor?:string;total?:number;knownCount?:number;missingCount?:number;pendingCount?:number;errorCount?:number;min?:number;max?:number;}
export interface PagedSnapshot<T>{value:PageData<T>;loading:boolean;error:string;}
/** While a library is indexed the catalog changes between pages, which ends a cursor: such errors read again from the start. */
const stale=(error:unknown)=>/cursor|revision|stale|changed|restart/i.test(String(error));
/** A paged list's requests, without React. One query at a time (`start`; `cancel` or `disable` end it): its first page, then
 * `more`, `refresh` (a new index revision re-reads the rows loaded) and `readAll` run one after another, so none cancels
 * another and each reads the rows the one before it left. Results of an earlier query are never shown. `loading` is set
 * while a first page, `more` or `readAll` is waiting or running; a refresh never sets it, clears the list or moves it. */
export class PagedList<T>{
 private query=0;private queue:Promise<unknown>=Promise.resolve();private waiting=0;private appending=false;private refreshQueued=false;private loaded=0;private seen?:number;
 snapshot:PagedSnapshot<T>={value:{rows:[],revision:0},loading:false,error:''};
 constructor(public loader:(cursor?:string)=>Promise<PageData<T>>,private changed:(snapshot:PagedSnapshot<T>)=>void=()=>{}){}
 private set(patch:Partial<PagedSnapshot<T>>){if(Object.entries(patch).every(([k,v])=>this.snapshot[k as keyof PagedSnapshot<T>]===v))return;this.snapshot={...this.snapshot,...patch};this.changed(this.snapshot);}
 /** Runs `job` after the jobs before it, for the current query only; `shows` marks the list loading meanwhile. */
 private run<R>(shows:boolean,job:(query:number)=>Promise<R|undefined>):Promise<R|undefined>{
  const query=this.query;if(shows){this.waiting++;this.set({loading:true});}
  const done=this.queue.then(async()=>{if(query!==this.query)return undefined;try{return await job(query);}catch(e){if(query===this.query)this.set({error:String(e)});return undefined;}finally{if(shows&&query===this.query){this.waiting--;this.set({loading:this.waiting>0});}}});
  this.queue=done.catch(()=>{});return done;
 }
 /** Pages from the start until `count` rows are read (the cursor carries the query, so every page has the same size); undefined once the query is gone. */
 private async read(count:number,query:number):Promise<PageData<T>|undefined>{
  for(let attempt=0;;attempt++){
   try{let cursor:string|undefined,page:PageData<T>;const rows:T[]=[];do{page=await this.loader(cursor);if(query!==this.query)return undefined;rows.push(...page.rows);cursor=page.nextCursor;}while(cursor&&rows.length<count);return {...page,rows,nextCursor:cursor};}
   catch(error){if(query!==this.query)return undefined;if(attempt>=5||!stale(error))throw error;}
  }
 }
 private show(result:PageData<T>){this.loaded=result.rows.length;this.set({value:result,error:''});}
 /** A new query at index `revision`: its first page replaces the rows when it arrives. */
 start(revision:number){this.cancel();this.seen=revision;this.loaded=0;this.set({error:''});void this.run(true,async query=>{const result=await this.read(1,query);if(result)this.show(result);return result;});}
 /** Ends the query: later results are dropped, and nothing is loading. */
 cancel(){this.query++;this.queue=Promise.resolve();this.waiting=0;this.appending=false;this.refreshQueued=false;this.set({loading:false});}
 /** No query: the list is empty. */
 disable(){this.cancel();this.loaded=0;this.seen=undefined;this.set({value:{rows:[],revision:0},error:''});}
 /** The index moved on: re-reads the rows loaded, once for any number of revisions that arrive before it runs. */
 revise(revision:number){if(revision===this.seen)return;this.seen=revision;void this.refresh();}
 refresh():Promise<void>{if(this.refreshQueued)return Promise.resolve();this.refreshQueued=true;return this.run(false,async query=>{this.refreshQueued=false;const result=await this.read(Math.max(1,this.loaded),query);if(result)this.show(result);return undefined;}).then(()=>{});}
 /** The next page, appended. A cursor the index has ended re-reads the list instead. After an error the list waits for a
  * reload (Retry), so a list that scrolls or fills itself does not ask again and again. */
 more(){if(this.appending||!this.snapshot.value.nextCursor||this.snapshot.error)return;this.appending=true;void this.run(true,async query=>{try{const cursor=this.snapshot.value.nextCursor;if(!cursor)return undefined;let page:PageData<T>;try{page=await this.loader(cursor);}catch(error){if(query===this.query&&stale(error)){void this.refresh();return undefined;}throw error;}if(query!==this.query)return undefined;const rows=[...this.snapshot.value.rows,...page.rows];this.show({...page,rows});return undefined;}finally{if(query===this.query)this.appending=false;}});}
 /** Every row of the current query (for Select all), shown too; undefined if the query changed meanwhile or could not be read. */
 readAll():Promise<T[]|undefined>{return this.run(true,async query=>{const result=await this.read(Number.MAX_SAFE_INTEGER,query);if(!result)return undefined;this.show(result);return result.rows;});}
}
/** Rows accumulate as the list scrolls. A new query loads its first page; a new index revision re-reads the rows already
 * loaded in place. Neither clears the list, marks it busy or moves its scroll position. */
export function usePaged<T>(key:string,revision:number,load:(cursor?:string)=>Promise<PageData<T>>,enabled=true){
 const [snapshot,setSnapshot]=useState<PagedSnapshot<T>>(()=>({value:{rows:[],revision:0},loading:false,error:''}));
 const list=useRef<PagedList<T>>(undefined);list.current??=new PagedList<T>(load,setSnapshot);list.current.loader=load;const [retry,setRetry]=useState(0);
 useEffect(()=>{const paged=list.current!;if(!enabled){paged.disable();return;}paged.start(revision);return()=>paged.cancel();},[key,retry,enabled]);// eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{if(enabled)list.current!.revise(revision);},[revision]);// eslint-disable-line react-hooks/exhaustive-deps
 const more=useCallback(()=>list.current!.more(),[]),readAll=useCallback(()=>list.current!.readAll(),[]),reload=useCallback(()=>setRetry(r=>r+1),[]);
 return {...snapshot.value,loading:snapshot.loading,error:snapshot.error,more,readAll,hasMore:!!snapshot.value.nextCursor,reload};
}
/** Every page of a column's catalog values, for a column that shows them grouped (a date tree, merged formats). */
export async function allFacets(api:BrowserAPI,query:CatalogQuery,field:CategoryField):Promise<FacetResult> {
 // While the library is indexed the catalog changes between pages, which ends a cursor: read again from the start
 // (the column also reloads as the index moves on).
 for(let attempt=0;;attempt++){
  try{
   let page=await api.catalogFacets({...query,limit:500},field);const rows=[...page.rows];
   while(page.nextCursor){page=await api.catalogFacets({...query,limit:500,cursor:page.nextCursor},field);rows.push(...page.rows);}
   return {...page,rows,nextCursor:undefined};
  }catch(error){if(attempt>=5||!stale(error))throw error;}
 }
}
