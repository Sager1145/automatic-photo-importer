import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import type { DuplicateExif, DuplicateFile, DuplicateGroup, InventoryFile, MediaKind, Metadata, Progress } from '../shared';
import { buildGroups, candidates } from '../duplicate-rules';
import { inventory } from './inventory';
import { listingEstimate } from '../listing-estimate';
import { DRIVE_BACKUPS } from './drive-backup';
import { APP_DATA_FOLDER, LEGACY_RECOVERY_FOLDER, RECOVERY_FOLDER } from './legacy-names';
import { PROBLEM_FILES_FOLDER } from '../shared';
import { checkAbort, code, directory, identity, statKey, syncDirectory, within } from './paths';
import { indexLocations, indexTarget, provablySame, statRecord, type StatRecord } from './destination-index';
import { toMessage, type Message } from '../messages';
import { openV5, sealV5 } from './app-store';
import type { DestinationIndex } from './destination-index';
import { CHECK_CONCURRENCY } from './devices';

/** The per-library record of what duplicate detection found: visible, never hidden, and ignored by inventories. */
export const DUPLICATES_PREFIX='photo-importer-duplicates';
/** Folders the app owns, skipped at any depth: mirrors of other drives, the recovery store and collected problem files. */
export const APP_FOLDERS=[DRIVE_BACKUPS,APP_DATA_FOLDER,RECOVERY_FOLDER,LEGACY_RECOVERY_FOLDER,PROBLEM_FILES_FOLDER];
/** The files duplicate detection looks at, in planning and in a library scan alike: recognised media with bytes, never a
 * companion (a sidecar, an edit's settings, a Live Photo's clip), which goes with its primary. */
export const duplicateMember=(file:Pick<InventoryFile,'kind'|'size'|'companionOf'>)=>file.kind!=='Other'&&file.size>0&&!file.companionOf;
/** The destination libraries a chosen folder is, contains or sits inside. More than one means the scan would mix
 * libraries (or pair a library with another), so the folder is refused. */
export function overlappingLibraries(folder:string,libraries:string[]):string[] {
  return [...new Set(libraries)].filter(library=>within(folder,library)||within(library,folder));
}
export const DUPLICATES_FILE='duplicates.json';
const MAX_BYTES=256*1024*1024;
/** What the store keeps of a media file: its kind, edited state and EXIF fingerprint, bound to the stat they were read under.
 * Content digests are not kept here: the destination index owns them. */
export interface FileRecord {stat:StatRecord;kind:MediaKind;edited:boolean;exif?:DuplicateExif;}
const milliseconds=(value:bigint)=>Number(value)/1e6;
const relativeOf=(root:string,absolute:string)=>path.relative(root,absolute).split(path.sep).join('/');
const isStatRecord=(value:unknown):value is StatRecord=>!!value&&typeof value==='object'&&['dev','ino','size','mtime','ctime'].every(key=>typeof (value as Record<string,unknown>)[key]==='string');

/** Records of a library's media files, so a scan does not read the metadata of an unchanged file again. A record
 * is trusted only while the file's stat provably matches (see provablySame); anything else is read again. */
