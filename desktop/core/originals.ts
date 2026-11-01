import * as fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { beneath, checkAbort, code, contained, digest, statKey , unlinkEntry } from './paths';
import { removeEmptiedFolders } from './redundant-folders';
import { mapPool } from './devices';
import { log, logDeletion } from '../logger';
import { refuseOnCamera } from './camera-guard';
import { destinationEntries } from './allocation';
import type { DestinationOutcome } from './destinations';
import type { TransferPlan } from '../shared';
import { mediaKindForPath } from '../media-formats';

/** Files checked at once; each device's own stream limit (devices.ts) still caps the reads. */
const VERIFY_CONCURRENCY=4;

/** A source file an import copied and verified: its checksum and every place the import put it.
 * identity: the source's statKey when the import read it for that checksum. */
export interface VerifiedOriginal {source:string;size:number;sha256:string;destinations:string[];identity?:string;}
/** Only photos and videos are ever deleted from a source: everything else an import copies (documents, archives, sidecars,
 * hidden files) stays where it is. */
export function deletableFromSource(file:string):boolean {
  const name=path.basename(file);
  return !name.startsWith('.')&&mediaKindForPath(name)!=='Other';
}
/** stopped: Stop was pressed before this file was removed. not-media: not a photo or video (deletableFromSource). */
export type KeptReason='not-media'|'changed'|'missing'|'unverified'|'destination-missing'|'destination-differs'|'unsafe'|'error'|'stopped';
export interface OriginalsMeasure {files:number;bytes:number;/** Files that would stay: changed, missing or not found in the backup. */kept:number;}
/** stopped: the run was stopped; files it had already removed are still listed in `deleted`. A stop before the emptied-folder pass removes no folder; one during it ends the pass early. */
export interface OriginalsResult {deleted:{source:string;size:number}[];kept:{source:string;reason:KeptReason}[];bytes:number;errors:string[];/** Source folders removed because this run left them empty. */folders:number;stopped?:boolean;}

async function regular(file:string) {
  const stat=await fs.lstat(file,{bigint:true});
  return stat.isFile()&&!stat.isSymbolicLink()?stat:undefined;
}
/** Quick read-only count for the confirmation: size and presence only, no file contents are read. */
export async function measureOriginals(sourceRoot:string,files:VerifiedOriginal[],signal?:AbortSignal):Promise<OriginalsMeasure> {
  let count=0,bytes=0,kept=0;
  for(const file of files) {
    checkAbort(signal);
    let ok=!!file.sha256&&file.destinations.length>0&&beneath(file.source,sourceRoot)&&!file.destinations.includes(file.source);
    try {
      if(ok) {
        const source=await regular(file.source);
        ok=!!source&&source.size===BigInt(file.size);
        for(const destination of file.destinations) if(ok){const found=await regular(destination);ok=!!found&&found.size===BigInt(file.size);}
      }
    } catch { ok=false; }
    if(ok){count++;bytes+=file.size;} else kept++;
  }
  return {files:count,bytes,kept};
}
/** Why a source this import copied is not offered for deletion. copy-missing: a destination its allocation requires
 * (both disks when mirroring, the one it was assigned when filling first) holds no copy from this run. unverified: a
 * required copy was never read back (verification off). not-media: not a photo or video, never deleted (deletableFromSource). */
export interface WithheldOriginal {source:string;reason:'copy-missing'|'unverified'|'not-media';}
/** The originals a finished import may offer to delete, from what each file actually came to at each destination: a source
 * qualifies only when every destination its plan sends it to holds a copy this run verified, and its actual paths there are
 * what deleteOriginals re-reads. Only a source this run read itself (a copy it published) carries its identity, which lets
 * deleteOriginals skip reading it again; a file found already in the backup never does. */
export function verifiedOriginals(outcomes:ReadonlyMap<string,readonly DestinationOutcome[]>,plans:TransferPlan[]):{files:VerifiedOriginal[];withheld:WithheldOriginal[]} {
  const required=new Map<string,Set<number>>();
  plans.forEach((plan,slot)=>{for(const entry of destinationEntries(plan)){const slots=required.get(entry.source)??new Set<number>();slots.add(slot);required.set(entry.source,slots);}});
  const files:VerifiedOriginal[]=[],withheld:WithheldOriginal[]=[];
  for(const [source,found] of outcomes) {
    const slots=required.get(source);
    if(!slots||!found.length) continue;
    if(!deletableFromSource(source)) {withheld.push({source,reason:'not-media'});continue;}
    if([...slots].some(slot=>!found.some(item=>item.destinationSlot===slot))) {withheld.push({source,reason:'copy-missing'});continue;}
    if(found.some(item=>item.verification!=='content-verified')) {withheld.push({source,reason:'unverified'});continue;}
    const read=found.find(item=>item.disposition==='published'&&item.sourceIdentity!==undefined);
    files.push({source,size:found[0]!.size,sha256:found[0]!.sha256,...(read?{identity:read.sourceIdentity}:{}),destinations:[...new Set(found.map(item=>item.destination))]});
  }
  return {files,withheld};
}
/** The source files an import found already in the library (Remove confirmed duplicates for drive transfers): every
 * destination its plan sends it to already held identical bytes (or an older route did), and this run confirmed them there.
 * A file this import published itself, also in an earlier run of the same job before a pause, is not one. */
