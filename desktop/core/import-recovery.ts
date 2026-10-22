import * as fs from 'node:fs/promises';
import {constants,type BigIntStats} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {PlanEntry,TransferPlan} from '../shared';
import {authenticateImportRecord,sealImportRecord} from './recovery';
import {MessageError} from '../messages';
import {checkAbort,code,contained,identity,regularHandle,rootUnchanged,sameStat,syncDirectory,syncParents} from './paths';

type Kind='stage'|'publication';
interface Snapshot {dev:string;ino:string;size:string;mtime:string;ctime:string;}
interface RecordData {version:1;kind:Kind;file:string;source:string;destination:string;sha256:string;sourceStat:Snapshot;root:string;rootIdentity:string;sourceRoot:string;sourceIdentity:string;parentIdentity:string;fileIdentity:string;}
export interface OwnedPartial {file:string;stat:BigIntStats;journal:string;journalStat:BigIntStats;record:RecordData;}
// Scoped to one plan/execution: directory enumeration is linear even for a
// camera folder with thousands of files. A cached name never grants ownership;
// every candidate is freshly authenticated, opened and checked before writing.
type FolderReceipts=Map<string,Map<string,RecordData>>;
export type RecoveryIndex=Map<string,Promise<FolderReceipts>>;
const recordKey=(record:Pick<RecordData,'kind'|'source'|'destination'|'sha256'>)=>JSON.stringify([record.kind,record.source,record.destination,record.sha256]);
function remember(records:FolderReceipts,name:string,record:RecordData):void {const key=recordKey(record),matches=records.get(key)??new Map<string,RecordData>();matches.set(name,record);records.set(key,matches);}
async function readRecord(journal:string,root:string):Promise<{record:RecordData;journalStat:BigIntStats}>{
 await contained(journal,root);const handle=await regularHandle(journal);
 try {const journalStat=await handle.stat({bigint:true});if(journalStat.size>32768n)throw new Error('Import receipt is too large');
  const record=authenticateImportRecord(JSON.parse(await handle.readFile('utf8'))) as unknown as RecordData;
  if(!sameStat(journalStat,await handle.stat({bigint:true})))throw new Error('Import receipt changed');return {record,journalStat};
 }finally{await handle.close();}
}
async function receiptNames(folder:string,root:string,index:RecoveryIndex):Promise<FolderReceipts>{
 let listing=index.get(folder);if(!listing){listing=(async()=>{const records:FolderReceipts=new Map();let names:string[];
  try{names=await fs.readdir(folder);}catch(error){if(code(error)==='ENOENT')return records;throw error;}
  for(const name of names.filter(name=>recordPattern.test(name))){try{const {record}=await readRecord(path.join(folder,name),root);remember(records,name,record);}catch{/* Unknown records grant no ownership. */}}
  return records;
 })();index.set(folder,listing);}return listing;
}
const snapshot=(s:BigIntStats):Snapshot=>({dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs)});
const sourceMatches=(s:BigIntStats,r:Snapshot)=>JSON.stringify(snapshot(s))===JSON.stringify(r);
const fileIdentity=(s:BigIntStats)=>`${s.dev}:${s.ino}:${s.birthtimeNs}`;
const recordPattern=/^(?:\.import|photo-importer)-(?:stage|intent)-[a-f0-9-]+\.json$/;

/** A leftover receipt, authenticated with this host's key (it throws otherwise): whether its file
 * is still there, whether the receipt still binds it, and for a stage, whether that copy could
 * continue from its unchanged source (or a card not connected now). */
export async function leftoverReceipt(journal:string,root:string):Promise<{kind:Kind;file?:string;present:boolean;bound:boolean;resumable:boolean}>{
 const {record}=await readRecord(journal,root);
 const file=typeof record.file==='string'&&path.dirname(record.file)===path.dirname(journal)?record.file:undefined;
 const stat=file?await fs.lstat(file,{bigint:true}).catch(()=>undefined):undefined;
 const bound=!!stat?.isFile()&&fileIdentity(stat)===record.fileIdentity;
 // A card that is not connected (its folder missing or another volume there) may come back
 // unchanged; only the same card holding a changed or removed file ends the copy's use.
 const cardPresent=await identity(record.sourceRoot).then(found=>found===record.sourceIdentity,()=>false);
 const resumable=bound&&record.kind==='stage'&&!!record.sourceStat&&(!cardPresent||await fs.lstat(record.source,{bigint:true}).then(source=>source.isFile()&&sourceMatches(source,record.sourceStat),()=>false));
 return {kind:record.kind,file,present:!!stat,bound,resumable};
}

/** Record exclusive creation durably before the first byte is written. */
export async function recordPartial(kind:Kind,file:string,stat:BigIntStats,entry:PlanEntry,transfer:TransferPlan,index:RecoveryIndex):Promise<OwnedPartial> {
 await rootUnchanged(transfer.root,transfer.rootIdentity);await contained(file,transfer.root);await contained(entry.source,transfer.source);
 const sourceStat=await fs.lstat(entry.source,{bigint:true});
 if(!sourceStat.isFile()||sourceStat.size!==BigInt(entry.size))throw new MessageError('error.sourceChanged',{path:entry.source});
 const record:RecordData={version:1,kind,file,source:entry.source,destination:entry.destination,sha256:entry.digest??'',sourceStat:snapshot(sourceStat),root:transfer.root,rootIdentity:transfer.rootIdentity,sourceRoot:transfer.source,sourceIdentity:await identity(transfer.source),parentIdentity:await identity(path.dirname(file)),fileIdentity:fileIdentity(stat)};
 const journal=path.join(path.dirname(file),`photo-importer-${kind==='stage'?'stage':'intent'}-${randomUUID()}.json`),handle=await fs.open(journal,'wx',0o600);
 let journalStat:BigIntStats;
 try {await handle.writeFile(JSON.stringify(sealImportRecord({...record})));await handle.sync();journalStat=await handle.stat({bigint:true});}finally{await handle.close();}
 await syncParents(journal,transfer.root);
 remember(await receiptNames(path.dirname(journal),transfer.root,index),path.basename(journal),record);
 return {file,stat,journal,journalStat,record};
}

