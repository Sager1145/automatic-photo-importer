import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { noteTemporary } from '../core/run-trace';
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
/** A camera's storages as the helper reported them, and its capacity: their sums, when every storage reported one. */
export function cameraCapacity(value:unknown):Pick<Source,'storages'|'total'|'free'> {
  if(!Array.isArray(value))return {};
  const storages=value.filter(item=>typeof item?.name==='string'&&item.name).map(item=>({name:String(item.name),total:size(item.total),free:size(item.free)}));
  if(!storages.length)return {};
  const sum=(key:'total'|'free')=>storages.every(item=>item[key]!==undefined)?storages.reduce((all,item)=>all+item[key]!,0):undefined;
  return {storages,total:sum('total'),free:sum('free')};
}
export async function cameraSources():Promise<Source[]> {
  if(staging)return cached;
  if(!await bridgeLaunch())return [];
  // The first Windows request also compiles the bridge's copy helper, so it gets longer.
  const result=await request({command:'list'},process.platform==='win32'?30000:10000);
  if(!Array.isArray(result))throw new Error('The camera helper returned an invalid source list.');
  cached=result.filter((camera):camera is Camera=>typeof camera?.cameraID==='string'&&typeof camera?.name==='string').map(camera=>({id:`camera:${camera.cameraID}`,name:camera.name,path:`camera://${encodeURIComponent(camera.cameraID)}`,transport:'camera' as const,...cameraCapacity(camera.storages)}));
  return cached;
}
export async function prepareCamera(source:Source, signal?:AbortSignal, onProgress?:(completed:number,total:number)=>void):Promise<{path:string;cleanup():Promise<void>}> {
  if(source.transport!=='camera'||!source.path.startsWith('camera://'))throw new Error('Choose a native camera source.');
  signal?.throwIfAborted();
  const cameraID=decodeURIComponent(source.path.slice('camera://'.length));
  const scratch=await mkdtemp(path.join(tmpdir(),'photo-importer-camera-'));
  // The job staging it owns the folder: its Clean up removes it if this run could not.
  noteTemporary(scratch);
  const cleanup=()=>rm(scratch,{recursive:true,force:true});
  const abort=()=>{void closeCameraBridge();};signal?.addEventListener('abort',abort,{once:true});staging++;
  try {
    signal?.throwIfAborted();
    // Every staged file restarts the 30-minute timeout, so a large card is not cut off while files keep arriving
    // (a 128 GB card at the 68 MB/s once measured over MTP takes 31 minutes).
    const result=await request({command:'stage',cameraID,directory:scratch},30*60*1000,onProgress,signal) as {path?:unknown};
    signal?.throwIfAborted();
    if(typeof result?.path!=='string')throw new Error('The camera helper did not return its staged folder.');
    const root=await realpath(scratch);const staged=await realpath(result.path);
    if(!beneath(staged,root)||!(await stat(staged)).isDirectory())throw new Error('The camera helper returned an unsafe staging folder.');
    return {path:staged,cleanup};
  }catch(error){await cleanup();signal?.throwIfAborted();throw error;}finally{staging--;signal?.removeEventListener('abort',abort);}
}
