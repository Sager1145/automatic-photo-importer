import * as fs from 'node:fs/promises';
import {constants,type BigIntStats} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {PlanEntry,TransferPlan} from '../shared';
import {authenticateImportRecord} from './recovery';
import {MessageError} from '../messages';
import {appendLines,holdLog,LINE_CAPS,maybeLstat,openRegular,openV5,readLines,sealedLine,storeFolder,storeFor,storesFor,storeUnchanged,type Store} from './app-store';
import {checkAbort,code,contained,identity,regularHandle,rootUnchanged,sameBirth,sameStat} from './paths';

type Kind='stage'|'publication';
interface Snapshot {dev:string;ino:string;size:string;mtime:string;ctime:string;}
interface RecordData {kind:Kind;file:string;source:string;destination:string;sha256:string;sourceStat:Snapshot;root:string;rootIdentity:string;sourceRoot:string;sourceIdentity:string;parentIdentity:string;fileIdentity:string;}
/** An open receipt in a store's receipt log: what it says and where it is. */
export interface Receipt {rid:string;store:Store;record:RecordData;}
export interface OwnedPartial extends Receipt {file:string;stat:BigIntStats;/** A receipt written before its file was created: no file was there. */absent?:boolean;}
/** The identity recorded in a receipt written before its file exists. */
const CREATING='creating';
/** Records v5: receipts are sealed lines in the store's receipt log, Imports/receipts-<n>.jsonl, a new segment once
 * the last reaches 8 MiB. A receipt is open from its `open` line until a `close` line names its rid. Staged copies
 * are Imports/Staging/<uuid>.partial, on the destination's volume. */
export const IMPORTS='Imports',STAGING='Staging',SEGMENT_BYTES=8*1024*1024;
export const segmentPattern=/^receipts-(\d{6})\.jsonl$/;
export const stagePattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.partial$/;
const ridPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** One store's open receipts, read once per plan or execution: every segment, in order. A cached receipt never
 * grants ownership; every candidate is checked again against the disk before anything is written. */
interface ReceiptSet {store:Store;open:Map<string,RecordData>;}
export type RecoveryIndex=Map<string,Promise<ReceiptSet>>;
const recordKey=(record:Pick<RecordData,'kind'|'source'|'destination'|'sha256'>)=>JSON.stringify([record.kind,record.source,record.destination,record.sha256]);
const snapshot=(s:BigIntStats):Snapshot=>({dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs)});
const sourceMatches=(s:BigIntStats,r:Snapshot)=>JSON.stringify(snapshot(s))===JSON.stringify(r);
const fileIdentity=(s:BigIntStats)=>`${s.dev}:${s.ino}:${s.birthtimeNs}`;
/** exFAT names a file without a start cluster by a temporary (negative) inode, replaced when data
 * first reaches the disk or the volume is mounted again: such a receipt binds by device and birth time. */
const binds=(s:BigIntStats,recorded:string)=>{
 if(recorded===CREATING)return s.size===0n&&s.nlink===1n;
 const [dev,ino,birth,...extra]=recorded.split(':');
 if(!ino||!birth||extra.length||String(s.dev)!==dev)return false;
 let expected:bigint;try{expected=BigInt(birth);}catch{return false;}
 // A whole-second birth time recorded after the date helper matches within that second (exFAT re-reads the stored 10 ms value).
 return sameBirth(expected,s.birthtimeNs)&&(String(s.ino)===ino||ino.startsWith('-'));
};
/** A device number names a mount, not a disk: after a re-attach the recorded dev is read as the
 * current one while the recorded root/source folder is still the same inode at the same path. */
