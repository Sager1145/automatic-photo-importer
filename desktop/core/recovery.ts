import * as fs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { OrganizationRecovery, Progress, TransferPlan } from '../shared';
export type { OrganizationRecovery } from '../shared';
import {applyFileTimestamps} from '../platform/file-timestamps';
import { beneath, checkAbort, code, contained, within, digest, identity, isAbort, makeParent, pathKey, regularHandle, rootUnchanged, syncDirectory, syncParents, syncFile } from './paths';

/** retained: originals kept in recovery storage for undo (copy path only); renamed files keep none.
 * released: retained duplicates removed right after a clean run (only when that was asked for). */
export interface ReorganizationResult {copied:number;skipped:number;errors:string[];moved:number;retained:number;retainedBytes:number;notes?:string[];released?:number;releasedBytes?:number;}
/** rename: move each file on its volume with rename(2); copy: verified copy plus a retained original. */
export type OrganizationStrategy='rename'|'copy';
export interface OrganizationEntry {captureTimeMs?:number;source:string;destination:string;digest:string;size:number;stat:BigIntStats;move:boolean;}
interface FileIdentity {dev:string;ino:string;size:string;mtime:string;ctime:string;}
interface Entry {captureTimeMs?:number;source:string;destination:string;digest:string;size:number;stat:FileIdentity;move:boolean;parents:Record<string,string>;}
interface Manifest {version:1;id:string;root:string;rootIdentity:string;source:string;sourceIdentity:string;entries:Entry[];strategy?:'rename';keepFolders?:true;/** Other backup folders organized from the same source (the video-root layout's); never removed as empty. */libraries?:string[];}
/** Visible on purpose: the app never creates hidden folders. */
export const RECOVERY_FOLDER='Photo Importer Recovery';
/** Where versions before RECOVERY_FOLDER kept their journals and originals. */
export const LEGACY_RECOVERY_FOLDER='.photo-importer-recovery';
const storage=RECOVERY_FOLDER;
export const isRecoveryName=(name:string)=>[RECOVERY_FOLDER,LEGACY_RECOVERY_FOLDER].some(item=>item.toLowerCase()===name.toLowerCase());
/** Move journals an earlier version kept in the hidden folder into the visible one, on the same volume. */
async function adoptLegacyStorage(root:string):Promise<void>{
 const legacy=path.join(root,LEGACY_RECOVERY_FOLDER),visible=path.join(root,storage);
 const old=await fs.lstat(legacy).catch(error=>{if(code(error)==='ENOENT')return undefined;throw error;});
 if(!old)return;if(!old.isDirectory()||old.isSymbolicLink())throw new Error('Unsafe recovery storage');
 await contained(legacy,root);await contained(visible,root);
 if(!await fs.lstat(visible).catch(error=>{if(code(error)==='ENOENT')return undefined;throw error;})){await fs.rename(legacy,visible);await syncDirectory(root);return;}
 // Both exist: move each journal that the visible folder does not already hold.
 for(const name of await fs.readdir(legacy)){
  if(!uuid.test(name))continue;const target=path.join(visible,name);
  if(await fs.lstat(target).then(()=>true,error=>{if(code(error)==='ENOENT')return false;throw error;}))continue;
  await fs.rename(path.join(legacy,name),target);
 }
 await syncDirectory(visible);await syncDirectory(legacy);
 await fs.rmdir(legacy).catch(error=>{if(code(error)!=='ENOTEMPTY'&&code(error)!=='EEXIST')throw error;});await syncDirectory(root);
}
let hostKey:Buffer|undefined;
/** Configure once from the host's private application data, never from a drive journal. */
export function configureOrganizationRecovery(secret:Buffer|string):void {
 const key=Buffer.isBuffer(secret)?Buffer.from(secret):Buffer.from(secret,'utf8');
 if(key.length<32)throw new Error('Recovery authentication requires a host key of at least 32 bytes');
 if(hostKey&&!hostKey.equals(key))throw new Error('Recovery host key is already configured');
 hostKey=key;
}
function signed(value:Record<string,unknown>):Record<string,unknown> {
 if(!hostKey)throw new Error('Organization recovery host authentication key is not configured');
 return {...value,seal:createHmac('sha256',hostKey).update(JSON.stringify(value)).digest('hex')};
}
function authenticated(value:unknown):Record<string,unknown> {
 if(!hostKey)throw new Error('Organization recovery host authentication key is not configured');
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid recovery authentication record');
 const {seal,...unsigned}=value as Record<string,unknown>;
 if(typeof seal!=='string'||!/^([a-f0-9]{64})$/.test(seal)||!timingSafeEqual(Buffer.from(seal,'hex'),Buffer.from(signed(unsigned).seal as string,'hex')))throw new Error('Recovery journal authentication failed; originals retained');
 return unsigned;
}
// Import journals share the private host key. An unsigned legacy intent can
// explain an interruption, but can never authorize writing an existing file.
export function importRecoveryAvailable():boolean {return !!hostKey;}
export function sealImportRecord(value:Record<string,unknown>):Record<string,unknown> {return hostKey?signed(value):value;}
export function authenticateImportRecord(value:unknown):Record<string,unknown> {return authenticated(value);}
const UUID_PATTERN='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',uuid=new RegExp(`^${UUID_PATTERN}$`);
const locks=new Map<string,Promise<unknown>>();
async function locked<T>(key:string,work:()=>Promise<T>):Promise<T> {
 const previous=locks.get(key)??Promise.resolve();let release!:()=>void;const next=new Promise<void>(r=>{release=r;});locks.set(key,next);
 await previous.catch(()=>{});try{return await work();}finally{release();if(locks.get(key)===next)locks.delete(key);}
}
function snapshot(stat:BigIntStats):FileIdentity {return {dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtime:String(stat.mtimeNs),ctime:String(stat.ctimeNs)};}
/** An empty file has no stable inode on exFAT (a synthetic number that changes on rename),
 * so it is identified by device, size and times only. */
function matches(stat:BigIntStats,expected:FileIdentity,renamed=false):boolean {
 const actual=snapshot(stat);return Object.keys(expected).every(k=>renamed&&k==='ctime'||k==='ino'&&expected.size==='0'||actual[k as keyof FileIdentity]===expected[k as keyof FileIdentity]);
}
export const sameFile=matches;
async function jsonFile(file:string,value:unknown):Promise<void> {
 const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}await syncDirectory(path.dirname(file));
}
async function ensureDirectory(folder:string,root:string):Promise<void> {
 await contained(folder,root);try{await fs.mkdir(folder,{mode:0o700});await syncDirectory(path.dirname(folder));}catch(error){if(code(error)!=='EEXIST')throw error;}
 await contained(folder,root);const stat=await fs.lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error(`Unsafe recovery directory: ${folder}`);
}
async function maybeStat(file:string):Promise<BigIntStats|undefined> {try{return await fs.lstat(file,{bigint:true});}catch(error){if(code(error)==='ENOENT')return;throw error;}}
function jobPath(root:string,id:string):string {if(!uuid.test(id))throw new Error('Invalid recovery identifier');return path.join(root,storage,id);}
interface JournalState {slots:Map<number,string[]>;exclusive:Map<number,FileIdentity[]>;complete:boolean;finalizing:Set<number>;finalized:Set<number>;superseded?:string;/** Where the successor's journal is when it is not this root: a sibling backup folder its manifest lists. */successorRoot?:string;
 renameIntent:Set<number>;renamed:Map<number,FileIdentity>;dated:Map<number,Set<string>>;fallback:Set<number>;published:Set<number>;undone:Set<number>;undoComplete:boolean;
 /** Entries a later complete organization moved on from their destination; that one owns them now. */handedOff:Map<number,HandOff>;}
/** A later journal (`successor`, in `successorRoot`) that moved an entry's file from its destination to `destination`. */
interface HandOff {successor:string;successorRoot:string;destination:string;}
function originalPath(m:Manifest,index:number,slot:string):string{return path.join(jobPath(m.root,m.id),'originals',String(index),slot,path.basename(m.entries[index]!.source));}
/** Finished journals' events, by journal folder, kept for this app session. A journal from an earlier
 * version can hold tens of thousands of event files: on a USB drive, reading them takes many minutes,
 * and every listing and every organization's check of earlier journals would read them again. */
const finishedJournals=new Map<string,{stamp:string;state:JournalState}>();
/** Changes whenever an event is added: the folder itself (identity and dates), how many files it
 * holds, and the event log's size and dates. */
async function journalStamp(folder:string,names:string[]):Promise<string>{
 const [own,log]=await Promise.all([fs.lstat(folder,{bigint:true}),fs.lstat(path.join(folder,eventLog),{bigint:true}).catch(()=>undefined)]);
 return [own.dev,own.ino,own.mtimeNs,own.ctimeNs,names.length,log?.ino,log?.size,log?.mtimeNs].join(':');
}
/** Fully undone, superseded, or complete with every finalize finished and nothing undone. Only these
 * are cached. Anything the app records later (a successor, a hand-off, a finalize or an undo) is an
 * append, which changes the stamp; the app never rewrites events in place. */
const finished=(state:JournalState)=>state.undoComplete||!!state.superseded||state.complete&&state.finalizing.size===state.finalized.size&&state.undone.size===0;
function copyState(state:JournalState):JournalState{
 return {...state,slots:new Map([...state.slots].map(([index,slots])=>[index,[...slots]])),exclusive:new Map([...state.exclusive].map(([index,stats])=>[index,[...stats]])),
  finalizing:new Set(state.finalizing),finalized:new Set(state.finalized),renameIntent:new Set(state.renameIntent),renamed:new Map(state.renamed),
  dated:new Map([...state.dated].map(([index,dates])=>[index,new Set(dates)])),fallback:new Set(state.fallback),published:new Set(state.published),undone:new Set(state.undone),handedOff:new Map(state.handedOff)};
}
/** `onRead`: records read so far out of the journal's files, for journals written one file per event.
 * `follow` false reads only this journal's own signed events, without checking its successor.
 * `folder`: where the journal's folder is now, when it differs from its recorded root only by case. */
