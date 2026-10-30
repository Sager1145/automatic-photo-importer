import * as fs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OrganizationRecovery, Progress, TransferPlan } from '../shared';
export type { OrganizationRecovery } from '../shared';
import {applyFileTimestamps} from '../platform/file-timestamps';
import { mapPool, streams, STREAMS } from './devices';
import { hasher } from './hasher';
import type { AppleDoubleCleaner, AppleDoubleReport } from './appledouble';
import { appendLines, configureHostKey, hostKeyConfigured, LINE_CAPS, openRegular, openV5, pointerPartition, readLines, renameChecked, requireHostKey, SealError, sealedLine, sealV5, storeFolder, storeFor, storesFor, storeUnchanged, writeNewFile, type Store } from './app-store';
import { MessageError } from '../messages';
import { driveName, refuseOldRecords } from './old-records';
import { provable, full as fullStat } from './destination-index';
import { log, logDeletion } from '../logger';
import { removeEmptiedFolders } from './redundant-folders';
import { beneath, checkAbort, code, contained, within, digest, identity, isAbort, makeParent, pathKey, regularHandle, rootUnchanged, syncDirectory, syncParents, syncFile, sameStat, maybeLstat, posixRelative, readdirIfPresent, statRecord, isStatRecord, rebaseDevice, LINK_UNSUPPORTED, linkRefused, type StatRecord } from './paths';

/** retained: originals kept in recovery storage for undo (copy path only); renamed files keep none.
 * released: retained duplicates removed right after a clean run (only when that was asked for). */
export interface ReorganizationResult {copied:number;skipped:number;errors:string[];moved:number;retained:number;retainedBytes:number;notes?:string[];released?:number;releasedBytes?:number;/** What removing macOS "._" files did; present only when it was on. */appleDouble?:AppleDoubleReport;/** Source folders this run removed because it left them empty; present only when there were some. */foldersRemoved?:number;}
/** kept: a duplicate removal's entry names the copy that stays as its destination; that copy may differ from the removed file's bytes (EXIF-identical duplicates), so its own size and SHA-256 are checked instead. */
export interface OrganizationEntry {captureTimeMs?:number;source:string;destination:string;digest:string;size:number;stat:BigIntStats;move:boolean;kept?:{digest:string;size:number};}
interface Entry {captureTimeMs?:number;source:string;destination:string;digest:string;size:number;stat:StatRecord;move:boolean;parents:Record<string,string>;kept?:{digest:string;size:number};}
interface Manifest {version:1;/** duplicates: a Remove duplicates run; nothing is copied, each entry's destination is the copy kept. */kind?:'duplicates';id:string;root:string;rootIdentity:string;source:string;sourceIdentity:string;entries:Entry[];/** rename: each file moves on its volume with rename(2), every new organization's. Absent (journals of earlier
 * versions): a verified copy plus a retained original. */strategy?:'rename';keepFolders?:true;/** Other backup folders organized from the same source (the video-root layout's); never removed as empty. */libraries?:string[];
 /** The chosen source folders (the source itself when none were chosen): only folders inside them that the run emptied
 * are removed, OS bookkeeping included. Absent (earlier versions' journals): only folders already empty go, up to the source. */cleanupScope?:string[];}
import {APP_DATA_FOLDER,isRecordFolderName} from './legacy-names';
export {APP_DATA_FOLDER,LEGACY_RECOVERY_FOLDER,RECOVERY_FOLDER} from './legacy-names';
/** This app's record folders, current and earlier: never organized, listed or cleaned as user files. */
export const isRecoveryName=isRecordFolderName;
/** Configure once from the host's private application data, never from a drive journal. */
export function configureOrganizationRecovery(secret:Buffer|string):void {configureHostKey(secret);}
// Import receipts share the private host key.
export function importRecoveryAvailable():boolean {return hostKeyConfigured();}
const UUID_PATTERN='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',uuid=new RegExp(`^${UUID_PATTERN}$`);
const locks=new Map<string,Promise<unknown>>();
async function locked<T>(key:string,work:()=>Promise<T>):Promise<T> {
 const previous=locks.get(key)??Promise.resolve();const {promise:next,resolve:release}=Promise.withResolvers<void>();locks.set(key,next);
 await previous.catch(()=>{});try{return await work();}finally{release();if(locks.get(key)===next)locks.delete(key);}
}
/** An empty file has no stable inode on exFAT (a synthetic number that changes on rename),
 * so it is identified by device, size and times only. */
function matches(stat:BigIntStats,expected:StatRecord,renamed=false):boolean {
 const actual=statRecord(stat);return Object.keys(expected).every(k=>renamed&&k==='ctime'||k==='ino'&&expected.size==='0'||actual[k as keyof StatRecord]===expected[k as keyof StatRecord]);
}
export const sameFile=matches;
async function ensureDirectory(folder:string,root:string):Promise<void> {
 await contained(folder,root);try{await fs.mkdir(folder,{mode:0o700});await syncDirectory(path.dirname(folder));}catch(error){if(code(error)!=='EEXIST')throw error;}
 await contained(folder,root);const stat=await fs.lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error(`Unsafe recovery directory: ${folder}`);
}
/** In a store: Organizations/<id>/journal.jsonl, and Pointers/<folder partition>/journal-<id>.json. */
export const ORGANIZATIONS='Organizations',POINTERS='Pointers',JOURNAL='journal.jsonl';
/** Where a journal is: its folder in a store (paths inside are checked against the store). */
interface Location {folder:string;journal:string;scope:string;store:Store;eventsFrom:number;/** The header says the journal was converted from an earlier version's. */converted?:boolean;}
const locations=new WeakMap<Manifest,Location>();
function where(m:Manifest):Location {const at=locations.get(m);if(!at)throw new Error('Unknown organization record location');return at;}
const jobFolder=(m:Manifest)=>where(m).folder;
/** The folder every path of the journal's own files must stay inside. */
const scopeOf=(m:Manifest)=>where(m).scope;
/** One lock per journal, by library and id, wherever its records are. */
const lockKey=(root:string,id:string)=>{if(!uuid.test(id))throw new Error('Invalid recovery identifier');return `${root}\0${id}`;};
interface JournalState {slots:Map<number,string[]>;exclusive:Map<number,StatRecord[]>;complete:boolean;finalizing:Set<number>;finalized:Set<number>;superseded?:string;/** Where the successor's journal is when it is not this root: a sibling backup folder its manifest lists. */successorRoot?:string;
 renameIntent:Set<number>;renamed:Map<number,StatRecord>;dated:Map<number,Set<string>>;fallback:Set<number>;published:Set<number>;undone:Set<number>;undoComplete:boolean;/** The migrator finished converting this journal (its `migration-complete` event). */migrationComplete:boolean;/** Converted only in part: the earlier version's folder may still hold its kept originals, so it is an old record. */halfConverted?:boolean;
 /** Entries a later complete organization moved on from their destination; that one owns them now. */handedOff:Map<number,HandOff>;}
/** A later journal (`successor`, in `successorRoot`) that moved an entry's file from its destination to `destination`. */
interface HandOff {successor:string;successorRoot:string;destination:string;}
function originalPath(m:Manifest,index:number,slot:string):string{return path.join(jobFolder(m),'originals',String(index),slot,path.basename(m.entries[index]!.source));}
/** Finished journals' events, by journal file, kept for this app session: how far the journal was read
 * (only whole lines) and the resulting state. Every listing and every organization's check of earlier
 * journals would otherwise read them again. */
interface JournalCache {ino:bigint;mark:LogMark;state:JournalState;/** Records applied up to the mark. */records:number;}
/** How far the log was applied, and its first and last bytes up to there, so a log rewritten rather
 * than appended to is recognized. */
interface LogMark {ino:bigint;offset:number;size:bigint;mtime:bigint;head:Buffer;tail:Buffer;}
const markSpan=4096;
async function logMark(handle:fs.FileHandle,offset:number):Promise<LogMark>{
 const stat=await handle.stat({bigint:true}),head=Buffer.alloc(Math.min(markSpan,offset)),tail=Buffer.alloc(Math.min(markSpan,offset));
 if(head.length){await handle.read(head,0,head.length,0);await handle.read(tail,0,tail.length,offset-tail.length);}
 return {ino:stat.ino,offset,size:stat.size,mtime:stat.mtimeNs,head,tail};
}
const finishedJournals=new Map<string,JournalCache>();
function emptyState():JournalState{return {slots:new Map(),exclusive:new Map(),complete:false,finalizing:new Set(),finalized:new Set(),renameIntent:new Set(),renamed:new Map(),dated:new Map(),fallback:new Set(),published:new Set(),undone:new Set(),undoComplete:false,handedOff:new Map(),migrationComplete:false};}
/** Fully undone, superseded, or complete with every finalize finished and nothing undone. Only these
 * are cached. Anything the app records later (a successor, a hand-off, a finalize or an undo) is an
 * append, which changes the stamp; the app never rewrites events in place. */
const finished=(state:JournalState)=>state.undoComplete||!!state.superseded||state.complete&&state.finalizing.size===state.finalized.size&&state.undone.size===0;
function copyState(state:JournalState):JournalState{
 return {...state,slots:new Map([...state.slots].map(([index,slots])=>[index,[...slots]])),exclusive:new Map([...state.exclusive].map(([index,stats])=>[index,[...stats]])),
  finalizing:new Set(state.finalizing),finalized:new Set(state.finalized),renameIntent:new Set(state.renameIntent),renamed:new Map(state.renamed),
  dated:new Map([...state.dated].map(([index,dates])=>[index,new Set(dates)])),fallback:new Set(state.fallback),published:new Set(state.published),undone:new Set(state.undone),handedOff:new Map(state.handedOff)};
}
/** Applies one authenticated event of journal `m` to `state` (a line is counted once: that is the reader's job). */
function applier(m:Manifest,state:JournalState):(record:Record<string,unknown>)=>void {
 return record=>{
  if(record.id!==m.id||record.root!==m.root)throw new Error('Invalid recovery event scope');
  if(record.event==='complete'){state.complete=true;return;}
  if(record.event==='undo-complete'){state.undoComplete=true;return;}
  // Journals the migrator (records-migrator-v5) converted carry this event, and 'migration-moved' (ignored).
  if(record.event==='migration-complete'){state.migrationComplete=true;return;}
  // What a listing would show at that point; for display only, never state.
  if(record.event==='summary')return;
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
  if(record.event==='renamed'||record.event==='timed'){const stat=record.stat as StatRecord;if(!isStatRecord(stat))throw new Error('Invalid moved file identity');state.renamed.set(index,stat);state.dated.set(index,new Set([...(state.dated.get(index)??[]),stat.mtime]));}
  if(record.event==='exclusive-created'){const stat=record.stat as StatRecord;if(!stat||typeof stat.dev!=='string'||typeof stat.ino!=='string')throw new Error('Invalid recovery publication identity');state.exclusive.set(index,[...(state.exclusive.get(index)??[]),stat]);}
 };
}
/** Identities recorded under an earlier mount are read as this mount's, like the manifest's. */
function rebasedEvent(m:Manifest):(record:Record<string,unknown>)=>Record<string,unknown> {
 const mount=mountDevices.get(m);
 return record=>{const stat=record.stat as StatRecord|undefined;return mount&&stat&&typeof stat==='object'?{...record,stat:{...stat,dev:mount}}:record;};
}
/** One v5 event line: undefined for a blank line or one an interrupted write cut short; a line that is JSON must verify. */
function parseEvent(text:string,rebased:(record:Record<string,unknown>)=>Record<string,unknown>):Record<string,unknown>|undefined {
 const line=text.trim();if(!line)return undefined;
 let value:unknown;try{value=JSON.parse(line);}catch(error){if(error instanceof SyntaxError)return undefined;throw error;}
 try{return rebased(openV5('event',value));}catch(error){if(error instanceof SealError)throw new Error('Recovery journal authentication failed; originals retained');throw error;}
}
/** `onRead`: bytes of events read so far, of those to read. `follow` false reads only this journal's own signed
 * events, without checking its successor. A journal's events are lines after its header and entries, read in 1 MiB
 * chunks; a finished journal read before in this session is read only past what was already applied. */
