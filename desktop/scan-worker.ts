// Isolated read-only work: an unresponsive volume must not exhaust the UI
// process's filesystem workers. No copy/move/write operations run here.
import {inventory} from './core';
import {metadata,closeMetadata,primeRouting,beginRoutingCapture} from './platform/metadata';
import {adoptVolumes,type MountedVolume} from './platform/volumes';
import {analyzeSourceCameras} from './source-cameras';
import type {Source,Preferences,Listing,Metadata} from './shared';
import {setResourceLimits} from './resource-limits';
// The user's CPU and memory limits, from the parent (this process has its own copy of the module).
try{setResourceLimits(JSON.parse(process.env.IMPORTER_LIMITS??'{}'));}catch{/* Defaults. */}
const source:Source=JSON.parse(process.argv[2]);
const options: {unknownRules?:Preferences['unknownRules'];unknownDefault?:Preferences['unknownDefault']}=JSON.parse(process.argv[3]??'{}');
const signal=new AbortController();
// Only reads made here go back: the parent already holds what it sent. They go back as they are read
// (each second, and before the scan ends, fails or stops), so a review started during the scan, or a scan stopped half way, keeps them.
const capture=beginRoutingCapture();
const flush=()=>{const entries=capture.take();if(entries.length)process.parentPort.postMessage({type:'routing',entries});};
// The parent sends what it remembers about this source (last listing, metadata already read, the volume it is on)
// in a start message; any other message stops the scan.
process.parentPort.on('message',event=>{
 const data=event.data as {type?:string;reuse?:Listing;routing?:[string,Metadata][];volume?:MountedVolume};
 if(data?.type==='start'){void scan(data.reuse,data.routing??[],data.volume);return;}
 flush();signal.abort();void closeMetadata().catch(()=>{}).finally(()=>process.exit(0));
});
async function scan(reuse:Listing|undefined,routing:[string,Metadata][],volume:MountedVolume|undefined){
 const timer=setInterval(flush,1000);
 try{
  // The parent's description of the source's volume: reading metadata asks what kind of drive it is.
  if(volume)await adoptVolumes([volume]);
  primeRouting(routing);
  const {listing,...result}=await inventory(source.path,{...options,reuse,onProgress:(files,bytes,top,file)=>process.parentPort.postMessage({type:'progress',files,bytes,file,top})},signal.signal);
  process.parentPort.postMessage({type:'inventory',inventory:result,listing});
  await analyzeSourceCameras(source,result,file=>metadata(file,{details:false}),signal.signal,info=>process.parentPort.postMessage({type:'cameras',info}));
  clearInterval(timer);flush();
  await closeMetadata();process.parentPort.postMessage({type:'done'});
 }catch(error){clearInterval(timer);flush();await closeMetadata().catch(()=>{});process.parentPort.postMessage({type:'error',error:error instanceof Error?error.message:String(error)});}
 finally{capture.close();}
}
