import * as fs from 'node:fs/promises';
import {constants,type BigIntStats} from 'node:fs';
import path from 'node:path';
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {APP_DATA_FOLDER} from './legacy-names';
import {beneath,code,contained,pathKey,syncDirectory,unreliableIno} from './paths';
export {APP_DATA_FOLDER} from './legacy-names';

/** Records v5: every record this app writes on a drive lives in one visible "Photo Importer Data" folder (the
 * store) at the base of a library: the configured destination the library sits in (same volume), or the library
 * itself. Every record is one sealed JSON line or file; logs are append-only and synchronized as a group. */
export const STORE_VERSION=5;
/** The first app version that reads this store; earlier versions are not supported on a drive that has one. */
export const STORE_MIN_VERSION='0.3.0';

// ---- Host key and seals ----
let hostKey:Buffer|undefined;
/** Configure once from the host's private application data, never from a drive record. */
export function configureHostKey(secret:Buffer|string):void {
 const key=Buffer.isBuffer(secret)?Buffer.from(secret):Buffer.from(secret,'utf8');
 if(key.length<32)throw new Error('Recovery authentication requires a host key of at least 32 bytes');
 if(hostKey&&!hostKey.equals(key))throw new Error('Recovery host key is already configured');
 hostKey=key;
}
export function hostKeyConfigured():boolean {return !!hostKey;}
export function requireHostKey():Buffer {
 if(!hostKey)throw new Error('Organization recovery host authentication key is not configured');
 return hostKey;
}
/** Seal kinds: what a sealed record is, part of what its seal covers. */
export type SealKind='store'|'organization'|'entries'|'event'|'pointer'|'receipt'|'index'|'duplicates'|'drive'|'reviewed'|'cache';
const v5Seal=(kind:string,text:string)=>createHmac('sha256',requireHostKey()).update(`photo-importer:v5:${kind}\n${text}`).digest('hex');
/** A v5 record: the value with `v` and `kind`, sealed with this host's key over a domain-separated text, so a
 * record of one kind (or one sealed by an earlier version) never verifies as another. */
export function sealV5(kind:SealKind,value:Record<string,unknown>):Record<string,unknown> {
 const {v:_v,kind:_kind,seal:_seal,...rest}=value;
 const unsigned={v:STORE_VERSION,kind,...rest};
 return {...unsigned,seal:v5Seal(kind,JSON.stringify(unsigned))};
}
export class SealError extends Error {constructor(message='Record authentication failed'){super(message);this.name='SealError';}}
/** The verified record (without its seal), or a SealError. */
export function openV5(kind:SealKind,value:unknown):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new SealError('Invalid record');
 const {seal,...unsigned}=value as Record<string,unknown>;
 if(unsigned.v!==STORE_VERSION||unsigned.kind!==kind)throw new SealError(`Not a version ${STORE_VERSION} ${kind} record`);
 if(typeof seal!=='string'||!/^[a-f0-9]{64}$/.test(seal)||!timingSafeEqual(Buffer.from(seal,'hex'),Buffer.from(v5Seal(kind,JSON.stringify(unsigned)),'hex')))throw new SealError();
 return unsigned;
}
/** One sealed line (no newline). */
export const sealedLine=(kind:SealKind,value:Record<string,unknown>)=>JSON.stringify(sealV5(kind,value));

// ---- Streaming line reader ----
/** Longest line of each kind. A longer line that is valid JSON is refused; one that is not is what an
 * interrupted write leaves (cut short, zero-filled) and carries nothing. No line is ever buffered past HARD_LINE_CAP. */
export const LINE_CAPS={event:2048,header:64*1024,entries:64*1024*1024,receipt:32*1024,pointer:4096} as const;
export const HARD_LINE_CAP=64*1024*1024;
const CHUNK=1024*1024;
export class RecordTooLarge extends Error {constructor(file:string){super(`Record too large: ${file}`);this.name='RecordTooLarge';}}
/** Reads only whole lines, in 1 MiB chunks, from `from`. `capFor(n)` is the cap for the n-th line read in this
 * call. Lines within their cap go to `onLine` with their start offset; the final line without a newline goes to
 * `onTail` (an append cut short, or one still being written). Returns the offset after the last newline read. */