export function libraryDuplicates(outcomes:ReadonlyMap<string,readonly DestinationOutcome[]>,plans:TransferPlan[]):VerifiedOriginal[] {
  return verifiedOriginals(outcomes,plans).files.filter(file=>outcomes.get(file.source)!.every(item=>item.disposition!=='published')).map(({identity:_,...file})=>file);
}
/** What a review says Remove confirmed duplicates would delete after a clean import: the source files every destination
 * already holds, by the plan (the run confirms each again, and the deletion re-reads both copies). */
export function plannedLibraryDuplicates(plans:TransferPlan[]):{files:number;bytes:number} {
  const seen=new Map<string,{size:number;everywhere:boolean}>();
  for(const plan of plans) for(const entry of destinationEntries(plan)) {
    if(!deletableFromSource(entry.source)) continue;
    const known=seen.get(entry.source),there=entry.skip&&!!entry.digest;
    seen.set(entry.source,{size:entry.size,everywhere:(known?.everywhere??true)&&there});
  }
  let files=0,bytes=0;
  for(const item of seen.values()) if(item.everywhere){files++;bytes+=item.size;}
  return {files,bytes};
}
type Outcome={deleted:true}|{kept:KeptReason;error?:string};
/** Deletes only source files whose checksum is re-confirmed, now, at every backup copy. A file that
 * changed since the import, is gone, was never verified, or whose backup copy is missing or different stays.
 * Files are checked through a small pool: the source is hashed (unless it is unchanged since the import read it), then every backup copy at once, so the reads
 * overlap (each device's stream limit still applies). A file is removed right after its own final re-check;
 * the report is assembled in input order afterwards. */
