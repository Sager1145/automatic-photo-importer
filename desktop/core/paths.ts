import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function checkAbort(signal?:AbortSignal):void {
  if(signal?.aborted) throw new DOMException('Import stopped','AbortError');
}
export function isAbort(error:unknown):boolean { return error instanceof Error && error.name==='AbortError'; }
export function code(error:unknown):string|undefined { return (error as NodeJS.ErrnoException)?.code; }
export function beneath(child:string,root:string):boolean {
  const relative=path.relative(root,child);
  return relative!=='' && relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);
}
/** Inclusive containment: the root itself or anything beneath it. */
export function within(child:string,root:string):boolean {return path.relative(root,child)===''||beneath(child,root);}
export async function directory(selected:string):Promise<string> {
  const canonical=await fs.realpath(path.resolve(selected));
  if(!(await fs.stat(canonical)).isDirectory()) throw new Error(`Directory unavailable: ${selected}`);
  return canonical;
}
export async function identity(root:string):Promise<string> {
  const stat=await fs.lstat(root,{bigint:true});
  if(!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe destination directory: ${root}`);
  return `${stat.dev}:${stat.ino}`;
}
export async function rootUnchanged(root:string,expected:string):Promise<void> {
  if(await identity(root)!==expected || await fs.realpath(root)!==root) throw new Error(`Destination identity changed; scan again: ${root}`);
}
/** Strict directory durability: unsupported filesystems must not acknowledge a backup. */
export async function syncDirectory(folder:string):Promise<void> {
  let handle:Awaited<ReturnType<typeof fs.open>>|undefined;
  try {
    handle=await fs.open(folder,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    if(!(await handle.stat()).isDirectory())throw new Error(`Unsafe directory: ${folder}`);
    await handle.sync();
  } catch(error){throw Object.assign(new Error(`Directory synchronization failed: ${folder}: ${error instanceof Error?error.message:String(error)}`,{cause:error}),{code:code(error)});}
  finally {await handle?.close();}
}
export async function syncParents(file:string,root:string):Promise<void> {
  for(let folder=path.dirname(file);;folder=path.dirname(folder)){await syncDirectory(folder);if(folder===root)break;if(!beneath(folder,root))throw new Error('Unsafe synchronization scope');}
}
export async function syncFile(file:string):Promise<void> {const handle=await regularHandle(file);try{await handle.sync();}finally{await handle.close();}}
/** Check every existing path component, including ancestors of a missing leaf. */
export async function contained(file:string,root:string):Promise<void> {
  if(!beneath(path.resolve(file),root)) throw new Error(`Unsafe path outside selected folder: ${file}`);
  const parts=path.relative(root,file).split(path.sep);
  let current=root;
  for(let i=0;i<parts.length;i++) {
    current=path.join(current,parts[i]!);
    try {
      const stat=await fs.lstat(current);
      if(stat.isSymbolicLink()) throw new Error(`Unsafe symbolic link: ${current}`);
      if(i<parts.length-1 && !stat.isDirectory()) throw new Error(`Unsafe non-directory ancestor: ${current}`);
      if(!beneath(await fs.realpath(current),root)) throw new Error(`Unsafe resolved path: ${current}`);
    } catch(error) { if(code(error)==='ENOENT') return; throw error; }
  }
}
export async function makeParent(file:string,root:string):Promise<void> {
  await contained(file,root);
  const parts=path.relative(root,path.dirname(file)).split(path.sep).filter(Boolean);
  let current=root;
  for(const part of parts) {
    current=path.join(current,part);
    try { await fs.mkdir(current); } catch(error) { if(code(error)!=='EEXIST') throw error; }
    await contained(current,root);
    if(!(await fs.lstat(current)).isDirectory()) throw new Error(`Unsafe parent: ${current}`);
  }
  await contained(file,root);
}
export function validateRelative(folder:string):void {
  if(!folder || path.isAbsolute(folder) || /[\\:\x00-\x1f\x7f]/u.test(folder) || folder.split('/').some(p=>!p || p==='.' || p==='..' || p.trim()!==p || /[. ]$/.test(p) || /[<>"|?*]/u.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error(`Invalid relative folder: ${folder}`);
  }
}
export function safeComponent(value:string):string {
  let result=value.normalize('NFC').replace(/[\\/:\x00-\x1f\x7f<>"|?*]/gu,'-').trim().replace(/[. ]+$/u,'').slice(0,120);
  if(!result || result==='.' || result==='..') result='Unknown Camera';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result='_'+result;
  return result;
}
export const fileFlags=constants.O_RDONLY | (constants.O_NOFOLLOW??0);
export async function regularHandle(file:string) {
  if(!(await fs.lstat(file)).isFile()) throw new Error(`Unsafe non-regular source: ${file}`);
  const handle=await fs.open(file,fileFlags);
  const stat=await handle.stat({bigint:true});
  if(!stat.isFile()) { await handle.close(); throw new Error(`Unsafe non-regular source: ${file}`); }
  return handle;
}
export function sameStat(a:import('node:fs').BigIntStats,b:import('node:fs').BigIntStats):boolean {
  return a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeNs===b.mtimeNs && a.ctimeNs===b.ctimeNs;
}
/** dev:ino:size:mtimeNs:ctimeNs — the identity a plan, review or receipt binds a file to. */
export function statKey(stat:import('node:fs').BigIntStats):string {return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;}
export async function digest(file:string,signal?:AbortSignal):Promise<string> {
  checkAbort(signal);
  const handle=await regularHandle(file);
  try {
    const before=await handle.stat({bigint:true});
    const hash=createHash('sha256'), buffer=Buffer.allocUnsafe(1024*1024);
    for(;;) {
      checkAbort(signal);
      const {bytesRead}=await handle.read(buffer,0,buffer.length,null);
      if(!bytesRead) break;
      hash.update(buffer.subarray(0,bytesRead));
    }
    const after=await handle.stat({bigint:true});
    const pathname=await fs.lstat(file,{bigint:true});
    if(!sameStat(before,after) || !sameStat(after,pathname)) throw new Error(`File changed while reading; scan again: ${file}`);
    return hash.digest('hex');
  } finally { await handle.close(); }
}
export function pathKey(file:string):string { return file.normalize('NFC').toLowerCase(); }