const sourceRebased=new WeakSet<RecordData>();
export async function rebaseMount<T extends RecordData>(record:T):Promise<T>{
 const swap=(value:string,dev:string)=>value.replace(/^\d+:/,dev+':');
 const out:T={...record,sourceStat:record.sourceStat&&{...record.sourceStat}};
 const root=await fs.lstat(record.root,{bigint:true}).catch(()=>undefined);
 if(root?.isDirectory()&&String(record.rootIdentity).split(':')[1]===String(root.ino)){const dev=String(root.dev);out.rootIdentity=swap(out.rootIdentity,dev);out.parentIdentity=swap(out.parentIdentity,dev);out.fileIdentity=swap(out.fileIdentity,dev);}
 const source=typeof record.sourceRoot==='string'?await fs.lstat(record.sourceRoot,{bigint:true}).catch(()=>undefined):undefined;
 if(source?.isDirectory()&&String(record.sourceIdentity).split(':')[1]===String(source.ino)){const dev=String(source.dev);if(String(record.sourceIdentity).split(':')[0]!==dev)sourceRebased.add(out);out.sourceIdentity=swap(out.sourceIdentity,dev);if(out.sourceStat)out.sourceStat.dev=dev;}
 return out;
}

// ---- The receipt log ----
const openLine=(rid:string,record:RecordData)=>{const {kind,...rest}=record;return sealedLine('receipt',{op:'open',rid,type:kind,...rest});};
const closeLine=(rid:string)=>sealedLine('receipt',{op:'close',rid});
/** A receipt line's record: undefined for a torn line (not JSON) or one that does not verify (it grants nothing). */
export function parseReceiptLine(text:string):{op:'open';rid:string;record:RecordData}|{op:'close';rid:string}|{op:'bad'}|undefined{
 const line=text.trim();if(!line)return undefined;
 let value:unknown;try{value=JSON.parse(line);}catch{return undefined;}
 let opened:Record<string,unknown>;try{opened=openV5('receipt',value);}catch{return {op:'bad'};}
 if(typeof opened.rid!=='string'||!ridPattern.test(opened.rid))return {op:'bad'};
 if(opened.op==='close')return {op:'close',rid:opened.rid};
 const {v:_v,kind:_k,op,rid,type,...rest}=opened;
 if(op!=='open'||(type!=='stage'&&type!=='publication'))return {op:'bad'};
 return {op:'open',rid:rid as string,record:{kind:type,...rest} as unknown as RecordData};
}
/** The store's receipt segments, oldest first. */
export async function receiptSegments(store:Store):Promise<string[]>{
 const folder=path.join(store.path,IMPORTS);
 return (await fs.readdir(folder).catch(error=>{if(code(error)==='ENOENT')return [] as string[];throw error;})).filter(name=>segmentPattern.test(name)).sort().map(name=>path.join(folder,name));
}
/** Stream every line of one segment. */
export async function readSegment(file:string,onLine:(line:ReturnType<typeof parseReceiptLine>)=>void,signal?:AbortSignal):Promise<void>{
 const handle=await openRegular(file);
 try{await readLines(handle,file,0,()=>LINE_CAPS.receipt,text=>onLine(parseReceiptLine(text)),{onTail:text=>onLine(parseReceiptLine(text)),signal});}
 finally{await handle.close();}
}
/** Every open receipt of the store: the union of its segments, read in order. */
export async function openReceipts(store:Store,signal?:AbortSignal):Promise<Map<string,RecordData>>{
 const open=new Map<string,RecordData>();
 for(const file of await receiptSegments(store))await readSegment(file,line=>{if(line?.op==='open')open.set(line.rid,line.record);else if(line?.op==='close')open.delete(line.rid);},signal);
 return open;
}
/** The segment appends go to: the last one, or a new one once it holds 8 MiB. */
export async function activeSegment(store:Store):Promise<string>{
 const folder=await storeFolder(store,IMPORTS),segments=await receiptSegments(store),last=segments.at(-1);
 if(last){const stat=await maybeLstat(last);if(!stat||stat.size<BigInt(SEGMENT_BYTES))return last;}
 const next=last?Number(path.basename(last).match(segmentPattern)![1])+1:1;
 return path.join(folder,`receipts-${String(next).padStart(6,'0')}.jsonl`);
}
async function appendReceipts(store:Store,lines:string[]):Promise<void>{
 const segment=await activeSegment(store);
 await appendLines(segment,lines,async()=>{await storeUnchanged(store);await contained(segment,store.path);});
}
async function receiptSet(store:Store,index:RecoveryIndex):Promise<ReceiptSet>{
 let set=index.get(store.path);
 if(!set){set=openReceipts(store).then(open=>({store,open}));index.set(store.path,set);set.catch(()=>{if(index.get(store.path)===set)index.delete(store.path);});}
 return set;
}
/** The receipt sets of every store readers consult for `root`. */
async function receiptSets(root:string,index:RecoveryIndex):Promise<ReceiptSet[]>{
 const sets:ReceiptSet[]=[];
 for(const store of await storesFor(root).catch(error=>{if(code(error)==='ENOENT')return [] as Store[];throw error;}))sets.push(await receiptSet(store,index).catch(()=>({store,open:new Map()})));
 return sets;
}
/** The staging folder of the store `root` writes to, made if needed. Staged copies are linked or copied into the
 * destination, so it must be on the destination's volume. */
