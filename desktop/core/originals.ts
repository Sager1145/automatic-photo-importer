import * as fs from 'node:fs/promises';
import { beneath, checkAbort, code, contained, digest } from './paths';

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
/** Deletes only source files whose checksum is re-confirmed, now, at every backup copy. A file that
 * changed since the import, is gone, was never verified, or whose backup copy is missing or different stays. */
export async function deleteOriginals(sourceRoot:string,files:VerifiedOriginal[],options:{signal?:AbortSignal;onProgress?:(completed:number,total:number,file:string)=>void}={}):Promise<OriginalsResult> {
  const result:OriginalsResult={deleted:[],kept:[],bytes:0,errors:[]};
  let completed=0;
  for(const file of files) {
    checkAbort(options.signal);
    options.onProgress?.(completed++,files.length,file.source);
    const keep=(reason:KeptReason,error?:string)=>{result.kept.push({source:file.source,reason});if(error)result.errors.push(error);};
    try {
      if(!file.sha256||!file.destinations.length) {keep('unverified');continue;}
      if(!beneath(file.source,sourceRoot)||file.destinations.includes(file.source)) {keep('unsafe');continue;}
      await contained(file.source,sourceRoot);
      const before=await regular(file.source).catch(error=>{if(code(error)==='ENOENT')return null;throw error;});
      if(before===null) {keep('missing');continue;}
      if(!before||before.size!==BigInt(file.size)) {keep('changed');continue;}
      if(await digest(file.source,options.signal)!==file.sha256) {keep('changed');continue;}
      let reason:KeptReason|undefined;
      for(const destination of file.destinations) {
        const found=await regular(destination).catch(error=>{if(code(error)==='ENOENT')return null;throw error;});
        if(!found) {reason='destination-missing';break;}
        if(found.size!==BigInt(file.size)||await digest(destination,options.signal)!==file.sha256) {reason='destination-differs';break;}
      }
      if(reason) {keep(reason);continue;}
      // The file read for the checksum must still be the one removed.
      const after=await regular(file.source);
      if(!after||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeNs!==before.mtimeNs) {keep('changed');continue;}
      await fs.unlink(file.source);
      result.deleted.push({source:file.source,size:file.size});result.bytes+=file.size;
    } catch(error) {
      if(options.signal?.aborted) throw error;
      keep('error',`${file.source}: ${error instanceof Error?error.message:String(error)}`);
    }
  }
  options.onProgress?.(completed,files.length,'');
  return result;
}
