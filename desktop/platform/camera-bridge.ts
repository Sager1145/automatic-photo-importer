import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Source } from '../shared';
import { beneath } from '../core/paths';
import { windowsCameraBridgeArgs } from './windows-camera';

interface Camera {name:string;cameraID:string;storages?:unknown;}
interface Pending {resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;progress?:(completed:number,total:number)=>void;/** Restarts the timeout: a request that reports progress is timed from its last report, not its start. */alive():void;}
let child:ChildProcessWithoutNullStreams|undefined;
let starting:Promise<boolean>|undefined;
let stdout='';let stderr='';let staging=0;let cached:Source[]=[];
const pending=new Map<string,Pending>();
function failed(error:Error) {for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();cached=[];}
/** Ends the helper (SIGTERM, then SIGKILL after 2 s); resolves once it has exited. */
export function closeCameraBridge():Promise<void> {
  const current=child;child=undefined;stdout='';stderr='';failed(new Error('The native camera session closed.'));
  if(!current || current.exitCode!==null || current.signalCode!==null) return Promise.resolve();
  return new Promise<void>(resolve=>{
    const force=setTimeout(()=>{try{current.kill('SIGKILL');}catch{/* Already gone. */}},2000);
    current.once('exit',()=>{clearTimeout(force);resolve();});
    try{current.kill('SIGTERM');}catch{clearTimeout(force);resolve();}
  });
}
export async function nativeCameraHelperPath():Promise<string|undefined> {
  if(process.platform!=='darwin')return undefined;
  const resources=(process as NodeJS.Process & {resourcesPath?:string}).resourcesPath;
  const candidates=process.env.IMPORTER_NATIVE_BRIDGE?[process.env.IMPORTER_NATIVE_BRIDGE]:[resources?path.join(resources,'native','NativeCameraBridge'):'',path.join(process.cwd(),'build','native','NativeCameraBridge')];
  for(const filename of candidates.filter(Boolean))try{await access(filename,constants.X_OK);return filename;}catch{}
  return undefined;
}
/** The camera helper to run: the macOS ImageCaptureCore helper, or on Windows the Portable Devices bridge in
 * PowerShell. Both speak the same JSONL protocol. Other platforms list cameras through their mounted storage. */
async function bridgeLaunch():Promise<{command:string;args:string[]}|undefined> {
  if(process.platform==='win32')return {command:'powershell.exe',args:windowsCameraBridgeArgs()};
  const executable=await nativeCameraHelperPath();return executable?{command:executable,args:[]}:undefined;
}
async function startBridge():Promise<boolean> {
  if(child && child.exitCode===null && !child.killed)return true;
  const launch=await bridgeLaunch();if(!launch)return false;
  const current=spawn(launch.command,launch.args,{stdio:['pipe','pipe','pipe'],windowsHide:true});child=current;stdout='';stderr='';
  current.stdout.setEncoding('utf8');
  current.stdout.on('data',(text:string)=>{
    if(child!==current)return;stdout+=text;
    if(stdout.length>4*1024*1024){void closeCameraBridge();return;}
    let newline:number;
    while((newline=stdout.indexOf('\n'))>=0){
      const line=stdout.slice(0,newline);stdout=stdout.slice(newline+1);
      let message:any;try{message=JSON.parse(line);}catch{continue;}
      const item=pending.get(message.id);if(!item)continue;
      if(message.progress){item.alive();const {completed,total}=message.progress;if(Number.isSafeInteger(completed)&&Number.isSafeInteger(total))item.progress?.(completed,total);continue;}
      pending.delete(message.id);clearTimeout(item.timer);
      if(typeof message.error==='string')item.reject(new Error(message.error));else item.resolve(message.result);
    }
  });
  current.stderr.on('data',(text:Buffer)=>{if(child===current)stderr=(stderr+text.toString()).slice(-4096);});
  current.stdin.on('error',error=>{if(child===current)failed(error);});
  current.on('error',error=>{if(child===current){child=undefined;failed(error);}});
  current.on('exit',()=>{if(child===current){child=undefined;failed(new Error(stderr.trim()||'The native camera process disconnected.'));}});
  return true;
}
async function ensureBridge():Promise<boolean> {
  if(starting)return starting;
  starting=startBridge();
  try{return await starting;}finally{starting=undefined;}
}
async function request(command:Record<string,unknown>, timeout:number, progress?:(completed:number,total:number)=>void, signal?:AbortSignal):Promise<unknown> {
  if(!await ensureBridge())throw new Error('The native camera helper is unavailable.');
  signal?.throwIfAborted();
  const current=child!;const id=randomUUID();
  return new Promise((resolve,reject)=>{
    const expire=()=>{if(pending.has(id)){void closeCameraBridge();reject(new Error('The native camera request timed out.'));}};
    const item:Pending={resolve,reject,timer:setTimeout(expire,timeout),progress,alive(){clearTimeout(item.timer);item.timer=setTimeout(expire,timeout);}};
    pending.set(id,item);
    current.stdin.write(`${JSON.stringify({...command,id})}\n`,error=>{if(error){clearTimeout(item.timer);pending.delete(id);reject(error);}});
  });
}
const size=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;
type Storage={id?:string;name:string;total?:number;free?:number};
function cameraStorages(value:unknown):Storage[] {
  if(!Array.isArray(value))return [];
  return value.filter(item=>typeof item?.name==='string'&&item.name).map(item=>({...(typeof item.id==='string'&&item.id?{id:String(item.id)}:{}),name:String(item.name),total:size(item.total),free:size(item.free)}));
}
/** A camera's storages as the helper reported them, and its capacity: their sums, when every storage reported one. */
export function cameraCapacity(value:unknown):Pick<Source,'storages'|'total'|'free'> {
  const storages=cameraStorages(value).map(({name,total,free})=>({name,total,free}));
  if(!storages.length)return {};
  const sum=(key:'total'|'free')=>storages.every(item=>item[key]!==undefined)?storages.reduce((all,item)=>all+item[key]!,0):undefined;
  return {storages,total:sum('total'),free:sum('free')};
}
/** The sources for the helper's "list" reply. A camera with several storages (card slots), each with its own id, is
 * one source per storage ("Z f · Slot 1"), with that storage's capacity; its id joins the camera's id and the
 * storage's id (the camera's own id for that slot, never its position), so it is the same source on every
 * connection. A camera with one storage stays one source under its own name and id, as it always was. */