async function readEvents(m:Manifest,chain=new Set<string>(),onRead?:(read:number,total:number)=>void,follow=true,folder=m.root):Promise<JournalState> {
 if(chain.has(m.id))throw new Error('Organization supersession cycle');chain=new Set(chain).add(m.id);
 const state:JournalState={slots:new Map(),exclusive:new Map(),complete:false,finalizing:new Set(),finalized:new Set(),renameIntent:new Set(),renamed:new Map(),dated:new Map(),fallback:new Set(),published:new Set(),undone:new Set(),undoComplete:false,handedOff:new Map()};
 const apply=(record:Record<string,unknown>)=>{
  if(record.id!==m.id||record.root!==m.root)throw new Error('Invalid recovery event scope');
  if(record.event==='complete'){state.complete=true;return;}
  if(record.event==='undo-complete'){state.undoComplete=true;return;}
  if(record.event==='superseded'){
   const successorRoot=record.successorRoot;
   if(typeof record.successor!=='string'||!uuid.test(record.successor)||record.successor===m.id||(state.superseded&&(state.superseded!==record.successor||state.successorRoot!==successorRoot)))throw new Error('Invalid organization successor');
   if(successorRoot!==undefined&&(typeof successorRoot!=='string'||path.resolve(successorRoot)!==successorRoot||successorRoot===m.root))throw new Error('Invalid organization successor folder');
   state.superseded=record.successor;if(successorRoot!==undefined)state.successorRoot=successorRoot;return;
  }
  if(!Number.isSafeInteger(record.index)||(record.index as number)<0||(record.index as number)>=m.entries.length)throw new Error('Invalid recovery entry index');
  const index=record.index as number;
  if(record.event==='finalize-intent'||record.event==='finalized')(record.event==='finalize-intent'?state.finalizing:state.finalized).add(index);
  if(record.event==='stash-intent'){if(typeof record.slot!=='string'||!uuid.test(record.slot))throw new Error('Invalid recovery original slot');state.slots.set(index,[...(state.slots.get(index)??[]),record.slot]);}
  if(record.event==='rename-intent')state.renameIntent.add(index);
  if(record.event==='rename-fallback')state.fallback.add(index);
  if(record.event==='published')state.published.add(index);
  if(record.event==='undone')state.undone.add(index);
  if(record.event==='handed-off'){
   const handOff={successor:record.successor,successorRoot:record.successorRoot,destination:record.destination};
   const canonical=(value:unknown)=>typeof value==='string'&&path.resolve(value)===value;
   if(typeof handOff.successor!=='string'||!uuid.test(handOff.successor)||handOff.successor===m.id||!canonical(handOff.successorRoot)||!canonical(handOff.destination))throw new Error('Invalid organization hand-off');
   const known=state.handedOff.get(index);if(known&&JSON.stringify(known)!==JSON.stringify(handOff))throw new Error('Invalid organization hand-off');
   state.handedOff.set(index,handOff as HandOff);
  }
  if(record.event==='renamed'||record.event==='timed'){const stat=record.stat as FileIdentity;if(!stat||['dev','ino','size','mtime','ctime'].some(key=>typeof (stat as unknown as Record<string,unknown>)[key]!=='string'))throw new Error('Invalid moved file identity');state.renamed.set(index,stat);state.dated.set(index,new Set([...(state.dated.get(index)??[]),stat.mtime]));}
  if(record.event==='exclusive-created'){const stat=record.stat as FileIdentity;if(!stat||typeof stat.dev!=='string'||typeof stat.ino!=='string')throw new Error('Invalid recovery publication identity');state.exclusive.set(index,[...(state.exclusive.get(index)??[]),stat]);}
 };
 // Events are lines of one append-only log; journals written before it hold one file per event.
 // A line or file cut short by an interrupted write carries no event.
 // Identities recorded under an earlier mount are read as this mount's, like the manifest's.
 const mount=mountDevices.get(m),rebased=(record:Record<string,unknown>)=>{const stat=record.stat as FileIdentity|undefined;return mount&&stat&&typeof stat==='object'?{...record,stat:{...stat,dev:mount}}:record;};
 const parse=(text:string)=>{let value:unknown;try{value=JSON.parse(text);}catch(error){if(error instanceof SyntaxError)return;throw error;}apply(rebased(authenticated(value)));};
 const names=await fs.readdir(jobPath(folder,m.id));let read=0;
 // A finished journal read before in this session, and unchanged since, is not read again.
 const stamp=await journalStamp(jobPath(folder,m.id),names),cacheKey=`${folder}\0${m.id}\0${m.rootIdentity}\0${mountDevices.get(m)??''}`,cached=finishedJournals.get(cacheKey);
 if(cached&&cached.stamp===stamp){onRead?.(names.length,names.length);Object.assign(state,copyState(cached.state));return finishJournalRead(m,state,chain,follow);}
 // Journals from before the event log hold one small file per event (tens of thousands on a large
 // organization); on a USB drive these are read several at a time, then applied in folder order.
 const texts:(string|string[]|undefined)[]=new Array(names.length);let next=0;
 const readOne=async(position:number)=>{
  const name=names[position]!,file=path.join(jobPath(folder,m.id),name);
  if(name===eventLog){
   await contained(file,folder);const handle=await regularHandle(file);
   try{if((await handle.stat()).size>maxEventLog)throw new Error('Recovery journal is too large');texts[position]=(await handle.readFile('utf8')).split('\n');}finally{await handle.close();}
  } else if(/^event-[a-f0-9-]+\.json$/.test(name)){
   await contained(file,folder);const handle=await regularHandle(file);
   try{if((await handle.stat()).size>2048)throw new Error('Invalid recovery event');texts[position]=await handle.readFile('utf8');}finally{await handle.close();}
  }
  onRead?.(++read,names.length);
 };
 await Promise.all(Array.from({length:Math.min(32,names.length)},async()=>{while(next<names.length)await readOne(next++);}));
 for(const text of texts){
  if(Array.isArray(text)){for(const line of text){if(line.length>2048)throw new Error('Invalid recovery event');if(line)parse(line);}}
  else if(text!==undefined)parse(text);
 }
 if(finished(state))finishedJournals.set(cacheKey,{stamp,state:copyState(state)});
 return finishJournalRead(m,state,chain,follow);
}
/** Checks that need the events of the whole journal, and its successor and hand-offs; never cached. */
async function finishJournalRead(m:Manifest,state:JournalState,chain:Set<string>,follow:boolean):Promise<JournalState> {
 if(state.finalizing.size&&!state.complete)throw new Error('An incomplete organization cannot be finalized');
 for(const index of state.finalized)if(!state.finalizing.has(index))throw new Error('Finalized entry lacks a durable deletion intent');
 // Each hand-off names a signed journal that really moved this entry's file on from its destination.
 // One that no longer checks out (the later journal is gone or changed) is set aside: that entry is then
 // treated as if it had never been handed off, and its usual checks report what is wrong.
 if(follow){const manifests=new Map<string,Promise<Manifest|undefined>>();for(const [index,handOff] of [...state.handedOff])if(!await handOffMatches(m,index,handOff,manifests))state.handedOff.delete(index);}
 if(state.superseded&&follow){
  if(!state.complete||state.finalizing.size!==state.finalized.size)throw new Error('An unfinished organization cannot be superseded');
  const successor=await readManifest(state.successorRoot??m.root,state.superseded);
  // A successor kept in another backup folder (the video-root layout's, or a later single-folder
  // organization that pulled files out of this one) is named by this journal's own signed record and
  // must, like any successor, relocate one of its destinations; neither manifest need list the other.
  const destinations=new Set(m.entries.map(entry=>pathKey(entry.destination)));
  if(!successor.entries.some(next=>next.move&&next.source!==next.destination&&destinations.has(pathKey(next.source))))throw new Error('Organization successor does not relocate a prior destination');
  await readEvents(successor,chain);
 }
 return state;
}
async function savedOriginal(m:Manifest,index:number,state:JournalState):Promise<string|undefined> {
 let saved:string|undefined;
 for(const slot of state.slots.get(index)??[]){const file=originalPath(m,index,slot);await contained(file,m.root);if(await maybeStat(file)){if(saved)throw new Error('Multiple recovery originals require inspection');saved=file;}}
 return saved;
}
async function roots(m:Manifest):Promise<void> {
 await rootUnchanged(m.root,m.rootIdentity);await rootUnchanged(m.source,m.sourceIdentity);
 if((await fs.lstat(m.root,{bigint:true})).dev!==(await fs.lstat(m.source,{bigint:true})).dev)throw new Error('Recovery source and destination must remain on the same filesystem');
 await contained(jobPath(m.root,m.id),m.root);
}
async function parents(entry:Entry,m:Manifest):Promise<void> {
 await contained(entry.source,m.source);for(const [folder,expected]of Object.entries(entry.parents))await rootUnchanged(folder,expected);
}
async function validateOriginal(file:string,entry:Entry,scope:string,renamed:boolean,signal?:AbortSignal,verifyContents=true):Promise<void> {
 await contained(file,scope);const before=await fs.lstat(file,{bigint:true});
 if(!before.isFile()||before.isSymbolicLink()||!matches(before,entry.stat,renamed)||(verifyContents&&await digest(file,signal)!==entry.digest))throw new Error(`Source changed after review; original retained: ${file}`);
 if(!matches(await fs.lstat(file,{bigint:true}),entry.stat,renamed))throw new Error(`Source changed while rechecking: ${file}`);
}
async function targetMatches(entry:Entry,m:Manifest,signal?:AbortSignal,verifyContents=true):Promise<boolean> {
 await contained(entry.destination,m.root);const stat=await maybeStat(entry.destination);if(!stat)return false;
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==BigInt(entry.size)||(verifyContents&&await digest(entry.destination,signal)!==entry.digest))throw new Error(`Destination changed; original retained: ${entry.destination}`);
 return true;
}
function validateManifest(value:unknown,root:string,id:string):Manifest {
 const m=value as Manifest;
 if(!m||m.version!==1||(m.strategy!==undefined&&m.strategy!=='rename')||(m.keepFolders!==undefined&&m.keepFolders!==true)||m.id!==id||m.root!==root||typeof m.source!=='string'||path.resolve(m.source)!==m.source||!(m.source===root||beneath(root,m.source))||!Array.isArray(m.entries)||typeof m.rootIdentity!=='string'||typeof m.sourceIdentity!=='string'||(m.libraries!==undefined&&(!Array.isArray(m.libraries)||m.libraries.some(folder=>typeof folder!=='string'||path.resolve(folder)!==folder||!beneath(folder,m.source)))))throw new Error('Invalid or unsafe organization recovery journal');
 const sources=new Set<string>();
 for(const entry of m.entries) {
  if(!entry||(entry.captureTimeMs!==undefined&&(!Number.isFinite(entry.captureTimeMs)||Math.abs(entry.captureTimeMs)>8640000000000000))||typeof entry.source!=='string'||typeof entry.destination!=='string'||!beneath(entry.source,m.source)||path.resolve(entry.source)!==entry.source||!beneath(entry.destination,root)||path.resolve(entry.destination)!==entry.destination||typeof entry.digest!=='string'||!/^[a-f0-9]{64}$/.test(entry.digest)||!Number.isSafeInteger(entry.size)||entry.size<0||typeof entry.move!=='boolean'||!entry.stat||!entry.parents||typeof entry.parents!=='object')throw new Error('Invalid or unsafe organization recovery entry');
  if(path.relative(m.source,entry.source).split(path.sep).some(p=>isRecoveryName(p))||path.relative(root,entry.destination).split(path.sep).some(p=>isRecoveryName(p)))throw new Error('Unsafe recovery storage path in journal');
  if(sources.has(pathKey(entry.source)))throw new Error('Duplicate recovery source');sources.add(pathKey(entry.source));
  const keys=Object.keys(entry.stat).sort().join(',');if(keys!=='ctime,dev,ino,mtime,size'||Object.entries(entry.stat).some(([key,v])=>typeof v!=='string'||!(key==='ino'?/^-?\d+$/:/^\d+$/).test(v))||entry.stat.size!==String(entry.size)||entry.stat.dev!==m.rootIdentity.split(':')[0])throw new Error('Invalid recovery source identity');
  const ancestors:string[]=[];for(let folder=path.dirname(entry.source);folder!==m.source;folder=path.dirname(folder)){if(!beneath(folder,m.source))throw new Error('Unsafe recovery source ancestor');ancestors.push(folder);}
  if(Object.keys(entry.parents).length!==ancestors.length||ancestors.some(folder=>typeof entry.parents[folder]!=='string'||!/^\d+:\d+$/.test(entry.parents[folder]!)))throw new Error('Invalid recovery source ancestor identities');
 }
 return m;
}
async function readManifest(root:string,id:string):Promise<Manifest> {
 if(path.resolve(root)!==root||await fs.realpath(root)!==root)throw new Error('Unsafe recovery root');
 const job=jobPath(root,id),file=path.join(job,'manifest.json');await contained(file,root);
 const handle=await regularHandle(file);let value:unknown;try{if((await handle.stat()).size>64*1024*1024)throw new Error('Recovery journal is too large');value=JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
 const manifest=validateManifest(authenticated(value),root,id);await rebaseMount(manifest);await roots(manifest);return manifest;
}
/** The mount each journal was read under: a device number names a mount, not a disk. */
const mountDevices=new WeakMap<Manifest,string>();
/** A device number names the disk node a volume is mounted from, which can change between mounts
 * (and can come back), so a journal or its later events may record another mount's. While the
 * recovery root is still the same directory (same inode; the caller has already matched the
 * volume's UUID), every recorded device number is read as this mount's. Everything else is
 * checked as strictly as before. */
async function rebaseMount(m:Manifest):Promise<void>{
 const [recorded,inode]=m.rootIdentity.split(':'),now=await fs.lstat(m.root,{bigint:true});
 if(String(now.ino)!==inode)return;
 const dev=String(now.dev);mountDevices.set(m,dev);
 if(dev===recorded)return;
 const rebase=(identity:string)=>identity.replace(/^\d+:/,`${dev}:`);
 m.rootIdentity=rebase(m.rootIdentity);m.sourceIdentity=rebase(m.sourceIdentity);
 for(const entry of m.entries){entry.stat.dev=dev;for(const folder of Object.keys(entry.parents))entry.parents[folder]=rebase(entry.parents[folder]!);}
}
// The cap stays well below the longest string a log can be read into.
const eventLog='event-log.jsonl',maxEventLog=256*1024*1024,appending=new Map<string,Promise<void>>(),syncedLogs=new Set<string>();
/** Append one signed event to the job's log and make it durable before returning. One file
 * per job instead of one per event: on exFAT each small file takes a whole cluster. */
async function checkpoint(m:Manifest,event:string,index?:number,extra:Record<string,unknown>={}):Promise<void> {
 await roots(m);
 const file=path.join(jobPath(m.root,m.id),eventLog),line=JSON.stringify(signed({id:m.id,root:m.root,event,index,at:new Date().toISOString(),...extra}));
 if(line.length>2048)throw new Error('Invalid recovery event');
 const previous=appending.get(file)??Promise.resolve();
 const write=previous.catch(()=>{}).then(async()=>{
  await contained(file,m.root);const existed=await maybeStat(file);
  if(existed&&(!existed.isFile()||existed.isSymbolicLink()))throw new Error('Unsafe recovery journal');
  const handle=await fs.open(file,constants.O_RDWR|constants.O_APPEND|constants.O_CREAT|(constants.O_NOFOLLOW??0),0o600);
  try{
   const opened=await handle.stat();if(!opened.isFile()||opened.nlink!==1)throw new Error('Unsafe recovery journal');
   const size=opened.size;let torn=false;
   // Start on a fresh line if an interrupted write left a partial one.
   if(size>0){const last=Buffer.alloc(1);await handle.read(last,0,1,size-1);torn=last[0]!==0x0a;}
   await handle.writeFile((torn?'\n':'')+line+'\n');await handle.sync();
  }finally{await handle.close();}
  // The log's own folder entry is synchronized once per process, not only by the write that
  // created it, in case that write was interrupted before its folder was synchronized.
  if(!existed||!syncedLogs.has(file)){await syncDirectory(path.dirname(file));syncedLogs.add(file);}
 });
 appending.set(file,write);
 try{await write;}finally{if(appending.get(file)===write)appending.delete(file);}
}
// Filesystems without hard links need an exclusive stream. The synchronized
// inode record lets a later process recognize an incomplete owned publication.
async function exclusivePublication(staged:string,entry:Entry,index:number,m:Manifest,signal?:AbortSignal):Promise<void> {
 const output=await fs.open(entry.destination,'wx',0o600);
 try {
  await output.sync();await syncParents(entry.destination,m.root);
  await checkpoint(m,'exclusive-created',index,{stat:snapshot(await output.stat({bigint:true}))});
  const input=await regularHandle(staged);
  try {const buffer=Buffer.allocUnsafe(1024*1024);for(;;){checkAbort(signal);const {bytesRead}=await input.read(buffer,0,buffer.length,null);if(!bytesRead)break;let offset=0;while(offset<bytesRead){const {bytesWritten}=await output.write(buffer,offset,bytesRead-offset,null);if(!bytesWritten)throw new Error('Unable to publish exclusive copy');offset+=bytesWritten;}}const stat=await input.stat({bigint:true});await applyFileTimestamps(output,stat,entry.captureTimeMs);await output.sync();}finally{await input.close();}
 }finally{await output.close();}
}
async function preserveIncomplete(entry:Entry,index:number,m:Manifest,input:string,state:JournalState,signal?:AbortSignal):Promise<boolean> {
 const current=await fs.lstat(entry.destination,{bigint:true});if(!current.isFile()||current.size>BigInt(entry.size))return false;
 const owned=(state.exclusive.get(index)??[]).some(stat=>stat.dev===String(current.dev)&&stat.ino===String(current.ino));
 if(!owned)return false;
 const partial=await regularHandle(entry.destination),original=await regularHandle(input);
 try {const a=Buffer.allocUnsafe(1024*1024),b=Buffer.allocUnsafe(1024*1024);for(;;){checkAbort(signal);const {bytesRead}=await partial.read(a,0,a.length,null);if(!bytesRead)break;let count=0;while(count<bytesRead){const read=await original.read(b,count,bytesRead-count,null);if(!read.bytesRead)return false;count+=read.bytesRead;}if(!a.subarray(0,bytesRead).equals(b.subarray(0,bytesRead)))return false;}
  if(!matches(await partial.stat({bigint:true}),snapshot(current))||!matches(await fs.lstat(entry.destination,{bigint:true}),snapshot(current)))throw new Error('Incomplete destination changed while checking');
 }finally{await partial.close();await original.close();}
 await checkpoint(m,'incomplete-intent',index);checkAbort(signal);await roots(m);await contained(entry.destination,m.root);
 if(!matches(await fs.lstat(entry.destination,{bigint:true}),snapshot(current)))throw new Error('Incomplete destination changed before preservation');
 const saved=path.join(jobPath(m.root,m.id),`incomplete-${randomUUID()}`);await contained(saved,m.root);if(await maybeStat(saved))throw new Error('Recovery collision');
 await fs.rename(entry.destination,saved);await syncParents(entry.destination,m.root);await syncDirectory(path.dirname(saved));return true;
}
async function copy(entry:Entry,index:number,m:Manifest,input:string,signal?:AbortSignal,onBytes?:(bytes:number)=>void):Promise<void> {
 await roots(m);await contained(input,m.source);await makeParent(entry.destination,m.root,m.rootIdentity);await syncDirectory(path.dirname(entry.destination));
 const staged=path.join(jobPath(m.root,m.id),`stage-${randomUUID()}.partial`);
 const output=await fs.open(staged,'wx',0o600);
 // Stages are expendable verified copies: a failed or stopped copy removes its own.
 try{await copyThroughStage(staged,output,entry,index,m,input,signal,onBytes);}
 catch(error){try{await contained(staged,m.root);await fs.unlink(staged);}catch{/* Already gone, or left for the residue cleanup. */}throw error;}
}
async function copyThroughStage(staged:string,output:fs.FileHandle,entry:Entry,index:number,m:Manifest,input:string,signal?:AbortSignal,onBytes?:(bytes:number)=>void):Promise<void> {
 let source:fs.FileHandle;try{source=await regularHandle(input);}catch(error){await output.close();throw error;}
 try {
  const before=await source.stat({bigint:true}),hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
  for(;;){checkAbort(signal);const {bytesRead}=await source.read(buffer,0,buffer.length,null);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));let offset=0;while(offset<bytesRead){const {bytesWritten}=await output.write(buffer,offset,bytesRead-offset,null);if(!bytesWritten)throw new Error('Unable to write recovery stage');offset+=bytesWritten;}onBytes?.(bytesRead);}
  if(hash.digest('hex')!==entry.digest||!matches(await source.stat({bigint:true}),snapshot(before))||await digest(input,signal)!==entry.digest)throw new Error(`Source changed while copying: ${input}`);
  await applyFileTimestamps(output,before,entry.captureTimeMs);await output.sync();
 } finally {await source.close();await output.close();}
 if(await digest(staged,signal)!==entry.digest)throw new Error('Recovery stage verification failed');
 checkAbort(signal);await roots(m);await contained(entry.destination,m.root);await checkpoint(m,'publish-intent',index);
 try{await fs.link(staged,entry.destination);}catch(error){if(!['EXDEV','ENOSYS','EPERM','ENOTSUP','EOPNOTSUPP'].includes(code(error)??''))throw error;await exclusivePublication(staged,entry,index,m,signal);}
 await syncFile(entry.destination);await syncParents(entry.destination,m.root);
 if(!await targetMatches(entry,m,signal))throw new Error('Destination disappeared after publication');
 // Retained originals are never unlinked; only the stage is.
 await contained(staged,m.root);await fs.unlink(staged);await checkpoint(m,'published',index);
}
/** Only reviewed obsolete source parents can be removed, and only by nonrecursive rmdir.
 * Stashed originals are independent of these paths, so recovery remains usable.
 */
