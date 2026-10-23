import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { checkAbort, digest, identity, sameStat, statKey, syncDirectory } from './paths';
import { libraryPartition, openV5, sealV5, storeFolder, storeFor, storesFor } from './app-store';

/** Per-destination cache of verified SHA-256 values, sealed, in the records folder: Libraries/<library>/index.json.
 * The earlier version kept it in the library (its names stay ignored by inventory; the converter moves it). */
export const INDEX_PREFIX='photo-importer-index';
export const LEGACY_INDEX_NAMES=[`${INDEX_PREFIX}.json`,`.${INDEX_PREFIX}.json`];
/** Each library's folder of cached records in the store. */
export const LIBRARIES='Libraries',INDEX_FILE='index.json';
const MAX_INDEX_BYTES=256*1024*1024;
/** Where the index of `root` is read from (every store readers consult) and written to (the store `root` writes to). */
export async function indexLocations(root:string,name:string):Promise<string[]>{
  return (await storesFor(root).catch(()=>[])).map(store=>path.join(store.path,LIBRARIES,libraryPartition(store,root),name));
}
export async function indexTarget(root:string,name:string):Promise<string>{
  const store=await storeFor(root);return path.join(await storeFolder(store,LIBRARIES,libraryPartition(store,root)),name);
}
interface Recorded {dev:string;ino:string;size:string;mtime:string;ctime:string;sha256:string;}
const fingerprint=(stat:BigIntStats)=>({dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtime:String(stat.mtimeNs),ctime:String(stat.ctimeNs)});
/** FAT and exFAT report ctime equal to mtime and reuse entry numbers as inodes, so
 * there an unchanged stat proves nothing; such files are always hashed. */
const provable=(stat:BigIntStats)=>stat.ctimeNs!==stat.mtimeNs;
/** Every stat field, birth time included: what a short-lived, in-memory reuse is bound to. */
const full=(stat:BigIntStats)=>`${statKey(stat)}:${stat.birthtimeNs}`;
/** What the duplicate checks need: a destination file's SHA-256. */
export interface Digests {digestOf(file:string,signal?:AbortSignal):Promise<string>;}
/** Reuse a digest while the file's whole stat is unchanged; `memo` decides how long. */
async function memoized(memo:Map<string,{stat:string;sha256:string}>,file:string,compute:()=>Promise<string>,also?:Map<string,{stat:string;sha256:string}>):Promise<string> {
  const before=await fs.lstat(file,{bigint:true}),known=memo.get(file);
  if(known&&known.stat===full(before)) return known.sha256;
  const sha256=await compute(),after=await fs.lstat(file,{bigint:true});
  if(sameStat(before,after)&&before.birthtimeNs===after.birthtimeNs) {const value={stat:full(after),sha256};memo.set(file,value);also?.set(file,value);}
  else also?.delete(file);
  return sha256;
}
function unchanged(recorded:Recorded,stat:BigIntStats):boolean {
  if(!provable(stat)) return false;
  const now=fingerprint(stat);
  return recorded.dev===now.dev && recorded.ino===now.ino && recorded.size===now.size && recorded.mtime===now.mtime && recorded.ctime===now.ctime;
}

/** The file's text, read in chunks so a large index reports how far it is. */
async function readWhole(file:string,size:number,onBytes?:(read:number,total:number)=>void):Promise<string> {
  const handle=await fs.open(file,'r');
  try {
    const bytes=Buffer.alloc(size);let filled=0;onBytes?.(0,size);
    while(filled<size) {
      const {bytesRead}=await handle.read(bytes,filled,Math.min(8*1024*1024,size-filled),filled);
      if(!bytesRead) break;
      filled+=bytesRead;onBytes?.(filled,size);
    }
    return bytes.subarray(0,filled).toString('utf8');
  } finally { await handle.close(); }
}

/** A cache only: an entry is trusted solely while every recorded stat field
 * still matches, so a touched, replaced or moved file is always hashed again. */