export async function readLines(handle:fs.FileHandle,file:string,from:number,capFor:(n:number)=>number,onLine:(text:string,start:number,n:number)=>void|Promise<void>,options:{onTail?:(text:string,start:number,n:number)=>void|Promise<void>;signal?:AbortSignal;onBytes?:(position:number,size:number)=>void}={}):Promise<{end:number;lines:number}>{
 const size=Number((await handle.stat()).size),buffer=Buffer.allocUnsafe(CHUNK);
 let position=from,lineStart=from,parts:Buffer[]=[],length=0,n=0;
 const finish=async(bytes:Buffer,start:number,tail:boolean)=>{
  const cap=capFor(n);
  if(bytes.length>cap){
   let parsed=false;try{JSON.parse(bytes.toString('utf8'));parsed=true;}catch{/* Not JSON: an interrupted write. */}
   if(parsed)throw new RecordTooLarge(file);
  }else{const text=bytes.toString('utf8');if(tail)await options.onTail?.(text,start,n);else await onLine(text,start,n);}
  n++;
 };
 while(position<size){
  if(options.signal?.aborted)throw new DOMException('Import stopped','AbortError');
  const {bytesRead}=await handle.read(buffer,0,Math.min(CHUNK,size-position),position);
  if(!bytesRead)break;
  let offset=0;
  for(;;){
   const newline=buffer.indexOf(0x0a,offset);
   if(newline<0||newline>=bytesRead){
    const piece=buffer.subarray(offset,bytesRead);
    if(length+piece.length>HARD_LINE_CAP)throw new RecordTooLarge(file);
    parts.push(Buffer.from(piece));length+=piece.length;break;
   }
   const piece=buffer.subarray(offset,newline);
   if(length+piece.length>HARD_LINE_CAP)throw new RecordTooLarge(file);
   const bytes=parts.length?Buffer.concat([...parts,piece]):Buffer.from(piece);
   parts=[];length=0;
   await finish(bytes,lineStart,false);
   offset=newline+1;lineStart=position+offset;
  }
  position+=bytesRead;options.onBytes?.(position,size);
 }
 if(length)await finish(Buffer.concat(parts),lineStart,true);
 return {end:lineStart,lines:n};
}
/** Opened without following a link, judged by its own handle. */
export async function openRegular(file:string,flags=constants.O_RDONLY):Promise<fs.FileHandle>{
 const handle=await fs.open(file,flags|(constants.O_NOFOLLOW??0));
 try{const stat=await handle.stat();if(!stat.isFile())throw new Error(`Unsafe non-regular record: ${file}`);return handle;}
 catch(error){await handle.close().catch(()=>{});throw error;}
}

// ---- Group-committed append-only logs ----
interface Waiter {lines:string[];check?:()=>Promise<void>;resolve:()=>void;reject:(error:unknown)=>void;}
interface Log {waiting:Waiter[];chain:Promise<void>;scheduled:boolean;}
const logs=new Map<string,Log>();
/** For tests: how many writes, file and folder synchronizations the logs made. */
export const logStats={writes:0,fileSyncs:0,folderSyncs:0};
const logFor=(file:string)=>{let log=logs.get(file);if(!log){log={waiting:[],chain:Promise.resolve(),scheduled:false};logs.set(file,log);}return log;};
/** Append lines to `file` and return once they are durable. Every append waiting when a write starts goes in
 * that one write, followed by one synchronization of the file and one of its folder (the folder holds the
 * file's size on FAT and exFAT). `check` runs right before the write (containment, identities); an append
 * whose check fails is refused alone. */
