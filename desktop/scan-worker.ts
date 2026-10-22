// Isolated read-only work: an unresponsive volume must not exhaust the UI
// process's filesystem workers. No copy/move/write operations run here.
import {inventory} from './core';
import {metadata,closeMetadata,routingEntries,primeRouting} from './platform/metadata';
import {analyzeSourceCameras} from './source-cameras';
import type {Source,Preferences,Inventory,Metadata} from './shared';
const source:Source=JSON.parse(process.argv[2]);
const options: {unknownRules?:Preferences['unknownRules'];unknownDefault?:Preferences['unknownDefault']}=JSON.parse(process.argv[3]??'{}');
const signal=new AbortController();
// The parent sends what it remembers about this source (last listing, metadata
// already read) in a start message; any other message stops the scan.
process.parentPort.on('message',event=>{const data=event.data as {type?:string;reuse?:Inventory;routing?:[string,Metadata][]};if(data?.type==='start'){void scan(data.reuse,data.routing??[]);return;}signal.abort();void closeMetadata().catch(()=>{}).finally(()=>process.exit(0));});
async function scan(reuse:Inventory|undefined,routing:[string,Metadata][]){
 // Only reads made here go back: the parent already holds what it sent.
 const known=new Set(routing.map(([key])=>key)),learned=()=>routingEntries().filter(([key])=>!known.has(key));
 try{
  primeRouting(routing);
  const result=await inventory(source.path,{...options,reuse,onProgress:(files,bytes,top,file)=>process.parentPort.postMessage({type:'progress',files,bytes,file,top})},signal.signal);
  process.parentPort.postMessage({type:'inventory',inventory:result});
  await analyzeSourceCameras(source,result,file=>metadata(file,{preview:false,details:false}),signal.signal,info=>process.parentPort.postMessage({type:'cameras',info}));
  process.parentPort.postMessage({type:'routing',entries:learned()});
  await closeMetadata();process.parentPort.postMessage({type:'done'});
 }catch(error){process.parentPort.postMessage({type:'routing',entries:learned()});await closeMetadata().catch(()=>{});process.parentPort.postMessage({type:'error',error:error instanceof Error?error.message:String(error)});}
}
