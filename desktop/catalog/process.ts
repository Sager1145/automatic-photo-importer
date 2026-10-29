import {utilityProcess} from 'electron';
import path from 'node:path';
import type {Catalog,CatalogLibrary,CatalogStatus} from './types';

/** Small utility-process seam permits lifecycle tests without a second SQLite owner. */
export interface CatalogChild {
 postMessage(message:unknown):void;
 on(event:'message',listener:(message:any)=>void):unknown;
 on(event:'exit',listener:(code:number)=>void):unknown;
 on(event:'error',listener:(...details:any[])=>void):unknown;
 kill():boolean;
}
export interface CatalogProcessOptions {onError?:(error:Error)=>void;workerPath?:string;}
interface Response {id:number;ok:boolean;result?:unknown;error?:{message:string;code?:string};}
/** Child exit is terminal. The owner can reopen once through its normal refresh flow. */
export function createCatalogClient(child:CatalogChild,options:Pick<CatalogProcessOptions,'onError'>={}):Catalog {
 let sequence=0;
 let failure:Error|undefined;
 let closing=false;
 let closed=false;
 const pending=new Map<number,{resolve:(result:any)=>void;reject:(error:Error)=>void}>();
 const libraries=new Map<string,CatalogLibrary>();
 const statuses=new Map<string,CatalogStatus>();
 const failed=(error:Error)=>{
  if(failure||closed)return;
  failure=error;
  for(const request of pending.values())request.reject(error);
  pending.clear();
  if(!closing)options.onError?.(error);
 };
 child.on('message',(message:Response)=>{
  if(!message||!Number.isSafeInteger(message.id))return;
  const request=pending.get(message.id);
  if(!request)return;
  pending.delete(message.id);
  if(message.ok)request.resolve(message.result);
  else request.reject(Object.assign(new Error(message.error?.message??'Catalog request failed.'),{code:message.error?.code}));
 });
 child.on('exit',code=>failed(new Error(`The catalog worker exited (${code}). Refresh the library to reopen its cache.`)));
 child.on('error',(...details)=>failed(details[0] instanceof Error?details[0]:new Error(`Catalog worker error: ${details.join(' ')}`)));
 const request=<T>(method:keyof Catalog,args:unknown[]):Promise<T>=>{
  if(failure)return Promise.reject(failure);
  if(closed||closing)return Promise.reject(new Error('Catalog is closed.'));
  const id=++sequence;
  return new Promise((resolve,reject)=>{
   pending.set(id,{resolve,reject});
   try{child.postMessage({id,method,args});}catch(error){failed(error instanceof Error?error:new Error(String(error)));}
  });
 };
 return {
  async configure(definitions){await request<void>('configure',[definitions]);for(const definition of definitions)libraries.set(definition.libraryId,definition);},
  records:(...args)=>request('records',args),file:(...args)=>request('file',args),
  beginScan:(...args)=>request('beginScan',args),ingest:(...args)=>request('ingest',args),endScan:(...args)=>request('endScan',args),
  apply:(...args)=>request('apply',args),query:(...args)=>request('query',args),directories:(...args)=>request('directories',args),facets:(...args)=>request('facets',args),
  async status(id){
   if(failure){
    const previous=statuses.get(id);const definition=libraries.get(id);
    return {...(previous??{libraryId:id,online:definition?.online??false,revision:0,progress:{discovered:0,read:0,failed:0},total:0,checked:0,misplaced:0,unclassifiable:0,unchecked:0}),dirty:true,state:'error',error:failure.message};
   }
   const status=await request<CatalogStatus>('status',[id]);statuses.set(id,status);return status;
  },
  async close(){
   if(closed)return;
   if(failure){closed=true;child.kill();return;}
   const finished=request<void>('close',[]);closing=true;
   try{await finished;}finally{closed=true;child.kill();}
  },
 };
}
/** Database path is local app userData, never a photo-volume path or renderer argument. */
export function startCatalog(databasePath:string,options:CatalogProcessOptions={}):Catalog {
 const child=utilityProcess.fork(options.workerPath??path.join(__dirname,'catalog-worker.cjs'),[databasePath],{serviceName:'Photo Importer library catalog',stdio:'ignore'});
 return createCatalogClient(child,options);
}