export function appendLines(file:string,lines:string[],check?:()=>Promise<void>):Promise<void>{
 if(lines.some(line=>line.includes('\n')))return Promise.reject(new Error('Invalid record line'));
 return new Promise<void>((resolve,reject)=>{
  const log=logFor(file);log.waiting.push({lines,check,resolve,reject});
  if(!log.scheduled){log.scheduled=true;log.chain=log.chain.then(()=>flush(file,log));}
 });
}
async function flush(file:string,log:Log):Promise<void>{
 log.scheduled=false;
 const batch=log.waiting.splice(0),ready:Waiter[]=[];
 for(const waiter of batch){try{await waiter.check?.();ready.push(waiter);}catch(error){waiter.reject(error);}}
 if(!ready.length)return;
 try{
  const handle=await fs.open(file,constants.O_RDWR|constants.O_APPEND|constants.O_CREAT|(constants.O_NOFOLLOW??0),0o600);
  try{
   const opened=await handle.stat();if(!opened.isFile()||opened.nlink!==1)throw new Error(`Unsafe record log: ${file}`);
   // Start on a fresh line if an interrupted write left a partial one.
   let torn=false;if(opened.size>0){const last=Buffer.alloc(1);await handle.read(last,0,1,opened.size-1);torn=last[0]!==0x0a;}
   await handle.writeFile((torn?'\n':'')+ready.flatMap(waiter=>waiter.lines).join('\n')+'\n');logStats.writes++;
   await handle.sync();logStats.fileSyncs++;
  }finally{await handle.close();}
  await syncDirectory(path.dirname(file));logStats.folderSyncs++;
  for(const waiter of ready)waiter.resolve();
 }catch(error){for(const waiter of ready)waiter.reject(error);}
}
/** Run `work` with no append to `file` in progress or starting (a segment's deletion check). */
export function holdLog<T>(file:string,work:()=>Promise<T>):Promise<T>{
 const log=logFor(file),run=log.chain.then(work);log.chain=run.then(()=>{},()=>{});return run;
}
/** A new file holding exactly `text`, created exclusively, synchronized with its folder. */
export async function writeNewFile(file:string,text:string):Promise<void>{
 const handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
 try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
 await syncDirectory(path.dirname(file));
}

// ---- Both-names rule ----
/** Two names for one file, or a target that is not what was moved: nothing is unlinked, the user is told. */
export class FirstAidError extends Error {readonly code='first-aid';constructor(message:string){super(message);this.name='FirstAidError';}}
export const maybeLstat=async(file:string):Promise<BigIntStats|undefined>=>{try{return await fs.lstat(file,{bigint:true});}catch(error){if(code(error)==='ENOENT')return undefined;throw error;}};
/** Where a rename stands, judged by both names: 'source' (not done), 'target' (done), 'both-same' (one file, two
 * names: stop), 'both' (two files: stop), 'none'. */
export async function bothNames(source:string,target:string):Promise<'source'|'target'|'both-same'|'both'|'none'>{
 const [from,to]=await Promise.all([maybeLstat(source),maybeLstat(target)]);
 if(from&&to)return from.dev===to.dev&&from.ino===to.ino&&!unreliableIno(from)?'both-same':'both';
 return from?'source':to?'target':'none';
}
/** The same file after a rename: device, size and inode (birth time where the inode is unreliable). */
export const renamedIdentity=(before:BigIntStats)=>(after:BigIntStats)=>after.dev===before.dev&&after.size===before.size&&(unreliableIno(before)||unreliableIno(after)?after.birthtimeNs===before.birthtimeNs:after.ino===before.ino);
/** rename(2) under the both-names rule: the target must be absent first; afterwards the source must be gone
 * and the target must be the file that was moved (`expected`, by default the source's identity). 'retry': the
 * source is still there and the target absent (a fresh name may be tried where names are free-form). Anything
 * else stops with a FirstAidError, unlinking neither name. Synchronizes both folders when done. */
export async function renameChecked(source:string,target:string,expected?:(stat:BigIntStats)=>boolean):Promise<'done'|'retry'>{
 if(await maybeLstat(target))throw new FirstAidError(`Something is already at ${target}; nothing was moved`);
 const before=await fs.lstat(source,{bigint:true});
 await fs.rename(source,target);
 const [from,to]=await Promise.all([maybeLstat(source),maybeLstat(target)]);
 if(from&&to){
  if(from.dev===to.dev&&from.ino===to.ino)throw new FirstAidError(`First Aid needed: ${source} and ${target} name the same file`);
  throw new FirstAidError(`First Aid needed: both ${source} and ${target} exist after a move`);
 }
 if(from&&!to)return 'retry';
 if(!to||!(expected??renamedIdentity(before))(to))throw new FirstAidError(`First Aid needed: ${target} is not the file moved from ${source}`);
 await syncDirectory(path.dirname(target));if(path.dirname(source)!==path.dirname(target))await syncDirectory(path.dirname(source));
 return 'done';
}