export async function stagingFolder(root:string,destinationFolder:string):Promise<{store:Store;folder:string}>{
 const store=await storeFor(root),folder=await storeFolder(store,IMPORTS,STAGING);
 const [here,there]=await Promise.all([fs.lstat(folder,{bigint:true}),fs.lstat(destinationFolder,{bigint:true})]);
 if(here.dev!==there.dev)throw new Error(`Staging folder is not on the destination's volume: ${folder}`);
 return {store,folder};
}

/** Record exclusive creation durably before the first byte is written. */
export async function recordPartial(kind:Kind,file:string,stat:BigIntStats,entry:PlanEntry,transfer:TransferPlan,index:RecoveryIndex):Promise<OwnedPartial> {
 return {file,stat,...await writeReceipt(kind,file,fileIdentity(stat),entry,transfer,index)};
}
/** Record, before a name is created, that this app is about to create it exclusively: a crash right
 * after leaves an empty file the receipt owns, which the next import resumes or replaces in place. */
export function recordCreation(file:string,entry:PlanEntry,transfer:TransferPlan,index:RecoveryIndex):Promise<Receipt> {
 return writeReceipt('publication',file,CREATING,entry,transfer,index);
}
async function writeReceipt(kind:Kind,file:string,fileId:string,entry:PlanEntry,transfer:TransferPlan,index:RecoveryIndex):Promise<Receipt> {
 await rootUnchanged(transfer.root,transfer.rootIdentity);
 const store=await storeFor(transfer.root);
 await contained(file,kind==='stage'?store.path:transfer.root);await contained(entry.source,transfer.source);
 const sourceStat=await fs.lstat(entry.source,{bigint:true});
 if(!sourceStat.isFile()||sourceStat.size!==BigInt(entry.size))throw new MessageError('error.sourceChanged',{path:entry.source});
 const record:RecordData={kind,file,source:entry.source,destination:entry.destination,sha256:entry.digest??'',sourceStat:snapshot(sourceStat),root:transfer.root,rootIdentity:transfer.rootIdentity,sourceRoot:transfer.source,sourceIdentity:await identity(transfer.source),parentIdentity:await identity(path.dirname(file)),fileIdentity:fileId};
 const rid=randomUUID(),line=openLine(rid,record);
 if(Buffer.byteLength(line)>LINE_CAPS.receipt)throw new Error('Import receipt is too large');
 await appendReceipts(store,[line]);
 (await receiptSet(store,index)).open.set(rid,record);
 return {rid,store,record};
}

async function prefixMatches(file:string,source:string,length:number,signal?:AbortSignal):Promise<boolean>{
 const partial=await regularHandle(file),input=await regularHandle(source),a=Buffer.allocUnsafe(1024*1024),b=Buffer.allocUnsafe(a.length);
 try {for(let position=0;position<length;){checkAbort(signal);const size=Math.min(a.length,length-position);let left=0,right=0;
  while(left<size){const read=await partial.read(a,left,size-left,position+left);if(!read.bytesRead)return false;left+=read.bytesRead;}
  while(right<size){const read=await input.read(b,right,size-right,position+right);if(!read.bytesRead)return false;right+=read.bytesRead;}
  if(!a.subarray(0,size).equals(b.subarray(0,size)))return false;position+=size;
 }return true;}finally{await partial.close();await input.close();}
}
/** Where a receipt's file must be to be the app's: a staged copy in its store's staging folder, a publication at its destination inside the library. */
const ownedPlace=(record:RecordData,store:Store)=>record.kind==='stage'?path.dirname(record.file)===path.join(store.path,IMPORTS,STAGING)&&stagePattern.test(path.basename(record.file)):record.file===record.destination;
const scopeOf=(record:RecordData,store:Store)=>record.kind==='stage'?store.path:record.root;

