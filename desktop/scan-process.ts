import {utilityProcess} from 'electron';
import path from 'node:path';
import {stopScanChild} from './scan-stop';
import type {Source,Inventory,SourceCameraInfo,Preferences,Metadata} from './shared';

/** Scans still running or stopping; quitting waits for them so no process still reads a card. */
const inFlight=new Set<Promise<void>>();
export const scansSettled=():Promise<unknown>=>Promise.allSettled([...inFlight]);
export function scanSourceInWorker(...args:Parameters<typeof startScan>):Promise<void> {
  const work=startScan(...args);inFlight.add(work);
  const forget=()=>{inFlight.delete(work);};work.then(forget,forget);
  return work;
}
function startScan(source:Source,signal:AbortSignal,onInventory:(value:Inventory)=>void,onCameras:(value:SourceCameraInfo)=>void,options:{unknownRules?:Preferences['unknownRules'];unknownDefault?:Preferences['unknownDefault']}={},onListing?:(files:number,bytes:number,file?:string,top?:{done:number;total:number})=>void,onRouting?:(entries:[string,Metadata][])=>void,memory:{reuse?:Inventory;routing?:[string,Metadata][]}={}):Promise<void>{
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const child=utilityProcess.fork(path.join(__dirname,'scan-worker.cjs'),[JSON.stringify(source),JSON.stringify(options)],{serviceName:'Photo Importer read-only scan',stdio:'ignore'});
  let settled=false;
  let exit:()=>void=()=>{};const exited=new Promise<void>(resolve=>{exit=resolve;});
  // Resolves or rejects only after the child has exited, so the card is released when the scan reports.
  const finish=(error?:Error)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);void stopScanChild(child,exited).then(()=>{error?reject(error):resolve();});};
  const abort=()=>finish(new DOMException('Scan stopped','AbortError'));
  signal.addEventListener('abort',abort,{once:true});
  // Sent after spawn rather than in argv: a large card's listing exceeds argument limits.
  child.once('spawn',()=>{try{child.postMessage({type:'start',reuse:memory.reuse,routing:memory.routing??[]});}catch{finish(new Error('The read-only scanner could not start.'));}});
  child.on('message',(message:{type:string;inventory?:Inventory;info?:SourceCameraInfo;error?:string;files?:number;bytes?:number;file?:string;top?:{done:number;total:number};entries?:[string,Metadata][]})=>{if(settled)return;if(message.type==='progress'){onListing?.(message.files??0,message.bytes??0,message.file,message.top);return;}if(message.type==='routing'){onRouting?.(message.entries??[]);return;}if(message.type==='inventory'&&message.inventory)onInventory(message.inventory);else if(message.type==='cameras'&&message.info)onCameras(message.info);else if(message.type==='done')finish();else if(message.type==='error')finish(new Error(message.error||'Could not scan this source.'));});
  child.on('exit',code=>{exit();if(!settled)finish(new Error(`The read-only scanner exited (${code}). Reconnect the source and try again.`));});
  child.on('error',()=>{if(!child.pid)exit();finish(new Error('The read-only scanner could not start.'));});
 });
}
