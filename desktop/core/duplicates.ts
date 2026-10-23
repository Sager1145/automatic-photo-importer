import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import type { DuplicateExif, DuplicateFile, DuplicateGroup, InventoryFile, MediaKind, Metadata, Progress } from '../shared';
import { buildGroups, candidates, groupId } from '../duplicate-rules';
import { inventory } from './inventory';
import { DRIVE_BACKUPS } from './drive-backup';
import { LEGACY_RECOVERY_FOLDER, RECOVERY_FOLDER } from './recovery';
import { PROBLEM_FILES_FOLDER } from '../shared';
import { checkAbort, code, directory, identity, syncDirectory, within } from './paths';
import type { DestinationIndex } from './destination-index';

/** The per-library record of what duplicate detection found: visible, never hidden, and ignored by inventories. */
export const DUPLICATES_PREFIX='photo-importer-duplicates';
/** Folders the app owns, skipped at any depth: mirrors of other drives, the recovery store and collected problem files. */
export const APP_FOLDERS=[DRIVE_BACKUPS,RECOVERY_FOLDER,LEGACY_RECOVERY_FOLDER,PROBLEM_FILES_FOLDER];
/** The destination libraries a chosen folder is, contains or sits inside. More than one means the scan would mix
 * libraries (or pair a library with another), so the folder is refused. */
export function overlappingLibraries(folder:string,libraries:string[]):string[] {
  return [...new Set(libraries)].filter(library=>within(folder,library)||within(library,folder));
}
const NAME=`${DUPLICATES_PREFIX}.json`,MAX_BYTES=256*1024*1024;
interface FileRecord {size:string;mtimeNs:string;ino:string;kind:MediaKind;birth:number;ctime:number;edited:boolean;exif?:DuplicateExif;sha256?:string;/** The file's metadata was read (a record without it only knows size and hash). */read?:boolean;}
interface StoredGroup {strength:DuplicateGroup['strength'];files:string[];}
const unchanged=(record:FileRecord,stat:BigIntStats)=>record.size===String(stat.size)&&record.mtimeNs===String(stat.mtimeNs)&&record.ino===String(stat.ino);
const milliseconds=(value:bigint)=>Number(value)/1e6;
const relativeOf=(root:string,absolute:string)=>path.relative(root,absolute).split(path.sep).join('/');

/** Records of a library's media files and the groups found among them. A record is trusted only while
 * the file's size, modified time and inode are unchanged; anything else is read again. */
