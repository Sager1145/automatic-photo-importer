import * as fs from 'node:fs/promises';
import {constants,type BigIntStats} from 'node:fs';
import path from 'node:path';
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {APP_DATA_FOLDER} from './legacy-names';
import {ownRecordWrite} from './own-entries';
import {logDeletion} from '../logger';
import {beneath,checkAbort,code,contained,maybeLstat,pathKey,posixRelative,syncDirectory,unreliableIno,sameFileIgnoringCtime,exactStatKey,unlinkEntry,isOwnRealpath} from './paths';
export {APP_DATA_FOLDER} from './legacy-names';

/** Records v5: every record this app writes on a drive lives in one visible "Photo Importer Data" folder (the
 * store) at the base of a library: the configured destination the library sits in (same volume), or the library
 * itself. Every record is one sealed JSON line or file; logs are append-only and synchronized as a group. */
export const STORE_VERSION=5;
/** The first app version that reads this store; earlier versions are not supported on a drive that has one. */
export const STORE_MIN_VERSION='0.3.0';

// ---- Computer keys and seals ----
let hostKey:Buffer|undefined;
/** Keys of the other computers that write to the stores this app has opened, by id (docs/shared-records.md). */
const learnedKeys=new Map<string,Buffer>();
/** A computer key's id, as listed in a store record. */
export const keyId=(key:Buffer)=>createHash('sha256').update('photo-importer:computer-key\n').update(key).digest('hex').slice(0,16);
/** Configure once from the host's private application data, never from a drive record. It seals everything this
 * computer writes; stores this computer writes to list it, so every computer using the drive can verify its records. */
export function configureHostKey(secret:Buffer|string):void {
 const key=Buffer.isBuffer(secret)?Buffer.from(secret):Buffer.from(secret,'utf8');
 if(key.length<32)throw new Error('Recovery authentication requires a host key of at least 32 bytes');
 if(hostKey&&!hostKey.equals(key))throw new Error('Recovery host key is already configured');
 hostKey=key;
}
/** Keys a verified store record lists: each record sealed with one of them is accepted from then on. */
function learnKeys(keys:Buffer[]):void {for(const key of keys)if(!hostKey?.equals(key))learnedKeys.set(keyId(key),key);}
export function hostKeyConfigured():boolean {return !!hostKey;}
export function requireHostKey():Buffer {
 if(!hostKey)throw new Error('Organization recovery host authentication key is not configured');
 return hostKey;
}
/** Seal kinds: what a sealed record is, part of what its seal covers. */
export type SealKind='store'|'organization'|'entries'|'event'|'pointer'|'receipt'|'index'|'duplicates'|'drive'|'reviewed'|'cache';
const v5Seal=(kind:string,text:string,key:Buffer=requireHostKey())=>createHmac('sha256',key).update(`photo-importer:v5:${kind}\n${text}`).digest('hex');
/** A v5 record: the value with `v` and `kind`, sealed with this computer's key over a domain-separated text, so a
 * record of one kind (or one sealed by an earlier version) never verifies as another. */
export function sealV5(kind:SealKind,value:Record<string,unknown>):Record<string,unknown> {
 const {v:_v,kind:_kind,seal:_seal,...rest}=value;
 const unsigned={v:STORE_VERSION,kind,...rest};
 return {...unsigned,seal:v5Seal(kind,JSON.stringify(unsigned))};
}
export class SealError extends Error {constructor(message='Record authentication failed'){super(message);this.name='SealError';}}
/** The record verified with one of `keys` (without its seal), or a SealError. */
function openWith(kind:SealKind,value:unknown,keys:Iterable<Buffer>):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new SealError('Invalid record');
 const {seal,...unsigned}=value as Record<string,unknown>;
 if(unsigned.v!==STORE_VERSION||unsigned.kind!==kind)throw new SealError(`Not a version ${STORE_VERSION} ${kind} record`);
 if(typeof seal!=='string'||!/^[a-f0-9]{64}$/.test(seal))throw new SealError();
 const text=JSON.stringify(unsigned),given=Buffer.from(seal,'hex');
 for(const key of keys)if(timingSafeEqual(given,Buffer.from(v5Seal(kind,text,key),'hex')))return unsigned;
 throw new SealError();
}
/** The verified record (without its seal), or a SealError: sealed by this computer, or by another computer listed
 * in a store this app has opened. */
