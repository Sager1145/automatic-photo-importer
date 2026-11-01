import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { Source } from '../shared';
import { registerListedSource, type ListedFile } from '../core/source-fs';
import { windowsCameraBridgeArgs } from './windows-camera';

interface Camera {name:string;cameraID:string;storages?:unknown;}
interface Pending {resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;progress?:(completed:number,total:number)=>void;/** Restarts the timeout: a request that reports progress is timed from its last report, not its start. */alive():void;}
let child:ChildProcessWithoutNullStreams|undefined;
let starting:Promise<boolean>|undefined;
let stdout:string[]=[];let stdoutLength=0;let stderr='';let opened=0;let cached:Source[]=[];
const pending=new Map<string,Pending>();
/** The longest line the helper may send: a 16 MB read is 22 MB of base64. */
const MAX_LINE=96*1024*1024;
function failed(error:Error) {for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();cached=[];}
/** Ends the helper (SIGTERM, then SIGKILL after 2 s); resolves once it has exited. */
export function closeCameraBridge():Promise<void> {
  const current=child;child=undefined;stdout=[];stdoutLength=0;stderr='';failed(new Error('The native camera session closed.'));
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
 * PowerShell. Both speak the same JSONL protocol. Other platforms list cameras through their mounted storage.
 * IMPORTER_NATIVE_BRIDGE names a stand-in on any system (a .js/.mjs one runs in Node), for tests. */
async function bridgeLaunch():Promise<{command:string;args:string[]}|undefined> {
  const standIn=process.env.IMPORTER_NATIVE_BRIDGE;
  if(standIn&&/\.[cm]?js$/i.test(standIn))return {command:process.execPath,args:[standIn]};
  if(process.platform==='win32'&&!standIn)return {command:'powershell.exe',args:windowsCameraBridgeArgs()};
  const executable=await nativeCameraHelperPath();return executable?{command:executable,args:[]}:undefined;
}
function received(line:string) {
  let message:any;try{message=JSON.parse(line);}catch{return;}
  const item=pending.get(message?.id);if(!item)return;
  if(message.progress){item.alive();const {completed,total}=message.progress;if(Number.isSafeInteger(completed)&&Number.isSafeInteger(total))item.progress?.(completed,total);return;}
  pending.delete(message.id);clearTimeout(item.timer);
  if(typeof message.error==='string')item.reject(new Error(message.error));else item.resolve(message.result);
}
async function startBridge():Promise<boolean> {
  if(child && child.exitCode===null && !child.killed)return true;
  const launch=await bridgeLaunch();if(!launch)return false;
  const current=spawn(launch.command,launch.args,{stdio:['pipe','pipe','pipe'],windowsHide:true});child=current;stdout=[];stdoutLength=0;stderr='';
  current.stdout.setEncoding('utf8');
  // A reply carrying file data is one long line: pieces are kept until its newline and joined once, never rescanned.
  current.stdout.on('data',(text:string)=>{
    if(child!==current)return;
    let newline:number;
    while((newline=text.indexOf('\n'))>=0){
      stdout.push(text.slice(0,newline));const line=stdout.join('');stdout=[];stdoutLength=0;text=text.slice(newline+1);
      received(line);
      if(child!==current)return;
    }
    if(text){stdout.push(text);stdoutLength+=text.length;}
    if(stdoutLength>MAX_LINE)void closeCameraBridge();
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
    // Stop stops waiting at once; the helper's late answer is dropped.
    const stop=()=>{const item=pending.get(id);if(item){clearTimeout(item.timer);pending.delete(id);reject(signal!.reason??new DOMException('Import stopped','AbortError'));}};
    const settle=(done:()=>void)=>{signal?.removeEventListener('abort',stop);done();};
    const item:Pending={resolve:value=>settle(()=>resolve(value)),reject:error=>settle(()=>reject(error)),timer:setTimeout(expire,timeout),progress,alive(){clearTimeout(item.timer);item.timer=setTimeout(expire,timeout);}};
    signal?.addEventListener('abort',stop,{once:true});
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
  // While a camera is being imported its helper serves that import; the last list stands.
  if(opened)return cached;
  if(!await bridgeLaunch())return [];
  // The first Windows request also compiles the bridge's reader, so it gets longer.
  const result=await request({command:'list'},process.platform==='win32'?30000:10000);
  if(!Array.isArray(result))throw new Error('The camera helper returned an invalid source list.');
  cached=result.filter((camera):camera is Camera=>typeof camera?.cameraID==='string'&&typeof camera?.name==='string').map(camera=>({id:`camera:${camera.cameraID}`,name:camera.name,path:`camera://${encodeURIComponent(camera.cameraID)}`,transport:'camera' as const,...cameraCapacity(camera.storages)}));
  return cached;
}
/** One file as the helper lists it: its storage (card slot), folders, name, size, dates (ms) and the helper's own id for it. */
export interface CameraFile {storage:string;folder:string[];name:string;size:number;modified?:number;created?:number;objectID:string;}
const part=(value:unknown)=>typeof value==='string'&&value!==''&&value!=='.'&&value!=='..'&&!/[\\/\x00]/.test(value);
const millis=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>0?value:undefined;
/** The helper's file list, checked: entries without a usable name, folder, size or id are left out (and counted). */
export function cameraFiles(value:unknown):{files:CameraFile[];invalid:number} {
  if(!Array.isArray(value))throw new Error('The camera helper returned an invalid file list.');
  const files:CameraFile[]=[];let invalid=0;
  for(const item of value){
    if(part(item?.storage)&&Array.isArray(item.folder)&&item.folder.every(part)&&part(item.name)&&size(item.size)!==undefined&&typeof item.objectID==='string'&&item.objectID)
      files.push({storage:item.storage,folder:item.folder,name:item.name,size:item.size,...(millis(item.modified)?{modified:item.modified}:{}),...(millis(item.created)?{created:item.created}:{}),objectID:item.objectID});
    else invalid++;
  }
  return {files,invalid};
}
/** Where a camera file is read from in the listing: storage/folders/name, '/' separated. A name the camera repeats
 * in one folder keeps each file apart, in a folder named after its id, as staging used to. */
export function listedFiles(files:readonly CameraFile[]):(ListedFile&{objectID:string})[] {
  const taken=new Set<string>();
  return files.map(file=>{
    let relative=[file.storage,...file.folder,file.name].join('/');
    if(taken.has(relative.toLowerCase()))relative=[file.storage,...file.folder,`duplicate-${file.objectID.replace(/[^\w.-]/g,'_')}`,file.name].join('/');
    taken.add(relative.toLowerCase());
    return {relative,size:file.size,modifiedMs:file.modified??file.created??0,...(file.created?{createdMs:file.created}:{}),objectID:file.objectID};
  });
}
/** The camera (and, for a source that is one card slot, its storage) a camera source reads. */
export function cameraOf(source:Source):{cameraID:string;storage?:string} {
  if(source.transport!=='camera'||!source.path.startsWith('camera://'))throw new Error('Choose a native camera source.');
  return {cameraID:decodeURIComponent(source.path.slice('camera://'.length))};
}
/** Opens a camera for an import without downloading anything: its files are listed (names, folders, sizes, dates),
 * then made readable under a folder path of their own (core/source-fs), so the import plans from the list, reads only
 * what it needs (headers for capture dates, contents to compare with the library) straight from the camera, and writes
 * new files only into the destination. `cleanup` makes the path unreadable again. */
export async function prepareCamera(source:Source, signal?:AbortSignal, onProgress?:(completed:number,total:number)=>void):Promise<{path:string;cleanup():Promise<void>}> {
  const {cameraID,storage}=cameraOf(source);
  signal?.throwIfAborted();
  opened++;
  let release=true;
  try {
    // A progress line every 250 files restarts the timeout, so a large card is not cut off while it is listed.
    const {files}=cameraFiles(await request({command:'files',cameraID,...(storage?{storage}:{})},120000,onProgress,signal));
    signal?.throwIfAborted();
    const listed=listedFiles(files);
    const {root,unregister}=registerListedSource({id:`${cameraID}\0${storage??''}`,files:listed,
      async read(file,offset,length){
        const result=await request({command:'read',cameraID,objectID:(file as typeof listed[number]).objectID,offset,length},120000) as {bytes?:unknown;data?:unknown};
        if(typeof result?.data!=='string'||!Number.isSafeInteger(result.bytes))throw new Error('The camera helper returned an invalid read.');
        const data=Buffer.from(result.data,'base64');
        if(data.length!==result.bytes||data.length>length)throw new Error('The camera helper returned an invalid read.');
        return data;
      },
      release(file){void request({command:'release',objectID:(file as typeof listed[number]).objectID},30000).catch(()=>{});},
    });
    release=false;
    let closed=false;
    return {path:root,cleanup:async()=>{if(closed)return;closed=true;unregister();opened--;}};
  } finally { if(release)opened--; }
}