/** Unknown, unsigned, replaced or non-prefix data is left untouched. */
export async function findPartial(kind:Kind,entry:PlanEntry,root:string,index:RecoveryIndex,signal?:AbortSignal):Promise<OwnedPartial|undefined>{
 // A stage partial is bound to its source by stat identity and a byte-prefix check, and the whole stream is
 // hashed again, so a receipt written before the checksum was known still identifies it. Publication receipts match exactly.
 const stageMatch=(record:RecordData)=>record.sha256===''||entry.digest===undefined||record.sha256===entry.digest;
 const key=recordKey({kind,source:entry.source,destination:entry.destination,sha256:entry.digest??''});
 for(const set of await receiptSets(root,index)){
  const candidates=[...set.open].filter(([,record])=>record.kind===kind&&(kind==='stage'?record.source===entry.source&&record.destination===entry.destination&&stageMatch(record):recordKey(record)===key)).sort(([a],[b])=>a<b?-1:1);
  for(const [rid,raw] of candidates){
   checkAbort(signal);
   try {
    const record=await rebaseMount(raw);
    if(record.root!==root||!record.sourceStat||typeof record.file!=='string'||!ownedPlace(record,set.store))continue;
    if(kind==='publication'&&record.file!==entry.destination)continue;
    await rootUnchanged(root,record.rootIdentity);await rootUnchanged(record.sourceRoot,record.sourceIdentity);await contained(entry.source,record.sourceRoot);
    if(kind==='stage')await storeUnchanged(set.store);
    await contained(record.file,scopeOf(record,set.store));
    if(await identity(path.dirname(record.file))!==record.parentIdentity)continue;
    const source=await fs.lstat(entry.source,{bigint:true});
    if(kind==='publication'&&record.fileIdentity===CREATING&&!await maybeLstat(record.file)){
     if(!sourceMatches(source,record.sourceStat))continue;
     return {rid,store:set.store,record,file:record.file,stat:source,absent:true};
    }
    const stat=await fs.lstat(record.file,{bigint:true});
    if(!sourceMatches(source,record.sourceStat)||!stat.isFile()||stat.nlink!==1n||!binds(stat,record.fileIdentity)||stat.size>BigInt(entry.size))continue;
    if(!await prefixMatches(record.file,entry.source,Number(stat.size),signal))continue;
    if(!sameStat(stat,await fs.lstat(record.file,{bigint:true}))||!sameStat(source,await fs.lstat(entry.source,{bigint:true})))continue;
    return {rid,store:set.store,record,file:record.file,stat};
   }catch(error){if((error as Error)?.name==='AbortError')throw error;/* Untrusted/unavailable records grant no overwrite permission. */}
  }
 }
 return undefined;
}

/** Open without truncation, then verify the descriptor and pathname again. */
export async function openPartial(partial:OwnedPartial,root:string){
 await contained(partial.file,scopeOf(partial.record,partial.store));await rootUnchanged(root,partial.record.rootIdentity);await rootUnchanged(partial.record.sourceRoot,partial.record.sourceIdentity);
 if(partial.record.kind==='stage')await storeUnchanged(partial.store);
 if(await identity(path.dirname(partial.file))!==partial.record.parentIdentity||!sourceMatches(await fs.lstat(partial.record.source,{bigint:true}),partial.record.sourceStat))throw new Error('Incomplete copy identity changed; scan again');
 const output=await fs.open(partial.file,constants.O_RDWR|(constants.O_NOFOLLOW??0));
 try{if(!sameStat(partial.stat,await output.stat({bigint:true}))||!sameStat(partial.stat,await fs.lstat(partial.file,{bigint:true})))throw new Error('Incomplete copy changed before resuming');return output;}catch(error){await output.close();throw error;}
}
/** Once a destination is complete and verified, every authenticated publication receipt for it is
 * moot: the one written before its name was created, and an older one a kill left behind between
 * writing a newer receipt and closing it. Closed together, in one append. */