export function openV5(kind:SealKind,value:unknown):Record<string,unknown> {
 return openWith(kind,value,[requireHostKey(),...learnedKeys.values()]);
}
/** One sealed line (no newline). */
export const sealedLine=(kind:SealKind,value:Record<string,unknown>)=>JSON.stringify(sealV5(kind,value));

// ---- Streaming line reader ----
/** Longest line of each kind. A longer line that is valid JSON is refused; one that is not is what an
 * interrupted write leaves (cut short, zero-filled) and carries nothing. No line is ever buffered past HARD_LINE_CAP. */
/** Events: the earlier version limited them to 2048 characters, which is up to 6 KiB of UTF-8 (paths in any script). */
export const LINE_CAPS={event:8192,header:64*1024,entries:64*1024*1024,receipt:32*1024,pointer:4096} as const;
export const HARD_LINE_CAP=64*1024*1024;
const CHUNK=1024*1024;
export class RecordTooLarge extends Error {constructor(file:string){super(`Record too large: ${file}`);this.name='RecordTooLarge';}}
/** Reads only whole lines, in 1 MiB chunks, from `from`. `capFor(n)` is the cap for the n-th line read in this
 * call. Lines within their cap go to `onLine` with their start offset; the final line without a newline goes to
 * `onTail` (an append cut short, or one still being written). Returns the offset after the last newline read. */
export async function readLines(handle:fs.FileHandle,file:string,from:number,capFor:(n:number)=>number,onLine:(text:string,start:number,n:number)=>void|Promise<void>,options:{onTail?:(text:string,start:number,n:number)=>void|Promise<void>;signal?:AbortSignal;onBytes?:(position:number,size:number)=>void;/** Stop after this many lines. */limit?:number}={}):Promise<{end:number;lines:number}>{
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
  checkAbort(options.signal);
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
   if(options.limit!==undefined&&n>=options.limit)return {end:lineStart,lines:n};
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
interface Log {waiting:Waiter[];chain:Promise<void>;scheduled:boolean;create:boolean;}
const logs=new Map<string,Log>();
/** Whether every group also synchronizes the log's folder. The exFAT durability probe (design r2 §11 T1, 120/120 runs
 * on FSKit exFAT) showed a synchronized file keeps its new size without it; a log's folder is still synchronized
 * when the log is created (its name must be durable before what depends on it). */
export const SYNC_LOG_FOLDER_EACH_GROUP=false;
/** For tests: how many writes, file and folder synchronizations the logs made. */
export const logStats={writes:0,fileSyncs:0,folderSyncs:0};
const logFor=(file:string)=>{let log=logs.get(file);if(!log){log={waiting:[],chain:Promise.resolve(),scheduled:false,create:true};logs.set(file,log);}return log;};
/** Append lines to `file` and return once they are durable. Every append waiting when a write starts goes in
 * that one write, followed by one synchronization of the file (and of its folder when the file is new, or when
 * SYNC_LOG_FOLDER_EACH_GROUP is set). `check` runs right before the write (containment, identities); an append
 * whose check fails is refused alone. */
export function appendLines(file:string,lines:string[],check?:()=>Promise<void>,options:{/** false: the log must already exist (a journal, whose first lines are written when it is created). */create?:boolean}={}):Promise<void>{
 if(lines.some(line=>line.includes('\n')))return Promise.reject(new Error('Invalid record line'));
 return new Promise<void>((resolve,reject)=>{
  const log=logFor(file);log.create=options.create!==false;log.waiting.push({lines,check,resolve,reject});
  if(!log.scheduled){log.scheduled=true;log.chain=log.chain.then(()=>flush(file,log));}
 });
}
async function flush(file:string,log:Log):Promise<void>{
 log.scheduled=false;
 const batch=log.waiting.splice(0),ready:Waiter[]=[];
 for(const waiter of batch){try{await waiter.check?.();ready.push(waiter);}catch(error){waiter.reject(error);}}
 if(!ready.length)return;
 try{
  const created=log.create&&!await maybeLstat(file);
  const handle=await fs.open(file,constants.O_RDWR|constants.O_APPEND|(log.create?constants.O_CREAT:0)|(constants.O_NOFOLLOW??0),0o600);if(created)ownRecordWrite(file);
  try{
   const opened=await handle.stat();if(!opened.isFile()||opened.nlink!==1)throw new Error(`Unsafe record log: ${file}`);
   // Start on a fresh line if an interrupted write left a partial one.
   let torn=false;if(opened.size>0){const last=Buffer.alloc(1);await handle.read(last,0,1,opened.size-1);torn=last[0]!==0x0a;}
   await handle.writeFile((torn?'\n':'')+ready.flatMap(waiter=>waiter.lines).join('\n')+'\n');logStats.writes++;
   await handle.sync();logStats.fileSyncs++;
  }finally{await handle.close();}
  if(created||SYNC_LOG_FOLDER_EACH_GROUP){await syncDirectory(path.dirname(file));logStats.folderSyncs++;}
  for(const waiter of ready)waiter.resolve();
 }catch(error){for(const waiter of ready)waiter.reject(error);}
}
/** Run `work` with no append to `file` in progress or starting (a segment's deletion check). */
export function holdLog<T>(file:string,work:()=>Promise<T>):Promise<T>{
 const log=logFor(file),run=log.chain.then(work);log.chain=run.then(()=>{},()=>{});return run;
}
/** A new file holding exactly `text`, created exclusively, synchronized with its folder. */
export async function writeNewFile(file:string,text:string):Promise<void>{
 const handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);ownRecordWrite(file);
 try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
 await syncDirectory(path.dirname(file));
}