async function removeEmptySourceFolders(m:Manifest,finalized:Set<number>,signal?:AbortSignal):Promise<void>{
 const candidates=new Map<string,string>();
 for(const [index,entry]of m.entries.entries())if(entry.move&&!finalized.has(index))for(const [folder,expected]of Object.entries(entry.parents))candidates.set(folder,expected);
 for(const [folder,expected]of [...candidates].sort(([a],[b])=>b.length-a.length)){
  checkAbort(signal);if(folder===m.root||folder===m.source||m.libraries?.includes(folder))continue;
  await contained(folder,m.source);const stat=await maybeStat(folder);if(!stat)continue;
  if(!stat.isDirectory()||stat.isSymbolicLink()||await identity(folder)!==expected)throw new Error('Original folder changed; retained without cleanup');
  try{await fs.rmdir(folder);await syncDirectory(path.dirname(folder));}catch(error){if(!['ENOTEMPTY','EEXIST'].includes(code(error)??''))throw error;}
 }
}
/** The folders next to `root` on the same drive (none when `root` is a drive's top folder, so the
 * other mounted volumes are never read), skipping hidden ones. */
async function neighbourFolders(root:string):Promise<string[]>{
 const parent=path.dirname(root),[own,above]=await Promise.all([root,parent].map(folder=>fs.lstat(folder).catch(()=>undefined)));
 if(!own||!above||own.dev!==above.dev)return [];
 return (await fs.readdir(parent,{withFileTypes:true}).catch(()=>[])).filter(entry=>entry.isDirectory()&&!entry.name.startsWith('.')).map(entry=>path.join(parent,entry.name));
}
/** Whether `handOff` names a signed journal with a move of exactly this entry's file, from its
 * destination to `handOff.destination`, with the same size and SHA-256. */