export async function releaseCreations(entry:PlanEntry,root:string,index:RecoveryIndex):Promise<void>{
 const key=recordKey({kind:'publication',source:entry.source,destination:entry.destination,sha256:entry.digest??''});
 for(const set of await receiptSets(root,index)){
  const rids=[...set.open].filter(([,record])=>recordKey(record)===key&&record.file===entry.destination&&record.root===root).map(([rid])=>rid);
  if(!rids.length)continue;
  try{await appendReceipts(set.store,rids.map(closeLine));for(const rid of rids)set.open.delete(rid);}catch{/* Left open: the store cleanup closes it once the file is checked. */}
 }
}
/** Close a receipt: its file is gone, done with, or no longer the app's to continue. `sync` is kept for callers;
 * every close is durable before this returns. */
export async function clearPartialRecord(partial:Receipt,_root:string,index:RecoveryIndex,_sync=true):Promise<void>{
 await appendReceipts(partial.store,[closeLine(partial.rid)]);
 (await receiptSet(partial.store,index)).open.delete(partial.rid);
}
/** Close receipts by rid in one append (the store cleanup, the converter). */
export async function closeReceipts(store:Store,rids:string[]):Promise<void>{if(rids.length)await appendReceipts(store,rids.map(closeLine));}
/** Write an open receipt for an existing record (the converter: an earlier version's receipt moved into the log). */
export async function openReceiptFor(store:Store,record:RecordData):Promise<string>{
 const rid=randomUUID(),line=openLine(rid,record);if(Buffer.byteLength(line)>LINE_CAPS.receipt)throw new Error('Import receipt is too large');
 await appendReceipts(store,[line]);return rid;
}

/** What an open receipt's file is now: present, bound by it, owned (where the app puts such files), whether a re-import
 * of its unchanged source could continue it (resumable), whether its source card is present and the source gone or
 * changed (stale; a card not connected proves nothing, nor does one whose device number had to be rewritten), and,
 * for a staged copy, whether it holds every byte (complete). */
export async function assessReceipt(store:Store,raw:RecordData):Promise<{kind:Kind;file:string;present:boolean;bound:boolean;owned:boolean;resumable:boolean;stale:boolean;complete:boolean;stat?:BigIntStats}>{
 const record=await rebaseMount(raw);
 const owned=typeof record.file==='string'&&ownedPlace(record,store)&&await contained(record.file,scopeOf(record,store)).then(()=>true,()=>false);
 const stat=owned?await maybeLstat(record.file):undefined;
 const bound=!!stat?.isFile()&&binds(stat,record.fileIdentity);
 const cardPresent=await identity(record.sourceRoot).then(found=>found===record.sourceIdentity,()=>false);
 const sourceNow=cardPresent?await fs.lstat(record.source,{bigint:true}).catch(()=>undefined):undefined;
 const resumable=bound&&record.kind==='stage'&&!!record.sourceStat&&(!cardPresent||!!sourceNow?.isFile()&&sourceMatches(sourceNow,record.sourceStat));
 const stale=record.kind==='stage'&&!!record.sourceStat&&cardPresent&&!sourceRebased.has(record)&&(!sourceNow?.isFile()||String(sourceNow.size)!==record.sourceStat.size||String(sourceNow.mtimeNs)!==record.sourceStat.mtime);
 const complete=!!stat&&!!record.sourceStat&&String(stat.size)===record.sourceStat.size;
 return {kind:record.kind,file:record.file,present:!!stat,bound,owned,resumable,stale,complete,...(stat?{stat}:{})};
}
/** For the store cleanup: whether a segment can go. Only the oldest segment, not the one appends go to, every receipt
 * it opens closed somewhere, none it closes opened in a later segment (that close is what keeps it closed), and no
 * line that is JSON but fails its seal (an interrupted write's torn line is fine). A close of a receipt whose open
 * line is gone with an older segment closes nothing any more. Read again and removed while no append to it can start. */
