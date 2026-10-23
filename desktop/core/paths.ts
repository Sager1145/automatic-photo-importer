import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { hasher } from './hasher';
import { streams } from './devices';
import { volumeAt } from '../platform/volumes';
import { execFile } from 'node:child_process';

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
// A folder's entries change when a file is published into it, and its ancestors' only when a
// subfolder is created. So the file's own folder is always synchronized, and an ancestor only
// when makeParent created a subfolder in it, or the first time this process meets it (a folder
// left by an interrupted run may never have been synchronized).
// A sync in progress is shared: a caller that would skip the folder waits for it instead, and
// gets its failure, so nobody returns before the folder is on disk.
const changedFolders=new Set<string>(),durableFolders=new Set<string>(),syncing=new Map<string,Promise<void>>();
// Folder flushes of a copy run are grouped. commitFolder joins a flush of the folder that has been queued but not started
// (it will start after this request, so it covers every change made before it) and otherwise queues one behind the flush
// running now: a request never joins a flush that has already started, which may have missed its change. A flush that
// fails fails every request waiting on it and is not retried. dirtyFolder marks a change nobody waits on (a receipt
// removed after its file was made durable): the next commit of that folder, a 250 ms timer or flushFolders covers it.
const queuedCommits=new Map<string,Promise<void>>(),runningCommits=new Map<string,Promise<void>>(),lazyFolders=new Set<string>();
let lazyTimer:ReturnType<typeof setTimeout>|undefined;
export function commitFolder(folder:string):Promise<void> {
  const queued=queuedCommits.get(folder);
  if(queued) return queued;
  const previous=runningCommits.get(folder);
  let start!:()=>void;
  const turn=new Promise<void>(resolve=>{start=resolve;});
  const commit=turn.then(async()=>{
    // From here on this flush has started: later requests queue another, and what was marked lazily is covered.
    queuedCommits.delete(folder);lazyFolders.delete(folder);
    const flush=syncDirectory(folder);runningCommits.set(folder,flush);
    try { await flush; } finally { if(runningCommits.get(folder)===flush) runningCommits.delete(folder); }
  });
  queuedCommits.set(folder,commit);
  // Requests of the same tick still join; it starts once the flush running now (if any) has ended, whatever its outcome.
  if(previous) void previous.then(start,start); else queueMicrotask(start);
  return commit;
}
/** A folder entry changed that nothing waits on; see commitFolder. */
export function dirtyFolder(folder:string):void {
  lazyFolders.add(folder);
  lazyTimer??=setTimeout(()=>{lazyTimer=undefined;void flushFolders();},250);
  lazyTimer.unref?.();
}
/** Flushes every folder marked by dirtyFolder. A failure leaves only advisory changes (removed receipts) undone, so it is not raised. */
export async function flushFolders():Promise<void> {
  if(lazyTimer){clearTimeout(lazyTimer);lazyTimer=undefined;}
  await Promise.all([...lazyFolders].map(folder=>commitFolder(folder).catch(()=>{})));
}
/** A folder whose entries changed outside a publication (a file removed from it): the next synchronization that passes through it as an ancestor covers it. */
export function markFolderChanged(folder:string):void {changedFolders.add(folder);}
export async function syncParents(file:string,root:string):Promise<void> {
  for(let folder=path.dirname(file),own=true;;folder=path.dirname(folder),own=false){
    // An ancestor unchanged since a sync of it started is covered by that sync.
    if(own||changedFolders.has(folder)||(!durableFolders.has(folder)&&!syncing.has(folder))){
      // Cleared first, so a subfolder created during this sync marks the folder again.
      changedFolders.delete(folder);
      const sync=commitFolder(folder).then(()=>{durableFolders.add(folder);},error=>{changedFolders.add(folder);throw error;});
      syncing.set(folder,sync);
      try{await sync;}finally{if(syncing.get(folder)===sync)syncing.delete(folder);}
    } else await syncing.get(folder);
    if(folder===root)break;if(!beneath(folder,root))throw new Error('Unsafe synchronization scope');
  }
}
export async function syncFile(file:string):Promise<void> {const handle=await regularHandle(file);try{await handle.sync();}finally{await handle.close();}}
/** Check every existing path component, including ancestors of a missing leaf. */
export async function contained(file:string,root:string):Promise<void> {
  if(!beneath(path.resolve(file),root)) throw new Error(`Unsafe path outside selected folder: ${file}`);
  const parts=path.relative(root,file).split(path.sep);
  let current=root,deepest:string|undefined;
  for(let i=0;i<parts.length;i++) {
    current=path.join(current,parts[i]!);
    try {
      const stat=await fs.lstat(current);
      if(stat.isSymbolicLink()) throw new Error(`Unsafe symbolic link: ${current}`);
      if(i<parts.length-1 && !stat.isDirectory()) throw new Error(`Unsafe non-directory ancestor: ${current}`);
      deepest=current;
    } catch(error) { if(code(error)==='ENOENT') break; throw error; }
  }
  // One resolution of the deepest existing component covers every ancestor: a component
  // replaced by a link after its own check still resolves outside `root` here.
  if(deepest) try { if(!beneath(await fs.realpath(deepest),root)) throw new Error(`Unsafe resolved path: ${deepest}`); } catch(error) { if(code(error)!=='ENOENT') throw error; }
}
/** With rootIdentity, every folder is created only while the root is still that volume: a drive
 * unmounted mid-run leaves an empty mount folder on the system disk, and nothing may be written there.
 * Folders this call created are removed again (empty only) when it fails. */
