import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { checkAbort, digest, identity, isStatRecord, sameStat, statKey, statRecord, syncDirectory, type StatRecord } from './paths';
import { libraryPartition, readSealedRecord, replaceSealed, storeFolder, storeFor, storesFor } from './app-store';

/** Per-destination cache of verified SHA-256 values, sealed, in the records folder: Libraries/<library>/index.json.
 */
export const INDEX_PREFIX='photo-importer-index';
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
/** The first sealed record of this kind, in the stores readers consult, that belongs to this root (same identity, a `files` object); undefined when none does. */
export async function loadRootRecord(root:string,rootIdentity:string,fileName:string,kind:Parameters<typeof readSealedRecord>[0],maxBytes:number,read?:Parameters<typeof readSealedRecord>[3]):Promise<Record<string,unknown>|undefined>{
  for(const file of await indexLocations(root,fileName)) {
    try {
      const data=await readSealedRecord(kind,file,maxBytes,read);
      if(!data) continue;
      if(data.rootIdentity!==rootIdentity || !data.files || typeof data.files!=='object') continue;
      return data;
    } catch { /* Missing, unreadable, corrupt, from another volume or another Mac's: try the next, else start empty and rebuild. */ }
  }
  return undefined;
}
/** Atomic, serialized writes of one root's record: a dirty flag, a guard that the root is still the same volume, and re-dirtying when the write fails. */
export class RootRecordWriter {
  private dirty=false;
  private writing:Promise<void>=Promise.resolve();
  constructor(private readonly root:string,private readonly rootIdentity:string,private readonly fileName:string,private readonly kind:Parameters<typeof replaceSealed>[0]) {}
  mark():void {this.dirty=true;}
  flush(payload:()=>Record<string,unknown>):Promise<void> {
    const write=this.writing.then(async()=>{
      if(!this.dirty) return;
      if(await identity(this.root).catch(()=>undefined)!==this.rootIdentity) return;
      this.dirty=false;
      let target:string;
      try { target=await indexTarget(this.root,this.fileName); } catch(error) { this.dirty=true; throw error; }
      // A cache is replaced in one step; a crash leaves either version (and a temp file the cleanup removes after an hour).
      try { await replaceSealed(this.kind,target,this.kind,{rootIdentity:this.rootIdentity,files:payload()}); } catch(error) { this.dirty=true; throw error; }
    });
    this.writing=write.catch(()=>{});
    return write;
  }
}
interface Recorded extends StatRecord {sha256:string;}
/** FAT and exFAT report ctime equal to mtime and reuse entry numbers as inodes, so
 * there an unchanged stat proves nothing; such files are always read again. */
export const provable=(stat:BigIntStats)=>stat.ctimeNs!==stat.mtimeNs;
/** Whether a cached record still describes the file: a provable stat with every recorded field unchanged. */
export function provablySame(recorded:StatRecord,stat:BigIntStats):boolean {
  if(!provable(stat)) return false;
  const now=statRecord(stat);
  return recorded.dev===now.dev && recorded.ino===now.ino && recorded.size===now.size && recorded.mtime===now.mtime && recorded.ctime===now.ctime;
}
/** Every stat field, birth time included: what a short-lived, in-memory reuse is bound to. */
export const full=(stat:BigIntStats)=>`${statKey(stat)}:${stat.birthtimeNs}`;
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
  private readonly writer:RootRecordWriter;
  /** This session's listing of the library (path and size of each file), for the lookup of files filed elsewhere. Dropped with the index, and when the library is reorganized. */
  listing?:Promise<{path:string;size:number}[]>;
  constructor(readonly root:string,readonly rootIdentity:string) {this.writer=new RootRecordWriter(root,rootIdentity,INDEX_FILE,'index');}
  /** `onBytes`: bytes of the index file read so far and its size, as it is read (it can be hundreds of MB on a slow drive). */
  static async load(root:string,rootIdentity:string,onBytes?:(read:number,total:number)=>void):Promise<DestinationIndex> {
    const index=new DestinationIndex(root,rootIdentity);
    // Sealed: a digest read from here can let a copy be skipped, so only this Mac's own record is trusted.
    const data=await loadRootRecord(root,rootIdentity,INDEX_FILE,'index',MAX_INDEX_BYTES,(name,size)=>readWhole(name,size,onBytes));
    if(data) index.load(data.files as Record<string,Recorded>);
    return index;
  }
  /** Take the recorded digests of a stored index (this one's, or the earlier version's being converted). */
  load(files:Record<string,Recorded>):void {
    for(const [relative,value] of Object.entries(files))
      if(isStatRecord(value) && typeof (value as Recorded).sha256==='string' && /^[a-f0-9]{64}$/.test((value as Recorded).sha256)) this.files.set(relative,value);
  }
  private key(file:string):string {return path.relative(this.root,file);}
  /** SHA-256 of a regular file inside the root, reusing a still-valid record. */
  async digestOf(file:string,signal?:AbortSignal):Promise<string> {
    checkAbort(signal);
    const before=await fs.lstat(file,{bigint:true}),known=this.files.get(this.key(file));
    if(known && provablySame(known,before)) return known.sha256;
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
    return known&&provablySame(known,stat)?known.sha256:undefined;
  }
  /** Record a digest computed from bytes this app just wrote or verified. */
  remember(file:string,sha256:string,stat:BigIntStats):void {
    if(!stat.isFile() || !provable(stat)) return;
    this.files.set(this.key(file),{...statRecord(stat),sha256});this.writer.mark();
  }
  forget(file:string):void {this.hints.delete(file);if(this.files.delete(this.key(file)))this.writer.mark();}
  clear():void {this.listing=undefined;this.hints.clear();if(this.files.size){this.files.clear();this.writer.mark();}}
  /** Atomic replace: write a sibling, fsync, rename, fsync the folder. */
  flush():Promise<void> {return this.writer.flush(()=>Object.fromEntries(this.files));}
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