export function cameraSourcesFrom(result:unknown[]):Source[] {
  return result.filter((camera):camera is Camera=>typeof (camera as Camera)?.cameraID==='string'&&typeof (camera as Camera)?.name==='string').flatMap(camera=>{
    const base={id:`camera:${camera.cameraID}`,name:camera.name,path:`camera://${encodeURIComponent(camera.cameraID)}`,transport:'camera' as const};
    const storages=cameraStorages(camera.storages),ids=storages.map(storage=>storage.id);
    if(storages.length<2||ids.some(id=>id===undefined)||new Set(ids).size!==ids.length)return [{...base,...cameraCapacity(camera.storages)}];
    return storages.map(storage=>({id:`${base.id}|${storage.id}`,name:`${camera.name} · ${storage.name}`,path:`${base.path}/${encodeURIComponent(storage.id!)}`,transport:'camera' as const,total:storage.total,free:storage.free,storage:{id:storage.id!,name:storage.name,camera:camera.name}}));
  });
}
export async function cameraSources():Promise<Source[]> {
  if(staging)return cached;
  if(!await bridgeLaunch())return [];
  // The first Windows request also compiles the bridge's copy helper, so it gets longer.
  const result=await request({command:'list'},process.platform==='win32'?30000:10000);
  if(!Array.isArray(result))throw new Error('The camera helper returned an invalid source list.');
  cached=cameraSourcesFrom(result);
  return cached;
}
/** The bridge's "stage" request for a camera source: the whole camera, or only the storage the source stands for. */
export function stageRequest(source:Pick<Source,'path'>,directory:string):{command:'stage';cameraID:string;storageID?:string;directory:string} {
  const [camera,storage]=source.path.slice('camera://'.length).split('/');
  return {command:'stage',cameraID:decodeURIComponent(camera!),...(storage?{storageID:decodeURIComponent(storage)}:{}),directory};
}
/** One stage at a time per camera: a camera serves one transfer session, so its storages are staged one after another. */
const cameraTurns=new Map<string,Promise<unknown>>();
export async function prepareCamera(source:Source, signal?:AbortSignal, onProgress?:(completed:number,total:number)=>void):Promise<{path:string;cleanup():Promise<void>}> {
  if(source.transport!=='camera'||!source.path.startsWith('camera://'))throw new Error('Choose a native camera source.');
  signal?.throwIfAborted();
  const {cameraID}=stageRequest(source,'');
  const previous=cameraTurns.get(cameraID)??Promise.resolve();
  // A stop while waiting ends the wait at once; the next stage still waits for the one running.
  const turn=new Promise<void>((resolve,reject)=>{
    const abort=()=>reject(signal!.reason);signal?.addEventListener('abort',abort,{once:true});
    void previous.then(()=>{signal?.removeEventListener('abort',abort);resolve();});
  }).then(()=>stageCamera(source,signal,onProgress));
  const settled=Promise.allSettled([previous,turn]);cameraTurns.set(cameraID,settled);
  try{return await turn;}finally{if(cameraTurns.get(cameraID)===settled)cameraTurns.delete(cameraID);}
}
async function stageCamera(source:Source, signal?:AbortSignal, onProgress?:(completed:number,total:number)=>void):Promise<{path:string;cleanup():Promise<void>}> {
  signal?.throwIfAborted();
  const scratch=await mkdtemp(path.join(tmpdir(),'photo-importer-camera-'));
  const cleanup=()=>rm(scratch,{recursive:true,force:true});
  const abort=()=>{void closeCameraBridge();};signal?.addEventListener('abort',abort,{once:true});staging++;
  try {
    signal?.throwIfAborted();
    // Every staged file restarts the 30-minute timeout, so a large card is not cut off while files keep arriving
    // (a 128 GB card at the 68 MB/s once measured over MTP takes 31 minutes).
    const result=await request(stageRequest(source,scratch),30*60*1000,onProgress,signal) as {path?:unknown};
    signal?.throwIfAborted();
    if(typeof result?.path!=='string')throw new Error('The camera helper did not return its staged folder.');
    const root=await realpath(scratch);const staged=await realpath(result.path);
    if(!beneath(staged,root)||!(await stat(staged)).isDirectory())throw new Error('The camera helper returned an unsafe staging folder.');
    return {path:staged,cleanup};
  }catch(error){await cleanup();signal?.throwIfAborted();throw error;}finally{staging--;signal?.removeEventListener('abort',abort);}
}