export async function removeSegmentIfDone(store:Store,file:string,signal?:AbortSignal):Promise<boolean>{
 const segments=await receiptSegments(store);
 if(segments[0]!==file||segments.length<2)return false;
 return holdLog(file,async()=>{
  const opened=new Set<string>(),closedHere=new Set<string>();let bad=false;
  await readSegment(file,line=>{if(line?.op==='bad')bad=true;else if(line?.op==='open')opened.add(line.rid);else if(line?.op==='close')closedHere.add(line.rid);},signal);
  if(bad)return false;
  const later=new Set<string>();
  for(const segment of (await receiptSegments(store)).filter(item=>item!==file))await readSegment(segment,line=>{if(line?.op==='open')later.add(line.rid);},signal);
  if([...closedHere].some(rid=>!opened.has(rid)&&later.has(rid)))return false;
  const stillOpen=await openReceipts(store,signal);
  if([...opened].some(rid=>stillOpen.has(rid)))return false;
  const before=await fs.lstat(file,{bigint:true});
  if((await receiptSegments(store))[0]!==file)return false;
  const now=await fs.lstat(file,{bigint:true});if(!sameStat(before,now))return false;
  await contained(file,store.path);await fs.unlink(file);
  return true;
 });
}

// ---- The earlier version's per-file receipts: read by the converter, and by Clean up for what it leaves ----
interface LegacyRecord extends RecordData {version:1;}
const legacyRecordPattern=/^(?:\.import|photo-importer)-(?:stage|intent)-[a-f0-9-]+\.json$/;
export const isLegacyReceiptName=(name:string)=>legacyRecordPattern.test(name);
export async function readLegacyReceipt(journal:string,root:string):Promise<{record:LegacyRecord;journalStat:BigIntStats}>{
 await contained(journal,root);const handle=await regularHandle(journal);
 try {const journalStat=await handle.stat({bigint:true});if(journalStat.size>32768n)throw new Error('Import receipt is too large');
  const record=authenticateImportRecord(JSON.parse(await handle.readFile('utf8'))) as unknown as LegacyRecord;
  if(!sameStat(journalStat,await handle.stat({bigint:true})))throw new Error('Import receipt changed');return {record,journalStat};
 }finally{await handle.close();}
}
/** An earlier version's receipt, authenticated with this host's key (it throws otherwise): whether its file is still
 * there and bound, and for a stage, whether that copy could continue (resumable), is dead (stale) or holds every byte
 * (complete). owned: it names a file in its own folder. */
export async function leftoverReceipt(journal:string,root:string):Promise<{kind:Kind;file?:string;present:boolean;bound:boolean;resumable:boolean;owned:boolean;stale:boolean;complete:boolean;record:LegacyRecord;journalStat:BigIntStats}>{
 const read=await readLegacyReceipt(journal,root),record=await rebaseMount(read.record);
 const file=typeof record.file==='string'&&path.dirname(record.file)===path.dirname(journal)?record.file:undefined;
 const stat=file?await fs.lstat(file,{bigint:true}).catch(()=>undefined):undefined;
 const bound=!!stat?.isFile()&&binds(stat,record.fileIdentity);
 const cardPresent=await identity(record.sourceRoot).then(found=>found===record.sourceIdentity,()=>false);
 const resumable=bound&&record.kind==='stage'&&!!record.sourceStat&&(!cardPresent||await fs.lstat(record.source,{bigint:true}).then(source=>source.isFile()&&sourceMatches(source,record.sourceStat),()=>false));
 const stale=record.kind==='stage'&&!!record.sourceStat&&cardPresent&&!sourceRebased.has(record)&&await fs.lstat(record.source,{bigint:true}).then(source=>!source.isFile()||String(source.size)!==record.sourceStat.size||String(source.mtimeNs)!==record.sourceStat.mtime,()=>true);
 const complete=!!stat&&!!record.sourceStat&&String(stat.size)===record.sourceStat.size;
 return {kind:record.kind,file,present:!!stat,bound,resumable,owned:!!file,stale,complete,record:read.record,journalStat:read.journalStat};
}