async function readEvents(m:Manifest,chain=new Set<string>(),onRead?:(read:number,total:number,name?:string)=>void,follow=true,signal?:AbortSignal):Promise<JournalState> {
 checkAbort(signal);
 if(chain.has(m.id))throw new Error('Organization supersession cycle');chain=new Set(chain).add(m.id);
 const at=where(m);
 const rebased=rebasedEvent(m),cacheKey=`${at.journal}\0${m.rootIdentity}\0${mountDevices.get(m)??''}`,cached=finishedJournals.get(cacheKey);
 await contained(at.journal,at.scope);
 const handle=await openRegular(at.journal);let state:JournalState,tail:Record<string,unknown>|undefined;
 try{
  const stat=await handle.stat({bigint:true});
  // Untouched since (the app only appends, and an append moves size and date), or grown with the same first and last bytes.
  const reuse=!!cached&&cached.ino===stat.ino&&Number(stat.size)>=cached.mark.offset&&(stat.size===cached.mark.size&&stat.mtimeNs===cached.mark.mtime||await logMark(handle,cached.mark.offset).then(now=>now.head.equals(cached.mark.head)&&now.tail.equals(cached.mark.tail)));
  state=reuse?copyState(cached!.state):emptyState();
  const from=reuse?cached!.mark.offset:at.eventsFrom,total=Math.max(0,Number(stat.size)-from),apply=applier(m,state);
  // Records read so far, of an estimate from the bytes read (exact once all are read).
  // Before the first chunk: an estimate from the bytes to read (an event line is a few hundred bytes).
  // A cached journal counts the records it had already applied.
  const known=reuse?cached!.records:0;let records=known;const name=path.basename(at.folder);onRead?.(known,known+Math.max(1,Math.round(total/400)),name);
  const {end}=await readLines(handle,at.journal,from,()=>LINE_CAPS.event,text=>{records++;const record=parseEvent(text,rebased);if(record)apply(record);},{onTail:text=>{tail=parseEvent(text,rebased);},onBytes:position=>{const done=position-from,fresh=records-known;onRead?.(records,done>=total?records:Math.max(records,known+Math.round(fresh*total/Math.max(1,done))),name);},signal});
  onRead?.(records,records,name);
  if(finished(state))finishedJournals.set(cacheKey,{ino:stat.ino,mark:await logMark(handle,end),state:copyState(state),records});else finishedJournals.delete(cacheKey);
 }finally{await handle.close();}
 // A last line without its newline (an append cut short, or one being written) counts, but is read again next time.
 if(tail)applier(m,state)(tail);
 state.halfConverted=!!at.converted&&!state.migrationComplete;
 return finishJournalRead(m,state,chain,follow,onRead,signal);
}
/** Checks that need the events of the whole journal, and its successor and hand-offs; never cached. */
async function finishJournalRead(m:Manifest,state:JournalState,chain:Set<string>,follow:boolean,onRead?:(read:number,total:number,name?:string)=>void,signal?:AbortSignal):Promise<JournalState> {
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
  await readEvents(successor,chain,onRead,true,signal);
 }
 return state;
}
async function savedOriginal(m:Manifest,index:number,state:JournalState):Promise<string|undefined> {
 let saved:string|undefined;
 for(const slot of state.slots.get(index)??[]){const file=originalPath(m,index,slot);await contained(file,scopeOf(m));if(await maybeLstat(file)){if(saved)throw new Error('Multiple recovery originals require inspection');saved=file;}}
 return saved;
}
async function roots(m:Manifest):Promise<void> {
 const at=where(m);
 await rootUnchanged(m.root,m.rootIdentity);await rootUnchanged(m.source,m.sourceIdentity);
 const library=await fs.lstat(m.root,{bigint:true});
 if(library.dev!==(await fs.lstat(m.source,{bigint:true})).dev)throw new Error('Recovery source and destination must remain on the same filesystem');
 // Originals and staged copies move between the library and the store with rename(2) and link(2): one volume.
 await storeUnchanged(at.store);if((await fs.lstat(at.store.path,{bigint:true})).dev!==library.dev)throw new Error('Recovery records and the library must remain on the same filesystem');
 await contained(at.folder,at.scope);
}
async function parents(entry:Entry,m:Manifest):Promise<void> {
 await contained(entry.source,m.source);for(const [folder,expected]of Object.entries(entry.parents))await rootUnchanged(folder,expected);
}
async function validateOriginal(file:string,entry:Entry,scope:string,renamed:boolean,signal?:AbortSignal,verifyContents=true,proofs?:Proofs):Promise<void> {
 await contained(file,scope);const before=await fs.lstat(file,{bigint:true});
 if(!before.isFile()||before.isSymbolicLink()||!matches(before,entry.stat,renamed)||(verifyContents&&await (proofs?proofs.digest(file,signal):digest(file,signal))!==entry.digest))throw new Error(`Source changed after review; original retained: ${file}`);
 if(!matches(await fs.lstat(file,{bigint:true}),entry.stat,renamed))throw new Error(`Source changed while rechecking: ${file}`);
}
async function targetMatches(entry:Entry,m:Manifest,signal?:AbortSignal,verifyContents=true,proofs?:Proofs):Promise<boolean> {
 await contained(entry.destination,m.root);const stat=await maybeLstat(entry.destination);if(!stat)return false;
 const expected=entry.kept??entry;
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==BigInt(expected.size)||(verifyContents&&await (proofs?proofs.digest(entry.destination,signal):digest(entry.destination,signal))!==expected.digest))throw new Error(`Destination changed; original retained: ${entry.destination}`);
 return true;
}
/** Content proofs taken by this process during one run, finalize or undo: each file's SHA-256 with the full stat
 * (birth time included) it was read under. One is reused only while that stat is unchanged, and only where the
 * filesystem keeps a real change time (provable: not FAT or exFAT), so there nothing is reused between steps. */
class Proofs {
 private known=new Map<string,{stat:string;sha256:string}>();
 /** The proof held for this exact stat, without reading the file. */
 held(file:string,stat:BigIntStats):string|undefined {const known=this.known.get(file);return known&&provable(stat)&&known.stat===fullStat(stat)?known.sha256:undefined;}
 /** The file's SHA-256: the proof already held for its stat, or a fresh read that becomes one. */
 async digest(file:string,signal?:AbortSignal):Promise<string> {
  const before=await fs.lstat(file,{bigint:true}),held=this.held(file,before);if(held)return held;
  const sha256=await digest(file,signal);this.seed(file,before,sha256,await fs.lstat(file,{bigint:true}));return sha256;
 }
 /** Bytes hashed by this process while the file had stat `before`, and still had it at `after`. */
 seed(file:string,before:BigIntStats,sha256:string,after=before):void {
  if(provable(after)&&sameStat(before,after)&&before.birthtimeNs===after.birthtimeNs)this.known.set(file,{stat:fullStat(after),sha256});else this.known.delete(file);
 }
}
/** Runs `check` (which reads `file`) and returns the file's stat when it was the same before and after, so the
 * bytes just read belong to that stat; undefined when the file changed meanwhile, or when its filesystem keeps no
 * real change time (FAT, exFAT), where an unchanged stat proves nothing. */
async function proven(file:string,check:()=>Promise<void>):Promise<BigIntStats|undefined> {
 const before=await fs.lstat(file,{bigint:true});await check();const after=await fs.lstat(file,{bigint:true});
 return provable(after)&&sameStat(before,after)&&before.birthtimeNs===after.birthtimeNs?after:undefined;
}
const unchangedSince=(proof:BigIntStats|undefined,now:BigIntStats)=>!!proof&&provable(now)&&sameStat(proof,now)&&proof.birthtimeNs===now.birthtimeNs;
function validateManifest(value:unknown,root:string,id:string):Manifest {
 const m=value as Manifest;
 if(!m||m.version!==1||(m.strategy!==undefined&&m.strategy!=='rename')||(m.kind!==undefined&&m.kind!=='duplicates')||(m.keepFolders!==undefined&&m.keepFolders!==true)||m.id!==id||m.root!==root||typeof m.source!=='string'||path.resolve(m.source)!==m.source||!(m.source===root||beneath(root,m.source))||!Array.isArray(m.entries)||typeof m.rootIdentity!=='string'||typeof m.sourceIdentity!=='string'||(m.libraries!==undefined&&(!Array.isArray(m.libraries)||m.libraries.some(folder=>typeof folder!=='string'||path.resolve(folder)!==folder||!beneath(folder,m.source))))||(m.cleanupScope!==undefined&&(m.keepFolders||!Array.isArray(m.cleanupScope)||!m.cleanupScope.length||m.cleanupScope.some(folder=>typeof folder!=='string'||path.resolve(folder)!==folder||!within(folder,m.source)||path.relative(m.source,folder).split(path.sep).some(p=>isRecoveryName(p))))))throw new Error('Invalid or unsafe organization recovery journal');
 const sources=new Set<string>();
 for(const entry of m.entries) {
  if(!entry||(entry.captureTimeMs!==undefined&&(!Number.isFinite(entry.captureTimeMs)||Math.abs(entry.captureTimeMs)>8640000000000000))||typeof entry.source!=='string'||typeof entry.destination!=='string'||!beneath(entry.source,m.source)||path.resolve(entry.source)!==entry.source||!beneath(entry.destination,root)||path.resolve(entry.destination)!==entry.destination||typeof entry.digest!=='string'||!/^[a-f0-9]{64}$/.test(entry.digest)||!Number.isSafeInteger(entry.size)||entry.size<0||typeof entry.move!=='boolean'||!entry.stat||!entry.parents||typeof entry.parents!=='object')throw new Error('Invalid or unsafe organization recovery entry');
  if(path.relative(m.source,entry.source).split(path.sep).some(p=>isRecoveryName(p))||path.relative(root,entry.destination).split(path.sep).some(p=>isRecoveryName(p)))throw new Error('Unsafe recovery storage path in journal');
  if(entry.kept!==undefined&&(m.kind!=='duplicates'||!entry.kept||typeof entry.kept.digest!=='string'||!/^[a-f0-9]{64}$/.test(entry.kept.digest)||!Number.isSafeInteger(entry.kept.size)||entry.kept.size<0||pathKey(entry.source)===pathKey(entry.destination)))throw new Error('Invalid duplicate removal entry');
  if(m.kind==='duplicates'&&pathKey(entry.source)===pathKey(entry.destination))throw new Error('Invalid duplicate removal entry');
  if(sources.has(pathKey(entry.source)))throw new Error('Duplicate recovery source');sources.add(pathKey(entry.source));
  const keys=Object.keys(entry.stat).sort().join(',');if(keys!=='ctime,dev,ino,mtime,size'||Object.entries(entry.stat).some(([key,v])=>typeof v!=='string'||!(key==='ino'?/^-?\d+$/:/^\d+$/).test(v))||entry.stat.size!==String(entry.size)||entry.stat.dev!==m.rootIdentity.split(':')[0])throw new Error('Invalid recovery source identity');
  const ancestors:string[]=[];for(let folder=path.dirname(entry.source);folder!==m.source;folder=path.dirname(folder)){if(!beneath(folder,m.source))throw new Error('Unsafe recovery source ancestor');ancestors.push(folder);}
  if(Object.keys(entry.parents).length!==ancestors.length||ancestors.some(folder=>typeof entry.parents[folder]!=='string'||!/^\d+:\d+$/.test(entry.parents[folder]!)))throw new Error('Invalid recovery source ancestor identities');
 }
 return m;
}
/** A journal's first lines: its sealed header and (with `entries`) its sealed entries, and where its events start. */
async function readJournalHead(journal:string,scope:string,entries:boolean):Promise<{header:Record<string,unknown>;entries?:Record<string,unknown>;eventsFrom:number}>{
 await contained(journal,scope);const handle=await openRegular(journal);
 try{
  const lines:string[]=[],count=entries?2:1;
  const {end}=await readLines(handle,journal,0,n=>n===0?LINE_CAPS.header:LINE_CAPS.entries,text=>{lines.push(text);},{limit:count});
  const damaged=()=>new Error(`Damaged organization record: ${journal}`);
  if(lines.length<count)throw damaged();
  const parse=(text:string)=>{try{return JSON.parse(text) as unknown;}catch{throw damaged();}};
  try{return {header:openV5('organization',parse(lines[0]!)),...(entries?{entries:openV5('entries',parse(lines[1]!))}:{}),eventsFrom:end};}
  catch(error){if(error instanceof SealError)throw new Error('Recovery journal authentication failed; originals retained');throw error;}
 }finally{await handle.close();}
}
/** The manifest a v5 header and entries line describe, checked like any manifest. */
function manifestFrom(header:Record<string,unknown>,entries:Record<string,unknown>,root:string,id:string):Manifest {
 if(header.id!==id||entries.id!==id||!Array.isArray(entries.entries))throw new Error('Invalid or unsafe organization recovery journal');
 const m={version:1,...(header.dupKind!==undefined?{kind:header.dupKind}:{}),id:header.id,root:header.root,rootIdentity:header.rootIdentity,source:header.source,sourceIdentity:header.sourceIdentity,entries:entries.entries,
  ...(header.strategy!==undefined?{strategy:header.strategy}:{}),...(header.keepFolders!==undefined?{keepFolders:header.keepFolders}:{}),...(header.libraries!==undefined?{libraries:header.libraries}:{}),...(header.cleanupScope!==undefined?{cleanupScope:header.cleanupScope}:{})};
 return validateManifest(m,root,id);
}
interface Found {store:Store;folder:string;journal:string;}
/** Where journal `id` of library `root` is: its folder in exactly one of the stores readers consult. Refused when
 * two stores hold it. */
async function locateJob(root:string,id:string):Promise<Found>{
 if(!uuid.test(id))throw new Error('Invalid recovery identifier');
 const found:Found[]=[];
 for(const store of await storesFor(root)){const folder=path.join(store.path,ORGANIZATIONS,id),journal=path.join(folder,JOURNAL);if((await maybeLstat(journal))?.isFile())found.push({store,folder,journal});}
 if(found.length>1)throw new MessageError('error.recordsMultipleCopies',{id});
 if(!found.length)throw Object.assign(new Error(`Organization record not found: ${id}`),{code:'ENOENT'});
 return found[0]!;
}
/** Read a located journal's manifest. `checkRoots` false: for a folder renamed only by case, whose journals record its old name. */
async function openJournal(found:Found,root:string,id:string,checkRoots=true):Promise<Manifest>{
 const head=await readJournalHead(found.journal,found.store.path,true);
 const m=manifestFrom(head.header,head.entries!,root,id);
 locations.set(m,{folder:found.folder,journal:found.journal,scope:found.store.path,store:found.store,eventsFrom:head.eventsFrom,...(head.header.convertedFrom!==undefined?{converted:true}:{})});
 await rebaseMount(m);if(checkRoots)await roots(m);return m;
}
async function readManifest(root:string,id:string):Promise<Manifest> {
 if(path.resolve(root)!==root||await fs.realpath(root)!==root)throw new Error('Unsafe recovery root');
 return openJournal(await locateJob(root,id),root,id);
}
/** The journals whose header names `folder` (by path key) as their library, in every store readers consult for it. */
async function journalsIn(folder:string,unreadable?:{id:string;error:string}[]):Promise<{id:string;root:string;found:Found}[]>{
 const journals:{id:string;root:string;found:Found}[]=[];
 const stores=await storesFor(folder).catch(error=>{if(code(error)==='ENOENT')return [] as Store[];throw error;});
 for(const store of stores){
  const organizations=path.join(store.path,ORGANIZATIONS);
  for(const id of (await readdirIfPresent(organizations)).sort()){
   if(!uuid.test(id))continue;
   const found={store,folder:path.join(organizations,id),journal:path.join(organizations,id,JOURNAL)};
   if(!(await maybeLstat(found.journal))?.isFile())continue;
   let root:unknown;
   // A journal whose head cannot be read may be this folder's: refused, or (for a listing) reported as it is.
   try{root=(await readJournalHead(found.journal,store.path,false)).header.root;}
   catch(error){
    const text=error instanceof Error?error.message:String(error);
    // Another Mac's journal was never written by this app here and cannot name its journals: it is skipped (and listed).
    if(unreadable){unreadable.push({id,error:text});continue;}
    if(text.startsWith('Recovery journal authentication failed'))continue;
    throw new Error(`The organization record ${found.journal} cannot be read, so it is not known which library it belongs to: ${text}`);
   }
   if(typeof root==='string'&&pathKey(root)===pathKey(folder))journals.push({id,root,found});
  }
 }
 return journals;
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
 const rebase=(identity:string)=>rebaseDevice(identity,dev);
 m.rootIdentity=rebase(m.rootIdentity);m.sourceIdentity=rebase(m.sourceIdentity);
 for(const entry of m.entries){entry.stat.dev=dev;for(const folder of Object.keys(entry.parents))entry.parents[folder]=rebase(entry.parents[folder]!);}
}
/** Append one signed event to the journal and make it durable before returning. */
async function checkpoint(m:Manifest,event:string,index?:number,extra:Record<string,unknown>={}):Promise<void> {
 await roots(m);
 const line=sealedLine('event',{id:m.id,root:m.root,event,index,at:new Date().toISOString(),...extra});
 // Records stay as short as before (2048 characters), so every one the earlier version wrote also fits once converted.
 if(line.length>2048||Buffer.byteLength(line)>LINE_CAPS.event)throw new Error('Invalid recovery event');
 await appendEvents(m,[line]);
}
/** A `summary` event: what a listing would show now. For display only, best effort: it never fails the operation. */
async function summary(m:Manifest,value:{files:number;completed:number;retainedFiles?:number;retainedBytes?:number;status:'complete'|'undone'}):Promise<void>{
 await checkpoint(m,'summary',undefined,Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined))).catch(()=>{});
}
/** Append sealed event lines to the journal (group-committed with every other append waiting) and make them durable. */
async function appendEvents(m:Manifest,lines:string[]):Promise<void> {
 const at=where(m);
 await appendLines(at.journal,lines,async()=>{await contained(at.journal,at.scope);const stat=await maybeLstat(at.journal);if(!stat?.isFile())throw new Error('Unsafe recovery journal');},{create:false});
}

