import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { checkAbort, digest, identity, sameStat, statKey, syncDirectory } from './paths';

/** Per-destination cache of verified SHA-256 values. Its names (and the older hidden ones) are ignored by inventory. */
export const INDEX_PREFIX='photo-importer-index';
const INDEX_NAME=`${INDEX_PREFIX}.json`, LEGACY_INDEX_NAME=`.${INDEX_NAME}`, MAX_INDEX_BYTES=256*1024*1024;
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

/** A cache only: an entry is trusted solely while every recorded stat field
 * still matches, so a touched, replaced or moved file is always hashed again. */
export class DestinationIndex implements Digests {
  private files=new Map<string,Recorded>();
  private hints=new Map<string,{stat:string;sha256:string}>();
  private dirty=false;
  private writing:Promise<void>=Promise.resolve();
  constructor(readonly root:string,readonly rootIdentity:string) {}
  static async load(root:string,rootIdentity:string):Promise<DestinationIndex> {
    const index=new DestinationIndex(root,rootIdentity);
    for(const name of [INDEX_NAME,LEGACY_INDEX_NAME]) {
      try {
        const file=path.join(root,name),stat=await fs.lstat(file);
        if(!stat.isFile() || stat.size>MAX_INDEX_BYTES) continue;
        const data=JSON.parse(await fs.readFile(file,'utf8'));
        if(data?.version!==1 || data.rootIdentity!==rootIdentity || !data.files || typeof data.files!=='object') continue;
        for(const [relative,value] of Object.entries(data.files as Record<string,Recorded>))
          if(value && ['dev','ino','size','mtime','ctime','sha256'].every(key=>typeof (value as unknown as Record<string,unknown>)[key]==='string') && /^[a-f0-9]{64}$/.test(value.sha256)) index.files.set(relative,value);
        if(name===LEGACY_INDEX_NAME) index.dirty=true; // Rewritten under the visible name by the next flush.
        return index;
      } catch { /* Missing, unreadable or corrupt: try the older name, else start empty and rebuild. */ }
    }
    return index;
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
  /** Record a digest computed from bytes this app just wrote or verified. */
  remember(file:string,sha256:string,stat:BigIntStats):void {
    if(!stat.isFile() || !provable(stat)) return;
    this.files.set(this.key(file),{...fingerprint(stat),sha256});this.dirty=true;
  }
  forget(file:string):void {this.hints.delete(file);if(this.files.delete(this.key(file)))this.dirty=true;}
  clear():void {this.hints.clear();if(this.files.size){this.files.clear();this.dirty=true;}}
  /** Atomic replace: write a sibling, fsync, rename, fsync the folder. */
  flush():Promise<void> {
    const write=this.writing.then(async()=>{
      if(!this.dirty) return;
      if(await identity(this.root).catch(()=>undefined)!==this.rootIdentity) return;
      this.dirty=false;
      const target=path.join(this.root,INDEX_NAME),temporary=path.join(this.root,`${INDEX_PREFIX}-${randomUUID()}.tmp`);
      try {
        const handle=await fs.open(temporary,'wx',0o600);
        try { await handle.writeFile(JSON.stringify({version:1,rootIdentity:this.rootIdentity,files:Object.fromEntries(this.files)})); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary,target);
      } catch(error) { await fs.unlink(temporary).catch(()=>{}); this.dirty=true; throw error; }
      await fs.unlink(path.join(this.root,LEGACY_INDEX_NAME)).catch(()=>{});
      await syncDirectory(this.root);
    });
    this.writing=write.catch(()=>{});
    return write;
  }
}
const indexes=new Map<string,Promise<DestinationIndex>>();
/** One shared index per destination root and identity for this app session. */
export function destinationIndex(root:string,rootIdentity:string):Promise<DestinationIndex> {
  const key=`${root}\0${rootIdentity}`;
  let index=indexes.get(key);
  if(!index){index=DestinationIndex.load(root,rootIdentity);indexes.set(key,index);index.catch(()=>indexes.delete(key));}
  return index;
}
/** Start over as a new app session does: later lookups load from disk. */
export function dropDestinationIndexes():void {indexes.clear();}
/** Best effort: an index write failure never fails a verified copy. */
export async function flushIndex(index:DestinationIndex):Promise<void> {
  try { await index.flush(); } catch { /* The next verified copy rewrites it. */ }
}
