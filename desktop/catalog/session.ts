import type {Catalog,CatalogLibrary,CatalogStatus} from './types';

export interface CatalogSession {catalog:Catalog;/** Reopens only after failure, and only when explicitly called. */reopen():Promise<void>;}
/** Stable ownership facade: worker failure never starts a replacement by itself. */
export function createCatalogSession(open:(onError:(error:Error)=>void)=>Catalog,options:{onError?:(error:Error)=>void}={}):CatalogSession {
 let generation=0,failure:Error|undefined,closed=false,reopening:Promise<void>|undefined,closing:Promise<void>|undefined;
 const closedError=new Error('Catalog session is closed.'),definitions=new Map<string,CatalogLibrary>(),statuses=new Map<string,CatalogStatus>();
 const failed=(error:Error)=>{failure=error;options.onError?.(error);};
 const start=()=>{const owner=++generation;return open(error=>{if(!closed&&owner===generation)failed(error);});};
 let current=start();
 async function ready():Promise<Catalog>{
  if(closed)throw closedError;
  if(reopening)await reopening;
  if(closed)throw closedError;
  if(failure)throw failure;
  return current;
 }
 async function invoke<K extends keyof Catalog>(method:K,args:Parameters<Catalog[K]>):Promise<Awaited<ReturnType<Catalog[K]>>>{
  const client=await ready(),call=client[method] as (...params:Parameters<Catalog[K]>)=>ReturnType<Catalog[K]>;
  return await call(...args) as Awaited<ReturnType<Catalog[K]>>;
 }
 async function close():Promise<void>{
  if(closing)return closing;
  closed=true;generation++;
  closing=(async()=>{await reopening?.catch(()=>{});await current.close();})();
  return closing;
 }
 const catalog:Catalog={
  async configure(libraries){for(const library of libraries)definitions.set(library.libraryId,structuredClone(library));await invoke('configure',[libraries]);},
  records:(...args)=>invoke('records',args),file:(...args)=>invoke('file',args),
  beginScan:(...args)=>invoke('beginScan',args),ingest:(...args)=>invoke('ingest',args),endScan:(...args)=>invoke('endScan',args),
  apply:(...args)=>invoke('apply',args),query:(...args)=>invoke('query',args),directories:(...args)=>invoke('directories',args),facets:(...args)=>invoke('facets',args),
  async status(id){
   if(closed)throw closedError;
   if(reopening)await reopening.catch(()=>{});
   if(closed)throw closedError;
   if(failure){const previous=statuses.get(id),definition=definitions.get(id);return {...(previous??{libraryId:id,online:definition?.online??false,revision:0,progress:{discovered:0,read:0,failed:0},total:0,checked:0,misplaced:0,unclassifiable:0,unchecked:0}),online:definition?.online??previous?.online??false,dirty:true,state:'error',error:failure.message};}
   const status=await invoke('status',[id]);statuses.set(id,status);return status;
  },close,
 };
 function reopen():Promise<void>{
  if(closed)return Promise.reject(closedError);
  if(reopening)return reopening;
  if(!failure)return Promise.resolve();
  const previous=current;
  reopening=(async()=>{
   let replacement:Catalog|undefined;
   try{
    await previous.close();if(closed)throw closedError;
    failure=undefined;replacement=start();current=replacement;
    if(failure)throw failure;
    await replacement.configure([...definitions.values()]);
    if(closed)throw closedError;
    if(failure)throw failure;
   }catch(error){
    const reason=error instanceof Error?error:new Error(String(error));
    if(!closed&&failure!==reason)failed(reason);
    await replacement?.close().catch(()=>{});
    throw closed?closedError:failure??reason;
   }
  })().finally(()=>{reopening=undefined;});
  return reopening;
 }
 return {catalog,reopen};
}
