import {useCallback,useEffect,useRef,useState} from 'react';
import type {CatalogQuery,CategoryField,FacetResult} from '../../catalog/types';
import type {BrowserAPI} from './api';
import {LatestRequest} from './state';
export interface PageData<T>{rows:T[];revision:number;nextCursor?:string;total?:number;knownCount?:number;missingCount?:number;pendingCount?:number;errorCount?:number;min?:number;max?:number;}
/** Rows accumulate as the list scrolls. A new query loads its first page; a new index revision re-reads the rows already
 * loaded in place. Neither clears the list, marks it busy or moves its scroll position. */
export function usePaged<T>(key:string,revision:number,load:(cursor?:string)=>Promise<PageData<T>>,enabled=true){
 const loader=useRef(load);loader.current=load;const gate=useRef(new LatestRequest());const [retry,setRetry]=useState(0);const [value,setValue]=useState<PageData<T>>({rows:[],revision:0});const [loading,setLoading]=useState(false);const [error,setError]=useState('');
 const loaded=useRef(0),shownKey=useRef(''),refreshing=useRef(false),refreshAgain=useRef(false),appending=useRef(false);
 /** Pages from the start until `count` rows are read; the cursor carries the query, so every page uses the same page size. */
 const read=useCallback(async(count:number)=>{let cursor:string|undefined,page:PageData<T>;const rows:T[]=[];do{page=await loader.current(cursor);rows.push(...page.rows);cursor=page.nextCursor;}while(cursor&&rows.length<count);return {...page,rows,nextCursor:cursor};},[]);
 useEffect(()=>{if(!enabled){gate.current.cancel();loaded.current=0;shownKey.current='';setValue({rows:[],revision:0});setLoading(false);return;}
  const token=gate.current.begin();setLoading(true);setError('');
  void read(1).then(result=>{if(!gate.current.isCurrent(token))return;loaded.current=result.rows.length;shownKey.current=key;setValue(result);setLoading(false);},e=>{if(!gate.current.isCurrent(token))return;setError(String(e));setLoading(false);});
  return()=>gate.current.cancel();},[key,retry,enabled,read]);
 const refresh=useCallback(async()=>{if(refreshing.current){refreshAgain.current=true;return;}refreshing.current=true;try{do{refreshAgain.current=false;const token=gate.current.begin(),forKey=shownKey.current;try{const result=await read(Math.max(1,loaded.current));if(gate.current.isCurrent(token)&&shownKey.current===forKey){loaded.current=result.rows.length;setValue(result);setError('');}}catch(e){if(gate.current.isCurrent(token))setError(String(e));}}while(refreshAgain.current);}finally{refreshing.current=false;}},[read]);
 const firstRevision=useRef(revision);
 useEffect(()=>{if(revision===firstRevision.current||!enabled||!shownKey.current||shownKey.current!==key)return;void refresh();},[revision]);// eslint-disable-line react-hooks/exhaustive-deps
 const more=useCallback(()=>{const cursor=value.nextCursor;if(!cursor||appending.current||refreshing.current)return;appending.current=true;const token=gate.current.begin(),forKey=shownKey.current;setLoading(true);
  void loader.current(cursor).then(page=>{if(gate.current.isCurrent(token)&&shownKey.current===forKey){setValue(previous=>{const rows=[...previous.rows,...page.rows];loaded.current=rows.length;return {...page,rows};});}},e=>{if(!gate.current.isCurrent(token))return;if(/cursor|revision|stale/i.test(String(e)))void refresh();else setError(String(e));}).finally(()=>{appending.current=false;if(gate.current.isCurrent(token))setLoading(false);});},[value.nextCursor,refresh]);
 /** Reads every remaining page (for Select all) and shows them; resolves to all rows, or undefined if the query changed meanwhile. */
 const readAll=useCallback(async():Promise<T[]|undefined>=>{const token=gate.current.begin(),forKey=shownKey.current;setLoading(true);try{const result=await read(Number.MAX_SAFE_INTEGER);if(!gate.current.isCurrent(token)||shownKey.current!==forKey)return undefined;loaded.current=result.rows.length;setValue(result);return result.rows;}catch(e){if(gate.current.isCurrent(token))setError(String(e));return undefined;}finally{if(gate.current.isCurrent(token))setLoading(false);}},[read]);
 return {...value,loading,error,more,readAll,hasMore:!!value.nextCursor,reload:()=>setRetry(r=>r+1)};
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
  }catch(error){if(attempt>=5||!/cursor|revision|stale|changed|restart/i.test(String(error)))throw error;}
 }
}
