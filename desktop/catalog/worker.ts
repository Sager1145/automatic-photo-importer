import {openCatalog} from './store';
import type {Catalog} from './types';

const allowed=new Set<keyof Catalog>(['configure','records','file','beginScan','ingest','endScan','apply','query','directories','facets','status','close']);
const catalog=openCatalog(process.argv[2]);
let queue=Promise.resolve();
// Serialize reads and transactions at the single connection owner, including asynchronous protocol responses.
process.parentPort.on('message',event=>{
 const message=event.data as {id?:number;method?:keyof Catalog;args?:unknown[]};
 if(!message||!Number.isSafeInteger(message.id))return;
 queue=queue.then(async()=>{
  try{
   if(!message.method||!allowed.has(message.method)||!Array.isArray(message.args))throw Object.assign(new Error('Invalid catalog request.'),{code:'invalidQuery'});
   const method=catalog[message.method] as (...args:unknown[])=>Promise<unknown>;
   const result=await method(...message.args);
   process.parentPort.postMessage({id:message.id,ok:true,result});
  }catch(error){
   const value=error as Error&{code?:string};
   process.parentPort.postMessage({id:message.id,ok:false,error:{message:value.message??String(error),code:value.code}});
  }
 });
});