/** The verified payload of the sealed record in `file`, or undefined when it is not a regular file or is larger than `maxBytes`.
 * Throws when it cannot be read, is not JSON or is not sealed by a computer this one knows (callers start empty then). `read` supplies the text (progress). */
export async function readSealedRecord(kind:SealKind,file:string,maxBytes:number,read:(file:string,size:number)=>Promise<string>=(name)=>fs.readFile(name,'utf8')):Promise<Record<string,unknown>|undefined>{
 const stat=await fs.lstat(file);
 if(!stat.isFile()||stat.size>maxBytes)return undefined;
 return openV5(kind,JSON.parse(await read(file,stat.size)));
}
/** Replaces the sealed record at `target` in one step: written to an exclusive sibling `<prefix>-<uuid>.tmp`, synchronized, renamed over `target`, then the folder synchronized.
 * A failure before the rename removes the sibling; a crash leaves either version (and a temp file the residue cleanup removes). */
export async function replaceSealed(kind:SealKind,target:string,prefix:string,payload:Record<string,unknown>):Promise<void>{
 const temporary=path.join(path.dirname(target),`${prefix}-${randomUUID()}.tmp`);
 try{
  const handle=await fs.open(temporary,'wx',0o600);ownRecordWrite(temporary);
  try{await handle.writeFile(JSON.stringify(sealV5(kind,payload)));await handle.sync();}finally{await handle.close();}
  await fs.rename(temporary,target);
 }catch(error){await unlinkEntry(temporary).then(()=>logDeletion('store',temporary,'temporary sealed record of a write that failed','written by this call, never renamed into place'),()=>{});throw error;}
 await syncDirectory(path.dirname(target));
}

// ---- Both-names rule ----
/** Two names for one file, or a target that is not what was moved: nothing is unlinked, the user is told. */
export class FirstAidError extends Error {readonly code='first-aid';constructor(message:string){super(message);this.name='FirstAidError';}}
/** Where a rename stands, judged by both names: 'source' (not done), 'target' (done), 'both-same' (one file, two
 * names: stop), 'both' (two files: stop), 'none'. */
export async function bothNames(source:string,target:string):Promise<'source'|'target'|'both-same'|'both'|'none'>{
 const [from,to]=await Promise.all([maybeLstat(source),maybeLstat(target)]);
 if(from&&to)return from.dev===to.dev&&from.ino===to.ino&&!unreliableIno(from)?'both-same':'both';
 return from?'source':to?'target':'none';
}
/** The same file after a rename: device, size and inode (birth time where the inode is unreliable). */
export const renamedIdentity=(before:BigIntStats)=>(after:BigIntStats)=>sameFileIgnoringCtime(before,after);
/** rename(2) under the both-names rule: the target must be absent first; afterwards the source must be gone
 * and the target must be the file that was moved (`expected`, by default the source's identity). 'retry': the
 * source is still there and the target absent (a fresh name may be tried where names are free-form). Anything
 * else stops with a FirstAidError, unlinking neither name. Synchronizes both folders when done. */