async function prefixMatches(file:string,source:string,length:number,signal?:AbortSignal):Promise<boolean>{
 const partial=await regularHandle(file),input=await regularHandle(source),a=Buffer.allocUnsafe(1024*1024),b=Buffer.allocUnsafe(a.length);
 try {for(let position=0;position<length;){checkAbort(signal);const size=Math.min(a.length,length-position);let left=0,right=0;
  while(left<size){const read=await partial.read(a,left,size-left,position+left);if(!read.bytesRead)return false;left+=read.bytesRead;}
  while(right<size){const read=await input.read(b,right,size-right,position+right);if(!read.bytesRead)return false;right+=read.bytesRead;}
  if(!a.subarray(0,size).equals(b.subarray(0,size)))return false;position+=size;
 }return true;}finally{await partial.close();await input.close();}
}

/** Unknown, unsigned, replaced or non-prefix data is left untouched. */
export async function findPartial(kind:Kind,entry:PlanEntry,root:string,index:RecoveryIndex,signal?:AbortSignal):Promise<OwnedPartial|undefined>{
 const folder=path.dirname(entry.destination),records=await receiptNames(folder,root,index);
 // A stage partial is bound to its source by stat identity and a byte-prefix
 // check, and the whole stream is hashed again, so a receipt written before the
 // checksum was known still identifies it. Publication receipts match exactly.
 const stageMatch=(record:RecordData)=>record.sha256===''||entry.digest===undefined||record.sha256===entry.digest;
 const names=kind==='stage'
  ?new Map([...records.values()].flatMap(matches=>[...matches]).filter(([,record])=>record.kind==='stage'&&record.source===entry.source&&record.destination===entry.destination&&stageMatch(record)))
  :records.get(recordKey({kind,source:entry.source,destination:entry.destination,sha256:entry.digest??''}));
 if(!names?.size)return;
 for(const name of [...names.keys()].sort()){
  checkAbort(signal);const journal=path.join(folder,name);
  try {
   const {record,journalStat}=await readRecord(journal,root);
   if(record.version!==1||record.kind!==kind||record.root!==root||record.source!==entry.source||record.destination!==entry.destination||(kind==='stage'?!stageMatch(record):record.sha256!==(entry.digest??''))||!record.sourceStat||typeof record.file!=='string'||path.dirname(record.file)!==folder)continue;
   if(kind==='publication'?record.file!==entry.destination:!/^(?:\.import|photo-importer)-[a-f0-9-]+\.partial$/.test(path.basename(record.file)))continue;
   await rootUnchanged(root,record.rootIdentity);await rootUnchanged(record.sourceRoot,record.sourceIdentity);await contained(entry.source,record.sourceRoot);await contained(record.file,root);
   if(await identity(folder)!==record.parentIdentity)continue;
   const source=await fs.lstat(entry.source,{bigint:true}),stat=await fs.lstat(record.file,{bigint:true});
   if(!sourceMatches(source,record.sourceStat)||!stat.isFile()||stat.nlink!==1n||fileIdentity(stat)!==record.fileIdentity||stat.size>BigInt(entry.size))continue;
   if(!await prefixMatches(record.file,entry.source,Number(stat.size),signal))continue;
   if(!sameStat(stat,await fs.lstat(record.file,{bigint:true}))||!sameStat(source,await fs.lstat(entry.source,{bigint:true})))continue;
   return {file:record.file,stat,journal,journalStat,record};
  }catch(error){if((error as Error)?.name==='AbortError')throw error;/* Untrusted/unavailable records grant no overwrite permission. */}
 }
}

/** Open without truncation, then verify the descriptor and pathname again. */
export async function openPartial(partial:OwnedPartial,root:string){
 await contained(partial.file,root);await rootUnchanged(root,partial.record.rootIdentity);await rootUnchanged(partial.record.sourceRoot,partial.record.sourceIdentity);
 if(await identity(path.dirname(partial.file))!==partial.record.parentIdentity||!sourceMatches(await fs.lstat(partial.record.source,{bigint:true}),partial.record.sourceStat))throw new Error('Incomplete copy identity changed; scan again');
 const output=await fs.open(partial.file,constants.O_RDWR|(constants.O_NOFOLLOW??0));
 try{if(!sameStat(partial.stat,await output.stat({bigint:true}))||!sameStat(partial.stat,await fs.lstat(partial.file,{bigint:true})))throw new Error('Incomplete copy changed before resuming');return output;}catch(error){await output.close();throw error;}
}
/** `sync:false` leaves synchronizing the folder to the caller, who removes several at once. */
export async function clearPartialRecord(partial:OwnedPartial,root:string,index:RecoveryIndex,sync=true):Promise<void>{
 await contained(partial.journal,root);
 if(!sameStat(partial.journalStat,await fs.lstat(partial.journal,{bigint:true})))throw new Error('Incomplete copy journal changed');
 await fs.unlink(partial.journal);(await receiptNames(path.dirname(partial.journal),root,index)).get(recordKey(partial.record))?.delete(path.basename(partial.journal));if(sync)await syncDirectory(path.dirname(partial.journal));
}
