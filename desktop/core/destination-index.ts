import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { checkAbort, digest, identity, sameStat, syncDirectory } from './paths';

/** Per-destination cache of verified SHA-256 values. Name prefix is ignored by inventory. */
export const INDEX_PREFIX='.photo-importer-index';
const INDEX_NAME=`${INDEX_PREFIX}.json`, MAX_INDEX_BYTES=256*1024*1024;
interface Recorded {dev:string;ino:string;size:string;mtime:string;ctime:string;sha256:string;}
const fingerprint=(stat:BigIntStats)=>({dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtime:String(stat.mtimeNs),ctime:String(stat.ctimeNs)});
/** FAT and exFAT report ctime equal to mtime and reuse entry numbers as inodes, so
 * there an unchanged stat proves nothing; such files are always hashed. */
const provable=(stat:BigIntStats)=>stat.ctimeNs!==stat.mtimeNs;
function unchanged(recorded:Recorded,stat:BigIntStats):boolean {
  if(!provable(stat)) return false;
  const now=fingerprint(stat);
  return recorded.dev===now.dev && recorded.ino===now.ino && recorded.size===now.size && recorded.mtime===now.mtime && recorded.ctime===now.ctime;
}

/** A cache only: an entry is trusted solely while every recorded stat field
 * still matches, so a touched, replaced or moved file is always hashed again. */
export class DestinationIndex {
  private files=new Map<string,Recorded>();
  private dirty=false;
  private writing:Promise<void>=Promise.resolve();
  constructor(readonly root:string,readonly rootIdentity:string) {}
  static async load(root:string,rootIdentity:string):Promise<DestinationIndex> {
    const index=new DestinationIndex(root,rootIdentity);
    try {
      const file=path.join(root,INDEX_NAME),stat=await fs.lstat(file);
      if(!stat.isFile() || stat.size>MAX_INDEX_BYTES) return index;
      const data=JSON.parse(await fs.readFile(file,'utf8'));
      if(data?.version!==1 || data.rootIdentity!==rootIdentity || !data.files || typeof data.files!=='object') return index;
      for(const [relative,value] of Object.entries(data.files as Record<string,Recorded>))
        if(value && ['dev','ino','size','mtime','ctime','sha256'].every(key=>typeof (value as unknown as Record<string,unknown>)[key]==='string') && /^[a-f0-9]{64}$/.test(value.sha256)) index.files.set(relative,value);
    } catch { /* Missing, unreadable or corrupt: start empty and rebuild. */ }
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
  /** Record a digest computed from bytes this app just wrote or verified. */
  remember(file:string,sha256:string,stat:BigIntStats):void {
    if(!stat.isFile() || !provable(stat)) return;
    this.files.set(this.key(file),{...fingerprint(stat),sha256});this.dirty=true;
  }
  forget(file:string):void {if(this.files.delete(this.key(file)))this.dirty=true;}
  clear():void {if(this.files.size){this.files.clear();this.dirty=true;}}
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