export async function renameChecked(source:string,target:string,expected?:(stat:BigIntStats)=>boolean):Promise<'done'|'retry'>{
 if(await maybeLstat(target))throw new FirstAidError(`Something is already at ${target}; nothing was moved`);
 const before=await fs.lstat(source,{bigint:true});
 await fs.rename(source,target);ownRecordWrite(source);ownRecordWrite(target);
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
export interface Store {/** The "Photo Importer Data" folder. */path:string;/** The folder it is in. */base:string;dev:bigint;baseIno:bigint;/** The store folder's own inode. */ino:bigint;
 /** false: a store an earlier version made on another computer. Nothing in it verifies here until that computer
  * uses the drive with this version; this computer still reads and writes it (docs/shared-records.md). */
 verified:boolean;
 /** The store record lists this computer's key and this system's identity of the base (a writer joins otherwise). */
 joined:boolean;
 /** Every path a computer writing to the store has had the base at (`/Volumes/A006`, `I:\`, `E:\`): records name
  * paths under these, and `recordedPath` reads them as paths under `base`. */
 bases:string[];
 /** A computer the store's key list does not name has written here (an earlier version's store, kept as `legacy`):
  * a record that verifies with no known key is most likely its, and cannot be checked until it joins. */
 unlisted?:Writer;}
/** A computer that wrote to a store, as far as its earlier record tells: the base path it had, and the system that path is from. */
export interface Writer {base?:string;system?:'darwin'|'win32'|'linux';}
/** The system a base path is from, by its form: a drive letter is Windows, /Volumes macOS, /media and /mnt Linux. */
export function pathSystem(base:string):Writer['system']{
 if(/^[A-Za-z]:([\\/]|$)/.test(base)||base.startsWith('\\\\'))return 'win32';
 if(/^\/Volumes(\/|$)/.test(base))return 'darwin';
 if(/^\/(media|mnt|run\/media)(\/|$)/.test(base))return 'linux';
 return undefined;
}
const writerOf=(record:Record<string,unknown>):Writer=>{const base=typeof record.base==='string'?record.base:undefined,system=base?pathSystem(base):undefined;return {...(base?{base}:{}),...(system?{system}:{})};};
let destinations:string[]=[];
/** The configured destinations (and folders organized in place on their own drive): a library beneath one keeps
 * its records in that destination's store, on the same volume. */
export function registerDestinations(paths:string[]):void {destinations=[...new Set(paths.filter(Boolean).map(item=>path.resolve(item)))];}
export function registeredDestinations():string[] {return [...destinations];}
/** A folder entry that is not Finder or temp-store bookkeeping, so counts as content. */
const storeFolderEntry=(name:string)=>name!=='.DS_Store'&&!name.startsWith('._')&&!/^store-[0-9a-f-]{36}\.tmp$/.test(name);
const storeCache=new Map<string,{key:string;store:Store;record:StoreRecord}>();
/** The base folder's identity on this system: the volume serial and file id on Windows (a volume root's file id is 0
 * there, and the serial is the same on every PC); the inode elsewhere, where device numbers change between mounts. */
export const storeIdentity=(stat:Pick<BigIntStats,'dev'|'ino'>,platform:NodeJS.Platform=process.platform)=>platform==='win32'?`${stat.dev}:${stat.ino}`:String(stat.ino);
/** A computer that writes to a store, as its record lists it. */
interface Computer {id:string;platform:string;key:string;}
/** What a store record says, checked. `computers` is undefined for a record an earlier version wrote. */
interface StoreRecord {computers?:Computer[];/** Each system's identity of the base, by `process.platform`. */identities:Record<string,string>;/** Every path a computer has had the base at. */bases:string[];/** An earlier version's record, kept as it was. */legacy?:Record<string,unknown>;verified:boolean;/** Its writer, when no listed key sealed it. */unlisted?:Writer;}
const damagedRecord=(file:string)=>new Error(`Damaged ${APP_DATA_FOLDER} record: ${file}`);
const isObject=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** An earlier version's record verified with this computer's key: its base identity, in this system's form (it wrote
 * `dev:ino`, and only on the system it ran on). Undefined when another computer sealed it. */