export class DuplicateStore {
  files=new Map<string,FileRecord>();
  groups:StoredGroup[]=[];
  /** Every media file of the library was looked at, so `groups` is the whole library's answer. */
  complete=false;
  updated='';
  private dirty=false;
  private writing:Promise<void>=Promise.resolve();
  constructor(readonly root:string,readonly rootIdentity:string) {}
  static async load(root:string,rootIdentity:string):Promise<DuplicateStore> {
    const store=new DuplicateStore(root,rootIdentity);
    try {
      const file=path.join(root,NAME),stat=await fs.lstat(file);
      if(!stat.isFile()||stat.size>MAX_BYTES) return store;
      const data=JSON.parse(await fs.readFile(file,'utf8'));
      if(data?.version!==1||data.rootIdentity!==rootIdentity||!data.files||typeof data.files!=='object') return store;
      for(const [relative,value] of Object.entries(data.files as {[name:string]:FileRecord})) if(value&&typeof value.size==='string'&&typeof value.mtimeNs==='string'&&typeof value.ino==='string'&&typeof value.kind==='string') store.files.set(relative,{...value,birth:Number(value.birth)||0,ctime:Number(value.ctime)||0,edited:!!value.edited});
      store.groups=Array.isArray(data.groups)?data.groups.filter((group:StoredGroup)=>Array.isArray(group?.files)&&group.files.every(item=>typeof item==='string')):[];
      store.complete=data.complete===true;store.updated=String(data.updated??'');
    } catch { /* Missing, unreadable or from another volume: start empty and rebuild. */ }
    return store;
  }
  mark():void {this.dirty=true;}
  /** Atomic replace, like the destination index: write a sibling, fsync, rename, fsync the folder. */
  flush():Promise<void> {
    const write=this.writing.then(async()=>{
      if(!this.dirty) return;
      if(await identity(this.root).catch(()=>undefined)!==this.rootIdentity) return;
      this.dirty=false;
      const target=path.join(this.root,NAME),temporary=path.join(this.root,`${DUPLICATES_PREFIX}-${randomUUID()}.tmp`);
      try {
        const handle=await fs.open(temporary,'wx',0o600);
        try { await handle.writeFile(JSON.stringify({version:1,rootIdentity:this.rootIdentity,updated:new Date().toISOString(),complete:this.complete,files:Object.fromEntries(this.files),groups:this.groups})); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary,target);
      } catch(error) { await fs.unlink(temporary).catch(()=>{}); this.dirty=true; throw error; }
      await syncDirectory(this.root);
    });
    this.writing=write.catch(()=>{});
    return write;
  }
  /** The groups, with each file as the store last saw it. A member that is gone or changed is dropped. */
  async restore():Promise<DuplicateGroup[]> {
    const groups:DuplicateGroup[]=[];
    for(const stored of this.groups) {
      const files:DuplicateFile[]=[];
      for(const relative of stored.files) {
        const record=this.files.get(relative),stat=await fs.lstat(path.join(this.root,relative),{bigint:true}).catch(()=>undefined);
        if(record&&stat?.isFile()&&unchanged(record,stat)) files.push(asFile(relative,record,stat));
      }
      if(files.length>1) groups.push({id:groupId(files),strength:stored.strength,files});
    }
    return groups;
  }
}
function asFile(relative:string,record:FileRecord,stat:BigIntStats):DuplicateFile {
  return {path:relative,size:Number(stat.size),kind:record.kind,...(record.sha256?{sha256:record.sha256}:{}),...(record.exif?{exif:record.exif}:{}),edited:record.edited,birth:record.birth,ctime:record.ctime,ino:record.ino,mtimeNs:record.mtimeNs};
}
const stores=new Map<string,Promise<DuplicateStore>>();
/** One store per library root and identity for this session. */
export function duplicateStore(root:string,rootIdentity:string):Promise<DuplicateStore> {
  const key=`${root}\0${rootIdentity}`;
  let store=stores.get(key);
  if(!store){store=DuplicateStore.load(root,rootIdentity);stores.set(key,store);store.catch(()=>stores.delete(key));}
  return store;
}
export function dropDuplicateStores():void {stores.clear();}

/** Stage 1: hash only the candidates (same name, or the same trusted EXIF key), right away. A candidate
 * whose hash cannot be read stays without one and is judged by its EXIF alone. */
export async function confirmCandidates(files:DuplicateFile[],hash:(file:DuplicateFile)=>Promise<string>,options:{signal?:AbortSignal;concurrency?:number;onProgress?:(progress:Progress)=>void}={}):Promise<DuplicateFile[]> {
  const todo=candidates(files).filter(item=>!item.sha256);let done=0,next=0,failure:unknown;
  const report=(current='')=>options.onProgress?.({phase:'planning',step:'candidates',completed:done,total:todo.length,bytes:0,totalBytes:0,speed:0,file:current});
  if(todo.length) report();
  await Promise.all(Array.from({length:Math.min(todo.length,options.concurrency??4)},async()=>{
    while(failure===undefined&&next<todo.length) {
      const item=todo[next++]!;checkAbort(options.signal);
      try { item.sha256=await hash(item); } catch(error) { if((error as Error)?.name==='AbortError') failure??=error; }
      done++;report(item.path);
    }
  }));
  if(failure!==undefined) throw failure;
  return todo;
}