// Filesystems without hard links need an exclusive stream. The synchronized
// inode record lets a later process recognize an incomplete owned publication.
async function exclusivePublication(staged:string,entry:Entry,index:number,m:Manifest,signal?:AbortSignal):Promise<void> {
 const output=await fs.open(entry.destination,'wx',0o600);
 try {
  await output.sync();await syncParents(entry.destination,m.root);
  await checkpoint(m,'exclusive-created',index,{stat:statRecord(await output.stat({bigint:true}))});
  // A stream slot on each device and the memory governor, like every other whole-file copy.
  await streams.run([staged,entry.destination],async chunk=>{
   const input=await regularHandle(staged);
   try {const buffer=Buffer.allocUnsafe(chunk);for(;;){checkAbort(signal);const {bytesRead}=await input.read(buffer,0,buffer.length,null);if(!bytesRead)break;let offset=0;while(offset<bytesRead){const {bytesWritten}=await output.write(buffer,offset,bytesRead-offset,null);if(!bytesWritten)throw new Error('Unable to publish exclusive copy');offset+=bytesWritten;}}const stat=await input.stat({bigint:true});await applyFileTimestamps(output,stat,entry.captureTimeMs);await output.sync();}finally{await input.close();}
  },signal);
 }finally{await output.close();}
}
async function preserveIncomplete(entry:Entry,index:number,m:Manifest,input:string,state:JournalState,signal?:AbortSignal):Promise<boolean> {
 const current=await fs.lstat(entry.destination,{bigint:true});if(!current.isFile()||current.size>BigInt(entry.size))return false;
 const owned=(state.exclusive.get(index)??[]).some(stat=>stat.dev===String(current.dev)&&stat.ino===String(current.ino));
 if(!owned)return false;
 const partial=await regularHandle(entry.destination),original=await regularHandle(input);
 try {
  const identical=await streams.run([entry.destination,input],async chunk=>{const a=Buffer.allocUnsafe(chunk),b=Buffer.allocUnsafe(chunk);for(;;){checkAbort(signal);const {bytesRead}=await partial.read(a,0,a.length,null);if(!bytesRead)break;let count=0;while(count<bytesRead){const read=await original.read(b,count,bytesRead-count,null);if(!read.bytesRead)return false;count+=read.bytesRead;}if(!a.subarray(0,bytesRead).equals(b.subarray(0,bytesRead)))return false;}return true;},signal);
  if(!identical)return false;
  if(!matches(await partial.stat({bigint:true}),statRecord(current))||!matches(await fs.lstat(entry.destination,{bigint:true}),statRecord(current)))throw new Error('Incomplete destination changed while checking');
 }finally{await partial.close();await original.close();}
 await checkpoint(m,'incomplete-intent',index);checkAbort(signal);await roots(m);await contained(entry.destination,m.root);
 if(!matches(await fs.lstat(entry.destination,{bigint:true}),statRecord(current)))throw new Error('Incomplete destination changed before preservation');
 const saved=path.join(jobFolder(m),`incomplete-${randomUUID()}`);await contained(saved,scopeOf(m));if(await maybeLstat(saved))throw new Error('Recovery collision');
 await fs.rename(entry.destination,saved);await syncParents(entry.destination,m.root);await syncDirectory(path.dirname(saved));return true;
}
async function copy(entry:Entry,index:number,m:Manifest,input:string,signal?:AbortSignal,onBytes?:(bytes:number)=>void,proofs?:Proofs):Promise<void> {
 await roots(m);await contained(input,m.source);await makeParent(entry.destination,m.root,m.rootIdentity);await syncDirectory(path.dirname(entry.destination));
 const staged=path.join(jobFolder(m),`stage-${randomUUID()}.partial`);
 const output=await fs.open(staged,'wx',0o600);
 // Stages are expendable verified copies: a failed or stopped copy removes its own.
 try{await copyThroughStage(staged,output,entry,index,m,input,signal,onBytes,proofs);}
 catch(error){try{await contained(staged,scopeOf(m));await fs.unlink(staged);logDeletion('organize',staged,'recovery stage of a copy that failed or was stopped','stage created by this copy with an exclusive open; it is expendable and the original is untouched',{error});}catch{/* Already gone, or left for the residue cleanup. */}throw error;}
}
async function copyThroughStage(staged:string,output:fs.FileHandle,entry:Entry,index:number,m:Manifest,input:string,signal?:AbortSignal,onBytes?:(bytes:number)=>void,proofs?:Proofs):Promise<void> {
 let source:fs.FileHandle;try{source=await regularHandle(input);}catch(error){await output.close();throw error;}
 try {
  // A stream slot on each device and the memory governor; the SHA-256 runs on a worker thread while the next chunk is read.
  const before=await streams.run([input,staged],async chunk=>{
   const before=await source.stat({bigint:true}),hash=hasher(),buffer=Buffer.allocUnsafe(chunk);
   try {
    for(;;){checkAbort(signal);const {bytesRead}=await source.read(buffer,0,buffer.length,null);if(!bytesRead)break;await hash.update(buffer.subarray(0,bytesRead));let offset=0;while(offset<bytesRead){const {bytesWritten}=await output.write(buffer,offset,bytesRead-offset,null);if(!bytesWritten)throw new Error('Unable to write recovery stage');offset+=bytesWritten;}onBytes?.(bytesRead);}
    // The bytes hashed are the bytes staged: the source is not read a second time.
    if(await hash.digest()!==entry.digest||!matches(await source.stat({bigint:true}),statRecord(before)))throw new Error(`Source changed while copying: ${input}`);
   } finally {hash.drop();}
   return before;
  },signal);
  // Still the file streamed, by its path too: those bytes are this run's proof of it.
  proofs?.seed(input,before,entry.digest,await fs.lstat(input,{bigint:true}));
  await applyFileTimestamps(output,before,entry.captureTimeMs);await output.sync();
 } finally {await source.close();await output.close();}
 const stage=await proven(staged,async()=>{if(await digest(staged,signal)!==entry.digest)throw new Error('Recovery stage verification failed');});
 checkAbort(signal);await roots(m);await contained(entry.destination,m.root);await checkpoint(m,'publish-intent',index);
 let linked=false;
 try{await fs.link(staged,entry.destination);linked=true;}catch(error){if(!linkRefused(error))throw error;await exclusivePublication(staged,entry,index,m,signal);}
 await syncFile(entry.destination);await syncParents(entry.destination,m.root);
 // A hard link is the verified stage itself (the link only moves its change time and adds this one name); a streamed
 // copy, or a link with any other name besides, is read back.
 const published=linked&&stage?await maybeLstat(entry.destination):undefined;
 const same=!!published&&!!stage&&provable(published)&&published.dev===stage.dev&&published.ino===stage.ino&&published.nlink===stage.nlink+1n&&published.size===stage.size&&published.mtimeNs===stage.mtimeNs;
 if(!await targetMatches(entry,m,signal,!same,proofs))throw new Error('Destination disappeared after publication');
 // Retained originals are never unlinked; only the stage is.
 await contained(staged,scopeOf(m));await fs.unlink(staged);logDeletion('organize',staged,'recovery stage after its copy was published and verified',`SHA-256 ${entry.digest} matched at the stage and at the published destination ${entry.destination}`,{bytes:entry.size});
 // The stage's name is gone; its verified inode, unchanged but for the change time, is this run's proof of the copy.
 const kept=same?await maybeLstat(entry.destination):undefined;
 if(kept&&kept.dev===stage!.dev&&kept.ino===stage!.ino&&kept.size===stage!.size&&kept.mtimeNs===stage!.mtimeNs)proofs?.seed(entry.destination,kept,entry.digest);
 await checkpoint(m,'published',index);
}
/** Only reviewed obsolete source parents can be removed, and only by nonrecursive rmdir.
 * Stashed originals are independent of these paths, so recovery remains usable.
 */
/** The source folders an organization may remove once it emptied them, with their identities when it began: the
 * folders its moved files were in and their ancestors, inside its cleanup scope; none when it keeps its folders. */
function emptiable(m:Manifest,finalized:Set<number>):Map<string,string>{
 const candidates=new Map<string,string>();
 if(m.keepFolders)return candidates;
 for(const [index,entry]of m.entries.entries())if(entry.move&&!finalized.has(index))for(const [folder,expected]of Object.entries(entry.parents))
  if(folder!==m.root&&!m.libraries?.includes(folder)&&(!m.cleanupScope||m.cleanupScope.some(scope=>within(folder,scope))))candidates.set(folder,expected);
 return candidates;
}
/** The folders next to `root` on the same drive (none when `root` is a drive's top folder, so the
 * other mounted volumes are never read), skipping hidden ones. */
