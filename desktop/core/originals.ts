import * as fs from 'node:fs/promises';
import { beneath, checkAbort, code, contained, digest } from './paths';
import { mapPool } from './devices';

/** Files checked at once; each device's own stream limit (devices.ts) still caps the reads. */
const VERIFY_CONCURRENCY=4;

/** A source file an import copied and verified: its checksum and every place the import put it. */
export interface VerifiedOriginal {source:string;size:number;sha256:string;destinations:string[];}
export type KeptReason='changed'|'missing'|'unverified'|'destination-missing'|'destination-differs'|'unsafe'|'error';
export interface OriginalsMeasure {files:number;bytes:number;/** Files that would stay: changed, missing or not found in the backup. */kept:number;}
export interface OriginalsResult {deleted:{source:string;size:number}[];kept:{source:string;reason:KeptReason}[];bytes:number;errors:string[];}

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
type Outcome={deleted:true}|{kept:KeptReason;error?:string};
/** Deletes only source files whose checksum is re-confirmed, now, at every backup copy. A file that
 * changed since the import, is gone, was never verified, or whose backup copy is missing or different stays.
 * Files are checked through a small pool: the source is hashed, then every backup copy at once, so the reads
 * overlap (each device's stream limit still applies). A file is removed right after its own final re-check;
 * the report is assembled in input order afterwards. */
export async function deleteOriginals(sourceRoot:string,files:VerifiedOriginal[],options:{signal?:AbortSignal;onProgress?:(completed:number,total:number,file:string)=>void}={}):Promise<OriginalsResult> {
  const result:OriginalsResult={deleted:[],kept:[],bytes:0,errors:[]};
  let completed=0;
  const check=async(file:VerifiedOriginal):Promise<Outcome>=>{
    checkAbort(options.signal);
    options.onProgress?.(completed++,files.length,file.source);
    try {
      if(!file.sha256||!file.destinations.length) return {kept:'unverified'};
      if(!beneath(file.source,sourceRoot)||file.destinations.includes(file.source)) return {kept:'unsafe'};
      await contained(file.source,sourceRoot);
      const before=await regular(file.source).catch(error=>{if(code(error)==='ENOENT')return null;throw error;});
      if(before===null) return {kept:'missing'};
      if(!before||before.size!==BigInt(file.size)) return {kept:'changed'};
      if(await digest(file.source,options.signal)!==file.sha256) return {kept:'changed'};
      const found=await Promise.all(file.destinations.map(destination=>regular(destination).catch(error=>{if(code(error)==='ENOENT')return null;throw error;})));
      const same=await Promise.all(found.map((stat,index)=>stat&&stat.size===BigInt(file.size)?digest(file.destinations[index]!,options.signal).then(value=>value===file.sha256):false));
      for(let index=0;index<found.length;index++) {
        if(!found[index]) return {kept:'destination-missing'};
        if(!same[index]) return {kept:'destination-differs'};
      }
      // The file read for the checksum must still be the one removed.
      const after=await regular(file.source);
      if(!after||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeNs!==before.mtimeNs) return {kept:'changed'};
      await fs.unlink(file.source);
      return {deleted:true};
    } catch(error) {
      if(options.signal?.aborted) throw error;
      return {kept:'error',error:`${file.source}: ${error instanceof Error?error.message:String(error)}`};
    }
  };
  const outcomes=await mapPool(files,VERIFY_CONCURRENCY,check);
  outcomes.forEach((outcome,index)=>{
    const file=files[index]!;
    if('deleted' in outcome) {result.deleted.push({source:file.source,size:file.size});result.bytes+=file.size;}
    else {result.kept.push({source:file.source,reason:outcome.kept});if(outcome.error)result.errors.push(outcome.error);}
  });
  options.onProgress?.(completed,files.length,'');
  return result;
}