export interface ScanDeps {
  /** Routing metadata (camera, capture time, EXIF fingerprint) of a file. */
  metadata:(file:string)=>Promise<Metadata>;
  index:DestinationIndex;
}
export interface ScanOptions {
  /** Restrict the scan to these folders (relative to the root); the answer is then not the whole library's. */
  folders?:string[];
  editedFolder?:string;
  signal?:AbortSignal;
  onProgress?:(progress:Progress)=>void;
  /** full: read EXIF and hash whatever is not recorded. recorded: use only what is known (EXIF in the store, hashes in the destination index). */
  mode?:'full'|'recorded';
}
export interface ScanResult {
  groups:DuplicateGroup[];
  /** Media files looked at (companions excluded). */
  files:number;
  /** The files that follow a primary file: .xmp, .lrf, .wav, .thm and the like, by the primary's relative path. */
  companions:Map<string,string[]>;
}
async function parallel<T>(items:T[],limit:number,work:(item:T)=>Promise<void>,signal?:AbortSignal):Promise<void> {
  let next=0,failure:unknown;
  await Promise.all(Array.from({length:Math.min(items.length,limit)},async()=>{
    while(failure===undefined&&next<items.length) { try { checkAbort(signal); await work(items[next++]!); } catch(error) { failure??=error; } }
  }));
  if(failure!==undefined) throw failure;
}

/** Find the duplicates of one library. Stage 1 hashes the candidates found by name and EXIF; stage 2 hashes
 * every other file (or reads its recorded hash) so a renamed copy is found by SHA-256 too. */
export async function scanDuplicates(rootPath:string,deps:ScanDeps,options:ScanOptions={}):Promise<ScanResult> {
  const root=await directory(rootPath),rootIdentity=await identity(root),store=await duplicateStore(root,rootIdentity),mode=options.mode??'full',signal=options.signal;
  const report=(progress:Omit<Progress,'phase'|'bytes'|'totalBytes'|'speed'>)=>options.onProgress?.({phase:'planning',bytes:0,totalBytes:0,speed:0,...progress});
  const listed=await inventory(root,{backup:true,folders:options.folders,excludeNames:APP_FOLDERS,onProgress:(found,_bytes,top,latest)=>report({step:'listing',completed:found,total:0,file:latest??'',...(top?.total?{share:top.done/top.total}:{})})},signal);
  const media=listed.files.filter((item:InventoryFile)=>item.kind!=='Other'&&!item.companionOf);
  const companions=new Map<string,string[]>();
  for(const item of listed.files) if(item.companionOf) { const primary=relativeOf(root,item.companionOf); companions.set(primary,[...companions.get(primary)??[],relativeOf(root,item.path)]); }
  // Look at every file: reuse a record whose stat is unchanged, otherwise read its EXIF fingerprint.
  const edited=options.editedFolder??'editied',items:DuplicateFile[]=[],stats=new Map<DuplicateFile,BigIntStats>();
  let done=0;const total=media.length;
  await parallel(media,6,async item=>{
    const relative=relativeOf(root,item.path),stat=await fs.lstat(item.path,{bigint:true});
    if(!stat.isFile()) return;
    let record=store.files.get(relative);
    if(!record||!unchanged(record,stat)||(mode==='full'&&!record.read)) {
      let info:Metadata|undefined;
      if(mode==='full') try { info=await deps.metadata(item.path); } catch(error) { if((error as Error)?.name==='AbortError') throw error; }
      const inEdited=relative.split('/').slice(0,-1).includes(edited);
      record={size:String(stat.size),mtimeNs:String(stat.mtimeNs),ino:String(stat.ino),kind:item.kind,birth:milliseconds(stat.birthtimeNs),ctime:milliseconds(stat.ctimeNs),edited:inEdited||info?.edited===true,...(mode==='full'?{read:true}:{}),...(info?.fingerprint&&Object.keys(info.fingerprint).length?{exif:info.fingerprint}:{})};
      store.files.set(relative,record);store.mark();
    }
    const found=asFile(relative,record,stat);stats.set(found,stat);items.push(found);
    report({step:'fingerprinting',completed:++done,total,file:relative});
  },signal);
  items.sort((a,b)=>a.path<b.path?-1:1);
  const hashOf=async(found:DuplicateFile)=>{
    const absolute=path.join(root,found.path),known=deps.index.cached(absolute,stats.get(found)!);
    if(known) return known;
    if(mode==='recorded') throw new Error('not recorded');
    return deps.index.digestOf(absolute,signal);
  };
  // A record remembers a hash only for the stat it was computed under.
  const remember=(found:DuplicateFile)=>{const record=store.files.get(found.path);if(record&&found.sha256&&record.sha256!==found.sha256){record.sha256=found.sha256;store.mark();}};
  if(mode==='full') {
    const hashed=await confirmCandidates(items,hashOf,{signal,onProgress:options.onProgress});
    hashed.forEach(remember);
    const rest=items.filter(found=>!found.sha256&&found.size>0);let stage=0;
    await parallel(rest,4,async found=>{
      try { found.sha256=await hashOf(found);remember(found); } catch(error) { if((error as Error)?.name==='AbortError') throw error; }
      report({step:'collisions',completed:++stage,total:rest.length,file:found.path});
    },signal);
  } else {
    for(const found of items) if(!found.sha256) try { found.sha256=await hashOf(found);remember(found); } catch { /* Not recorded. */ }
  }
  const groups=buildGroups(items),inScope=new Set(items.map(found=>found.path));
  // A scan of some folders replaces only the groups it covers.
  store.groups=[...(options.folders?store.groups.filter(group=>!group.files.some(item=>inScope.has(item))):[]),...groups.map(group=>({strength:group.strength,files:group.files.map(item=>item.path)}))];
  if(!options.folders) for(const relative of [...store.files.keys()]) if(!inScope.has(relative)) store.files.delete(relative);
  store.complete=!options.folders&&mode==='full';store.mark();
  await store.flush().catch(()=>{/* Only a record: the groups are still returned. */});
  await deps.index.flush().catch(()=>{});
  return {groups,files:items.length,companions};
}