export class DestinationIndex implements Digests {
  private files=new Map<string,Recorded>();
  private hints=new Map<string,{stat:string;sha256:string}>();
  private dirty=false;
  /** This session's listing of the library (path and size of each file), for the lookup of files filed elsewhere. Dropped with the index, and when the library is reorganized. */
  listing?:Promise<{path:string;size:number}[]>;
  private writing:Promise<void>=Promise.resolve();
  constructor(readonly root:string,readonly rootIdentity:string) {}
  /** `onBytes`: bytes of the index file read so far and its size, as it is read (it can be hundreds of MB on a slow drive). */
  static async load(root:string,rootIdentity:string,onBytes?:(read:number,total:number)=>void):Promise<DestinationIndex> {
    const index=new DestinationIndex(root,rootIdentity);
    for(const file of await indexLocations(root,INDEX_FILE)) {
      try {
        const stat=await fs.lstat(file);
        if(!stat.isFile() || stat.size>MAX_INDEX_BYTES) continue;
        // Sealed: a digest read from here can let a copy be skipped, so only this Mac's own record is trusted.
        const data=openV5('index',JSON.parse(await readWhole(file,stat.size,onBytes)));
        if(data.rootIdentity!==rootIdentity || !data.files || typeof data.files!=='object') continue;
        index.load(data.files as Record<string,Recorded>);
        return index;
      } catch { /* Missing, unreadable, corrupt or another Mac's: start empty and rebuild. */ }
    }
    return index;
  }
  /** Take the recorded digests of a stored index (this one's, or the earlier version's being converted). */
  load(files:Record<string,Recorded>):void {
    for(const [relative,value] of Object.entries(files))
      if(value && ['dev','ino','size','mtime','ctime','sha256'].every(key=>typeof (value as unknown as Record<string,unknown>)[key]==='string') && /^[a-f0-9]{64}$/.test(value.sha256)) this.files.set(relative,value);
  }
  private key(file:string):string {return path.relative(this.root,file);}
  /** SHA-256 of a regular file inside the root, reusing a still-valid record. */
  async digestOf(file:string,signal?:AbortSignal):Promise<string> {
    checkAbort(signal);
    const before=await fs.lstat(file,{bigint:true}),known=this.files.get(this.key(file));
    if(known && unchanged(known,before)) return known.sha256;
    const sha256=await digest(file,signal),after=await fs.lstat(file,{bigint:true});
    // Record only the stat the hash was computed under; a change in between is not cached.
    if(sameStat(before,after)) this.remember(file,sha256,after);
    return sha256;
  }
  /** For answers that are only hints, checked again before anything is trusted (planning and
   * the copy preflight): also reuses, for this app session, the digest of a file whose every stat
   * field is unchanged where the filesystem cannot prove identity (FAT, exFAT), so a library
   * already on such a drive is read once per import, not once per check. */
  // Authoritative reads (section) replace a hint, so a file edited in place without changing
  // its stat is caught by the next confirmation and planned correctly from then on.
  readonly hinted:Digests={digestOf:(file,signal)=>memoized(this.hints,file,()=>this.digestOf(file,signal))};
  /** Checks that decide together, inside one hold of the publication lock: a file read by the
   * first and unchanged since is not read again by the next. */
  section():Digests {const memo=new Map<string,{stat:string;sha256:string}>();return {digestOf:(file,signal)=>memoized(memo,file,()=>this.digestOf(file,signal),this.hints)};}
  /** The recorded digest of a file whose whole stat still matches, without reading it. */
  cached(file:string,stat:BigIntStats):string|undefined {
    const known=this.files.get(this.key(file));
    return known&&unchanged(known,stat)?known.sha256:undefined;
  }
  /** Record a digest computed from bytes this app just wrote or verified. */
  remember(file:string,sha256:string,stat:BigIntStats):void {
    if(!stat.isFile() || !provable(stat)) return;
    this.files.set(this.key(file),{...fingerprint(stat),sha256});this.dirty=true;
  }
  forget(file:string):void {this.hints.delete(file);if(this.files.delete(this.key(file)))this.dirty=true;}
  clear():void {this.listing=undefined;this.hints.clear();if(this.files.size){this.files.clear();this.dirty=true;}}
  /** Atomic replace: write a sibling, fsync, rename, fsync the folder. */
  flush():Promise<void> {
    const write=this.writing.then(async()=>{
      if(!this.dirty) return;
      if(await identity(this.root).catch(()=>undefined)!==this.rootIdentity) return;
      this.dirty=false;
      let target:string;
      try { target=await indexTarget(this.root,INDEX_FILE); } catch(error) { this.dirty=true; throw error; }
      const temporary=path.join(path.dirname(target),`index-${randomUUID()}.tmp`);
      try {
        const handle=await fs.open(temporary,'wx',0o600);
        try { await handle.writeFile(JSON.stringify(sealV5('index',{rootIdentity:this.rootIdentity,files:Object.fromEntries(this.files)}))); await handle.sync(); }
        finally { await handle.close(); }
        // A cache is replaced in one step; a crash leaves either version (and a temp file the cleanup removes after an hour).
        await fs.rename(temporary,target);
      } catch(error) { await fs.unlink(temporary).catch(()=>{}); this.dirty=true; throw error; }
      await syncDirectory(path.dirname(target));
    });
    this.writing=write.catch(()=>{});
    return write;
  }
}
const indexes=new Map<string,Promise<DestinationIndex>>();
const loading=new Map<string,Set<(read:number,total:number)=>void>>();
/** One shared index per destination root and identity for this app session. `onBytes` hears the load while it runs
 * (also when another caller started it); an index already loaded reports nothing. */
export function destinationIndex(root:string,rootIdentity:string,onBytes?:(read:number,total:number)=>void):Promise<DestinationIndex> {
  const key=`${root}\0${rootIdentity}`;
  let index=indexes.get(key);
  if(!index){
    const listeners=new Set<(read:number,total:number)=>void>();loading.set(key,listeners);
    if(onBytes)listeners.add(onBytes);
    index=DestinationIndex.load(root,rootIdentity,(read,total)=>{for(const listener of listeners)listener(read,total);});
    indexes.set(key,index);index.catch(()=>indexes.delete(key));
    index.then(()=>{},()=>{}).then(()=>{if(loading.get(key)===listeners)loading.delete(key);});
  } else if(onBytes)loading.get(key)?.add(onBytes);
  return index;
}
/** Start over as a new app session does: later lookups load from disk. */
export function dropDestinationIndexes():void {indexes.clear();}
/** Best effort: an index write failure never fails a verified copy. */
export async function flushIndex(index:DestinationIndex):Promise<void> {
  try { await index.flush(); } catch { /* The next verified copy rewrites it. */ }
}