function ownLegacyIdentity(record:Record<string,unknown>):string|undefined{
 let opened:Record<string,unknown>;try{opened=openWith('store',record,[requireHostKey()]);}catch(error){if(error instanceof SealError)return undefined;throw error;}
 const recorded=typeof opened.baseIdentity==='string'?opened.baseIdentity:'';
 return process.platform==='win32'?recorded:recorded.split(':')[1]??'';
}
/** store.json, checked: a shared record sealed by one of the keys it lists (which are learned), or an earlier
 * version's single-computer record, verified only when this computer sealed it (docs/shared-records.md). */
async function readStoreRecord(folder:string,file:string,stat:BigIntStats):Promise<StoreRecord>{
 if(!stat.isFile()||stat.size>BigInt(LINE_CAPS.header))throw damagedRecord(file);
 const handle=await openRegular(file);let value:unknown;
 try{try{value=JSON.parse(await handle.readFile('utf8'));}catch{throw damagedRecord(file);}}finally{await handle.close();}
 if(!isObject(value)||value.v!==STORE_VERSION||value.kind!=='store'||typeof value.seal!=='string')throw damagedRecord(file);
 if(value.computers===undefined){
  const identity=ownLegacyIdentity(value);
  const bases=typeof value.base==='string'?[value.base]:[];
  return {identities:identity===undefined?{}:{[process.platform]:identity},bases,legacy:value,verified:identity!==undefined,...(identity===undefined?{unlisted:writerOf(value)}:{})};
 }
 const computers=value.computers;
 if(!Array.isArray(computers)||!computers.length||computers.some(item=>!isObject(item)||typeof item.platform!=='string'||typeof item.key!=='string'||Buffer.from(item.key,'base64').length<32||item.id!==keyId(Buffer.from(item.key,'base64'))))throw damagedRecord(file);
 const keys=(computers as Computer[]).map(item=>Buffer.from(item.key,'base64'));
 let record:Record<string,unknown>;
 try{record=openWith('store',value,keys);}catch(error){if(error instanceof SealError)throw new Error(`${folder} is damaged or was not made by this app; its records cannot be used. Use First Aid.`);throw error;}
 const identities=record.identities,bases=record.bases??[];
 if(!isObject(identities)||Object.values(identities).some(item=>typeof item!=='string')||!Array.isArray(bases)||bases.some(item=>typeof item!=='string')||record.legacy!==undefined&&!isObject(record.legacy))throw damagedRecord(file);
 learnKeys(keys);
 const legacy=record.legacy as Record<string,unknown>|undefined,own={...identities} as Record<string,string>;
 // A store this computer made with an earlier version, joined since by another system: its old record still names this system's identity.
 if(own[process.platform]===undefined&&legacy){const identity=ownLegacyIdentity(legacy);if(identity!==undefined)own[process.platform]=identity;}
 // An earlier record no listed key (nor this computer's) sealed: its computer has not joined, so its records do not verify yet.
 let unlisted:Writer|undefined;
 if(legacy){try{openWith('store',legacy,[requireHostKey(),...keys]);}catch(error){if(!(error instanceof SealError))throw error;unlisted=writerOf(legacy);}}
 return {computers:computers as Computer[],identities:own,bases:bases as string[],...(legacy?{legacy}:{}),verified:true,...(unlisted?{unlisted}:{})};
}
/** The store's own record, sealed; read and checked against the folder it is in. Undefined when absent. */
async function openStore(folder:string,base:string,baseStat:BigIntStats):Promise<{store:Store;record:StoreRecord}|undefined>{
 const file=path.join(folder,'store.json'),stat=await maybeLstat(file);if(!stat)return undefined;
 const own=await fs.lstat(folder,{bigint:true}),key=`${exactStatKey(stat)}:${baseStat.ino}:${own.ino}`;
 const cached=storeCache.get(folder);if(cached&&cached.key===key&&cached.store.base===base)return {store:{...cached.store,dev:baseStat.dev},record:cached.record};
 const record=await readStoreRecord(folder,file,stat),recorded=record.identities[process.platform];
 // A drive mounted again may get another device number (and another name or drive letter); the folder is the same one.
 if(recorded!==undefined&&recorded!==storeIdentity(baseStat))throw new Error(`${folder} was copied from another folder; its records are not used. Use First Aid.`);
 if(!record.verified)console.warn(`Records in ${folder} were written by another computer with an earlier version; they are kept as history and not acted on here until that computer uses this drive again.`);
 // Joined also means the store knows the path the base has here now (a drive letter can change).
 const joined=recorded!==undefined&&record.bases.includes(base)&&!!record.computers?.some(item=>item.id===keyId(requireHostKey()));
 const store:Store={path:folder,base,dev:baseStat.dev,baseIno:baseStat.ino,ino:own.ino,verified:record.verified,joined,bases:record.bases,...(record.unlisted?{unlisted:record.unlisted}:{})};
 storeCache.set(folder,{key,store,record});
 return {store,record};
}
async function storeRecord(folder:string,base:string,baseStat:BigIntStats):Promise<Store|undefined>{return (await openStore(folder,base,baseStat))?.store;}
/** Every store a reader must consult for `folder`: in `folder` itself and each folder above it on the same
 * device, that holds a plain (not linked) "Photo Importer Data" folder with a verified record. A folder by that
 * name without a record (a creation cut short, or the user's own folder) is skipped; writers refuse to adopt one
 * that holds anything. */