// ---- Store location ----
export interface Store {/** The "Photo Importer Data" folder. */path:string;/** The folder it is in. */base:string;dev:bigint;baseIno:bigint;/** The store folder's own inode. */ino:bigint;}
let destinations:string[]=[];
/** The configured destinations (and folders organized in place on their own drive): a library beneath one keeps
 * its records in that destination's store, on the same volume. */
export function registerDestinations(paths:string[]):void {destinations=[...new Set(paths.filter(Boolean).map(item=>path.resolve(item)))];}
export function registeredDestinations():string[] {return [...destinations];}
const storeCache=new Map<string,{key:string;store:Store}>();
const statKey=(stat:BigIntStats)=>`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
/** The store's own record, sealed; read and checked against the folder it is in. Undefined when absent. */
async function storeRecord(folder:string,base:string,baseStat:BigIntStats):Promise<Store|undefined>{
 const file=path.join(folder,'store.json'),stat=await maybeLstat(file);if(!stat)return undefined;
 const own=await fs.lstat(folder,{bigint:true}),key=`${statKey(stat)}:${baseStat.ino}:${own.ino}`;
 const cached=storeCache.get(folder);if(cached&&cached.key===key&&cached.store.base===base)return {...cached.store,dev:baseStat.dev};
 if(!stat.isFile()||stat.size>BigInt(LINE_CAPS.header))throw new Error(`Damaged ${APP_DATA_FOLDER} record: ${file}`);
 const handle=await openRegular(file);let value:unknown;
 try{try{value=JSON.parse(await handle.readFile('utf8'));}catch{throw new Error(`Damaged ${APP_DATA_FOLDER} record: ${file}`);}}finally{await handle.close();}
 let record:Record<string,unknown>;try{record=openV5('store',value);}catch{throw new Error(`${folder} belongs to another Mac or is damaged; its records cannot be used here`);}
 const recorded=typeof record.baseIdentity==='string'?record.baseIdentity.split(':')[1]:undefined;
 // A drive mounted again may get another device number (and another name); the folder is the same inode.
 if(recorded!==String(baseStat.ino))throw new Error(`${folder} was copied from another folder; its records are not used. Use First Aid.`);
 const store={path:folder,base,dev:baseStat.dev,baseIno:baseStat.ino,ino:own.ino};
 storeCache.set(folder,{key,store});
 return store;
}
/** Every store a reader must consult for `folder`: in `folder` itself and each folder above it on the same
 * device, that holds a plain (not linked) "Photo Importer Data" folder with a verified record. A store folder
 * whose record is missing is skipped while empty (a creation cut short); one with records is refused. */
export async function storesFor(folder:string):Promise<Store[]>{
 const found:Store[]=[];let current=path.resolve(folder);
 const first=await maybeLstat(current);if(!first)return found;
 for(;;){
  const here=await maybeLstat(current);if(!here||here.dev!==first.dev||!here.isDirectory())break;
  const candidate=path.join(current,APP_DATA_FOLDER),stat=await maybeLstat(candidate);
  if(stat?.isDirectory()&&!stat.isSymbolicLink()&&stat.dev===here.dev){
   const store=await storeRecord(candidate,current,here);
   if(store)found.push(store);
   else if((await fs.readdir(candidate)).some(name=>name!=='.DS_Store'&&!name.startsWith('._')&&!/^store-[0-9a-f-]{36}\.tmp$/.test(name)))throw new Error(`Damaged ${APP_DATA_FOLDER} folder (no store record): ${candidate}`);
  }
  const parent=path.dirname(current);if(parent===current)break;current=parent;
 }
 return found;
}
/** The base for a library's records: the deepest configured destination it lies strictly beneath, on the same
 * device, whose store can be made; otherwise the library itself. */
export async function baseFor(library:string):Promise<string>{
 const resolved=path.resolve(library),own=await fs.lstat(resolved,{bigint:true});
 const candidates=destinations.filter(destination=>beneath(resolved,destination)).sort((a,b)=>b.length-a.length);
 for(const destination of candidates){
  const stat=await maybeLstat(destination).catch(()=>undefined);
  if(!stat?.isDirectory()||stat.isSymbolicLink()||stat.dev!==own.dev)continue;
  if(await ensureStore(destination).then(()=>true,()=>false))return destination;
 }
 return resolved;
}
/** The store at `base`, made if needed: the folder, then its sealed record (aside, then renamed into place). */
export async function ensureStore(base:string):Promise<Store>{
 if(path.resolve(base)!==base||await fs.realpath(base)!==base)throw new Error(`Unsafe records location: ${base}`);
 const baseStat=await fs.lstat(base,{bigint:true});if(!baseStat.isDirectory())throw new Error(`Unsafe records location: ${base}`);
 const folder=path.join(base,APP_DATA_FOLDER);
 try{await fs.mkdir(folder,{mode:0o700});await syncDirectory(base);}catch(error){if(code(error)!=='EEXIST')throw error;}
 const stat=await fs.lstat(folder,{bigint:true});
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==baseStat.dev)throw new Error(`Unsafe ${APP_DATA_FOLDER} folder: ${folder}`);
 const existing=await storeRecord(folder,base,baseStat);if(existing)return existing;
 const temporary=path.join(folder,`store-${randomUUID()}.tmp`);
 await writeNewFile(temporary,JSON.stringify(sealV5('store',{base,baseIdentity:`${baseStat.dev}:${baseStat.ino}`,minVersion:STORE_MIN_VERSION})));
 const file=path.join(folder,'store.json');
 if(await maybeLstat(file)){await fs.unlink(temporary).catch(()=>{});}
 else if(await renameChecked(temporary,file)!=='done')throw new Error(`Unable to create ${file}`);
 const store=await storeRecord(folder,base,baseStat);if(!store)throw new Error(`Unable to create ${file}`);
 return store;
}
/** Where `library` writes its records. */
export async function storeFor(library:string):Promise<Store>{return ensureStore(await baseFor(library));}
/** The store is still the folder recorded, in place, on the base's device, not a link. */
export async function storeUnchanged(store:Store):Promise<void>{
 const base=await fs.lstat(store.base,{bigint:true}),folder=await fs.lstat(store.path,{bigint:true});
 if(!base.isDirectory()||base.isSymbolicLink()||base.ino!==store.baseIno||folder.ino!==store.ino||!folder.isDirectory()||folder.isSymbolicLink()||folder.dev!==base.dev||await fs.realpath(store.path)!==store.path)throw new Error(`${APP_DATA_FOLDER} changed; scan again: ${store.path}`);
}
/** `file` is inside the store, with no link on the way. */
export async function inStore(file:string,store:Store):Promise<void>{await contained(file,store.path);}
/** A private folder inside the store, made if needed (and synchronized into its parent). */
export async function storeFolder(store:Store,...parts:string[]):Promise<string>{
 let current=store.path;
 for(const part of parts){
  current=path.join(current,part);await contained(current,store.path);
  try{await fs.mkdir(current,{mode:0o700});await syncDirectory(path.dirname(current));}catch(error){if(code(error)!=='EEXIST')throw error;}
  const stat=await fs.lstat(current,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==store.dev)throw new Error(`Unsafe records folder: ${current}`);
 }
 return current;
}
export const hash8=(text:string)=>createHash('sha256').update(text).digest('hex').slice(0,8);
const label=(folder:string)=>path.basename(folder)||'volume';
/** The folder name for a library's index and duplicate store: its name and a hash of its place under the base. */
export const libraryPartition=(store:Pick<Store,'base'>,library:string)=>`${label(library)} ${hash8(pathKey(path.relative(store.base,library)))}`;
/** The folder name for the sibling pointers kept for folder `folder`. */
export const pointerPartition=(folder:string)=>`${label(folder)} ${hash8(pathKey(folder))}`;