/** What planning learned about the files it examined: EXIF for every media file, and the SHA-256 stage 1
 * computed for candidates. Paths are the source files'. */
export interface PlanDuplicates {files:DuplicateFile[];groups:DuplicateGroup[];}
/** Record a finished plan's findings in the library it wrote to. `destinationOf` maps a source path to its
 * path in this library (absent: not in it). Never deletes anything. */
export async function recordPlanDuplicates(root:string,found:PlanDuplicates,destinationOf:(source:string)=>string|undefined):Promise<void> {
  const library=await directory(root),rootIdentity=await identity(library),store=await duplicateStore(library,rootIdentity);
  const placed=new Map<string,DuplicateFile>();
  for(const item of found.files) {
    const destination=destinationOf(item.path);if(!destination) continue;
    const relative=relativeOf(library,destination);if(relative.startsWith('..')) continue;
    const stat=await fs.lstat(destination,{bigint:true}).catch(error=>{if(code(error)==='ENOENT')return undefined;throw error;});
    if(!stat?.isFile()) continue;
    const record:FileRecord={size:String(stat.size),mtimeNs:String(stat.mtimeNs),ino:String(stat.ino),kind:item.kind,birth:milliseconds(stat.birthtimeNs),ctime:milliseconds(stat.ctimeNs),edited:item.edited,read:true,...(item.exif?{exif:item.exif}:{}),...(item.sha256&&Number(stat.size)===item.size?{sha256:item.sha256}:{})};
    store.files.set(relative,record);placed.set(item.path,{...item,path:relative});
  }
  for(const group of found.groups) {
    const members=group.files.flatMap(item=>placed.get(item.path)??[]);
    if(members.length<2) continue;
    store.groups=store.groups.filter(old=>!old.files.some(name=>members.some(member=>member.path===name)));
    store.groups.push({strength:group.strength,files:members.map(member=>member.path)});
  }
  // Only a full look at the library can say what is not a duplicate.
  store.complete=false;store.mark();
  await store.flush();
}