export class DuplicateStore {
  files=new Map<string,FileRecord>();
  private dirty=false;
  private writing:Promise<void>=Promise.resolve();
  constructor(readonly root:string,readonly rootIdentity:string) {}
  static async load(root:string,rootIdentity:string):Promise<DuplicateStore> {
    const store=new DuplicateStore(root,rootIdentity);
    for(const file of await indexLocations(root,DUPLICATES_FILE)) try {
      const stat=await fs.lstat(file);
      if(!stat.isFile()||stat.size>MAX_BYTES) continue;
      const data=openV5('duplicates',JSON.parse(await fs.readFile(file,'utf8')));
      if(data.rootIdentity!==rootIdentity||!data.files||typeof data.files!=='object') continue;
      store.take(data.files as Record<string,unknown>);return store;
    } catch { /* Missing, unreadable, from another volume or another Mac's: start empty and rebuild. */ }
    return store;
  }
  /** Take the stored records; any other field a record carries is ignored. */
  private take(files:Record<string,unknown>):void {
    for(const [relative,value] of Object.entries(files)) {
      const record=value as Partial<FileRecord>|null;
      if(record&&isStatRecord(record.stat)&&typeof record.kind==='string') this.files.set(relative,{stat:record.stat,kind:record.kind,edited:!!record.edited,...(record.exif&&typeof record.exif==='object'?{exif:record.exif}:{})});
    }
  }
  /** The record of a file whose stat provably has not changed since it was read. */
  known(relative:string,stat:BigIntStats):FileRecord|undefined {
    const record=this.files.get(relative);
    return record&&provablySame(record.stat,stat)?record:undefined;
  }
  mark():void {this.dirty=true;}
  /** Atomic replace, like the destination index: write a sibling, fsync, rename, fsync the folder. */
  flush():Promise<void> {
    const write=this.writing.then(async()=>{
      if(!this.dirty) return;
      if(await identity(this.root).catch(()=>undefined)!==this.rootIdentity) return;
      this.dirty=false;
      let target:string;
      try { target=await indexTarget(this.root,DUPLICATES_FILE); } catch(error) { this.dirty=true; throw error; }
      const temporary=path.join(path.dirname(target),`duplicates-${randomUUID()}.tmp`);
      try {
        const handle=await fs.open(temporary,'wx',0o600);
        try { await handle.writeFile(JSON.stringify(sealV5('duplicates',{rootIdentity:this.rootIdentity,files:Object.fromEntries(this.files)}))); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary,target);
      } catch(error) { await fs.unlink(temporary).catch(()=>{}); this.dirty=true; throw error; }
      await syncDirectory(path.dirname(target));
    });
    this.writing=write.catch(()=>{});
    return write;
  }
}
function asFile(relative:string,record:Omit<FileRecord,'stat'>,stat:BigIntStats):DuplicateFile {
  return {path:relative,size:Number(stat.size),kind:record.kind,...(record.exif?{exif:record.exif}:{}),edited:record.edited,birth:milliseconds(stat.birthtimeNs),ctime:milliseconds(stat.ctimeNs),ino:String(stat.ino),mtimeNs:String(stat.mtimeNs)};
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

/** Stage 1: hash only the candidates (same name, or the same trusted EXIF key), right away. Each candidate without
 * a hash is tried once; one whose hash cannot be read stays without one and is returned with its error. */
export async function confirmCandidates(files:DuplicateFile[],hash:(file:DuplicateFile)=>Promise<string>,options:{signal?:AbortSignal;concurrency?:number;onProgress?:(progress:Progress)=>void}={}):Promise<{attempted:DuplicateFile[];failed:{file:DuplicateFile;error:unknown}[]}> {
  const todo=candidates(files).filter(item=>!item.sha256),failed:{file:DuplicateFile;error:unknown}[]=[];let done=0,next=0,failure:unknown;
  const report=(current='')=>options.onProgress?.({phase:'planning',step:'candidates',completed:done,total:todo.length,bytes:0,totalBytes:0,speed:0,file:current});
  if(todo.length) report();
  await Promise.all(Array.from({length:Math.min(todo.length,options.concurrency??4)},async()=>{
    while(failure===undefined&&next<todo.length) {
      const item=todo[next++]!;checkAbort(options.signal);
      try { item.sha256=await hash(item); } catch(error) { if((error as Error)?.name==='AbortError') failure??=error; else failed.push({file:item,error}); }
      done++;report(item.path);
    }
  }));
  if(failure!==undefined) throw failure;
  return {attempted:todo,failed};
}

export interface ScanDeps {
  /** Routing metadata (camera, capture time, EXIF fingerprint) of a file. */
  metadata:(file:string)=>Promise<Metadata>;
  /** The library's checksum index: the only source of content digests. */
  index:Pick<DestinationIndex,'cached'|'digestOf'|'flush'>;
}
export interface ScanOptions {
  editedFolder?:string;
  signal?:AbortSignal;
  onProgress?:(progress:Progress)=>void;
}
/** A file the scan could not read. metadata: it is still grouped by its content; hash: it is left out of this scan's groups. */
export interface ScanFailure {path:string;step:'metadata'|'hash';error:Message;}
export interface ScanResult {
  groups:DuplicateGroup[];
  /** Media files looked at (companions excluded). */
  files:number;
  /** The files that follow a primary file: .xmp, .lrf, .wav, .thm and the like, by the primary's relative path. */
  companions:Map<string,string[]>;
  /** Files whose metadata or contents could not be read, one entry per file, by path. */
  failures:ScanFailure[];
}
async function parallel<T>(items:T[],limit:number,work:(item:T)=>Promise<void>,signal?:AbortSignal):Promise<void> {
  let next=0,failure:unknown;
  await Promise.all(Array.from({length:Math.min(items.length,limit)},async()=>{
    while(failure===undefined&&next<items.length) { try { checkAbort(signal); await work(items[next++]!); } catch(error) { failure??=error; } }
  }));
  if(failure!==undefined) throw failure;
}
const isAbort=(error:unknown)=>(error as Error)?.name==='AbortError';

/** Find the duplicates of one library. Stage 1 hashes the candidates found by name and EXIF; stage 2 hashes every
 * other file (or takes the index's digest) so a renamed copy is found by SHA-256 too. Each file is hashed at most once. */
export async function scanDuplicates(rootPath:string,deps:ScanDeps,options:ScanOptions={}):Promise<ScanResult> {
  const root=await directory(rootPath),rootIdentity=await identity(root),store=await duplicateStore(root,rootIdentity),signal=options.signal;
  const report=(progress:Omit<Progress,'phase'|'bytes'|'totalBytes'|'speed'>)=>options.onProgress?.({phase:'planning',bytes:0,totalBytes:0,speed:0,...progress});
  const listed=await inventory(root,{backup:true,excludeNames:APP_FOLDERS,onProgress:(found,bytes,top,latest)=>{const {share}=listingEstimate(undefined,{files:found,bytes},top);report({step:'listing',completed:found,total:0,file:latest??'',...(share!==undefined?{share}:{})});}},signal);
  const media=listed.files.filter(duplicateMember);
  const companions=new Map<string,string[]>();
  for(const item of listed.files) if(item.companionOf) { const primary=relativeOf(root,item.companionOf); companions.set(primary,[...companions.get(primary)??[],relativeOf(root,item.path)]); }
  // One entry per file: a failed hash (the file is left out) replaces a failed metadata read of the same file.
  const failures=new Map<string,ScanFailure>();
  // Look at every file: reuse a record whose stat provably is unchanged, otherwise read its EXIF fingerprint.
  const edited=options.editedFolder??'editied',items:DuplicateFile[]=[],stats=new Map<DuplicateFile,BigIntStats>();
  let done=0;const total=media.length;
  await parallel(media,CHECK_CONCURRENCY,async item=>{
    const relative=relativeOf(root,item.path),stat=await fs.lstat(item.path,{bigint:true});
    if(!stat.isFile()) return;
    let record:Omit<FileRecord,'stat'>|undefined=store.known(relative,stat);
    if(!record) {
      const inEdited=relative.split('/').slice(0,-1).includes(edited);
      try {
        const info=await deps.metadata(item.path);
        const read:FileRecord={stat:statRecord(stat),kind:item.kind,edited:inEdited||info.edited===true,...(info.fingerprint&&Object.keys(info.fingerprint).length?{exif:info.fingerprint}:{})};
        store.files.set(relative,read);store.mark();record=read;
      } catch(error) {
        if(isAbort(error)) throw error;
        // Not remembered, so the next scan reads it again; this one groups the file by its content alone.
        failures.set(relative,{path:relative,step:'metadata',error:toMessage(error)});
        record={kind:item.kind,edited:inEdited};
      }
    }
    const found=asFile(relative,record,stat);stats.set(found,stat);items.push(found);
    report({step:'fingerprinting',completed:++done,total,file:relative});
  },signal);
  items.sort((a,b)=>a.path<b.path?-1:1);
  const hashOf=async(found:DuplicateFile)=>{
    const absolute=path.join(root,found.path);
    return deps.index.cached(absolute,stats.get(found)!)??deps.index.digestOf(absolute,signal);
  };
  const unread=new Set<DuplicateFile>();
  const hashFailed=(found:DuplicateFile,error:unknown)=>{unread.add(found);failures.set(found.path,{path:found.path,step:'hash',error:toMessage(error)});};
  const {attempted,failed}=await confirmCandidates(items,hashOf,{signal,onProgress:options.onProgress});
  for(const {file,error} of failed) hashFailed(file,error);
  const tried=new Set(attempted),rest=items.filter(found=>!found.sha256&&found.size>0&&!tried.has(found));let stage=0;
  await parallel(rest,4,async found=>{
    try { found.sha256=await hashOf(found); } catch(error) { if(isAbort(error)) throw error; hashFailed(found,error); }
    report({step:'collisions',completed:++stage,total:rest.length,file:found.path});
  },signal);
  // A file whose contents could not be read is left out: its EXIF alone never makes it a duplicate here.
  const groups=buildGroups(items.filter(found=>!unread.has(found))),inScope=new Set(items.map(found=>found.path));
  for(const relative of [...store.files.keys()]) if(!inScope.has(relative)) {store.files.delete(relative);store.mark();}
  await store.flush().catch(()=>{/* Only a record: the groups are still returned. */});
  await deps.index.flush().catch(()=>{});
  return {groups,files:items.length,companions,failures:[...failures.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)};
}

/** What planning learned about the files it examined: EXIF for every member, and the SHA-256 stage 1
 * computed for candidates. Paths are the source files'. */
export interface PlanDuplicates {files:DuplicateFile[];}
/** Record the EXIF a finished plan read, for the files it placed in this library, so a later scan does not read it
 * again. `placed` maps a source path to where the import verified it in this library and that file's identity then (absent:
 * not there); a file changed since gets nothing. Never deletes anything. */
export async function recordPlanDuplicates(root:string,found:PlanDuplicates,placed:(source:string)=>{destination:string;identity:string}|undefined):Promise<void> {
  const library=await directory(root),rootIdentity=await identity(library),store=await duplicateStore(library,rootIdentity);
  for(const item of found.files) {
    const at=placed(item.path);if(!at) continue;
    const relative=relativeOf(library,at.destination);if(relative.startsWith('..')) continue;
    const stat=await fs.lstat(at.destination,{bigint:true}).catch(error=>{if(code(error)==='ENOENT')return undefined;throw error;});
    // Only the very file the import verified there gets the source's kind and EXIF.
    if(!stat?.isFile()||statKey(stat)!==at.identity) continue;
    store.files.set(relative,{stat:statRecord(stat),kind:item.kind,edited:item.edited,...(item.exif?{exif:item.exif}:{})});store.mark();
  }
  await store.flush();
}