export async function storesFor(folder:string):Promise<Store[]>{
 const found:Store[]=[];let current=path.resolve(folder);
 const first=await maybeLstat(current);if(!first)return found;
 for(;;){
  const here=await maybeLstat(current);if(!here||here.dev!==first.dev||!here.isDirectory())break;
  const candidate=path.join(current,APP_DATA_FOLDER),stat=await maybeLstat(candidate);
  if(stat?.isDirectory()&&!stat.isSymbolicLink()&&stat.dev===here.dev){
   const store=await storeRecord(candidate,current,here);
   if(store)found.push(store);
   // Not a store (a folder of the user's own, or one whose record is missing): skipped, never read or written.
   else if((await fs.readdir(candidate)).some(name=>storeFolderEntry(name)))console.warn(`Skipped ${candidate}: it has no store record, so it is not this app's records folder`);
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
const creating=new Map<string,Promise<Store>>();
/** The store at `base`, made if needed: the folder, then its sealed record (aside, then renamed into place). Callers
 * that find it missing at the same time share one creation. */
export function ensureStore(base:string):Promise<Store>{
 let made=creating.get(base);
 if(!made){made=createStore(base).finally(()=>{if(creating.get(base)===made)creating.delete(base);});creating.set(base,made);}
 return made;
}
/** A store record listing this computer (its key, and this system's identity of the base) after those `record` lists. */
function joinedRecord(base:string,baseStat:BigIntStats,record?:StoreRecord):Record<string,unknown>{
 const key=requireHostKey(),me:Computer={id:keyId(key),platform:process.platform,key:key.toString('base64')};
 return {base,minVersion:STORE_MIN_VERSION,computers:[...(record?.computers??[]).filter(item=>item.id!==me.id),me],identities:{...record?.identities,[process.platform]:storeIdentity(baseStat)},bases:[...new Set([...(record?.bases??[]),base])].slice(-32),...(record?.legacy?{legacy:record.legacy}:{})};
}
async function createStore(base:string):Promise<Store>{
 if(path.resolve(base)!==base||!await isOwnRealpath(base))throw new Error(`Unsafe records location: ${base}`);
 const baseStat=await fs.lstat(base,{bigint:true});if(!baseStat.isDirectory())throw new Error(`Unsafe records location: ${base}`);
 const folder=path.join(base,APP_DATA_FOLDER);
 try{await fs.mkdir(folder,{mode:0o700});ownRecordWrite(folder);await syncDirectory(base);}catch(error){if(code(error)!=='EEXIST')throw error;}
 const stat=await fs.lstat(folder,{bigint:true});
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==baseStat.dev)throw new Error(`Unsafe ${APP_DATA_FOLDER} folder: ${folder}`);
 const file=path.join(folder,'store.json'),existing=await openStore(folder,base,baseStat);
 if(existing?.store.joined)return existing.store;
 if(existing){
  // Joining: this computer's key and identity are added in one replace; everything other computers wrote stays as it is.
  await replaceSealed('store',file,'store',joinedRecord(base,baseStat,existing.record));
 }else{
  // Only an empty folder (a creation cut short) is adopted; one holding records without its own record is refused, as readers refuse it.
  if((await fs.readdir(folder)).some(name=>storeFolderEntry(name)))throw new Error(`Damaged ${APP_DATA_FOLDER} folder (no store record): ${folder}`);
  const temporary=path.join(folder,`store-${randomUUID()}.tmp`);
  await writeNewFile(temporary,JSON.stringify(sealV5('store',joinedRecord(base,baseStat))));
  if(await maybeLstat(file)){await unlinkEntry(temporary).then(()=>logDeletion('store',temporary,'store record written by a creation another one beat','written by this call'),()=>{});}
  else if(await renameChecked(temporary,file)!=='done')throw new Error(`Unable to create ${file}`);
 }
 const store=await storeRecord(folder,base,baseStat);if(!store)throw new Error(`Unable to create ${file}`);
 return store;
}
/** `recorded`, a path a record names, as a path here: under the base where some system that wrote to the store had it
 * (`/Volumes/A006/photobackup` or `I:\photobackup`), read under `store.base` with this system's separator. Undefined
 * when it is under none of them. */
export function recordedPath(store:Pick<Store,'base'|'bases'>,recorded:string):string|undefined{
 const parts=(text:string)=>text.split(/[\\/]+/).filter(Boolean);
 const named=parts(recorded);
 for(const base of new Set([store.base,...store.bases])){
  const prefix=parts(base);
  if(prefix.length&&prefix.length<=named.length&&prefix.every((part,index)=>pathKey(part)===pathKey(named[index]!)))return path.join(store.base,...named.slice(prefix.length));
 }
 return undefined;
}
/** Joins the store already at `base`, if there is one this computer is not listed in yet, so the records it wrote
 * there verify on every computer as soon as it sees the drive (docs/shared-records.md). Never makes a store. */
export async function joinStore(base:string):Promise<boolean>{
 const stat=await maybeLstat(base),folder=path.join(base,APP_DATA_FOLDER),own=await maybeLstat(folder);
 if(!stat?.isDirectory()||!own?.isDirectory()||own.isSymbolicLink()||own.dev!==stat.dev)return false;
 const found=await openStore(folder,base,stat);
 if(!found||found.store.joined)return false;
 return (await ensureStore(base)).joined;
}
/** Where `library` writes its records. */
export async function storeFor(library:string):Promise<Store>{return ensureStore(await baseFor(library));}
/** The store is still the folder recorded, in place, on the base's device, not a link. */
export async function storeUnchanged(store:Store):Promise<void>{
 const base=await fs.lstat(store.base,{bigint:true}),folder=await fs.lstat(store.path,{bigint:true});
 if(!base.isDirectory()||base.isSymbolicLink()||base.ino!==store.baseIno||folder.ino!==store.ino||!folder.isDirectory()||folder.isSymbolicLink()||folder.dev!==base.dev||!await isOwnRealpath(store.path))throw new Error(`${APP_DATA_FOLDER} changed; scan again: ${store.path}`);
}
/** `file` is inside the store, with no link on the way. */
export async function inStore(file:string,store:Store):Promise<void>{await contained(file,store.path);}
/** A private folder inside the store, made if needed (and synchronized into its parent). */
export async function storeFolder(store:Store,...parts:string[]):Promise<string>{
 let current=store.path;
 for(const part of parts){
  current=path.join(current,part);await contained(current,store.path);
  try{await fs.mkdir(current,{mode:0o700});ownRecordWrite(current);await syncDirectory(path.dirname(current));}catch(error){if(code(error)!=='EEXIST')throw error;}
  const stat=await fs.lstat(current,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==store.dev)throw new Error(`Unsafe records folder: ${current}`);
 }
 return current;
}
export const hash8=(text:string)=>createHash('sha256').update(text).digest('hex').slice(0,8);
const label=(folder:string)=>path.basename(folder)||'volume';
/** What a library partition's hash covers: its place under the base, with "/", and the system. Caches name files by
 * that system's identities, so each system keeps its own (macOS keeps the name earlier versions gave it) and a drive
 * moving between a Mac and a PC never makes either rebuild the other's. */
const partitionKey=(relative:string)=>process.platform==='darwin'?pathKey(relative):`${process.platform}\n${pathKey(relative)}`;
/** The folder name for a library's index and duplicate store: its name and a hash of its place under the base and system. */
export const libraryPartition=(store:Pick<Store,'base'>,library:string)=>`${label(library)} ${hash8(partitionKey(posixRelative(store.base,library)))}`;
/** The folder name for the sibling pointers kept for folder `folder`. */
export const pointerPartition=(folder:string)=>`${label(folder)} ${hash8(pathKey(folder))}`;