export async function makeParent(file:string,root:string,rootIdentity?:string):Promise<void> {
  await contained(file,root);
  const rootDevice=rootIdentity?.split(':')[0];
  // Fast path: the folder already exists as a plain directory on the root's device, and contained() has just
  // checked every component above it, so there is nothing to create and no per-part check to repeat.
  // It never creates anything; any other case runs the full loop below.
  const existing=await fs.lstat(path.dirname(file),{bigint:true}).then(stat=>stat.isDirectory()&&!stat.isSymbolicLink()&&(!rootIdentity||String(stat.dev)===rootDevice),()=>false);
  if(existing) {
    if(rootIdentity) await rootUnchanged(root,rootIdentity);
    await contained(file,root);
    return;
  }
  const parts=path.relative(root,path.dirname(file)).split(path.sep).filter(Boolean);
  const created:string[]=[];
  let current=root;
  try {
    for(const part of parts) {
      current=path.join(current,part);
      if(rootIdentity) await rootUnchanged(root,rootIdentity);
      try { await fs.mkdir(current); created.push(current); changedFolders.add(path.dirname(current)); } catch(error) { if(code(error)!=='EEXIST') throw error; }
      // Ancestors were checked a step earlier; the whole chain is checked again below.
      const stat=await fs.lstat(current,{bigint:true});
      if(stat.isSymbolicLink()) throw new Error(`Unsafe symbolic link: ${current}`);
      if(!stat.isDirectory()) throw new Error(`Unsafe parent: ${current}`);
      // The volume can vanish between the check and mkdir: the new folder must be on the root's device.
      if(rootIdentity) {
        await rootUnchanged(root,rootIdentity);
        // The root is still the same volume, so a folder on another device is a volume mounted inside it.
        if(String(stat.dev)!==rootDevice) throw new Error(`A folder inside the destination is on another volume: ${current}`);
      }
    }
  } catch(error) {
    // Only when the volume left: removing a fresh folder after any other error could fail another job's file in it.
    if(rootIdentity&&await rootUnchanged(root,rootIdentity).then(()=>false,()=>true)) for(const folder of created.reverse()) await fs.rmdir(folder).catch(()=>undefined);
    throw error;
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
  if(!result || result==='.' || result==='..') result='Unknown files';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result='_'+result;
  return result;
}
export const fileFlags=constants.O_RDONLY | (constants.O_NOFOLLOW??0);
export async function regularHandle(file:string) {
  if(!(await fs.lstat(file)).isFile()) throw new Error(`Unsafe non-regular source: ${file}`);
  const handle=await fs.open(file,fileFlags);
  try {
    const stat=await handle.stat({bigint:true});
    if(!stat.isFile()) throw new Error(`Unsafe non-regular source: ${file}`);
  } catch(error) { await handle.close().catch(()=>{}); throw error; }
  return handle;
}
type Stat=import('node:fs').BigIntStats;
/** exFAT gives a zero-length file no start cluster, so its inode is synthetic (2^63 and up, negative when
 * read as signed) and changes whenever the vnode is recreated. Such an inode proves nothing either way. */
export function unreliableIno(stat:Pick<Stat,'ino'|'size'>):boolean {return stat.size===0n || stat.ino<0n || stat.ino>=2n**63n;}
/** The same file: dev, size and times, plus the inode - or the birth time where either inode cannot be trusted. */
export function sameStat(a:Stat,b:Stat):boolean {
  if(a.dev!==b.dev || a.size!==b.size || a.mtimeNs!==b.mtimeNs || a.ctimeNs!==b.ctimeNs) return false;
  // exFAT swaps an empty or fresh file's synthetic inode for the real one when it is first flushed: that alone is not another file.
  return unreliableIno(a)||unreliableIno(b)?a.birthtimeNs===b.birthtimeNs:a.ino===b.ino;
}
/** exFAT (macOS FSKit) reports a birth time as whole seconds while the file is cached after the date helper set it,
 * and as the stored 10 ms value once re-read from disk. A recorded whole second therefore matches any value in that
 * same second; every other recorded value (APFS nanoseconds included) must match exactly, and so must any negative value. */
export function sameBirth(expected:bigint,found:bigint):boolean {
  if(expected===found) return true;
  return expected>=0n&&found>=0n&&expected%1_000_000_000n===0n&&found/1_000_000_000n===expected/1_000_000_000n;
}
/** dev:ino:size:mtimeNs:ctimeNs - the identity a plan, review or receipt binds a file to (birth time instead of ino when the inode is unreliable). */
export function statKey(stat:Stat):string {return `${stat.dev}:${unreliableIno(stat)?`birth${stat.birthtimeNs}`:stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;}
/** `onBytes` hears each chunk as it is read, so a long file shows progress before it is done. */
export async function digest(file:string,signal?:AbortSignal,onBytes?:(bytes:number)=>void):Promise<string> {
  checkAbort(signal);
  // A stream slot on the file's device: spinning disks read one file at a time.
  return streams.run([file],async chunk=>{
    const handle=await regularHandle(file);
    try {
      const before=await handle.stat({bigint:true});
      // SHA-256 runs on a worker thread while the next chunk is read.
      const hash=hasher(), buffer=Buffer.allocUnsafe(chunk);
      try {
        for(;;) {
          checkAbort(signal);
          const {bytesRead}=await handle.read(buffer,0,buffer.length,null);
          if(!bytesRead) break;
          await hash.update(buffer.subarray(0,bytesRead));onBytes?.(bytesRead);
        }
        const after=await handle.stat({bigint:true});
        const pathname=await fs.lstat(file,{bigint:true});
        if(!sameStat(before,after) || !sameStat(after,pathname)) throw Object.assign(new Error(`File changed while reading; scan again: ${file}`),{changedWhileReading:true});
        return await hash.digest();
      } finally { hash.drop(); }
    } finally { await handle.close(); }
  },signal);
}
export function pathKey(file:string):string { return file.normalize('NFC').toLowerCase(); }

const directVolumes=new Map<string,Promise<boolean>>();
/** Whether files may be written straight to their final names under `root`: only macOS exFAT volumes (LINK_MAX 1 unless the caller
 * says so), which can neither hard-link nor publish a name atomically, so a staging file buys nothing. FAT (msdos) stays staged until
 * its local-time timestamps are probed; APFS, network and FUSE volumes, whose birth times are unproven, keep the staged path too.
 * Answered once per volume UUID, so a path or device number reused by another volume is never taken for the old one. A tool that
 * fails (a busy machine) is asked again once after a pause; if it still fails the answer is "staged" for this call only. */
export async function directCapable(root:string,_rootIdentity:string,exclusiveCopy=false):Promise<boolean> {
  if(process.platform!=='darwin') return false;
  const answer=async():Promise<boolean> => {
    const volume=await volumeAt(root),uuid=volume?.volumeId;
    if(volume?.fsType!=='exfat') return false;
    const key=`${uuid??''}\0${exclusiveCopy}`;
    const check=async()=>exclusiveCopy||(await new Promise<string>((resolve,reject)=>execFile('/usr/bin/getconf',['LINK_MAX',root],{timeout:30000},(error,stdout)=>error?reject(error):resolve(stdout.trim()))))==='1';
    if(!uuid) return check();
    let found=directVolumes.get(key);
    if(!found){found=check();directVolumes.set(key,found);found.catch(()=>directVolumes.delete(key));}
    return found;
  };
  try { return await answer(); }
  catch { await new Promise(resolve=>setTimeout(resolve,500)); return answer().catch(()=>false); }
}