async function handOffMatches(m:Manifest,index:number,handOff:HandOff,manifests:Map<string,Promise<Manifest|undefined>>):Promise<boolean>{
 const entry=m.entries[index]!,key=`${handOff.successorRoot}\0${handOff.successor}`;
 if(!manifests.has(key))manifests.set(key,readManifest(handOff.successorRoot,handOff.successor).catch(()=>undefined));
 const successor=await manifests.get(key)!;
 return !!successor?.entries.some(next=>next.move&&pathKey(next.source)===pathKey(entry.destination)&&pathKey(next.destination)===pathKey(handOff.destination)&&next.digest===entry.digest&&next.size===entry.size);
}
/** Later journals that could have moved this journal's files on: in its own folder, the folders it
 * lists or leaves pointers in, and the folders next to its own. Read once per operation. */
type Successors=Map<string,{root:string;m:Manifest;state:JournalState;index:number}>;
async function laterMoves(m:Manifest):Promise<Successors>{
 const moves:Successors=new Map(),neighbours=await neighbourFolders(m.root);
 for(const folder of new Set([m.root,...pointerFolders(m),...neighbours])){
  const names=await fs.readdir(path.join(folder,storage)).catch(()=>[] as string[]);
  for(const id of names){
   if(id===m.id||!uuid.test(id))continue;
   // Only a finished, never undone journal can have taken a file over for good.
   const later=await readManifest(folder,id).catch(()=>undefined);if(!later)continue;
   const state=await readEvents(later,undefined,undefined,false).catch(()=>undefined);
   if(!state?.complete||state.undone.size||state.undoComplete)continue;
   for(const [index,entry] of later.entries.entries())if(entry.move&&state.renamed.has(index))moves.set(pathKey(entry.source),{root:folder,m:later,state,index});
  }
 }
 return moves;
}
/** The hand-off for an entry whose file is gone from its destination: a later complete journal moved
 * that very file (same inode for a moved entry, same size and SHA-256) and it is still where that
 * journal put it, with the identity that journal recorded. */
async function findHandOff(m:Manifest,index:number,state:JournalState,moves:Successors):Promise<HandOff|undefined>{
 const entry=m.entries[index]!,later=moves.get(pathKey(entry.destination));if(!later)return;
 const next=later.m.entries[later.index]!,moved=state.renamed.get(index);
 if(next.digest!==entry.digest||next.size!==entry.size||(moved&&moved.ino!==next.stat.ino))return;
 const there=await maybeStat(next.destination);
 if(!there?.isFile()||!movedIdentity(there,next,later.state.dated.get(later.index)))return;
 return {successor:later.m.id,successorRoot:later.root,destination:next.destination};
}
/** Whether this journal put the entry's file at its destination: moved there, or copied there (a
 * published copy, or one whose original was kept or released; older journals record no 'published'). */
const placed=(state:JournalState,index:number)=>state.renamed.has(index)||state.published.has(index)||!!state.slots.get(index)?.length||state.finalizing.has(index);
/** Record, before anything moves, each entry a later complete journal has taken over. */
async function recordHandOffs(m:Manifest,state:JournalState):Promise<void>{
 let moves:Successors|undefined;
 for(const [index,entry] of m.entries.entries()){
  if(state.handedOff.has(index)||!placed(state,index)||await maybeStat(entry.destination))continue;
  moves??=await laterMoves(m);
  const handOff=await findHandOff(m,index,state,moves);if(!handOff)continue;
  await checkpoint(m,'handed-off',index,{...handOff});state.handedOff.set(index,handOff);
 }
}
const pointerName=/^journal-(.+)\.json$/,pointerTemporary=new RegExp(`^\\.?journal-${UUID_PATTERN}-${UUID_PATTERN}\\.tmp$`);
/** The folders a journal leaves a pointer in: the sibling backup folders it lists, and the top-level
 * folders (beneath its source) that its files move out of when they lie outside its own folder. */
function pointerFolders(m:Manifest):string[]{
 const found=new Set(m.libraries??[]);
 if(m.source!==m.root)for(const entry of m.entries){
  if(within(entry.source,m.root))continue;
  const parts=path.relative(m.source,entry.source).split(path.sep);if(parts.length<2)continue;
  const top=path.join(m.source,parts[0]!);if(!within(m.root,top))found.add(top);
 }
 return [...found];
}
/** Write this journal's signed pointer into `folder`: aside, then renamed into place, so a full disk
 * or power cut never leaves a torn one. */
async function writePointer(folder:string,m:Pick<Manifest,'root'|'id'>):Promise<void>{
 const storageFolder=path.join(folder,storage);await ensureDirectory(storageFolder,folder);
 const temporary=path.join(storageFolder,`journal-${m.id}-${randomUUID()}.tmp`);
 await jsonFile(temporary,signed({kind:'sibling-journal',library:folder,root:m.root,id:m.id}));
 await fs.rename(temporary,path.join(storageFolder,`journal-${m.id}.json`));await syncDirectory(storageFolder);
}
/** In each pointer folder, a signed pointer naming the journal and its folder, written before
 * anything moves, so an organization of that folder (which may list no other folder and hold no
 * journal of its own) finds and checks this journal. Removed when the journal finishes or is undone. */
async function writeSiblingPointers(m:Manifest):Promise<void>{
 for(const folder of pointerFolders(m)){
  // A folder that is gone or now resolves elsewhere gets no pointer; the scan refuses the latter.
  if(await fs.realpath(folder).catch(error=>{if(code(error)==='ENOENT')return undefined;throw error;})!==folder)continue;
  // Kept only when it is exactly this journal's signed pointer; a torn or wrong one is replaced.
  if(await siblingPointer(folder,`journal-${m.id}.json`).then(root=>root===m.root,()=>false))continue;
  await writePointer(folder,m);
 }
}
/** Best effort once a journal owns nothing more: its pointers, and the recovery folder each was the
 * last thing in, so the folders its files came from can be removed as empty. */
async function removeSiblingPointers(m:Manifest):Promise<void>{
 for(const folder of pointerFolders(m))try{
  const storageFolder=path.join(folder,storage),file=path.join(storageFolder,`journal-${m.id}.json`);
  await contained(file,folder);const stat=await maybeStat(file);if(!stat?.isFile())continue;
  await fs.unlink(file);await syncDirectory(storageFolder);
  await fs.rmdir(storageFolder).then(()=>syncDirectory(folder),()=>{});
 }catch{/* Left as an inert pointer; residue cleanup removes it. */}
}
/** For residue cleanup: a pointer temp file left by a crash, a pointer that belongs to another
 * folder, or one whose journal is gone, finished, undone or superseded. A damaged pointer, or one
 * whose journal cannot be read, is kept. */
export async function pointerLeftover(folder:string,name:string):Promise<boolean>{
 if(pointerTemporary.test(name))return true;
 const id=name.match(pointerName)?.[1];if(id===undefined)return false;
 try{
  const root=await siblingPointer(folder,name);if(root===undefined)return true;
  if(!await maybeStat(path.join(root,storage,id)))return true;
  const state=await readEvents(await readManifest(root,id),undefined,undefined,false);
  return !!state.superseded||!unfinished(state);
 }catch{return false;}
}
/** Signals a pointer file that cannot be read or trusted; the scan then looks for its journal. */
class DamagedPointer extends Error{constructor(readonly file:string,readonly id:string,reason:string){super(`Damaged sibling journal pointer ${file} (${reason})`);}}
/** The journal folder a pointer in `root`'s recovery folder names. Undefined for any other entry,
 * and for a valid pointer that belongs to another folder (copied here), which is inert. */
async function siblingPointer(root:string,name:string):Promise<string|undefined>{
 const id=name.match(pointerName)?.[1];if(id===undefined)return undefined;
 const file=path.join(root,storage,name);
 if(!uuid.test(id))throw new DamagedPointer(file,id,'name');
 await contained(file,root);const handle=await regularHandle(file);let value:unknown;
 try{if((await handle.stat()).size>4096)throw new DamagedPointer(file,id,'size');try{value=JSON.parse(await handle.readFile('utf8'));}catch(error){if(error instanceof SyntaxError)throw new DamagedPointer(file,id,'unreadable');throw error;}}finally{await handle.close();}
 let pointer:Record<string,unknown>;try{pointer=authenticated(value);}catch{throw new DamagedPointer(file,id,'authentication failed');}
 if(pointer.kind!=='sibling-journal'||pointer.id!==id||typeof pointer.library!=='string'||typeof pointer.root!=='string'||path.resolve(pointer.root)!==pointer.root)throw new DamagedPointer(file,id,'contents');
 // Copied from another folder: inert. A folder renamed only by case keeps its pointers.
 if(pathKey(pointer.library)!==pathKey(root))return undefined;
 if(pointer.root===root)throw new DamagedPointer(file,id,'contents');
 return pointer.root;
}
/** For a damaged pointer in `root`: the folder of the journal it names, found among `known` folders
 * and `root`'s neighbours, when that journal's own manifest puts a pointer in `root`. The pointer is
 * then rewritten. Otherwise the organization stops, naming the file. */
