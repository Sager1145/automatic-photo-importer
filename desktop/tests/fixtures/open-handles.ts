// Tracks every file, folder and watcher this process opens through `fs`, so a test can assert that an operation let go
// of all of them when it ended: on every OS, a handle left open keeps other programs from renaming or deleting a file
// (Windows) and a drive from ejecting (all of them). Opens through `fs/promises` are FileHandles (closed: fd -1),
// through `fs.open`/`fs.openSync` (streams too) numbered descriptors closed by `fs.close`, through `opendir` Dirs, and
// `fs.watch`/`fs.watchFile` watchers. The real module is patched (core code reaches it at call time, also through
// source-fs's Proxy), then synced into ESM bindings.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import type test from 'node:test';

interface Opened {kind:'file'|'folder'|'watcher';path:string;open():boolean;close():void;}
const inside=(file:string,roots:string[])=>roots.some(root=>{const relative=path.relative(root,file);return relative===''||!!relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);});
const name=(value:unknown)=>path.resolve(value instanceof URL?value.pathname:Buffer.isBuffer(value)?value.toString():String(value));

/** Starts tracking; `held(roots)` lists what is still open under `roots` (and closes it, so one leak fails one check). */
export function trackOpenFiles(t:test.TestContext){
 const opened:Opened[]=[],descriptors=new Map<number,Opened>();
 const real={open:fsp.open,opendir:fsp.opendir,fsOpen:fs.open,openSync:fs.openSync,close:fs.close,closeSync:fs.closeSync,fsOpendir:fs.opendir,opendirSync:fs.opendirSync,watch:fs.watch,watchFile:fs.watchFile,unwatchFile:fs.unwatchFile,pWatch:fsp.watch};
 const dir=(at:string,value:fs.Dir)=>{opened.push({kind:'folder',path:at,open:()=>{try{value.closeSync();return true;}catch{return false;}},close:()=>{}});return value;};
 const fd=(at:string,value:number)=>{const item:Opened={kind:'file',path:at,open:()=>descriptors.get(value)===item,close:()=>{descriptors.delete(value);try{real.closeSync(value);}catch{/* Already closed. */}}};opened.push(item);descriptors.set(value,item);return value;};
 fsp.open=(async(file:fs.PathLike,...rest:unknown[])=>{const handle=await (real.open as (...values:unknown[])=>Promise<fsp.FileHandle>)(file,...rest);opened.push({kind:'file',path:name(file),open:()=>handle.fd!==-1,close:()=>{void handle.close().catch(()=>{});}});return handle;}) as typeof fsp.open;
 fsp.opendir=(async(folder:fs.PathLike,...rest:unknown[])=>dir(name(folder),await (real.opendir as (...values:unknown[])=>Promise<fs.Dir>)(folder,...rest))) as typeof fsp.opendir;
 fs.opendirSync=((folder:fs.PathLike,...rest:unknown[])=>dir(name(folder),(real.opendirSync as (...values:unknown[])=>fs.Dir)(folder,...rest))) as typeof fs.opendirSync;
 fs.opendir=((folder:fs.PathLike,...rest:unknown[])=>{const done=rest.pop() as (error:Error|null,value?:fs.Dir)=>void;(real.fsOpendir as (...values:unknown[])=>void)(folder,...rest,(error:Error|null,value?:fs.Dir)=>done(error,value&&dir(name(folder),value)));}) as typeof fs.opendir;
 fs.openSync=((file:fs.PathLike,...rest:unknown[])=>fd(name(file),(real.openSync as (...values:unknown[])=>number)(file,...rest))) as typeof fs.openSync;
 fs.open=((file:fs.PathLike,...rest:unknown[])=>{const done=rest.pop() as (error:Error|null,value?:number)=>void;(real.fsOpen as (...values:unknown[])=>void)(file,...rest,(error:Error|null,value?:number)=>done(error,value===undefined?value:fd(name(file),value)));}) as typeof fs.open;
 fs.closeSync=((value:number)=>{descriptors.delete(value);real.closeSync(value);}) as typeof fs.closeSync;
 fs.close=((value:number,done?:(error:Error|null)=>void)=>{descriptors.delete(value);real.close(value,done??(()=>{}));}) as typeof fs.close;
 fs.watch=((file:fs.PathLike,...rest:unknown[])=>{const watcher=(real.watch as (...values:unknown[])=>fs.FSWatcher)(file,...rest);let closed=false;watcher.once('close',()=>{closed=true;});opened.push({kind:'watcher',path:name(file),open:()=>!closed,close:()=>watcher.close()});return watcher;}) as typeof fs.watch;
 const polled=new Map<string,Opened>();
 fs.watchFile=((file:fs.PathLike,...rest:unknown[])=>{const at=name(file),item:Opened={kind:'watcher',path:at,open:()=>polled.get(at)===item,close:()=>{polled.delete(at);real.unwatchFile(file);}};polled.set(at,item);opened.push(item);return (real.watchFile as (...values:unknown[])=>fs.StatWatcher)(file,...rest);}) as typeof fs.watchFile;
 fs.unwatchFile=((file:fs.PathLike,...rest:unknown[])=>{polled.delete(name(file));(real.unwatchFile as (...values:unknown[])=>void)(file,...rest);}) as typeof fs.unwatchFile;
 fsp.watch=((file:fs.PathLike,options?:{signal?:AbortSignal})=>{const iterator=(real.pWatch as (...values:unknown[])=>AsyncIterableIterator<unknown>)(file,options);let closed=false;const finish=iterator.return?.bind(iterator);iterator.return=(value?:unknown)=>{closed=true;return finish?finish(value):Promise.resolve({done:true,value});};options?.signal?.addEventListener('abort',()=>{closed=true;},{once:true});opened.push({kind:'watcher',path:name(file),open:()=>!closed,close:()=>{void iterator.return?.();}});return iterator;}) as typeof fsp.watch;
 syncBuiltinESMExports();
 const restore=()=>{fsp.open=real.open;fsp.opendir=real.opendir;fs.open=real.fsOpen;fs.openSync=real.openSync;fs.close=real.close;fs.closeSync=real.closeSync;fs.opendir=real.fsOpendir;fs.opendirSync=real.opendirSync;fs.watch=real.watch;fs.watchFile=real.watchFile;fs.unwatchFile=real.unwatchFile;fsp.watch=real.pWatch;syncBuiltinESMExports();};
 t.after(restore);
 return {
  /** How many files, folders and watchers under `roots` were opened since tracking began. */
  opens:(roots:string[])=>opened.filter(item=>inside(item.path,roots)).length,
  /** What is still open under `roots`, as "file <path>" lines; each one found is closed. */
  held(roots:string[]):string[]{
   const left=opened.filter(item=>inside(item.path,roots)&&item.open());
   for(const item of left)item.close();
   return left.map(item=>`${item.kind} ${item.path}`);
  },
  restore,
 };
}