export async function deleteOriginals(sourceRoot:string,files:VerifiedOriginal[],options:{signal?:AbortSignal;/** Folders chosen separately as sources: roots like `sourceRoot`, never removed. */protect?:string[];/** Empty-folder pass: folders looked at so far of all that may have become empty. */onFolders?:(done:number,total:number,folder:string)=>void;/** The source volume keeps real change times (APFS or HFS+, by its file system type): only then may a source
 * whose identity is unchanged since the import read it go unread. */changeTimes?:boolean;/** duplicates: the files an import found already in the library (Remove confirmed duplicates): every source is read
 * again whatever `changeTimes` says, each deletion is logged as such, and emptied folders are kept. */purpose?:'originals'|'duplicates';/** bytesDone/bytesTotal: what is re-read, counting each backup copy of every file and each source not known unchanged since its import; planned before the first read. */onProgress?:(completed:number,total:number,file:string,bytesDone?:number,bytesTotal?:number)=>void}={}):Promise<OriginalsResult> {
  const duplicates=options.purpose==='duplicates';
  // Nothing on a camera or camera card is deleted: refused before any file is read.
  await refuseOnCamera(duplicates?'duplicates':'originals',sourceRoot);
  if(duplicates) options={...options,changeTimes:false};
  const result:OriginalsResult={deleted:[],kept:[],bytes:0,errors:[],folders:0};
  let completed=0,bytesDone=0;
  // Still the very file the import hashed (its identity is only kept for a source the import read itself), on a
  // volume that keeps real change times: it is not read again. Every backup copy always is.
  const unchanged=(file:VerifiedOriginal,stat:BigIntStats)=>!!options.changeTimes&&file.identity!==undefined&&statKey(stat)===file.identity&&stat.ctimeNs!==stat.mtimeNs;
  // What each file will read, planned from a stat of each source before the first read, so the total holds still.
  const planned=new Map<VerifiedOriginal,number>();
  if(options.changeTimes) for(const file of files) {
    // A stop here ends the run as stopped: every file reports 'stopped' below and nothing is deleted.
    if(options.signal?.aborted) break;
    const stat=file.identity!==undefined?await regular(file.source).catch(()=>undefined):undefined;
    planned.set(file,file.size*(file.destinations.length+(stat&&unchanged(file,stat)?0:1)));
  }
  const reads=(file:VerifiedOriginal)=>planned.get(file)??file.size*(1+file.destinations.length);
  const bytesTotal=files.reduce((sum,file)=>sum+reads(file),0);
  // A stop never throws away the outcome of files already removed: each file still reports deleted or kept.
  const check=async(file:VerifiedOriginal):Promise<Outcome>=>{
    if(options.signal?.aborted) return {kept:'stopped'};
    options.onProgress?.(completed++,files.length,file.source,bytesDone,bytesTotal);
    // Counted as planned, even when the source turns out to need a read after all.
    const read=reads(file);
    try {
      if(!deletableFromSource(file.source)) return {kept:'not-media'};
      if(!file.sha256||!file.destinations.length) return {kept:'unverified'};
      if(!beneath(file.source,sourceRoot)||file.destinations.includes(file.source)) return {kept:'unsafe'};
      await contained(file.source,sourceRoot);
      const before=await regular(file.source).catch(error=>{if(code(error)==='ENOENT')return null;throw error;});
      if(before===null) return {kept:'missing'};
      if(!before||before.size!==BigInt(file.size)) return {kept:'changed'};
      const known=unchanged(file,before);
      if(!known&&await digest(file.source,options.signal)!==file.sha256) return {kept:'changed'};
      const found=await Promise.all(file.destinations.map(destination=>regular(destination).catch(error=>{if(code(error)==='ENOENT')return null;throw error;})));
      const same=await Promise.all(found.map((stat,index)=>stat&&stat.size===BigInt(file.size)?digest(file.destinations[index]!,options.signal).then(value=>value===file.sha256):false));
      for(let index=0;index<found.length;index++) {
        if(!found[index]) return {kept:'destination-missing'};
        if(!same[index]) return {kept:'destination-differs'};
      }
      // The file read for the checksum must still be the one removed.
      const after=await regular(file.source);
      if(!after||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeNs!==before.mtimeNs||known&&after.ctimeNs!==before.ctimeNs) return {kept:'changed'};
      await unlinkEntry(file.source);
      if(duplicates) logDeletion('duplicates',file.source,'source file already in the library before this import (Remove confirmed duplicates)',`sha256 ${file.sha256} re-read now at the source and at ${file.destinations.length} library cop${file.destinations.length===1?'y':'ies'}; same inode, size and mtime between check and removal`,{bytes:file.size,library:file.destinations});
      else logDeletion('originals',file.source,'original already verified in the backup (Delete originals)',`sha256 ${file.sha256} ${known?'not re-read at the source: unchanged since the import read it (identity + ctime); re-read':'re-read now at the source and'} at ${file.destinations.length} backup cop${file.destinations.length===1?'y':'ies'}; same inode, size and mtime between check and removal`,{bytes:file.size,backups:file.destinations});
      return {deleted:true};
    } catch(error) {
      if(options.signal?.aborted) return {kept:'stopped'};
      return {kept:'error',error:`${file.source}: ${error instanceof Error?error.message:String(error)}`};
    } finally {
      // Counted when this file's checks end, so the byte progress never runs ahead of the reads.
      bytesDone+=read;
    }
  };
  const outcomes=await mapPool(files,VERIFY_CONCURRENCY,check);
  outcomes.forEach((outcome,index)=>{
    const file=files[index]!;
    if(!('deleted' in outcome))log('detailed','originals','kept',{path:file.source,reason:outcome.kept,...(outcome.error?{error:outcome.error}:{})});
    if('deleted' in outcome) {result.deleted.push({source:file.source,size:file.size});result.bytes+=file.size;}
    else {result.kept.push({source:file.source,reason:outcome.kept});if(outcome.error)result.errors.push(outcome.error);}
  });
  options.onProgress?.(completed,files.length,'',bytesDone,bytesTotal);
  // A stop skips the folder pass; one that arrives during it ends the pass early. Neither throws away the deletions.
  if(!options.signal?.aborted&&!duplicates) {
    // The folders the removed files were in, and their ancestors below the source root.
    const emptied=new Set<string>();
    for(const item of result.deleted) for(let folder=path.dirname(item.source);beneath(folder,sourceRoot);folder=path.dirname(folder)) emptied.add(folder);
    result.folders=await removeEmptiedFolders(sourceRoot,emptied,{signal:options.signal,protect:options.protect,onFolders:options.onFolders,area:'originals',after:'Delete originals'});
  }
  if(options.signal?.aborted) result.stopped=true;
  return result;
}