async function repairPointer(root:string,damaged:DamagedPointer,known:string[]):Promise<string>{
 const neighbours=await neighbourFolders(root);
 for(const candidate of new Set([...known,...neighbours])){
  if(candidate===root||!uuid.test(damaged.id))continue;
  // A neighbour that cannot be read, or holds a copy of the journal, is not where it lives.
  const journal=await (async()=>{if(!await maybeStat(path.join(candidate,storage,damaged.id,'manifest.json')))return undefined;return readManifest(candidate,damaged.id);})().catch(()=>undefined);
  if(!journal||!pointerFolders(journal).includes(root))continue;
  await writePointer(root,journal);return candidate;
 }
 throw new Error(`${damaged.message}: organization ${damaged.id} was not found beside it. If that organization is finished or no longer needed, delete this file; otherwise Resume or Recheck it first.`);
}
/** For a folder renamed only by case: the id of an unfinished journal in it, if any. Its journals
 * record the old name, so they are read here without the exact-path check. */
async function unfinishedAfterCaseRename(real:string,recorded:string):Promise<string|undefined>{
 const folder=path.join(real,storage);
 for(const id of await fs.readdir(folder).catch(error=>{if(code(error)==='ENOENT')return [] as string[];throw error;})){
  if(pointerTemporary.test(id))continue;
  // A pointer here names a journal in another folder: unfinished there means this folder is in use.
  if(pointerName.test(id)){
   try{
    const root=await siblingPointer(real,id);if(root===undefined)continue;
    const named=id.match(pointerName)![1]!;if(!await maybeStat(path.join(root,storage,named)))continue;
    const state=await readEvents(await readManifest(root,named),undefined,undefined,false);
    if(!state.superseded&&unfinished(state))return named;
   }catch{return id;}
   continue;
  }
  if(!uuid.test(id))continue;
  try{
   const handle=await regularHandle(path.join(folder,id,'manifest.json'));let value:unknown;
   try{value=JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
   const claimed=(value as {root?:unknown})?.root;if(typeof claimed!=='string'||pathKey(claimed)!==pathKey(recorded))return id;
   const m=validateManifest(authenticated(value),claimed,id),state=await readEvents(m,undefined,undefined,false,real);
   if(!state.superseded&&unfinished(state))return id;
  }catch{return id;}
 }
}
/** Work a journal still owns: not finished, a finalize not completed, or an undo stopped part-way.
 * A fully undone journal owns nothing: its files are back where it found them. */
const unfinished=(state:JournalState)=>!state.undoComplete&&(!state.complete||state.finalizing.size!==state.finalized.size||state.undone.size>0);
/** Publish successor links before touching media. Repeating this preflight after
 * a crash finishes any links not yet written alongside the durable new manifest.
 */
async function supersedePriorOrganizations(m:Manifest,signal?:AbortSignal,onProgress?:(progress:Progress)=>void,state?:JournalState):Promise<void>{
 const touched=new Set(m.entries.flatMap(entry=>[pathKey(entry.source),pathKey(entry.destination)]));
 const started=!!state&&(state.renamed.size>0||state.renameIntent.size>0||state.slots.size>0||state.published.size>0||state.handedOff.size>0||state.exclusive.size>0||state.complete);
 const moved=new Set(m.entries.filter(entry=>entry.move&&entry.source!==entry.destination).map(entry=>pathKey(entry.source)));
 const predecessors:Manifest[]=[];
 const overlapping=(prior:Manifest)=>prior.entries.some(entry=>touched.has(pathKey(entry.source))||touched.has(pathKey(entry.destination)));
 const finish=(id:string)=>new Error(`Finish organization ${id} before starting an overlapping organization`);
 // Earlier journals in this backup folder, in the sibling backup folders this manifest lists
 // (the video-root layout moves files between them), and in any folder a journal found here
 // was superseded into, so an unfinished successor there is seen even when this plan lists none.
 const listed=[m.root,...pointerFolders(m)],folders=[...listed],scanned=new Set<string>();
 for(let position=0;position<folders.length;position++){
  const root=folders[position]!;if(scanned.has(root))continue;scanned.add(root);
  if(root!==m.root){
   // A folder that is gone has no journals. A listed sibling that now resolves elsewhere is
   // refused; a folder known only as an earlier successor's is then skipped like a gone one.
   const real=await fs.realpath(root).catch(error=>{if(code(error)==='ENOENT')return undefined;throw error;});
   if(real!==undefined&&real!==root){
    // Renamed only by case, its journals are still there under their old name: refused while one is unfinished.
    if(pathKey(real)===pathKey(root)){const live=await unfinishedAfterCaseRename(real,root);if(live)throw new Error(`Unsafe sibling backup folder: ${root} was renamed to ${path.basename(real)} while organization ${live} is unfinished; rename it back`);}
    else if(listed.includes(root))throw new Error(`Unsafe sibling backup folder: ${root}`);
   }
   if(real!==root)continue;
   await adoptLegacyStorage(root);if(!await maybeStat(path.join(root,storage)))continue;await contained(path.join(root,storage),root);
  }
  for(const id of await fs.readdir(path.join(root,storage))){
   checkAbort(signal);
   // A pointer to a journal kept in another backup folder that lists this one: check it there too.
   if(pointerTemporary.test(id))continue;
   const pointed=await siblingPointer(root,id).catch(async error=>{if(error instanceof DamagedPointer)return repairPointer(root,error,folders);throw error;});
   if(pointed!==undefined){if(pointed!==m.root)folders.push(pointed);continue;}
   if(id===m.id||!uuid.test(id))continue;
   // A journal its own signed log already hands to a successor is never written again, and it
   // already refuses resume, undo and finalize, so its successor is not read here: a successor's
   // folder removed later (a sibling backup folder) must not block organizing this one. The
   // recovery listing, resume, undo and finalize still check that successor in full.
   const prior=await readManifest(root,id),state=await readEvents(prior,undefined,(completed,total)=>onProgress?.({phase:'verifying',step:'earlier',completed,total,bytes:0,totalBytes:0,speed:0,file:id}),false);
   // The backup folders that journal was organized together with may hold its live partners.
   folders.push(...prior.libraries??[]);
   // Superseded journals are skipped even if their log shows unfinished work (left by a
   // version that did not lock): nothing can resume, undo or finalize them any more.
   if(state.superseded){if(state.successorRoot)folders.push(state.successorRoot);continue;}
   if(state.undoComplete||!overlapping(prior))continue;
   if(unfinished(state))throw finish(id);
   if(!prior.entries.some(entry=>moved.has(pathKey(entry.destination))))continue;
   // Links are only made before the first file moves, by the newest journal. A resumed or rechecked
   // journal that has already moved something never takes on new predecessors: one it finds now may be
   // newer than it, and either way that journal's kept originals would be stranded.
   if(started)continue;
   // Supersession preserves historical originals without authorizing deletion.
   // Current bytes (including intentional edits) belong to the new review and
   // are verified by its normal copy/stash path, not the predecessor's digest.
   predecessors.push(prior);
  }
 }
 // Only entries still waiting at their original path are checked there; a resumed or rechecked
 // journal has already moved, kept or handed off the rest.
 if(predecessors.length)for(const [index,entry] of m.entries.entries()){
  if(state&&(state.renamed.has(index)||state.handedOff.has(index)||state.slots.get(index)?.length||state.finalizing.has(index)))continue;
  checkAbort(signal);await parents(entry,m);await validateOriginal(entry.source,entry,m.source,false,signal,false);
 }
 // Each record is written under the predecessor's own lock, after checking again that a finalize
 // or undo of it has not started meanwhile.
 for(const prior of predecessors){
  checkAbort(signal);
  await locked(jobPath(prior.root,prior.id),async()=>{
   const state=await readEvents(prior,undefined,undefined,false);
   if(state.superseded||state.undoComplete)return;if(unfinished(state))throw finish(prior.id);
   await checkpoint(prior,'superseded',undefined,{successor:m.id,...(prior.root!==m.root?{successorRoot:m.root}:{})});
  });
 }
}
const unsupportedLink=['EPERM','ENOTSUP','ENOSYS','EOPNOTSUPP','EMLINK'];
/** The moved inode: same device, inode and size as reviewed, with its reviewed Modified
 * date, any date journaled for it, or the capture date a move applies. Journal order and a
 * crash between dating and journaling therefore never strand a moved file. */
function movedIdentity(stat:BigIntStats,entry:Pick<Entry,'stat'|'captureTimeMs'>,dated?:Set<string>):boolean {
 const reviewed=entry.stat,mtime=Number(stat.mtimeNs/1000000n);
 // A date written back is rounded to the filesystem's resolution (10 ms on exFAT).
 const near=(value:string)=>{const difference=stat.mtimeNs-BigInt(value);return (difference<0n?-difference:difference)<=20000000n;};
 return String(stat.dev)===reviewed.dev&&(reviewed.size==='0'||String(stat.ino)===reviewed.ino)&&String(stat.size)===reviewed.size&&stat.isFile()&&!stat.isSymbolicLink()&&
  (near(reviewed.mtime)||!!dated?.has(String(stat.mtimeNs))||(entry.captureTimeMs!==undefined&&Math.abs(mtime-entry.captureTimeMs)<=2000));
}
export const movedFileIdentity=movedIdentity;
/** exFAT and FAT clamp dates before 1980; such a capture date is not applied at all. */
const earliestStorableDate=new Date(1980,0,2).getTime();
/** Journal the move as soon as it happened, then give the file its capture date as
 * Created/Modified, as copies get. The bytes, and so the EXIF data, are never rewritten.
 * A date the filesystem cannot store (exFAT before 1980, a file with other hard links)
 * leaves the file with its original dates instead of failing a move already made. */
async function finishMove(entry:Entry,index:number,m:Manifest,state:JournalState,note:(message:string)=>void):Promise<void> {
 // The new name is made durable before the old one's removal, so a power cut leaves the file in
 // at least one folder. The original folder may already be gone when a move is resumed.
 await syncParents(entry.destination,m.root);await syncDirectory(path.dirname(entry.source)).catch(error=>{if(code(error)!=='ENOENT')throw error;});
 const handle=await fs.open(entry.destination,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try {
  const current=await handle.stat({bigint:true});
  const remember=async(event:'renamed'|'timed',stat:BigIntStats)=>{await checkpoint(m,event,index,{stat:snapshot(stat)});state.renamed.set(index,snapshot(stat));state.dated.set(index,new Set([...(state.dated.get(index)??[]),String(stat.mtimeNs)]));};
  if(!movedIdentity(current,entry,state.dated.get(index)))throw new Error(`Moved file changed; it stays where it is: ${entry.destination}`);
  await remember('renamed',current);
  if(entry.captureTimeMs===undefined||String(current.mtimeNs)!==entry.stat.mtime)return;
  // FAT and exFAT report ctime equal to mtime and cannot store dates before 1980.
  if(entry.captureTimeMs<earliestStorableDate&&current.ctimeNs===current.mtimeNs){note(`${path.basename(entry.destination)}: capture date before 1980 cannot be stored`);return;}
  try {
   const stored=await applyFileTimestamps(handle,current,entry.captureTimeMs);await handle.sync();
   await remember('timed',await handle.stat({bigint:true}));
   if(!stored)note(`${path.basename(entry.destination)}: the drive cannot store its capture date`);
  } catch(error) {
   // A partly applied date still leaves the same inode; record what is there now.
   const now=await handle.stat({bigint:true});
   if(!state.dated.get(index)?.has(String(now.mtimeNs)))await remember('timed',now);
   note(`${path.basename(entry.destination)}: ${error instanceof Error?error.message:String(error)}`);
  }
 } finally { await handle.close(); }
}
/** Two names may be one file only through a real hard link on the same device. On exFAT,
 * equal inode numbers with a link count of 1 mean cross-linked entries; never unlink then. */
export const sameHardLink=(a:Pick<BigIntStats,'dev'|'ino'|'nlink'>,b:Pick<BigIntStats,'dev'|'ino'|'nlink'>)=>a.dev===b.dev&&a.ino===b.ino&&a.nlink>=2n&&b.nlink>=2n;
/** Move one reviewed file within its volume. Nothing is copied and no duplicate is kept:
 * the original inode becomes the organized file. The destination is never overwritten.
 * Returns 'moved', or 'copy' when the caller must use the verified copy path instead
 * (another filesystem, or a destination that already holds something). */
async function relocate(entry:Entry,index:number,m:Manifest,state:JournalState,note:(message:string)=>void,signal?:AbortSignal):Promise<'moved'|'copy'> {
 await contained(entry.source,m.source);await contained(entry.destination,m.root);
 if(state.renamed.has(index)){
  const target=await maybeStat(entry.destination);
  if(await maybeStat(entry.source))throw new Error(`Original path reappeared after it was moved: ${entry.source}`);
  if(!target||!movedIdentity(target,entry,state.dated.get(index)))throw new Error(`Moved file changed or is missing; no copy was kept: ${entry.destination}`);
  return 'moved';
 }
 let source=await maybeStat(entry.source),target=await maybeStat(entry.destination);
 if(state.renameIntent.has(index)){
  // Finish or redo an interrupted move from what is on disk.
  if(source&&target&&sameHardLink(source,target)){await fs.unlink(entry.source);await finishMove(entry,index,m,state,note);return 'moved';}
  if(source&&target&&source.dev===target.dev&&source.ino===target.ino)throw new Error(`Two names point at one file entry without a hard link; nothing was removed. Check the drive: ${entry.source}`);
  // An inode number can be reused on exFAT; confirm the contents before accepting the move.
  if(!source&&target&&movedIdentity(target,entry,state.dated.get(index))&&await digest(entry.destination,signal)===entry.digest){await finishMove(entry,index,m,state,note);return 'moved';}
  if(!source&&!target)throw new Error(`Neither the original nor the moved file is present: ${entry.source}`);
 }
 // Empty files have no stable inode on exFAT; copying nothing is just as fast.
 if(!source||target||entry.size===0)return 'copy';
 await parents(entry,m);await validateOriginal(entry.source,entry,m.source,false,signal,false);
 // Folders created for the destination are durable before the file is renamed into them.
 await makeParent(entry.destination,m.root,m.rootIdentity);await syncParents(entry.destination,m.root);
 if(!state.renameIntent.has(index)){await checkpoint(m,'rename-intent',index);state.renameIntent.add(index);}
 checkAbort(signal);await roots(m);await parents(entry,m);await validateOriginal(entry.source,entry,m.source,false,signal,false);
 const appeared=()=>new Error(`Destination appeared during organization; nothing was overwritten: ${entry.destination}`);
 try {
  // A hard link fails instead of replacing an existing name.
  await fs.link(entry.source,entry.destination);
  source=await fs.lstat(entry.source,{bigint:true});target=await fs.lstat(entry.destination,{bigint:true});
  if(!sameHardLink(source,target))throw appeared();
  await fs.unlink(entry.source);
 } catch(error) {
  if(code(error)==='EEXIST')throw appeared();
  if(code(error)==='EXDEV'){await checkpoint(m,'rename-fallback',index);state.fallback.add(index);return 'copy';}
  if(!unsupportedLink.includes(code(error)??''))throw error;
  // exFAT and FAT have no hard links: check, then rename(2) in the same breath.
  if(await maybeStat(entry.destination))throw appeared();
  try{await fs.rename(entry.source,entry.destination);}
  catch(failure){if(code(failure)==='EXDEV'){await checkpoint(m,'rename-fallback',index);state.fallback.add(index);return 'copy';}throw failure;}
 }
 await finishMove(entry,index,m,state,note);
 return 'moved';
}
async function run(m:Manifest,signal?:AbortSignal,onProgress?:(progress:Progress)=>void):Promise<ReorganizationResult> {
 const state=await readEvents(m);
 if(state.superseded)throw new Error(`Organization ${m.id} was superseded by ${state.superseded}`);
 if(state.undoComplete||state.undone.size)throw new Error(`Organization ${m.id} was undone`);
 const result:ReorganizationResult={copied:0,skipped:0,errors:[],moved:0,retained:0,retainedBytes:0};const undated:string[]=[];let completed=0,bytes=0;const started=performance.now(),totalBytes=m.entries.reduce((n,e)=>n+e.size,0);
 const progress=(file:string)=>onProgress?.({step:'moving',completed,total:m.entries.length,bytes,totalBytes,speed:bytes/Math.max((performance.now()-started)/1000,0.001),file});
 // Verify the whole batch before moving any source, including completed jobs.
 try {
  await roots(m);await writeSiblingPointers(m);await recordHandOffs(m,state);await supersedePriorOrganizations(m,signal,onProgress,state);
  // Moves cannot wait for a later check: confirm every file that will move, by stat
  // only, before the first one does. Any change stops the run with nothing moved.
  if(m.strategy==='rename')for(const [index,entry] of m.entries.entries()){
   checkAbort(signal);
   onProgress?.({phase:'verifying',step:'confirming',completed:index+1,total:m.entries.length,bytes:0,totalBytes:0,speed:0,file:path.basename(entry.source)});
   if(!entry.move||state.handedOff.has(index)||state.renamed.has(index)||state.renameIntent.has(index)||state.fallback.has(index)||state.finalizing.has(index)||state.slots.get(index)?.length)continue;
   await parents(entry,m);await validateOriginal(entry.source,entry,m.source,false,signal,false);
  }
  for(const [index,entry]of m.entries.entries()) {
   checkAbort(signal);
   // A later organization took this file over; it stays where that one put it.
   if(state.handedOff.has(index)){if(entry.move)result.moved++;result.skipped++;completed++;progress(path.basename(entry.source));continue;}
   if(state.finalized.has(index)){
    if(!await targetMatches(entry,m,signal))throw new Error('Finalized destination unavailable');
    if(entry.move)result.moved++;result.skipped++;completed++;progress(path.basename(entry.source));continue;
   }
   if(m.strategy==='rename'&&entry.move&&!state.fallback.has(index)&&!state.slots.get(index)?.length&&!state.finalizing.has(index)&&await relocate(entry,index,m,state,message=>undated.push(message),signal)==='moved'){result.moved++;completed++;progress(path.basename(entry.source));continue;}
   const saved=await savedOriginal(m,index,state);if(!saved&&!state.finalizing.has(index))await parents(entry,m);
   const source=await maybeStat(entry.source),stash=saved?await maybeStat(saved):undefined;
   if(state.finalizing.has(index)){
    if(entry.move&&source)throw new Error('Original path reappeared after finalization');
    if(saved){if(!entry.move)throw new Error('Unexpected retained original');await validateOriginal(saved,entry,m.root,true,signal);}
    if(!await targetMatches(entry,m,signal))throw new Error('Finalized destination unavailable; retained original was explicitly released');
    if(entry.move)result.moved++;result.skipped++;completed++;progress(path.basename(entry.source));continue;
   }
   if(stash){if(!entry.move||source)throw new Error(`Recovery original collision: ${entry.source}`);await validateOriginal(saved!,entry,m.root,true,signal);result.moved++;}
   else {if(!source)throw new Error(`Original is unavailable; reconnect and recheck: ${entry.source}`);await validateOriginal(entry.source,entry,m.source,false,signal);}
   let present:boolean;try{present=await targetMatches(entry,m,signal);}catch(error){if(!await preserveIncomplete(entry,index,m,stash?saved!:entry.source,state,signal))throw error;present=false;}
   if(!present){await copy(entry,index,m,stash?saved!:entry.source,signal,count=>{bytes+=count;progress(path.basename(entry.source));});result.copied++;}else result.skipped++;
   completed++;progress(path.basename(entry.source));
  }
  for(const [index,entry]of m.entries.entries()) {
   checkAbort(signal);if(!entry.move||state.finalizing.has(index)||state.renamed.has(index)||state.handedOff.has(index))continue;await roots(m);let saved=await savedOriginal(m,index,state);
   if(saved){await validateOriginal(saved,entry,m.root,true,signal);if(await maybeStat(entry.source))throw new Error('Original path reappeared during recovery');if(!await targetMatches(entry,m,signal))throw new Error('Destination unavailable');continue;}
   await parents(entry,m);await validateOriginal(entry.source,entry,m.source,false,signal);if(!await targetMatches(entry,m,signal))throw new Error('Destination unavailable');
   await syncFile(entry.destination);await syncParents(entry.destination,m.root);
   await ensureDirectory(path.join(jobPath(m.root,m.id),'originals'),m.root);
   const entryDirectory=path.join(jobPath(m.root,m.id),'originals',String(index));await ensureDirectory(entryDirectory,m.root);
   const slot=randomUUID();saved=originalPath(m,index,slot);await contained(saved,m.root);
   // Each attempt owns a newly created private slot. Competing processes never
   // rename into the same pathname, and an existing slot is never reused.
   await fs.mkdir(path.dirname(saved),{mode:0o700});await syncDirectory(entryDirectory);
   await checkpoint(m,'stash-intent',index,{slot});state.slots.set(index,[...(state.slots.get(index)??[]),slot]);checkAbort(signal);await roots(m);await parents(entry,m);await contained(saved,m.root);
   const destinationStat=await fs.lstat(entry.destination,{bigint:true});
   await parents(entry,m);await validateOriginal(entry.source,entry,m.source,false,signal);if(!await targetMatches(entry,m,signal)||!matches(await fs.lstat(entry.destination,{bigint:true}),snapshot(destinationStat)))throw new Error('Destination changed before retaining original');
   if(await maybeStat(saved))throw new Error(`Recovery original collision: ${saved}`);
   // Same-filesystem rename preserves the original inode; its contents are never
   // deleted, even when the process exits immediately after this operation.
   await fs.rename(entry.source,saved);await syncDirectory(path.dirname(entry.source));await syncDirectory(path.dirname(saved));
   await validateOriginal(saved,entry,m.root,true,signal);await checkpoint(m,'stashed',index);result.moved++;
  }
  await checkpoint(m,'complete');
  // The user can keep emptied source folders; the choice is part of the signed journal.
  await removeSiblingPointers(m);
  if(!m.keepFolders)await removeEmptySourceFolders(m,state.finalized,signal);
 }catch(error){if(isAbort(error))throw error;result.errors.push(error instanceof Error?error.message:String(error));}
 if(undated.length)result.notes=[`${undated.length} moved files kept their original dates because the drive could not store their capture dates.`,...undated.slice(0,20)];
 // Originals kept in recovery storage so the organization can be undone.
 for(const [index,entry] of m.entries.entries())if(!state.finalizing.has(index)&&await savedOriginal(m,index,state).catch(()=>undefined)){result.retained++;result.retainedBytes+=entry.size;}
 return result;
}
export async function beginOrganization(transfer:TransferPlan,entries:OrganizationEntry[],signal?:AbortSignal,onProgress?:(progress:Progress)=>void,strategy:OrganizationStrategy='copy',keepFolders=false,libraries:string[]=[],releaseDuplicates=false):Promise<ReorganizationResult> {
 checkAbort(signal);if(!hostKey)throw new Error('Organization recovery host authentication key is not configured');await rootUnchanged(transfer.root,transfer.rootIdentity);
 const id=randomUUID(),manifest:Manifest={version:1,id,root:transfer.root,rootIdentity:transfer.rootIdentity,source:transfer.source,sourceIdentity:await identity(transfer.source),entries:[],...(strategy==='rename'?{strategy:'rename' as const}:{}),...(keepFolders?{keepFolders:true as const}:{}),...(libraries.length?{libraries}:{})};
 for(const entry of entries){const ancestors:Record<string,string>={};for(let folder=path.dirname(entry.source);folder!==transfer.source;folder=path.dirname(folder)){if(!beneath(folder,transfer.source))throw new Error('Unsafe source path');ancestors[folder]=await identity(folder);}manifest.entries.push({...entry,stat:snapshot(entry.stat),parents:ancestors});}
 validateManifest(manifest,transfer.root,id);await adoptLegacyStorage(transfer.root);await ensureDirectory(path.join(transfer.root,storage),transfer.root);await ensureDirectory(jobPath(transfer.root,id),transfer.root);
 // No destination publication or original relocation occurs until the complete
 // immutable review and containing directories have been synchronized.
 await jsonFile(path.join(jobPath(transfer.root,id),'manifest.json'),signed(manifest as unknown as Record<string,unknown>));await roots(manifest);
 const result=await locked(jobPath(transfer.root,id),()=>run(manifest,signal,onProgress));
 // Release re-verifies every destination by checksum before removing a kept original.
 if(releaseDuplicates&&result.errors.length===0&&result.retained>0){
  try{
   const released=await finalizeOrganization(transfer.root,id,signal);
   result.released=released.removed;result.releasedBytes=released.bytes;
   result.retained=Math.max(0,result.retained-released.removed);result.retainedBytes=Math.max(0,result.retainedBytes-released.bytes);
  }catch(error){if(isAbort(error))throw error;result.errors.push(error instanceof Error?error.message:String(error));}
 }
 return result;
}
export async function resumeOrganization(root:string,id:string,signal?:AbortSignal,onProgress?:(progress:Progress)=>void):Promise<ReorganizationResult> {
 await adoptLegacyStorage(root);
 const job=jobPath(root,id);return locked(job,async()=>run(await readManifest(root,id),signal,onProgress));
}
/** Cached listing skips media reads; explicit recheck/resume always verifies full hashes. */
export async function getOrganizationRecovery(root:string,options:{verifyContents?:boolean}={}):Promise<OrganizationRecovery[]> {
 const verifyContents=options.verifyContents!==false;
 if(path.resolve(root)!==root)throw new Error('Unsafe recovery root');
 try{if(await fs.realpath(root)!==root)throw new Error('Unsafe recovery root');}catch(error){if(code(error)==='ENOENT')return[];throw error;}
 await adoptLegacyStorage(root);const folder=path.join(root,storage);await contained(folder,root);const stat=await maybeStat(folder);if(!stat)return[];if(!stat.isDirectory())throw new Error('Unsafe recovery storage');
 const jobs:OrganizationRecovery[]=[];
 for(const id of(await fs.readdir(folder)).sort()) {
  if(!uuid.test(id))continue;const job:OrganizationRecovery={id,root,status:'pending',files:0,completed:0,retainedFiles:0,retainedBytes:0,finalizable:false,undoable:false};
  try{const m=await readManifest(root,id);job.files=m.entries.length;if(m.libraries?.length)job.libraries=[...m.libraries];let all=true;const state=await readEvents(m);if(state.superseded||state.undoComplete)continue;
   const released=state.finalizing.size>0||state.finalized.size>0;
   if(state.undone.size){job.completed=state.undone.size;job.undoable=!released;jobs.push(job);continue;}
   job.undoable=!released;let moves:Successors|undefined;
   for(const [index,entry]of m.entries.entries()) {
    // A later organization took this file over (recorded, or found now and recorded on the next resume or undo).
    if(state.handedOff.has(index)||placed(state,index)&&!await maybeStat(entry.destination)&&await findHandOff(m,index,state,moves??=await laterMoves(m))){
     // Any kept original of it stays, but is not among those a finalize would release.
     job.completed++;continue;
    }
    if(state.renamed.has(index)){
     const target=await maybeStat(entry.destination);
     if(await maybeStat(entry.source)||!target||!movedIdentity(target,entry,state.dated.get(index))||(verifyContents&&await digest(entry.destination)!==entry.digest)){
      // A finished organization's file that is gone with no later organization accounting for it may be
      // the only copy: every such file is counted and the job stays pending, without stopping the listing.
      if(state.complete&&!await maybeStat(entry.source)&&!target){job.missing=(job.missing??0)+1;all=false;continue;}
      throw new Error(`Moved file changed or is missing: ${entry.destination}`);
     }
     job.completed++;continue;
    }
    if(state.renameIntent.has(index)&&!state.fallback.has(index)&&!state.slots.get(index)?.length){all=false;continue;}
    if(state.finalized.has(index)){
     if(!await targetMatches(entry,m,undefined,verifyContents)){if(state.complete&&!await maybeStat(entry.destination)){job.missing=(job.missing??0)+1;all=false;continue;}throw new Error('Finalized destination unavailable');}
     job.completed++;continue;
    }
    const saved=await savedOriginal(m,index,state),source=await maybeStat(entry.source);if(!saved&&!state.finalizing.has(index))await parents(entry,m);
    if(state.finalizing.has(index)){
     if(entry.move&&source)throw new Error('Original path reappeared after finalization');
     if(saved){if(!entry.move)throw new Error('Unexpected retained original');await validateOriginal(saved,entry,m.root,true,undefined,verifyContents);}
     if(!await targetMatches(entry,m,undefined,verifyContents))throw new Error('Finalized destination unavailable');
     job.completed++;continue;
    }
    if(saved){if(source||!entry.move)throw new Error('Recovery original collision');await validateOriginal(saved,entry,m.root,true,undefined,verifyContents);job.retainedFiles!++;job.retainedBytes!+=entry.size;}
    else if(source)await validateOriginal(entry.source,entry,m.source,false,undefined,verifyContents);else throw new Error('Original unavailable');
    const valid=await targetMatches(entry,m,undefined,verifyContents);if(valid&&(!entry.move||!!saved))job.completed++;else all=false;
   }
   if(all&&state.complete)job.status='complete';
   job.finalizable=job.status==='complete'&&job.retainedFiles!>0&&!state.finalizing.size;
  }catch(error){job.error=error instanceof Error?error.message:String(error);}
  jobs.push(job);
 }
 return jobs;
}


/** handedOff: entries a later organization took over; their kept originals stay. */
export interface OrganizationFinalization {removed:number;bytes:number;finalized:number;handedOff:number;}
/** Finalize and undo first check every entry, then change them: `completed` is the entry being
 * handled, 1-based, out of `total` journal entries. */
export interface OrganizationProgress {step:'checking'|'releasing'|'restoring';completed:number;total:number;file:string;}
/** Explicitly release verified retained duplicates; never delete ordinary source paths.
 * All finalized entries become target-based, allowing a separate explicit
 * dedupe to remove unrelocated duplicate source paths. This call never does so.
 * After release, a lost destination can no longer be restored from this journal.
 * Repeating this call completes a durable deletion intent after interruption.
 */
export async function finalizeOrganization(root:string,id:string,signal?:AbortSignal,onProgress?:(progress:OrganizationProgress)=>void):Promise<OrganizationFinalization>{
 await adoptLegacyStorage(root);
 return locked(jobPath(root,id),async()=>{
  checkAbort(signal);const m=await readManifest(root,id),state=await readEvents(m);
  if(state.superseded)throw new Error(`Organization ${m.id} was superseded by ${state.superseded}`);
  if(!state.complete)throw new Error('Finish and verify the entire organization before finalizing retained originals');
  // A finalize in progress still owns its files: its pointers stay until it finishes.
  await writeSiblingPointers(m);await recordHandOffs(m,state);
  // Check every entry before authorizing the first deletion, including entries
  // that stay at their original paths and previously finalized destinations.
  for(const [index,entry]of m.entries.entries()){
   checkAbort(signal);onProgress?.({step:'checking',completed:index+1,total:m.entries.length,file:entry.destination});
   if(state.undone.size)throw new Error('This organization was undone');
   // A later organization took this file over: its kept original, if any, is kept, not released
   // (unless an interrupted finalize had already started releasing it).
   if(state.handedOff.has(index)&&!(state.finalizing.has(index)&&!state.finalized.has(index)))continue;
   if(state.renamed.has(index)){const target=await maybeStat(entry.destination);if(await maybeStat(entry.source)||!target||!movedIdentity(target,entry,state.dated.get(index)))throw new Error('Moved file changed; nothing released');continue;}
   if(state.finalized.has(index)){if(!await targetMatches(entry,m,signal))throw new Error('Finalized destination unavailable');continue;}
   const saved=await savedOriginal(m,index,state),source=await maybeStat(entry.source);if(!entry.move)await parents(entry,m);
   if(entry.move){
    if(source)throw new Error('Original path reappeared; retained originals preserved');
    if(saved)await validateOriginal(saved,entry,m.root,true,signal);
    else if(!state.finalizing.has(index))throw new Error('Retained original unavailable without a finalization intent');
   }else if(!state.finalizing.has(index))await validateOriginal(entry.source,entry,m.source,false,signal);
   if(!await targetMatches(entry,m,signal))throw new Error('Destination unavailable; retained originals preserved');
  }
  const result:OrganizationFinalization={removed:0,bytes:0,finalized:0,handedOff:0};
  for(const [index,entry]of m.entries.entries()){
   checkAbort(signal);onProgress?.({step:'releasing',completed:index+1,total:m.entries.length,file:entry.destination});await roots(m);
   if(state.handedOff.has(index)&&!(state.finalizing.has(index)&&!state.finalized.has(index))){result.handedOff++;continue;}
   // A moved file has no kept duplicate to release.
   if(state.renamed.has(index))continue;
   if(state.finalized.has(index)){if(!await targetMatches(entry,m,signal))throw new Error('Finalized destination unavailable');result.finalized++;continue;}
   if(!entry.move)await parents(entry,m);
   if(entry.move&&await maybeStat(entry.source))throw new Error('Original path reappeared; retained originals preserved');
   const saved=await savedOriginal(m,index,state);
   // Publish and synchronize the remaining copy before the authenticated intent.
   const destinationStat=await fs.lstat(entry.destination,{bigint:true});
   if(!await targetMatches(entry,m,signal))throw new Error('Destination unavailable; retained originals preserved');
   await syncFile(entry.destination);await syncParents(entry.destination,m.root);
   if(!matches(await fs.lstat(entry.destination,{bigint:true}),snapshot(destinationStat)))throw new Error('Destination changed while synchronizing');
   if(!entry.move){
    if(saved)throw new Error('Unexpected retained original');
    if(!state.finalizing.has(index)){await validateOriginal(entry.source,entry,m.source,false,signal);await checkpoint(m,'finalize-intent',index);state.finalizing.add(index);}
   }else if(saved){
    await validateOriginal(saved,entry,m.root,true,signal);const originalStat=await fs.lstat(saved,{bigint:true});
    if(!state.finalizing.has(index)){await checkpoint(m,'finalize-intent',index);state.finalizing.add(index);}
    checkAbort(signal);await roots(m);await contained(saved,m.root);await contained(entry.destination,m.root);
    if(await maybeStat(entry.source)||!matches(await fs.lstat(saved,{bigint:true}),snapshot(originalStat))||!matches(await fs.lstat(entry.destination,{bigint:true}),snapshot(destinationStat)))throw new Error('A verified file changed before finalization');
    await fs.unlink(saved);await syncDirectory(path.dirname(saved));result.removed++;result.bytes+=entry.size;
   }else if(!state.finalizing.has(index))throw new Error('Retained original disappeared before authorization');
   if(!state.finalized.has(index)){await checkpoint(m,'finalized',index);state.finalized.add(index);}
   result.finalized++;
  }
  await removeSiblingPointers(m);
  return result;
 });
}

/** handedOff: files a later organization moved on, left where that one put them. */
export interface OrganizationUndo {restored:number;removed:number;handedOff:number;}
/** Put every organized file back where it was reviewed, for a finished, stopped or
 * partly undone organization. Moved files are renamed back; copied entries get their
 * kept original back, and only a copy this organization published is removed, after
 * both it and the restored original are verified. Released originals cannot come back,
 * so a finalized organization is refused. Nothing is overwritten or removed unchecked. */
export async function undoOrganization(root:string,id:string,signal?:AbortSignal,onProgress?:(progress:OrganizationProgress)=>void):Promise<OrganizationUndo>{
 await adoptLegacyStorage(root);
 return locked(jobPath(root,id),async()=>{
  checkAbort(signal);const m=await readManifest(root,id),state=await readEvents(m);
  if(state.superseded)throw new Error(`Organization ${m.id} was superseded by ${state.superseded}`);
  if(state.finalizing.size||state.finalized.size)throw new Error('Kept originals were already released, so this organization cannot be undone');
  const result:OrganizationUndo={restored:0,removed:0,handedOff:0};
  if(state.undoComplete)return result;
  // Until the undo completes, the folders it restores into must be found by other organizations.
  await writeSiblingPointers(m);await recordHandOffs(m,state);
  // A file a later organization took over stays with it: undoing that one brings it back first.
  const handedOff=async(index:number)=>{const handOff=state.handedOff.get(index);return !!handOff&&!await maybeStat(m.entries[index]!.destination)&&!!await maybeStat(handOff.destination);};
  const occupied=(file:string)=>new Error(`Original path is occupied; nothing was overwritten: ${file}`);
  const restore=async(from:string,to:string)=>{
   await makeParent(to,m.source,m.sourceIdentity);
   try{await fs.link(from,to);const a=await fs.lstat(from,{bigint:true}),b=await fs.lstat(to,{bigint:true});if(!sameHardLink(a,b))throw occupied(to);await fs.unlink(from);}
   catch(error){
    if(code(error)==='EEXIST')throw occupied(to);
    if(!unsupportedLink.includes(code(error)??''))throw error;
    if(await maybeStat(to))throw occupied(to);
    await fs.rename(from,to);
   }
   await syncParents(to,m.source);await syncDirectory(path.dirname(from));
  };
  /** Where a moved entry is now: 'back' (already at its original path), 'moved' (still at the destination), or 'none'. */
  const movedState=async(index:number,entry:Entry):Promise<'back'|'moved'|'none'|'pair'>=>{
   const source=await maybeStat(entry.source),target=await maybeStat(entry.destination),dated=state.dated.get(index);
   if(source&&target&&sameHardLink(source,target))return 'pair';
   if(source&&target&&source.dev===target.dev&&source.ino===target.ino&&entry.size>0)throw new Error(`Two names point at one file entry without a hard link; nothing was changed. Check the drive: ${entry.source}`);
   // The original is in place and something else appeared at the destination: nothing to undo here.
   if(source&&movedIdentity(source,entry,dated))return 'back';
   if(source&&target)throw new Error(`Both the original path and the organized path hold files; nothing was changed: ${entry.source}`);
   if(target){
    if(movedIdentity(target,entry,dated)&&(state.renamed.has(index)||await digest(entry.destination,signal)===entry.digest))return 'moved';
    throw new Error(`Moved file changed; nothing was changed: ${entry.destination}`);
   }
   if(source)throw occupied(entry.source);
   return 'none';
  };
  const moved=(index:number)=>state.renamed.has(index)||(state.renameIntent.has(index)&&!state.fallback.has(index)&&!state.slots.get(index)?.length);
  // Check everything before the first change, then undo in reverse order. Moved files that are gone
  // from both places are all named, and nothing is changed.
  const missing:string[]=[];
  for(const [index,entry] of m.entries.entries()){
   checkAbort(signal);onProgress?.({step:'checking',completed:index+1,total:m.entries.length,file:entry.destination});if(state.undone.has(index))continue;
   await contained(entry.source,m.source);await contained(entry.destination,m.root);
   if(await handedOff(index))continue;
   if(moved(index)){if(await movedState(index,entry)==='none'&&state.renamed.has(index))missing.push(entry.destination);continue;}
   const saved=await savedOriginal(m,index,state);
   if(saved){if(await maybeStat(entry.source))throw occupied(entry.source);await validateOriginal(saved,entry,m.root,true,signal);}
  }
  if(missing.length)throw new Error(`${missing.length} organized file${missing.length===1?' is':'s are'} no longer where this organization put ${missing.length===1?'it':'them'} and cannot be put back; nothing was changed: ${missing.slice(0,20).join(', ')}${missing.length>20?', …':''}`);
  for(const [step,index] of [...m.entries.keys()].reverse().entries()){
   checkAbort(signal);onProgress?.({step:'restoring',completed:step+1,total:m.entries.length,file:m.entries[index]!.source});if(state.undone.has(index))continue;await roots(m);
   const entry=m.entries[index]!,handed=await handedOff(index);if(handed)result.handedOff++;
   // A moved file a later organization took over is left with it; a kept original still comes back.
   if(handed&&moved(index)){}
   else if(moved(index)){
    const where=await movedState(index,entry);
    if(where==='pair'){await fs.unlink(entry.destination);await syncParents(entry.destination,m.root);}
    else if(where==='moved')await restore(entry.destination,entry.source);
    if(where!=='none'){
     // Restore the reviewed Modified date; the bytes were never changed.
     const handle=await fs.open(entry.source,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
     try{const now=await handle.stat({bigint:true});if(String(now.mtimeNs)!==entry.stat.mtime){
      // Seconds pass through a double and FAT/exFAT truncate to 10 ms; aim mid-step there.
      const fat=now.ctimeNs===now.mtimeNs,milliseconds=Number(BigInt(entry.stat.mtime)/1000000n)+(fat?5:0);
      await handle.utimes(new Date(Number(now.atimeMs)),new Date(milliseconds));
     }}catch{/* Dates are best effort. */}finally{await handle.close();}
     if(where!=='back')result.restored++;
    }
   } else {
    const saved=await savedOriginal(m,index,state);
    if(saved){if(await maybeStat(entry.source))throw occupied(entry.source);await restore(saved,entry.source);result.restored++;}
    // Only a copy this organization published is removed, and only once the reviewed
    // original is verified at its own path, so the copy is never the last one.
    if(state.published.has(index)&&await maybeStat(entry.destination)&&await maybeStat(entry.source)){
     // Restoring a kept original moves its change time; its contents are still hashed.
     await validateOriginal(entry.source,entry,m.source,true,signal);
     if(await targetMatches(entry,m,signal)){await fs.unlink(entry.destination);await syncParents(entry.destination,m.root);result.removed++;}
    }
   }
   await checkpoint(m,'undone',index);state.undone.add(index);
  }
  await checkpoint(m,'undo-complete');await removeSiblingPointers(m);
  return result;
 });
}