async function neighbourFolders(root:string):Promise<string[]>{
 const parent=path.dirname(root),[own,above]=await Promise.all([root,parent].map(folder=>fs.lstat(folder).catch(()=>undefined)));
 if(!own||!above||own.dev!==above.dev)return [];
 return (await fs.readdir(parent,{withFileTypes:true}).catch(()=>[])).filter(entry=>entry.isDirectory()&&!entry.name.startsWith('.')&&!isRecoveryName(entry.name)).map(entry=>path.join(parent,entry.name));
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
async function laterMoves(m:Manifest,onLater?:(done:number,total:number,file:string)=>void,signal?:AbortSignal):Promise<Successors>{
 const moves:Successors=new Map(),neighbours=await neighbourFolders(m.root),candidates:[string,string][]=[];
 for(const folder of new Set([m.root,...pointerFolders(m),...neighbours]))
  for(const {id} of await journalsIn(folder).catch(()=>[]))if(id!==m.id)candidates.push([folder,id]);
 let done=0;onLater?.(0,candidates.length,'');
 for(const [folder,id] of candidates){
  checkAbort(signal);onLater?.(done++,candidates.length,id);
  // Only a finished, never undone journal can have taken a file over for good.
  const later=await readManifest(folder,id).catch(()=>undefined);if(!later)continue;
  const state=await readEvents(later,undefined,undefined,false,signal).catch(error=>{if(isAbort(error))throw error;return undefined;});
  if(!state?.complete||state.undone.size||state.undoComplete)continue;
  for(const [index,entry] of later.entries.entries())if(entry.move&&state.renamed.has(index))moves.set(pathKey(entry.source),{root:folder,m:later,state,index});
 }
 onLater?.(candidates.length,candidates.length,'');
 return moves;
}
/** The hand-off for an entry whose file is gone from its destination: a later complete journal moved
 * that very file (same inode for a moved entry, same size and SHA-256) and it is still where that
 * journal put it, with the identity that journal recorded. */
async function findHandOff(m:Manifest,index:number,state:JournalState,moves:Successors):Promise<HandOff|undefined>{
 const entry=m.entries[index]!,later=moves.get(pathKey(entry.destination));if(!later)return;
 const next=later.m.entries[later.index]!,moved=state.renamed.get(index);
 if(next.digest!==entry.digest||next.size!==entry.size||(moved&&moved.ino!==next.stat.ino))return;
 const there=await maybeLstat(next.destination);
 if(!there?.isFile()||!movedIdentity(there,next,later.state.dated.get(later.index)))return;
 return {successor:later.m.id,successorRoot:later.root,destination:next.destination};
}
/** Whether this journal put the entry's file at its destination: moved there, or copied there (a
 * published copy, or one whose original was kept or released; older journals record no 'published'). */
const placed=(state:JournalState,index:number)=>state.renamed.has(index)||state.published.has(index)||!!state.slots.get(index)?.length||state.finalizing.has(index);
/** Record, before anything moves, each entry a later complete journal has taken over. */
async function recordHandOffs(m:Manifest,state:JournalState,onLater?:(done:number,total:number,file:string)=>void,signal?:AbortSignal):Promise<void>{
 let moves:Successors|undefined;
 for(const [index,entry] of m.entries.entries()){
  if(state.handedOff.has(index)||!placed(state,index)||await maybeLstat(entry.destination))continue;
  moves??=await laterMoves(m,onLater,signal);
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
/** The pointer folders kept for `folder` (Pointers/<name> <hash>) in every store readers consult for it. */
async function pointerDirectories(folder:string):Promise<{store:Store;directory:string}[]>{
 const suffix=` ${pointerPartition(folder).split(' ').pop()}`,found:{store:Store;directory:string}[]=[];
 const stores=await storesFor(folder).catch(error=>{if(code(error)==='ENOENT')return [] as Store[];throw error;});
 for(const store of stores){
  const base=path.join(store.path,POINTERS);
  for(const name of await readdirIfPresent(base))
   if(name.endsWith(suffix))found.push({store,directory:path.join(base,name)});
 }
 return found;
}
/** Every file in the pointer folders kept for `folder`. */
async function pointersIn(folder:string):Promise<{store:Store;file:string;name:string}[]>{
 const found:{store:Store;file:string;name:string}[]=[];
 for(const {store,directory} of await pointerDirectories(folder))
  for(const name of await fs.readdir(directory).catch(()=>[] as string[]))found.push({store,file:path.join(directory,name),name});
 return found;
}
/** Write this journal's signed pointer for `folder` (in `directory`, by default the pointer folder of the store
 * `folder` writes to): aside, then renamed into place, so a full disk or power cut never leaves a torn one. A torn
 * or wrong pointer of this journal there is replaced. */
async function writePointer(folder:string,m:Pick<Manifest,'root'|'id'>,at?:{store:Store;directory:string}):Promise<void>{
 const store=at?.store??await storeFor(folder),directory=at?.directory??await storeFolder(store,POINTERS,pointerPartition(folder));
 const target=path.join(directory,`journal-${m.id}.json`),temporary=path.join(directory,`journal-${m.id}-${randomUUID()}.tmp`);
 await contained(target,store.path);
 await writeNewFile(temporary,JSON.stringify(sealV5('pointer',{library:folder,root:m.root,id:m.id})));
 // A torn or wrong pointer of this journal is replaced in one step, so a stop never leaves the folder without one.
 if((await maybeLstat(target))?.isFile()){await fs.rename(temporary,target);await syncDirectory(directory);return;}
 if(await renameChecked(temporary,target)!=='done')throw new Error(`Unable to write ${target}`);
}
/** In each pointer folder, a signed pointer naming the journal and its folder, written before
 * anything moves, so an organization of that folder (which may list no other folder and hold no
 * journal of its own) finds and checks this journal. Removed when the journal finishes or is undone. */
async function writeSiblingPointers(m:Manifest):Promise<void>{
 for(const folder of pointerFolders(m)){
  // A folder that is gone or now resolves elsewhere gets no pointer; the scan refuses the latter.
  if(await fs.realpath(folder).catch(error=>{if(code(error)==='ENOENT')return undefined;throw error;})!==folder)continue;
  // Kept only when it is exactly this journal's signed pointer; a torn or wrong one is replaced.
  let kept=false;
  for(const {store,file,name} of await pointersIn(folder))if(name===`journal-${m.id}.json`&&await siblingPointer(folder,file,store.path).then(root=>root===m.root,()=>false))kept=true;
  if(!kept)await writePointer(folder,m);
 }
}
/** Best effort once a journal owns nothing more: its pointers, the pointer folder each was the last thing in, and a
 * records folder made in that folder itself only to hold pointers, once it holds nothing else (so the folder the
 * files came from can be removed as empty). */
async function removeSiblingPointers(m:Manifest):Promise<void>{
 for(const folder of pointerFolders(m))for(const {store,directory} of await pointerDirectories(folder).catch(()=>[])){
  try{
   const file=path.join(directory,`journal-${m.id}.json`);
   await contained(file,store.path);const stat=await maybeLstat(file);if(!stat?.isFile())continue;
   await fs.unlink(file);logDeletion('organize',file,'sibling pointer of a finished journal',`pointer file named journal-${m.id}.json kept for a folder this journal listed, now that the journal owns nothing more`);await syncDirectory(directory);
   await fs.rmdir(directory).then(()=>{logDeletion('organize',directory,'pointer folder emptied by removing its last pointer','empty (non-recursive removal)');return syncDirectory(path.dirname(directory));},()=>{});
   if(store.base===folder)await removeEmptyStore(store);
  }catch{/* Left as an inert pointer; the store cleanup removes it. */}
 }
}
/** A store holding nothing but its own record, an empty Pointers folder and Finder's bookkeeping is removed (never
 * anything else). */
async function removeEmptyStore(store:Store):Promise<void>{
 await storeUnchanged(store);
 const names=await fs.readdir(store.path);
 if(names.some(name=>!finderMetadata(name)&&name!=='store.json'&&name!==POINTERS))return;
 const pointers=path.join(store.path,POINTERS);
 if(names.includes(POINTERS)){if((await fs.readdir(pointers)).some(name=>!finderMetadata(name)))return;}
 const bookkeeping=(file:string)=>fs.unlink(file).then(()=>logDeletion('organize',file,'Finder bookkeeping in a records folder made only for pointers, now empty','.DS_Store or a "._" file, in a store holding nothing else'),()=>{});
 for(const name of names.filter(finderMetadata))await bookkeeping(path.join(store.path,name));
 if(names.includes(POINTERS)){for(const name of await fs.readdir(pointers))await bookkeeping(path.join(pointers,name));await fs.rmdir(pointers);logDeletion('organize',pointers,'empty Pointers folder of a records folder made only for pointers','empty (non-recursive removal)');}
 await fs.unlink(path.join(store.path,'store.json'));await fs.rmdir(store.path);logDeletion('organize',store.path,'records folder made only for pointers, now empty','it held only its own store record, an empty Pointers folder and Finder bookkeeping',{});await syncDirectory(store.base);
 const beside=path.join(store.base,`._${APP_DATA_FOLDER}`);if((await maybeLstat(beside))?.isFile())await bookkeeping(beside);
}
/** For the store cleanup: a pointer temp file left by a crash, a pointer whose folder is not the one it is kept
 * for (copied), or one whose journal is gone, finished, undone or superseded. A damaged pointer, or one whose
 * journal cannot be read, is kept. */
export async function storePointerLeftover(store:Store,file:string):Promise<boolean>{
 const name=path.basename(file);
 if(pointerTemporary.test(name))return true;
 const id=name.match(pointerName)?.[1];if(id===undefined||!uuid.test(id))return false;
 try{
  const pointer=await readPointer(file,store.path,id);
  if(path.basename(path.dirname(file)).split(' ').pop()!==pointerPartition(pointer.library).split(' ').pop())return true;
  const root=await siblingPointer(pointer.library,file,store.path);if(root===undefined)return true;
  // A library folder that is not there (renamed, or on a drive not connected) proves nothing about its journal.
  if(await fs.realpath(root).then(real=>real!==root,()=>true))return false;
  let m:Manifest;try{m=await readManifest(root,id);}catch(error){if(code(error)==='ENOENT')return true;return false;}
  const state=await readEvents(m,undefined,undefined,false);
  // A half-converted journal is an old record: its pointers stay.
  if(state.halfConverted)return false;
  return !!state.superseded||!unfinished(state);
 }catch{return false;}
}
/** For the store cleanup: whether journal `id` of `root` is in a terminal state (complete and finalized, undone or
 * superseded). A journal that cannot be read, or is still pending, is not. */
export async function journalTerminal(root:string,id:string,onRead?:(read:number,total:number)=>void):Promise<boolean>{
 try{const state=await readEvents(await readManifest(root,id),undefined,onRead,false);return !state.halfConverted&&finished(state);}catch{return false;}
}
/** Signals a pointer file that cannot be read or trusted; the scan then looks for its journal. */
class DamagedPointer extends Error{constructor(readonly file:string,readonly id:string,reason:string){super(`Damaged sibling journal pointer ${file} (${reason})`);}}
/** A pointer file's sealed record. */
async function readPointer(file:string,scope:string,id:string):Promise<{library:string;root:string}>{
 await contained(file,scope);const handle=await regularHandle(file);let value:unknown;
 try{if((await handle.stat()).size>LINE_CAPS.pointer)throw new DamagedPointer(file,id,'size');try{value=JSON.parse(await handle.readFile('utf8'));}catch(error){if(error instanceof SyntaxError)throw new DamagedPointer(file,id,'unreadable');throw error;}}finally{await handle.close();}
 let pointer:Record<string,unknown>;try{pointer=openV5('pointer',value);}catch{throw new DamagedPointer(file,id,'authentication failed');}
 if(pointer.id!==id||typeof pointer.library!=='string'||path.resolve(pointer.library)!==pointer.library||typeof pointer.root!=='string'||path.resolve(pointer.root)!==pointer.root)throw new DamagedPointer(file,id,'contents');
 return {library:pointer.library,root:pointer.root};
}
/** The journal folder a pointer kept for `root` names. Undefined for any other file, and for a valid pointer
 * that belongs to another folder (copied here), which is inert. */
async function siblingPointer(root:string,file:string,scope:string):Promise<string|undefined>{
 const id=path.basename(file).match(pointerName)?.[1];if(id===undefined)return undefined;
 if(!uuid.test(id))throw new DamagedPointer(file,id,'name');
 const pointer=await readPointer(file,scope,id);
 // Copied from another folder: inert. A folder renamed only by case keeps its pointers.
 if(pathKey(pointer.library)!==pathKey(root))return undefined;
 if(pointer.root===root)throw new DamagedPointer(file,id,'contents');
 return pointer.root;
}
/** For a damaged pointer kept for `root`: the folder of the journal it names, found among `known` folders
 * and `root`'s neighbours, when that journal's own manifest puts a pointer in `root`. The pointer is
 * then rewritten where it is. Otherwise the organization stops, naming the file. */
async function repairPointer(root:string,damaged:DamagedPointer,known:string[],at:{store:Store;directory:string}):Promise<string>{
 const neighbours=await neighbourFolders(root);
 for(const candidate of new Set([...known,...neighbours])){
  if(candidate===root||!uuid.test(damaged.id))continue;
  // A neighbour that cannot be read, or holds no such journal, is not where it lives.
  const journal=await readManifest(candidate,damaged.id).catch(()=>undefined);
  if(!journal||!pointerFolders(journal).includes(root))continue;
  await writePointer(root,journal,at);return candidate;
 }
 throw new Error(`${damaged.message}: organization ${damaged.id} was not found beside it. If that organization is finished or no longer needed, delete this file; otherwise Resume or Recheck it first.`);
}
/** For a folder renamed only by case: the id of an unfinished journal in it, if any. Its journals
 * record the old name, so they are read here without the exact-path check. */
async function unfinishedAfterCaseRename(real:string,recorded:string):Promise<string|undefined>{
 // A pointer here names a journal in another folder: unfinished there means this folder is in use.
 for(const {store,file,name} of await pointersIn(real)){
  if(pointerTemporary.test(name))continue;
  try{
   const root=await siblingPointer(real,file,store.path);if(root===undefined)continue;
   const named=name.match(pointerName)![1]!;
   let m:Manifest;try{m=await readManifest(root,named);}catch(error){if(code(error)==='ENOENT')continue;throw error;}
   const state=await readEvents(m,undefined,undefined,false);
   if(!state.superseded&&unfinished(state))return named;
  }catch{return name;}
 }
 for(const {id,root,found} of await journalsIn(real)){
  try{
   if(pathKey(root)!==pathKey(recorded))return id;
   const m=await openJournal(found,root,id,false),state=await readEvents(m,undefined,undefined,false);
   if(!state.superseded&&unfinished(state))return id;
  }catch{return id;}
 }
 return undefined;
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
  }
  // A folder holding old records nobody acknowledged: what they name cannot be checked against.
  await refuseOldRecords(root);
  for(const {store,file,name} of await pointersIn(root)){
   checkAbort(signal);
   // A pointer to a journal kept in another backup folder that lists this one: check it there too.
   if(pointerTemporary.test(name))continue;
   const pointed=await siblingPointer(root,file,store.path).catch(async error=>{if(error instanceof DamagedPointer)return repairPointer(root,error,folders,{store,directory:path.dirname(file)});throw error;});
   if(pointed!==undefined&&pointed!==m.root)folders.push(pointed);
  }
  for(const {id} of await journalsIn(root)){
   checkAbort(signal);
   if(id===m.id)continue;
   // A journal its own signed log already hands to a successor is never written again, and it
   // already refuses resume, undo and finalize, so its successor is not read here: a successor's
   // folder removed later (a sibling backup folder) must not block organizing this one. The
   // recovery listing, resume, undo and finalize still check that successor in full.
   const prior=await readManifest(root,id),state=await readEvents(prior,undefined,(completed,total)=>onProgress?.({phase:'verifying',step:'earlier',completed,total,bytes:0,totalBytes:0,speed:0,file:id}),false,signal);
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
  await locked(lockKey(prior.root,prior.id),async()=>{
   const state=await readEvents(prior,undefined,(completed,total)=>onProgress?.({phase:'verifying',step:'earlier',completed,total,bytes:0,totalBytes:0,speed:0,file:prior.id}),false,signal);
   if(state.superseded||state.undoComplete){log('detailed','journal','supersession',{prior:prior.id,successor:m.id,decision:'skip',reason:state.superseded?'already superseded':'already undone'});return;}if(unfinished(state)){log('detailed','journal','supersession',{prior:prior.id,successor:m.id,decision:'blocked',reason:'prior organization is unfinished'});throw finish(prior.id);}
   log('detailed','journal','supersession',{prior:prior.id,successor:m.id,decision:'superseded',reason:'prior journal is complete and fully finalized, undone or otherwise finished'});
   await checkpoint(prior,'superseded',undefined,{successor:m.id,...(prior.root!==m.root?{successorRoot:m.root}:{})});
  });
 }
}
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
/** Told after a file was moved by rename: where it was (path and reviewed identity), where it is, and its final identity.
 * Lets a cache keyed by path and stat follow the file (same bytes, so same metadata) instead of reading it again. */
export type MoveObserver=(from:string,reviewed:StatRecord,to:string,now:BigIntStats)=>void;
let moveObserver:MoveObserver|undefined;
export function setMoveObserver(observer:MoveObserver|undefined):void{moveObserver=observer;}
async function finishMove(entry:Entry,index:number,m:Manifest,state:JournalState,note:(message:string)=>void):Promise<void> {
 // The new name is made durable before the old one's removal, so a power cut leaves the file in
 // at least one folder. The original folder may already be gone when a move is resumed.
 await syncParents(entry.destination,m.root);await syncDirectory(path.dirname(entry.source)).catch(error=>{if(code(error)!=='ENOENT')throw error;});
 const handle=await fs.open(entry.destination,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 let final=undefined as BigIntStats|undefined;
 try {
  const current=await handle.stat({bigint:true});
  const remember=async(event:'renamed'|'timed',stat:BigIntStats)=>{await checkpoint(m,event,index,{stat:statRecord(stat)});final=stat;state.renamed.set(index,statRecord(stat));state.dated.set(index,new Set([...(state.dated.get(index)??[]),String(stat.mtimeNs)]));};
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
 if(final){try{moveObserver?.(entry.source,entry.stat,entry.destination,final);}catch{/* A cache hint never fails a move. */}}
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
  const target=await maybeLstat(entry.destination);
  if(await maybeLstat(entry.source))throw new Error(`Original path reappeared after it was moved: ${entry.source}`);
  if(!target||!movedIdentity(target,entry,state.dated.get(index)))throw new Error(`Moved file changed or is missing; no copy was kept: ${entry.destination}`);
  return 'moved';
 }
 let source=await maybeLstat(entry.source),target=await maybeLstat(entry.destination);
 if(state.renameIntent.has(index)){
  // Finish or redo an interrupted move from what is on disk.
  if(source&&target&&sameHardLink(source,target)){await fs.unlink(entry.source);logDeletion('organize',entry.source,'second name of a file whose move was interrupted','source and destination are two hard links of one inode (same device, inode, link count >= 2)',{destination:entry.destination});await finishMove(entry,index,m,state,note);return 'moved';}
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
  log('trace','organize','moved',{from:entry.source,to:entry.destination,method:'link+unlink',bytes:entry.size,index});
 } catch(error) {
  if(code(error)==='EEXIST')throw appeared();
  if(code(error)==='EXDEV'){await checkpoint(m,'rename-fallback',index);state.fallback.add(index);return 'copy';}
  if(!LINK_UNSUPPORTED.has(code(error)??''))throw error;
  // exFAT and FAT have no hard links: check, then rename(2) in the same breath.
  if(await maybeLstat(entry.destination))throw appeared();
  try{await fs.rename(entry.source,entry.destination);}
  catch(failure){if(code(failure)==='EXDEV'){await checkpoint(m,'rename-fallback',index);state.fallback.add(index);return 'copy';}throw failure;}
 }
 await finishMove(entry,index,m,state,note);
 return 'moved';
}
/** Per journal, for each entry whose check reads file contents: what was verified at its last clean
 * pass in this session (the files' identities and the entry's journal state). */
const verifiedPasses=new Map<string,Map<number,string>>();
async function run(m:Manifest,signal?:AbortSignal,onProgress?:(progress:Progress)=>void,options:{full?:boolean;appleDouble?:AppleDoubleCleaner}={}):Promise<ReorganizationResult> {
 // A journal written one file per event can hold tens of thousands: its first read reports how many are read.
 const state=await readEvents(m,undefined,(completed,total,name)=>onProgress?.({phase:'verifying',step:'history',completed,total,bytes:0,totalBytes:0,speed:0,file:name??m.id}),true,signal);
 if(state.halfConverted)throw new MessageError('error.oldRecords',{drive:driveName(m.root)});
 if(state.superseded)throw new Error(`Organization ${m.id} was superseded by ${state.superseded}`);
 if(state.undoComplete||state.undone.size)throw new Error(`Organization ${m.id} was undone`);
 // A recheck reads file contents again only for entries that changed since they were last verified in
 // this session (or for every entry when a full recheck is asked for); sizes and identities are always checked.
 const passKey=`${m.root}\0${m.id}\0${mountDevices.get(m)??''}`,verified=options.full?new Map<number,string>():verifiedPasses.get(passKey)??new Map<number,string>(),passed=new Map<number,string>();
 const fileKey=async(file?:string)=>{const stat=file?await maybeLstat(file):undefined;return stat?[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':'):'-';};
 /** Whether this entry's file contents must be read: true unless it is unchanged since its last verified pass. */
 const deep=async(index:number,entry:Entry,saved?:string)=>{
  const signature=[await fileKey(entry.destination),await fileKey(saved),state.finalizing.has(index),state.finalized.has(index),state.slots.get(index)?.join(','),state.renamed.has(index)].join('|');
  passed.set(index,signature);return verified.get(index)!==signature;
 };
 let completedRun=false;const proofs=new Proofs(),sidecars=options.appleDouble,result:ReorganizationResult={copied:0,skipped:0,errors:[],moved:0,retained:0,retainedBytes:0,...(sidecars?{appleDouble:sidecars.report}:{})};const undated:string[]=[];let completed=0,bytes=0;const started=performance.now(),totalBytes=m.entries.reduce((n,e)=>n+e.size,0);
 const renames=m.strategy==='rename'?{renames:true as const}:{};
 // macOS "._" files: a rename on exFAT may carry the one beside the file along or leave it behind, so both places are looked at.
 const tidyMoved=async(entry:Entry,index:number)=>{
  if(!sidecars)return;
  await sidecars.besideFile(entry.destination,m.root,stat=>movedIdentity(stat,entry,state.dated.get(index)));
  if(entry.move)await sidecars.besideGone(entry.source,m.source);
 };
 const tidyCopied=async(entry:Entry)=>{
  if(!sidecars)return;
  try{
   const placed=await maybeLstat(entry.destination);
   if(placed)await sidecars.besideFile(entry.destination,m.root,stat=>sameStat(stat,placed));
  }catch(error){sidecars.warn(entry.destination,error);}
 };
 const progress=(file:string)=>onProgress?.({phase:'copying',step:'moving',completed,total:m.entries.length,bytes,totalBytes,speed:bytes/Math.max((performance.now()-started)/1000,0.001),file,...renames});
 // Verify the whole batch before moving any source, including completed jobs.
 try {
  await roots(m);await writeSiblingPointers(m);await recordHandOffs(m,state,(completed,total,file)=>onProgress?.({phase:'verifying',step:'later',completed,total,bytes:0,totalBytes:0,speed:0,file}),signal);await supersedePriorOrganizations(m,signal,onProgress,state);
  // Moves cannot wait for a later check: confirm every file that will move, by stat
  // only, before the first one does. Any change stops the run with nothing moved.
  if(m.strategy==='rename')for(const [index,entry] of m.entries.entries()){
   checkAbort(signal);
   onProgress?.({phase:'verifying',step:'confirming',completed:index+1,total:m.entries.length,bytes:0,totalBytes:0,speed:0,file:path.basename(entry.source),renames:true});
   if(!entry.move||state.handedOff.has(index)||state.renamed.has(index)||state.renameIntent.has(index)||state.fallback.has(index)||state.finalizing.has(index)||state.slots.get(index)?.length)continue;
   await parents(entry,m);await validateOriginal(entry.source,entry,m.source,false,signal,false);
  }
  for(const [index,entry]of m.entries.entries()) {
   checkAbort(signal);
   // A later organization took this file over; it stays where that one put it.
   if(state.handedOff.has(index)){if(entry.move)result.moved++;result.skipped++;completed++;progress(path.basename(entry.source));continue;}
   if(state.finalized.has(index)){
    if(!await targetMatches(entry,m,signal,await deep(index,entry),proofs))throw new Error('Finalized destination unavailable');
    if(entry.move)result.moved++;result.skipped++;completed++;progress(path.basename(entry.source));continue;
   }
   if(m.strategy==='rename'&&entry.move&&!state.fallback.has(index)&&!state.slots.get(index)?.length&&!state.finalizing.has(index)&&await relocate(entry,index,m,state,message=>undated.push(message),signal)==='moved'){result.moved++;await tidyMoved(entry,index);completed++;progress(path.basename(entry.source));continue;}
   const saved=await savedOriginal(m,index,state);if(!saved&&!state.finalizing.has(index))await parents(entry,m);
   const source=await maybeLstat(entry.source),stash=saved?await maybeLstat(saved):undefined;
   if(state.finalizing.has(index)){
    if(entry.move&&source)throw new Error('Original path reappeared after finalization');
    const contents=await deep(index,entry,saved);
    if(saved){if(!entry.move)throw new Error('Unexpected retained original');await validateOriginal(saved,entry,scopeOf(m),true,signal,contents,proofs);}
    if(!await targetMatches(entry,m,signal,contents,proofs))throw new Error('Finalized destination unavailable; retained original was explicitly released');
    if(entry.move)result.moved++;result.skipped++;completed++;progress(path.basename(entry.source));continue;
   }
   const contents=stash&&state.complete?await deep(index,entry,saved):true;
   if(stash){if(!entry.move||source)throw new Error(`Recovery original collision: ${entry.source}`);await validateOriginal(saved!,entry,scopeOf(m),true,signal,contents,proofs);result.moved++;}
   // The original's identity now; its bytes are proven below, by a read when the copy is already there, or by the
   // copy itself, which hashes every byte it streams against the reviewed checksum.
   else {if(!source)throw new Error(`Original is unavailable; reconnect and recheck: ${entry.source}`);await validateOriginal(entry.source,entry,m.source,false,signal,false);}
   let present:boolean;try{present=await targetMatches(entry,m,signal,contents,proofs);}catch(error){if(!await preserveIncomplete(entry,index,m,stash?saved!:entry.source,state,signal))throw error;present=false;}
   if(!present&&entry.kept)throw new Error(`The copy to keep is missing; the duplicate stays where it is: ${entry.destination}`);
   if(present&&!stash)await validateOriginal(entry.source,entry,m.source,false,signal,true,proofs);
   if(!present){await copy(entry,index,m,stash?saved!:entry.source,signal,count=>{bytes+=count;progress(path.basename(entry.source));},proofs);result.copied++;}else result.skipped++;
   await tidyCopied(entry);completed++;progress(path.basename(entry.source));
  }
  // Setting aside the originals that were moved is its own step: it can take minutes on a slow drive.
  const stashing=m.entries.reduce((count,entry,index)=>count+(entry.move&&!state.finalizing.has(index)&&!state.renamed.has(index)&&!state.handedOff.has(index)?1:0),0);
  let stashed=0,stashedBytes=0;const stashedOf=m.entries.reduce((sum,entry,index)=>sum+(entry.move&&!state.finalizing.has(index)&&!state.renamed.has(index)&&!state.handedOff.has(index)?entry.size:0),0);
  const stash_=(file:string)=>onProgress?.({phase:'copying',step:'stashing',completed:stashed,total:stashing,bytes:stashedBytes,totalBytes:stashedOf,speed:0,file,renames:true});
  if(stashing)stash_('');
  for(const [index,entry]of m.entries.entries()) {
   checkAbort(signal);if(!entry.move||state.finalizing.has(index)||state.renamed.has(index)||state.handedOff.has(index))continue;await roots(m);stashed++;stashedBytes+=entry.size;stash_(path.basename(entry.source));let saved=await savedOriginal(m,index,state);
   // Unchanged since its last verified pass (decided in the loop above): sizes and identities only.
   if(saved){const contents=!passed.has(index)||verified.get(index)!==passed.get(index);await validateOriginal(saved,entry,scopeOf(m),true,signal,contents,proofs);if(await maybeLstat(entry.source))throw new Error('Original path reappeared during recovery');if(!await targetMatches(entry,m,signal,contents,proofs))throw new Error('Destination unavailable');continue;}
   await parents(entry,m);
   // What was read here, by stat: unchanged when the original is set aside, neither is read again.
   const sourceProof=await proven(entry.source,()=>validateOriginal(entry.source,entry,m.source,false,signal,true,proofs));
   const destinationProof=await proven(entry.destination,async()=>{if(!await targetMatches(entry,m,signal,true,proofs))throw new Error('Destination unavailable');});
   await syncFile(entry.destination);await syncParents(entry.destination,m.root);
   await ensureDirectory(path.join(jobFolder(m),'originals'),scopeOf(m));
   const entryDirectory=path.join(jobFolder(m),'originals',String(index));await ensureDirectory(entryDirectory,scopeOf(m));
   const slot=randomUUID();saved=originalPath(m,index,slot);await contained(saved,scopeOf(m));
   // Each attempt owns a newly created private slot. Competing processes never
   // rename into the same pathname, and an existing slot is never reused.
   await fs.mkdir(path.dirname(saved),{mode:0o700});await syncDirectory(entryDirectory);
   await checkpoint(m,'stash-intent',index,{slot});state.slots.set(index,[...(state.slots.get(index)??[]),slot]);checkAbort(signal);await roots(m);await parents(entry,m);await contained(saved,scopeOf(m));
   const destinationStat=await fs.lstat(entry.destination,{bigint:true});
   await parents(entry,m);const reread=!unchangedSince(sourceProof,await fs.lstat(entry.source,{bigint:true}))||!unchangedSince(destinationProof,destinationStat);
   await validateOriginal(entry.source,entry,m.source,false,signal,reread,proofs);if(!await targetMatches(entry,m,signal,reread,proofs)||!matches(await fs.lstat(entry.destination,{bigint:true}),statRecord(destinationStat)))throw new Error('Destination changed before retaining original');
   if(await maybeLstat(saved))throw new Error(`Recovery original collision: ${saved}`);
   // Same-filesystem rename preserves the original inode; its contents are never
   // deleted, even when the process exits immediately after this operation.
   await fs.rename(entry.source,saved);await syncDirectory(path.dirname(entry.source));await syncDirectory(path.dirname(saved));
   // Renamed by this process just after the check above: its identity (all but the change time) is the proof.
   await validateOriginal(saved,entry,scopeOf(m),true,signal,false);await checkpoint(m,'stashed',index);result.moved++;
   await sidecars?.besideGone(entry.source,m.source);
  }
  // Closing the journal, then the emptied folders: each counted, the journal last.
  const emptied=emptiable(m,state.finalized),folders=emptied.size;
  const tidy=(done:number,file:string)=>onProgress?.({phase:'copying',step:'tidying',completed:done,total:folders+1,bytes:0,totalBytes:0,speed:0,file,renames:true});
  tidy(0,'');
  await checkpoint(m,'complete');completedRun=true;
  // The organization is complete: what follows can only add warnings. The "._" files already in the folders this
  // organization touched, beside a media file or companion or left without their main file.
  if(sidecars){
   const touched=new Map<string,string>();
   for(const [index,entry] of m.entries.entries()){
    if(state.handedOff.has(index))continue;
    touched.set(path.dirname(entry.destination),m.root);
    if(entry.move)touched.set(path.dirname(entry.source),m.source);
   }
   const total=touched.size,scoped=new Map<string,string[]>();
   for(const [folder,scope] of touched)scoped.set(scope,[...(scoped.get(scope)??[]),folder]);
   let looked=0;
   try{
    for(const [scope,folders] of scoped)await sidecars.sweep(scope,folders,signal,(_done,folder)=>{looked++;onProgress?.({phase:'copying',step:'tidying',completed:looked,total,bytes:0,totalBytes:0,speed:0,file:path.basename(folder),renames:true});});
   }catch(error){if(isAbort(error))throw error;sidecars.warnFolder(m.root,error);}
  }
  // The user can keep emptied source folders; the choice is part of the signed journal.
  await removeSiblingPointers(m);
  // A journal without a cleanup scope keeps its earlier meaning: only folders already empty.
  const removed=await removeEmptiedFolders(m.source,emptied.keys(),{signal,identities:emptied,bookkeeping:!!m.cleanupScope,area:'organize',after:'organizing',onFolders:(done,_total,folder)=>tidy(done,path.basename(folder))});
  if(removed)result.foldersRemoved=removed;
  if(folders)checkAbort(signal);
  tidy(folders+1,'journal');
 }catch(error){if(isAbort(error))throw error;result.errors.push(error instanceof Error?error.message:String(error));}
 // A clean pass becomes the reference for the next recheck in this session.
 if(!result.errors.length)verifiedPasses.set(passKey,new Map([...(options.full?[]:verified),...passed]));
 if(undated.length)result.notes=[`${undated.length} moved files kept their original dates because the drive could not store their capture dates.`,...undated.slice(0,20)];
 // Originals kept in recovery storage so the organization can be undone.
 for(const [index,entry] of m.entries.entries())if(!state.finalizing.has(index)&&await savedOriginal(m,index,state).catch(()=>undefined)){result.retained++;result.retainedBytes+=entry.size;}
 if(completedRun&&!result.errors.length)await summary(m,{files:m.entries.length,completed:m.entries.length,retainedFiles:result.retained,retainedBytes:result.retainedBytes,status:'complete'});
 return result;
}
/** The header and entries lines that open a journal. */
function journalHead(m:Manifest):string {
 const header=sealedLine('organization',{id:m.id,root:m.root,rootIdentity:m.rootIdentity,source:m.source,sourceIdentity:m.sourceIdentity,...(m.strategy?{strategy:m.strategy}:{}),...(m.keepFolders?{keepFolders:m.keepFolders}:{}),...(m.libraries?{libraries:m.libraries}:{}),...(m.cleanupScope?{cleanupScope:m.cleanupScope}:{}),...(m.kind?{dupKind:m.kind}:{}),folders:pointerFolders(m)});
 const entries=sealedLine('entries',{id:m.id,entries:m.entries});
 if(Buffer.byteLength(header)>LINE_CAPS.header||Buffer.byteLength(entries)>LINE_CAPS.entries)throw new Error('This organization is too large to record');
 return `${header}\n${entries}\n`;
}
/** What a new journal records besides its entries; its id and the source's identity are added here. */
type JournalSpec=Pick<Manifest,'kind'|'root'|'rootIdentity'|'source'|'strategy'|'keepFolders'|'libraries'|'cleanupScope'>;
/** Make a new journal for `entries` in the store its library writes to: each entry's source identity and those of the
 * folders above it, the manifest checked like any read one, then its header and entries written aside, synchronized,
 * and renamed into place under the both-names rule. No destination publication or original relocation occurs until
 * this complete immutable review and the folders containing it have been synchronized. */
async function createJournal(spec:JournalSpec,entries:OrganizationEntry[],signal?:AbortSignal):Promise<Manifest>{
 checkAbort(signal);requireHostKey();await rootUnchanged(spec.root,spec.rootIdentity);await refuseOldRecords(spec.root,...spec.libraries??[]);
 const id=randomUUID(),m:Manifest={version:1,...spec,id,sourceIdentity:spec.source===spec.root?spec.rootIdentity:await identity(spec.source),entries:[]};
 for(const entry of entries){const ancestors:Record<string,string>={};for(let folder=path.dirname(entry.source);folder!==spec.source;folder=path.dirname(folder)){if(!beneath(folder,spec.source))throw new Error('Unsafe source path');ancestors[folder]=await identity(folder);}m.entries.push({...entry,stat:statRecord(entry.stat),parents:ancestors});}
 validateManifest(m,spec.root,id);
 const store=await storeFor(m.root);
 if(store.dev!==(await fs.lstat(m.root,{bigint:true})).dev)throw new Error('Recovery records and the library must remain on the same filesystem');
 const folder=await storeFolder(store,ORGANIZATIONS,m.id),journal=path.join(folder,JOURNAL);
 if(await maybeLstat(journal))throw new Error('Recovery collision');
 const head=journalHead(m),temporary=path.join(folder,`journal-${randomUUID()}.tmp`);
 await writeNewFile(temporary,head);
 if(await renameChecked(temporary,journal)!=='done')throw new Error(`Unable to create ${journal}`);
 locations.set(m,{folder,journal,scope:store.path,store,eventsFrom:Buffer.byteLength(head)});
 await roots(m);
 return m;
}
/** Organize `entries` of a reviewed plan: every file moves by rename(2) where its volume allows. `folders`: the chosen
 * source folders, the only ones emptied folders are removed from (the whole source when none were chosen). */
export async function beginOrganization(transfer:TransferPlan,entries:OrganizationEntry[],signal?:AbortSignal,onProgress?:(progress:Progress)=>void,options:{keepFolders?:boolean;libraries?:string[];folders?:string[];releaseDuplicates?:boolean;appleDouble?:AppleDoubleCleaner}={}):Promise<ReorganizationResult> {
 const libraries=options.libraries??[],scope=options.folders?.length?options.folders.map(folder=>path.resolve(transfer.source,folder)):[transfer.source];
 const manifest=await createJournal({root:transfer.root,rootIdentity:transfer.rootIdentity,source:transfer.source,strategy:'rename',...(options.keepFolders?{keepFolders:true as const}:{cleanupScope:scope}),...(libraries.length?{libraries}:{})},entries,signal);
 const result=await locked(lockKey(transfer.root,manifest.id),()=>run(manifest,signal,onProgress,{appleDouble:options.appleDouble}));
 // Release re-verifies every destination by checksum before removing a kept original.
 if(options.releaseDuplicates&&result.errors.length===0&&result.retained>0){
  try{
   const released=await finalizeOrganization(transfer.root,manifest.id,signal,step=>onProgress?.({phase:step.step==='checking'?'verifying':'copying',step:step.step,completed:step.completed,total:step.total,bytes:0,totalBytes:0,speed:0,file:step.file,renames:true}));
   result.released=released.removed;result.releasedBytes=released.bytes;
   result.retained=Math.max(0,result.retained-released.removed);result.retainedBytes=Math.max(0,result.retainedBytes-released.bytes);
  }catch(error){if(isAbort(error))throw error;result.errors.push(error instanceof Error?error.message:String(error));}
 }
 return result;
}
/** Set duplicates aside in the recovery store, with undo: each entry's source is a duplicate and its destination
 * the copy kept. Nothing is copied unless an entry has no `kept` (a companion carried next to the kept file).
 * `root` is the library; the journal lives in its recovery folder, like an organization's. */
export async function beginDuplicateRemoval(transfer:Pick<TransferPlan,'root'|'rootIdentity'>,entries:OrganizationEntry[],signal?:AbortSignal,onProgress?:(progress:Progress)=>void):Promise<{id:string;result:ReorganizationResult}> {
 const manifest=await createJournal({kind:'duplicates',root:transfer.root,rootIdentity:transfer.rootIdentity,source:transfer.root,keepFolders:true},entries,signal);
 return {id:manifest.id,result:await locked(lockKey(transfer.root,manifest.id),()=>run(manifest,signal,onProgress))};
}
/** The files (relative to `root`, with `/`) that an earlier, still live journal of this library placed or kept. Removing
 * one supersedes that journal, which ends its Undo, so Remove duplicates warns before it does. Best effort: a
 * journal that cannot be read is skipped. */
export async function placedByEarlierJournals(root:string,signal?:AbortSignal,/** Which journal it is on (1-based, of how many) and how many of its records are read. */onProgress?:(update:{journal:number;journals:number;read:number;total:number;file:string})=>void):Promise<Set<string>> {
 const placed=new Set<string>();
 let ids:string[];
 try{ids=(await journalsIn(root)).map(journal=>journal.id);}catch{return placed;}
 let at=0;
 for(const id of ids){
  checkAbort(signal);
  const journal=++at;onProgress?.({journal,journals:ids.length,read:0,total:0,file:id});
  try{
   const prior=await readManifest(root,id),state=await readEvents(prior,undefined,(read,total)=>onProgress?.({journal,journals:ids.length,read,total,file:id}),false,signal);
   if(state.superseded||state.undoComplete)continue;
   for(const entry of prior.entries)placed.add(posixRelative(root,entry.destination));
  }catch(error){if(isAbort(error))throw error;}
 }
 return placed;
}
/** Journals in the stores at or above `destination` whose library folder no longer resolves (moved, renamed or
 * deleted): listed so they are not forgotten; nothing can be checked against a folder that is not there. */
export async function orphanedJournals(destination:string):Promise<OrganizationRecovery[]>{
 const found:OrganizationRecovery[]=[];
 for(const store of await storesFor(destination).catch(()=>[] as Store[]))for(const {id,root} of await storeJournals(store)){
  if(await fs.realpath(root).then(real=>real===root,()=>false))continue;
  found.push({id,root,missingRoot:true,status:'pending',files:0,completed:0,retainedFiles:0,retainedBytes:0,finalizable:false,undoable:false,error:`The library folder of this organization was not found: ${root}`});
 }
 return found;
}
/** The journals of `root` converted only in part (the header names the earlier version's folder, the conversion never
 * finished): old records, whose kept originals may still be in that folder. Each with the identity of its journal file. */
export async function halfConvertedJournals(root:string):Promise<{path:string;dev:string;ino:string;size:string;mtimeNs:string}[]>{
 const found:{path:string;dev:string;ino:string;size:string;mtimeNs:string}[]=[];
 for(const {id,root:library,found:at} of await journalsIn(root,[]).catch(()=>[])){
  try{
   const head=await readJournalHead(at.journal,at.store.path,false);
   if(head.header.convertedFrom===undefined)continue;
   const m=await openJournal(at,library,id,false);
   if(!(await readEvents(m,undefined,undefined,false)).halfConverted)continue;
   const stat=await fs.lstat(at.journal,{bigint:true});
   found.push({path:at.journal,dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtimeNs:String(stat.mtimeNs)});
  }catch{/* A journal that cannot be read is not reported here. */}
 }
 return found;
}
/** The pointer files kept for `folder`, in every store readers consult for it; for tests and First Aid. */
export async function pointerFilesFor(folder:string):Promise<string[]>{return (await pointersIn(folder)).map(pointer=>pointer.file);}
/** Where journal `id` of library `root` keeps its records (its folder in a store); for tests and First Aid. */
export async function journalFolderFor(root:string,id:string):Promise<string>{return (await locateJob(root,id)).folder;}
/** Resume, or recheck a finished organization. */
export async function resumeOrganization(root:string,id:string,signal?:AbortSignal,onProgress?:(progress:Progress)=>void,options:{full?:boolean}={}):Promise<ReorganizationResult> {
 return locked(lockKey(root,id),async()=>run(await readManifest(root,id),signal,onProgress,options));
}
/** Listing skips media reads. A recheck reads file contents for every entry the first time in a session
 * and for a full recheck, and later only for entries changed since their last verified pass (on exFAT and
 * FAT "changed" means size or dates; finalize and undo always read contents). */
export async function getOrganizationRecovery(root:string,options:{verifyContents?:boolean;/** Also list replaced and fully undone organizations, whose recovery files can only be deleted. */includeEnded?:boolean;/** Hears how far this folder's journals are read: the share (0 to 1), entries looked at so far, and the journal or event file it is on. */onProgress?:(update:{share:number;looked:number;file:string;/** While a journal's events are read: bytes read so far and in all. */read?:number;total?:number;/** While a later organization is looked for that took this one's files over. */later?:{done:number;total:number}})=>void;/** Stops the listing between files; finished journals read so far are kept for the next listing. */signal?:AbortSignal}={}):Promise<OrganizationRecovery[]> {
 const verifyContents=options.verifyContents!==false;
 if(path.resolve(root)!==root)throw new Error('Unsafe recovery root');
 try{if(await fs.realpath(root)!==root)throw new Error('Unsafe recovery root');}catch(error){if(code(error)==='ENOENT')return[];throw error;}
 const jobs:OrganizationRecovery[]=[],unreadable:{id:string;error:string}[]=[];
 const ids=[...new Set((await journalsIn(root,unreadable)).map(journal=>journal.id))].sort();let looked=0;
 for(const {id,error} of unreadable)jobs.push({id,root,status:'pending',files:0,completed:0,retainedFiles:0,retainedBytes:0,finalizable:false,undoable:false,error});
 const report=(position:number,within:number,file:string,counts?:{read:number;total:number},later?:{done:number;total:number})=>options.onProgress?.({share:Math.min(1,(position+Math.min(1,Math.max(0,within)))/Math.max(1,ids.length)),looked,file,...(counts??{}),...(later?{later}:{})});
 const {signal}=options;
 report(0,0,'');
 for(const [position,id] of ids.entries()) {
  checkAbort(signal);
  const job:OrganizationRecovery={id,root,status:'pending',files:0,completed:0,retainedFiles:0,retainedBytes:0,finalizable:false,undoable:false};
  try{const m=await readManifest(root,id);job.files=m.entries.length;if(m.kind)job.kind=m.kind;if(m.libraries?.length)job.libraries=[...m.libraries];let all=true;const state=await readEvents(m,undefined,(read,total,name)=>report(position,.5*read/Math.max(1,total),name??id,{read,total}),true,signal);if(state.superseded||state.undoComplete){if(options.includeEnded){job.status=state.superseded?'superseded':'undone';jobs.push(job);}continue;}
   const released=state.finalizing.size>0||state.finalized.size>0;
   if(state.undone.size){job.completed=state.undone.size;job.undoable=!released;jobs.push(job);continue;}
   job.undoable=!released;let moves:Successors|undefined;
   for(const [index,entry]of m.entries.entries()) {
    looked++;checkAbort(signal);report(position,.5+.5*index/Math.max(1,m.entries.length),id);
    // A later organization took this file over (recorded, or found now and recorded on the next resume or undo).
    if(state.handedOff.has(index)||placed(state,index)&&!await maybeLstat(entry.destination)&&await findHandOff(m,index,state,moves??=await laterMoves(m,(done,total,file)=>report(position,.5,file||id,undefined,{done,total}),signal))){
     // Any kept original of it stays, but is not among those a finalize would release.
     job.completed++;continue;
    }
    if(state.renamed.has(index)){
     const target=await maybeLstat(entry.destination);
     if(await maybeLstat(entry.source)||!target||!movedIdentity(target,entry,state.dated.get(index))||(verifyContents&&await digest(entry.destination)!==entry.digest)){
      // A finished organization's file that is gone with no later organization accounting for it may be
      // the only copy: every such file is counted and the job stays pending, without stopping the listing.
      if(state.complete&&!await maybeLstat(entry.source)&&!target){job.missing=(job.missing??0)+1;all=false;continue;}
      throw new Error(`Moved file changed or is missing: ${entry.destination}`);
     }
     job.completed++;continue;
    }
    if(state.renameIntent.has(index)&&!state.fallback.has(index)&&!state.slots.get(index)?.length){all=false;continue;}
    if(state.finalized.has(index)){
     if(!await targetMatches(entry,m,undefined,verifyContents)){if(state.complete&&!await maybeLstat(entry.destination)){job.missing=(job.missing??0)+1;all=false;continue;}throw new Error('Finalized destination unavailable');}
     job.completed++;continue;
    }
    const saved=await savedOriginal(m,index,state),source=await maybeLstat(entry.source);if(!saved&&!state.finalizing.has(index))await parents(entry,m);
    if(state.finalizing.has(index)){
     if(entry.move&&source)throw new Error('Original path reappeared after finalization');
     if(saved){if(!entry.move)throw new Error('Unexpected retained original');await validateOriginal(saved,entry,scopeOf(m),true,undefined,verifyContents);}
     if(!await targetMatches(entry,m,undefined,verifyContents))throw new Error('Finalized destination unavailable');
     job.completed++;continue;
    }
    if(saved){if(source||!entry.move)throw new Error('Recovery original collision');await validateOriginal(saved,entry,scopeOf(m),true,undefined,verifyContents);job.retainedFiles!++;job.retainedBytes!+=entry.size;}
    else if(source)await validateOriginal(entry.source,entry,m.source,false,undefined,verifyContents);else throw new Error('Original unavailable');
    const valid=await targetMatches(entry,m,undefined,verifyContents);if(valid&&(!entry.move||!!saved))job.completed++;else all=false;
   }
   if(all&&state.complete)job.status='complete';
   job.finalizable=job.status==='complete'&&job.retainedFiles!>0&&!state.finalizing.size;
  }catch(error){if(isAbort(error))throw error;job.error=error instanceof Error?error.message:String(error);}
  jobs.push(job);
 }
 return jobs;
}


/** handedOff: entries a later organization took over; their kept originals stay. */
export interface OrganizationFinalization {removed:number;bytes:number;finalized:number;handedOff:number;}
/** Finalize and undo first check every entry, then change them: `completed` is the entry being
 * handled, 1-based, out of `total` journal entries. */
export interface OrganizationProgress {step:'checking'|'releasing'|'restoring'|'deleting'|'history'|'later'|'measuring';completed:number;total:number;file:string;}
/** Explicitly release verified retained duplicates; never delete ordinary source paths.
 * All finalized entries become target-based, allowing a separate explicit
 * dedupe to remove unrelocated duplicate source paths. This call never does so.
 * After release, a lost destination can no longer be restored from this journal.
 * Repeating this call completes a durable deletion intent after interruption.
 */
export async function finalizeOrganization(root:string,id:string,signal?:AbortSignal,onProgress?:(progress:OrganizationProgress)=>void):Promise<OrganizationFinalization>{
 return locked(lockKey(root,id),async()=>{
  // Every slow call inside an entry can repeat the last report, so a long entry never looks frozen.
  let last:OrganizationProgress|undefined;const report=(progress:OrganizationProgress)=>{last=progress;onProgress?.(progress);},tick=()=>{if(last)onProgress?.(last);};
  checkAbort(signal);const m=await readManifest(root,id),proofs=new Proofs(),state=await readEvents(m,undefined,(read,total,name)=>onProgress?.({step:'history',completed:read,total,file:name??id}),true,signal);
  if(state.halfConverted)throw new MessageError('error.oldRecords',{drive:driveName(m.root)});
  if(state.superseded)throw new Error(`Organization ${m.id} was superseded by ${state.superseded}`);
  if(!state.complete)throw new Error('Finish and verify the entire organization before finalizing retained originals');
  // A finalize in progress still owns its files: its pointers stay until it finishes.
  await writeSiblingPointers(m);await recordHandOffs(m,state,(completed,total,file)=>onProgress?.({step:'later',completed,total,file}),signal);
  // Check every entry before authorizing the first deletion, including entries
  // that stay at their original paths and previously finalized destinations. A file's content is read here only
  // where its stat can prove it unchanged until its release (a real change time: not FAT or exFAT), so the release
  // reuses that read. Elsewhere this pass checks stats only, and the file is read once, right before its release.
  const upFront=async(file:string)=>{const stat=await maybeLstat(file);return !!stat&&provable(stat);};
  for(const [index,entry]of m.entries.entries()){
   checkAbort(signal);report({step:'checking',completed:index+1,total:m.entries.length,file:entry.destination});
   if(state.undone.size)throw new Error('This organization was undone');
   // A later organization took this file over: its kept original, if any, is kept, not released
   // (unless an interrupted finalize had already started releasing it).
   if(state.handedOff.has(index)&&!(state.finalizing.has(index)&&!state.finalized.has(index)))continue;
   if(state.renamed.has(index)){const target=await maybeLstat(entry.destination);if(await maybeLstat(entry.source)||!target||!movedIdentity(target,entry,state.dated.get(index)))throw new Error('Moved file changed; nothing released');continue;}
   if(state.finalized.has(index)){if(!await targetMatches(entry,m,signal,await upFront(entry.destination),proofs))throw new Error('Finalized destination unavailable');tick();continue;}
   const saved=await savedOriginal(m,index,state),source=await maybeLstat(entry.source);if(!entry.move)await parents(entry,m);
   if(entry.move){
    if(source)throw new Error('Original path reappeared; retained originals preserved');
    if(saved){await validateOriginal(saved,entry,scopeOf(m),true,signal,await upFront(saved),proofs);tick();}
    else if(!state.finalizing.has(index))throw new Error('Retained original unavailable without a finalization intent');
   }else if(!state.finalizing.has(index))await validateOriginal(entry.source,entry,m.source,false,signal,await upFront(entry.source),proofs);
   if(!await targetMatches(entry,m,signal,await upFront(entry.destination),proofs))throw new Error('Destination unavailable; retained originals preserved');
   tick();
  }
  const result:OrganizationFinalization={removed:0,bytes:0,finalized:0,handedOff:0};
  for(const [index,entry]of m.entries.entries()){
   checkAbort(signal);report({step:'releasing',completed:index+1,total:m.entries.length,file:entry.destination});await roots(m);
   if(state.handedOff.has(index)&&!(state.finalizing.has(index)&&!state.finalized.has(index))){result.handedOff++;continue;}
   // A moved file has no kept duplicate to release.
   if(state.renamed.has(index))continue;
   if(state.finalized.has(index)){if(!await targetMatches(entry,m,signal,true,proofs))throw new Error('Finalized destination unavailable');result.finalized++;continue;}
   if(!entry.move)await parents(entry,m);
   if(entry.move&&await maybeLstat(entry.source))throw new Error('Original path reappeared; retained originals preserved');
   const saved=await savedOriginal(m,index,state);
   // Publish and synchronize the remaining copy before the authenticated intent.
   const destinationStat=await fs.lstat(entry.destination,{bigint:true});
   if(!await targetMatches(entry,m,signal,true,proofs))throw new Error('Destination unavailable; retained originals preserved');
   tick();await syncFile(entry.destination);await syncParents(entry.destination,m.root);tick();
   if(!matches(await fs.lstat(entry.destination,{bigint:true}),statRecord(destinationStat)))throw new Error('Destination changed while synchronizing');
   if(!entry.move){
    if(saved)throw new Error('Unexpected retained original');
    if(!state.finalizing.has(index)){await validateOriginal(entry.source,entry,m.source,false,signal,true,proofs);await checkpoint(m,'finalize-intent',index);state.finalizing.add(index);}
   }else if(saved){
    await validateOriginal(saved,entry,scopeOf(m),true,signal,true,proofs);tick();const originalStat=await fs.lstat(saved,{bigint:true});
    if(!state.finalizing.has(index)){await checkpoint(m,'finalize-intent',index);state.finalizing.add(index);}
    checkAbort(signal);await roots(m);await contained(saved,scopeOf(m));await contained(entry.destination,m.root);
    if(await maybeLstat(entry.source)||!matches(await fs.lstat(saved,{bigint:true}),statRecord(originalStat))||!matches(await fs.lstat(entry.destination,{bigint:true}),statRecord(destinationStat)))throw new Error('A verified file changed before finalization');
    await fs.unlink(saved);logDeletion('release',saved,'retained original released after the organization was finalized',`SHA-256 ${entry.digest} validated at the retained copy and at the organized file ${entry.destination}; the original path is empty; both files unchanged until removal`,{bytes:entry.size,destination:entry.destination,duplicatesJournal:m.kind==='duplicates'});tick();await syncDirectory(path.dirname(saved));result.removed++;result.bytes+=entry.size;
   }else if(!state.finalizing.has(index))throw new Error('Retained original disappeared before authorization');
   if(!state.finalized.has(index)){await checkpoint(m,'finalized',index);state.finalized.add(index);}
   tick();
   result.finalized++;
  }
  await removeSiblingPointers(m);
  await summary(m,{files:m.entries.length,completed:m.entries.length,retainedFiles:result.handedOff?undefined:0,status:'complete'});
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
 return locked(lockKey(root,id),async()=>{
  let last:OrganizationProgress|undefined;const report=(progress:OrganizationProgress)=>{last=progress;onProgress?.(progress);},tick=()=>{if(last)onProgress?.(last);};
  checkAbort(signal);const m=await readManifest(root,id),proofs=new Proofs(),state=await readEvents(m,undefined,(read,total,name)=>onProgress?.({step:'history',completed:read,total,file:name??id}),true,signal);
  if(state.halfConverted)throw new MessageError('error.oldRecords',{drive:driveName(m.root)});
  if(state.superseded)throw new Error(`Organization ${m.id} was superseded by ${state.superseded}`);
  if(state.finalizing.size||state.finalized.size)throw new Error('Kept originals were already released, so this organization cannot be undone');
  const result:OrganizationUndo={restored:0,removed:0,handedOff:0};
  if(state.undoComplete)return result;
  // Until the undo completes, the folders it restores into must be found by other organizations.
  await writeSiblingPointers(m);await recordHandOffs(m,state,(completed,total,file)=>onProgress?.({step:'later',completed,total,file}),signal);
  // A file a later organization took over stays with it: undoing that one brings it back first.
  const handedOff=async(index:number)=>{const handOff=state.handedOff.get(index);return !!handOff&&!await maybeLstat(m.entries[index]!.destination)&&!!await maybeLstat(handOff.destination);};
  const occupied=(file:string)=>new Error(`Original path is occupied; nothing was overwritten: ${file}`);
  const restore=async(from:string,to:string)=>{
   // A proof of `from` follows it to `to` when nothing but the change time (moved by the link or rename) differs.
   const moving=await fs.lstat(from,{bigint:true}),held=proofs.held(from,moving);
   await makeParent(to,m.source,m.sourceIdentity);
   try{await fs.link(from,to);const a=await fs.lstat(from,{bigint:true}),b=await fs.lstat(to,{bigint:true});if(!sameHardLink(a,b))throw occupied(to);await fs.unlink(from);}
   catch(error){
    if(code(error)==='EEXIST')throw occupied(to);
    if(!LINK_UNSUPPORTED.has(code(error)??''))throw error;
    if(await maybeLstat(to))throw occupied(to);
    await fs.rename(from,to);
   }
   await syncParents(to,m.source);await syncDirectory(path.dirname(from));
   const there=held?await maybeLstat(to):undefined;
   if(there&&there.dev===moving.dev&&there.ino===moving.ino&&there.size===moving.size&&there.mtimeNs===moving.mtimeNs&&there.birthtimeNs===moving.birthtimeNs)proofs.seed(to,there,held!);
  };
  /** Where a moved entry is now: 'back' (already at its original path), 'moved' (still at the destination), or 'none'. */
  const movedState=async(index:number,entry:Entry):Promise<'back'|'moved'|'none'|'pair'>=>{
   const source=await maybeLstat(entry.source),target=await maybeLstat(entry.destination),dated=state.dated.get(index);
   if(source&&target&&sameHardLink(source,target))return 'pair';
   if(source&&target&&source.dev===target.dev&&source.ino===target.ino&&entry.size>0)throw new Error(`Two names point at one file entry without a hard link; nothing was changed. Check the drive: ${entry.source}`);
   // The original is in place and something else appeared at the destination: nothing to undo here.
   if(source&&movedIdentity(source,entry,dated))return 'back';
   if(source&&target)throw new Error(`Both the original path and the organized path hold files; nothing was changed: ${entry.source}`);
   if(target){
    if(movedIdentity(target,entry,dated)&&(state.renamed.has(index)||await proofs.digest(entry.destination,signal)===entry.digest))return 'moved';
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
   checkAbort(signal);report({step:'checking',completed:index+1,total:m.entries.length,file:entry.destination});if(state.undone.has(index))continue;
   await contained(entry.source,m.source);await contained(entry.destination,m.root);
   if(await handedOff(index))continue;tick();
   if(moved(index)){if(await movedState(index,entry)==='none'&&state.renamed.has(index))missing.push(entry.destination);continue;}
   const saved=await savedOriginal(m,index,state);tick();
   if(saved){if(await maybeLstat(entry.source))throw occupied(entry.source);await validateOriginal(saved,entry,scopeOf(m),true,signal,true,proofs);tick();}
  }
  if(missing.length)throw new Error(`${missing.length} organized file${missing.length===1?' is':'s are'} no longer where this organization put ${missing.length===1?'it':'them'} and cannot be put back; nothing was changed: ${missing.slice(0,20).join(', ')}${missing.length>20?', …':''}`);
  for(const [step,index] of [...m.entries.keys()].reverse().entries()){
   checkAbort(signal);report({step:'restoring',completed:step+1,total:m.entries.length,file:m.entries[index]!.source});if(state.undone.has(index))continue;await roots(m);
   const entry=m.entries[index]!,handed=await handedOff(index);if(handed)result.handedOff++;
   // A moved file a later organization took over is left with it; a kept original still comes back.
   if(handed&&moved(index)){}
   else if(moved(index)){
    const where=await movedState(index,entry);
    if(where==='pair'){await fs.unlink(entry.destination);logDeletion('undo',entry.destination,'organized name removed while undoing a move','the original path and this name are two hard links of one inode',{restoredTo:entry.source});await syncParents(entry.destination,m.root);}
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
    if(saved){if(await maybeLstat(entry.source))throw occupied(entry.source);await restore(saved,entry.source);result.restored++;tick();}
    // Only a copy this organization published is removed, and only once the reviewed
    // original is verified at its own path, so the copy is never the last one.
    if(state.published.has(index)&&await maybeLstat(entry.destination)&&await maybeLstat(entry.source)){
     // Restoring a kept original moves its change time; its contents are still hashed.
     await validateOriginal(entry.source,entry,m.source,true,signal,true,proofs);tick();
     if(await targetMatches(entry,m,signal,true,proofs)){tick();await fs.unlink(entry.destination);logDeletion('undo',entry.destination,'copy this organization published, removed by Undo',`the original was restored and verified at ${entry.source} (SHA-256 ${entry.digest}) and this copy still matched the journal`,{bytes:entry.size});await syncParents(entry.destination,m.root);result.removed++;}
    }
   }
   tick();log('trace','undo','entry-undone',{index,source:entry.source,destination:entry.destination});await checkpoint(m,'undone',index);state.undone.add(index);
  }
  await checkpoint(m,'undo-complete');await removeSiblingPointers(m);
  await summary(m,{files:m.entries.length,completed:m.entries.length,retainedFiles:0,retainedBytes:0,status:'undone'});
  return result;
 });
}

/** files and bytes: everything deleting an organization's recovery files removes (its journal folder,
 * including kept originals, and its pointers in other folders). released: kept originals released
 * through finalizeOrganization first, counted in files and bytes too. */
export interface RecoveryDeletion {files:number;bytes:number;released:number;}
/** A journal folder set aside for deletion: never read as a journal, removed by residue cleanup if a
 * deletion stopped before it was gone. */
export const deletingPattern=new RegExp(`^deleting-${UUID_PATTERN}-${UUID_PATTERN}$`);
const journalFile=new RegExp(`^(?:journal\\.jsonl|journal-${UUID_PATTERN}\\.tmp|stage-[0-9a-f-]{36}\\.partial|incomplete-[0-9a-f-]{36}|originals)$`);
/** Readers at once on the journal's device: twice its stream limit (spinning disk 2, card 4, SSD 8), because small
 * reads mostly wait on the device. The main process has a 16-thread libuv pool (threadpool.ts), so they do not starve the listing beside. */
export async function journalReaderCount(folder:string):Promise<number> {
 return STREAMS[await streams.kind(folder).catch(()=>'unknown' as const)]*2;
}
/** Files and bytes under `folder`; links are counted, not followed. `onFiles` hears the running count. */
async function tally(folder:string,signal?:AbortSignal,onFiles?:(files:number,estimate:number)=>void):Promise<{files:number;bytes:number}>{
 const total={files:0,bytes:0};let estimate=0;
 const walk=async(current:string):Promise<void>=>{
  const entries=await fs.readdir(current,{withFileTypes:true});estimate+=entries.length;
  // Several at a time: a drive answers many small requests better than one after another.
  await mapPool(entries,await journalReaderCount(current),async entry=>{
   const file=path.join(current,entry.name);
   if(entry.isDirectory())await walk(file);
   else{const stat=await maybeLstat(file);if(stat){total.files++;total.bytes+=Number(stat.size);onFiles?.(total.files,Math.max(estimate,total.files));}}
  },signal);
 };
 onFiles?.(0,0);await walk(folder);
 return total;
}
/** Remove a folder and everything in it, counting the files as they go; a stop leaves what is left of it. */
export async function removeTree(folder:string,signal?:AbortSignal,onFile?:(removed:number)=>void,counter={removed:0}):Promise<void>{
 const entries=await fs.readdir(folder,{withFileTypes:true});
 await mapPool(entries,await journalReaderCount(folder),async entry=>{
  const file=path.join(folder,entry.name);
  if(entry.isDirectory())await removeTree(file,signal,onFile,counter);
  else{await fs.unlink(file).catch(error=>{if(code(error)!=='ENOENT')throw error;});onFile?.(++counter.removed);}
 },signal);
 await fs.rmdir(folder);
}
/** This journal's pointers (and their crash leftovers) in the folders it leaves them in. */
async function ownPointers(m:Manifest):Promise<{file:string;folder:string;size:number}[]>{
 const found:{file:string;folder:string;size:number}[]=[];
 for(const folder of pointerFolders(m))for(const {store,file,name} of await pointersIn(folder).catch(()=>[])){
  if(name!==`journal-${m.id}.json`&&!(pointerTemporary.test(name)&&name.replace(/^\./,'').startsWith(`journal-${m.id}-`)))continue;
  await contained(file,store.path);const stat=await maybeLstat(file);
  if(stat?.isFile())found.push({file,folder,size:Number(stat.size)});
 }
 return found;
}
async function journalFolder(m:Manifest):Promise<string>{
 const folder=jobFolder(m);await contained(folder,scopeOf(m));const stat=await fs.lstat(folder);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Unsafe recovery storage');
 return folder;
}
/** What deleting this organization's recovery files would remove: files and bytes. */
export async function measureOrganizationRecovery(root:string,id:string,signal?:AbortSignal,/** Files counted so far, and an estimate of all (the entries found so far). */onFiles?:(files:number,estimate:number)=>void):Promise<{files:number;bytes:number}>{
 const m=await openJournal(await locateJob(root,id),root,id,false);
 const size=await tally(await journalFolder(m),signal,onFiles);
 for(const pointer of await ownPointers(m)){size.files++;size.bytes+=pointer.size;}
 return size;
}
/** Only a finished (and fully finalized), replaced or fully undone organization can lose its records. */
function deletable(m:Manifest,state:JournalState):void{
 if(state.halfConverted)throw new MessageError('error.oldRecords',{drive:driveName(m.root)});
 if(!state.undoComplete&&!state.superseded&&unfinished(state))throw new Error(`Organization ${m.id} is not finished; finish or undo it before deleting its recovery files`);
}
/** Other journals that still name this one: one it replaced, or one whose files it took over. Each must
 * go first; without this journal, they could no longer be checked. Read in this journal's folder, the
 * folders it lists or leaves pointers in, its neighbours, the folders pointers here name, and the folders
 * each journal found lists. A journal that cannot be read stops the deletion: it may name this one. */
async function dependents(m:Manifest,onLater?:(done:number,total:number,file:string)=>void,signal?:AbortSignal):Promise<string[]>{
 let done=0,found=0;const names:string[]=[],folders=[...new Set([m.root,...pointerFolders(m),...await neighbourFolders(m.root)])];
 for(const {store,file} of await pointersIn(m.root).catch(()=>[])){const pointed=await siblingPointer(m.root,file,store.path).catch(()=>undefined);if(pointed&&!folders.includes(pointed))folders.push(pointed);}
 const unreadable=(id:string,folder:string,error:unknown)=>new Error(`Organization ${id} in ${folder} cannot be read, so it is not known whether it still relies on this one; nothing was deleted (${error instanceof Error?error.message:String(error)})`);
 for(let position=0;position<folders.length;position++){
  const folder=folders[position]!;
  // A folder that is itself a link can never get a notice, so it never refuses (a real folder reached through a linked parent does).
  if(folder===m.root||await fs.lstat(folder).then(stat=>!stat.isSymbolicLink(),()=>true))await refuseOldRecords(folder);
  const listed=(await journalsIn(folder)).filter(journal=>journal.id!==m.id);
  found+=listed.length;onLater?.(done,found,folder);
  for(const {id} of listed){
   checkAbort(signal);onLater?.(done++,found,id);
   // One another host signed was never written by this app.
   const other=await readManifest(folder,id).catch(error=>{if(code(error)==='ENOENT'||error instanceof Error&&error.message.startsWith('Recovery journal authentication failed'))return undefined;throw unreadable(id,folder,error);});
   if(!other)continue;
   for(const library of other.libraries??[])if(!folders.includes(library))folders.push(library);
   const state=await readEvents(other,undefined,undefined,false,signal).catch(error=>{if(isAbort(error))throw error;throw unreadable(id,folder,error);});
   const replaced=state.superseded===m.id&&(state.successorRoot??other.root)===m.root;
   const handed=!state.undoComplete&&[...state.handedOff.values()].some(handOff=>handOff.successor===m.id&&handOff.successorRoot===m.root);
   if(replaced||handed)names.push(id);
  }
 }
 return names;
}
/** Whether a file with exactly these bytes is somewhere outside this journal: where it put the file, back
 * at its original path, where a later organization moved it, or kept by the organization that replaced it. */
async function copyElsewhere(m:Manifest,state:JournalState,index:number,expected:{digest:string;size:bigint},signal?:AbortSignal,depth=0):Promise<boolean>{
 const entry=m.entries[index]!;
 const same=async(file:string|undefined,scope:string)=>{
  if(!file)return false;try{await contained(file,scope);}catch{return false;}
  const stat=await maybeLstat(file);return !!stat?.isFile()&&!stat.isSymbolicLink()&&stat.size===expected.size&&await digest(file,signal)===expected.digest;
 };
 if(await same(entry.destination,m.root)||await same(entry.source,m.source))return true;
 const handOff=state.handedOff.get(index);if(handOff&&await same(handOff.destination,handOff.successorRoot))return true;
 if(!state.superseded||depth>=16)return false;
 const next=await readManifest(state.successorRoot??m.root,state.superseded).catch(()=>undefined);if(!next)return false;
 const nextState=await readEvents(next,undefined,undefined,false).catch(()=>undefined);if(!nextState)return false;
 const at=next.entries.findIndex(item=>pathKey(item.source)===pathKey(entry.destination));if(at<0)return false;
 if(await same(await savedOriginal(next,at,nextState).catch(()=>undefined),scopeOf(next)))return true;
 return copyElsewhere(next,nextState,at,expected,signal,depth+1);
}
/** Finder's folder settings and the AppleDouble files macOS writes on exFAT: never media, never checked. */
const finderMetadata=(name:string)=>name==='.DS_Store'||name.startsWith('._');
/** Every entry in the journal folder is one the app writes there; every kept original left has a
 * byte-identical copy elsewhere. Anything else, or anything that cannot be read, stops the deletion
 * before anything is removed. */
async function checkJournalFolder(m:Manifest,state:JournalState,folder:string,signal?:AbortSignal,onProgress?:(progress:OrganizationProgress)=>void):Promise<void>{
 const unexpected=(file:string)=>new Error(`Unexpected file in recovery folder; nothing was deleted: ${file}`);
 const entries=async(directory:string)=>{const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw unexpected(directory);return (await fs.readdir(directory)).filter(name=>!finderMetadata(name));};
 for(const name of await entries(folder))if(!journalFile.test(name))throw unexpected(path.join(folder,name));
 const originals=path.join(folder,'originals'),kept:{index:number;file:string}[]=[];
 for(const index of await maybeLstat(originals)?await entries(originals):[]){
  const position=Number(index),indexFolder=path.join(originals,index);
  if(!/^\d+$/.test(index)||position>=m.entries.length)throw unexpected(indexFolder);
  for(const slot of await entries(indexFolder)){
   const slotFolder=path.join(indexFolder,slot);if(!uuid.test(slot))throw unexpected(slotFolder);
   for(const name of await entries(slotFolder)){
    // A link holds no bytes of its own, and removing the folder never follows it.
    const file=path.join(slotFolder,name),stat=await fs.lstat(file);
    if(stat.isFile())kept.push({index:position,file});else if(!stat.isSymbolicLink())throw unexpected(file);
   }
  }
 }
 for(const [position,{index,file}] of kept.entries()){
  checkAbort(signal);onProgress?.({step:'checking',completed:position+1,total:kept.length,file});
  const expected={digest:await digest(file,signal),size:(await fs.lstat(file,{bigint:true})).size};
  if(!await copyElsewhere(m,state,index,expected,signal))throw new Error(`A kept original has no checked copy elsewhere; nothing was deleted: ${file}`);
 }
}
/** Ended: fully undone, replaced, or complete with its kept originals released (a finished organization that
 * released nothing can still be undone). */
const ended=(state:JournalState)=>!state.halfConverted&&(state.undoComplete||!!state.superseded||state.complete&&state.finalizing.size>0&&state.finalizing.size===state.finalized.size&&state.undone.size===0);
/** The journals of one store, with the library each header names. */
export async function storeJournals(store:Store):Promise<{id:string;root:string}[]>{
 const organizations=path.join(store.path,ORGANIZATIONS),found:{id:string;root:string}[]=[];
 for(const id of (await readdirIfPresent(organizations)).sort()){
  if(!uuid.test(id))continue;const journal=path.join(organizations,id,JOURNAL);
  if(!(await maybeLstat(journal))?.isFile())continue;
  const root=await readJournalHead(journal,store.path,false).then(head=>head.header.root,()=>undefined);
  if(typeof root==='string')found.push({id,root});
 }
 return found;
}
/** For the store cleanup: an ended journal holding no kept original (no file under its originals), whose library
 * is still there. Returns the journals that still name it (they go first), or undefined when it is not one. */
export async function endedJournal(root:string,id:string):Promise<string[]|undefined>{
 try{
  const m=await readManifest(root,id),state=await readEvents(m,undefined,undefined,false);
  if(!ended(state))return undefined;
  if((await tally(path.join(jobFolder(m),'originals'),undefined).catch(error=>{if(code(error)==='ENOENT')return {files:0,bytes:0};throw error;})).files)return undefined;
  return await dependents(m);
 }catch{return undefined;}
}
/** Forget what this session cached for journal `id`. */
function forgetJournal(id:string):void{
 for(const key of [...finishedJournals.keys()])if(path.basename(path.dirname(key.split('\0')[0]!))===id)finishedJournals.delete(key);
 for(const key of [...verifiedPasses.keys()])if(key.split('\0')[1]===id)verifiedPasses.delete(key);
}
/** Delete an organization's recovery files: its journal folder (journal, kept originals, staging
 * leftovers) and its pointers in other folders. Organized files and other journals are never touched.
 * Refused while it is unfinished, or while another journal still names it. Kept originals of a finished
 * organization are first released by finalizeOrganization, which checks every destination by SHA-256;
 * any other kept original must have a byte-identical copy elsewhere. The folder is renamed aside in one
 * step (both names checked) before anything is removed, so a stop leaves the journal either whole or out
 * of every listing. */
export async function deleteOrganizationRecovery(root:string,id:string,signal?:AbortSignal,onProgress?:(progress:OrganizationProgress)=>void,options:{/** The store cleanup: never releases a kept original; refused if one would have to be. */automatic?:boolean}={}):Promise<RecoveryDeletion>{
 const check=async()=>{
  const m=await readManifest(root,id),state=await readEvents(m,undefined,(read,total,name)=>onProgress?.({step:'history',completed:read,total,file:name??id}),true,signal);deletable(m,state);
  const needed=await dependents(m,(done,total,file)=>onProgress?.({step:'later',completed:done,total,file}),signal);
  if(needed.length)throw new Error(`Organization ${needed.join(', ')} still relies on this organization's records; delete ${needed.length===1?'that one':'those'} first`);
  return {m,state};
 };
 const first=await locked(lockKey(root,id),check);
 const result:RecoveryDeletion={files:0,bytes:0,released:0};
 const releasable=!first.state.superseded&&!first.state.undoComplete&&first.m.entries.some((_,index)=>!first.state.finalizing.has(index)&&!first.state.handedOff.has(index)&&!!first.state.slots.get(index)?.length);
 if(releasable&&options.automatic)throw new Error(`Organization ${id} still keeps originals; it is not deleted automatically`);
 if(releasable){
  const released=await finalizeOrganization(root,id,signal,onProgress);
  result.released=released.removed;result.files+=released.removed;result.bytes+=released.bytes;
 }
 return locked(lockKey(root,id),async()=>{
  checkAbort(signal);const {m,state}=await check(),folder=await journalFolder(m);
  await checkJournalFolder(m,state,folder,signal,onProgress);
  const size=await tally(folder,signal,(files,estimate)=>onProgress?.({step:'measuring',completed:files,total:estimate,file:folder})),pointers=await ownPointers(m);
  checkAbort(signal);
  const parent=path.dirname(folder),aside=path.join(parent,`deleting-${id}-${randomUUID()}`);await contained(aside,scopeOf(m));
  if(await renameChecked(folder,aside)!=='done')throw new Error(`Unable to set ${folder} aside`);
  forgetJournal(id);
  onProgress?.({step:'deleting',completed:0,total:size.files,file:folder});
  // File by file, so the count moves; a stop leaves the folder set aside, which the store cleanup removes.
  await removeTree(aside,signal,removed=>onProgress?.({step:'deleting',completed:removed,total:size.files,file:folder}));
  logDeletion('recovery',folder,options.automatic?'ended organization records deleted by the automatic cleanup':'recovery files deleted at the user\'s request (Delete recovery files)',`journal ${id} checked: finished, finalized or undone, no kept original without a checked copy elsewhere, no other journal naming it; ${size.files} files, ${size.bytes} bytes set aside under a deleting- name (both names checked) before removal`,{files:size.files,bytes:size.bytes});
  await syncDirectory(parent);
  result.files+=size.files;result.bytes+=size.bytes;
  for(const pointer of pointers){
   try{await fs.unlink(pointer.file);logDeletion('recovery',pointer.file,'sibling pointer of the deleted recovery journal',`pointer belongs to journal ${id}`,{bytes:pointer.size});await syncDirectory(path.dirname(pointer.file));result.files++;result.bytes+=pointer.size;}catch{/* Left as an inert pointer; the store cleanup removes it. */}
   await fs.rmdir(path.dirname(pointer.file)).then(()=>{logDeletion('recovery',path.dirname(pointer.file),'pointer folder emptied by removing its last pointer','empty (non-recursive removal)');return syncDirectory(path.dirname(path.dirname(pointer.file)));},()=>{});
  }
  onProgress?.({step:'deleting',completed:size.files,total:size.files,file:folder});
  return result;
 });
}
