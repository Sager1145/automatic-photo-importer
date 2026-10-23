import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Source } from '../shared';

interface Camera {name:string;cameraID:string;}
interface Pending {resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;progress?:(completed:number,total:number)=>void;}
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
async function startBridge():Promise<boolean> {
  if(child && child.exitCode===null && !child.killed)return true;
  const executable=await nativeCameraHelperPath();if(!executable)return false;
  const current=spawn(executable,[],{stdio:['pipe','pipe','pipe'],windowsHide:true});child=current;stdout='';stderr='';
  current.stdout.setEncoding('utf8');
  current.stdout.on('data',(text:string)=>{
    if(child!==current)return;stdout+=text;
    if(stdout.length>4*1024*1024){void closeCameraBridge();return;}
    let newline:number;
    while((newline=stdout.indexOf('\n'))>=0){
      const line=stdout.slice(0,newline);stdout=stdout.slice(newline+1);
      let message:any;try{message=JSON.parse(line);}catch{continue;}
      const item=pending.get(message.id);if(!item)continue;
      if(message.progress){const {completed,total}=message.progress;if(Number.isSafeInteger(completed)&&Number.isSafeInteger(total))item.progress?.(completed,total);continue;}
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
  if(!await ensureBridge())throw new Error('The macOS native camera helper is unavailable.');
  signal?.throwIfAborted();
  const current=child!;const id=randomUUID();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{if(pending.has(id)){void closeCameraBridge();reject(new Error('The native camera request timed out.'));}},timeout);
    pending.set(id,{resolve,reject,timer,progress});
    current.stdin.write(`${JSON.stringify({...command,id})}\n`,error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error);}});
  });
}
export async function cameraSources():Promise<Source[]> {
  if(staging)return cached;
  if(!await nativeCameraHelperPath())return [];
  const result=await request({command:'list'},10000);
  if(!Array.isArray(result))throw new Error('The camera helper returned an invalid source list.');
  cached=result.filter((camera):camera is Camera=>typeof camera?.cameraID==='string'&&typeof camera?.name==='string').map(camera=>({id:`camera:${camera.cameraID}`,name:camera.name,path:`camera://${encodeURIComponent(camera.cameraID)}`,transport:'camera'}));
  return cached;
}
export async function prepareCamera(source:Source, signal?:AbortSignal, onProgress?:(completed:number,total:number)=>void):Promise<{path:string;cleanup():Promise<void>}> {
  if(source.transport!=='camera'||!source.path.startsWith('camera://'))throw new Error('Choose a native camera source.');
  signal?.throwIfAborted();
  const cameraID=decodeURIComponent(source.path.slice('camera://'.length));
  const scratch=await mkdtemp(path.join(tmpdir(),'photo-importer-camera-'));
  const cleanup=()=>rm(scratch,{recursive:true,force:true});
  const abort=()=>{void closeCameraBridge();};signal?.addEventListener('abort',abort,{once:true});staging++;
  try {
    signal?.throwIfAborted();
    const result=await request({command:'stage',cameraID,directory:scratch},30*60*1000,onProgress,signal) as {path?:unknown};
    signal?.throwIfAborted();
    if(typeof result?.path!=='string')throw new Error('The camera helper did not return its staged folder.');
    const root=await realpath(scratch);const staged=await realpath(result.path);const relative=path.relative(root,staged);
    if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)||!(await stat(staged)).isDirectory())throw new Error('The camera helper returned an unsafe staging folder.');
    return {path:staged,cleanup};
  }catch(error){await cleanup();signal?.throwIfAborted();throw error;}finally{staging--;signal?.removeEventListener('abort',abort);}
}
