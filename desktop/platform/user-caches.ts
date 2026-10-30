import * as fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import { unlinkEntry } from '../core/paths';
/** Records v5 for this Mac's own caches in the app's data folder: the stored value is {v:5,kind,...}. A cache in any
 * other shape is not read; it is rebuilt as if there were none. */
export type CacheKind='listing'|'scan'|'imported'|'placement'|'eta';
/** The stored value in the shape its loader checks (with `version` set to the loader's number); undefined for anything else. */
export function readCache<T>(value:unknown,kind:CacheKind,version:number):T|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 const record=value as Record<string,unknown>;
 if(record.v===5&&record.kind===kind){const {v:_v,kind:_kind,...rest}=record;return {...rest,version} as T;}
 return undefined;
}
/** The value as this version writes it. */
export function cacheRecord(kind:CacheKind,value:Record<string,unknown>):Record<string,unknown>{const {version:_version,...rest}=value;return {v:5,kind,...rest};}

const gunzip=promisify(zlib.gunzip),gzip=promisify(zlib.gzip);
/** The record stored in `file` as its loader would check it (see readCache); undefined for any problem: missing, too large, unreadable, another shape. */
export async function readCacheFile<T>(file:string,kind:CacheKind,version:number,options:{maxBytes:number;gzip?:boolean}):Promise<T|undefined>{
 try{
  if((await fs.lstat(file)).size>options.maxBytes)return undefined;
  const raw=await fs.readFile(file);
  return readCache<T>(JSON.parse((options.gzip?await gunzip(raw,{maxOutputLength:8*options.maxBytes}):raw).toString('utf8')),kind,version);
 }catch{return undefined;}
}
/** Writes the value as a record of `kind`: to a private temporary file beside `file`, then renamed over it; the temporary is removed on failure. */
export async function writeCacheFile(file:string,kind:CacheKind,value:Record<string,unknown>,options:{gzip?:boolean}={}):Promise<void>{
 const text=JSON.stringify(cacheRecord(kind,value)),body=options.gzip?await gzip(text,{level:1}):text,temporary=`${file}.${randomUUID()}.tmp`;
 await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
 try{await fs.writeFile(temporary,body,{mode:0o600});await fs.rename(temporary,file);}
 catch(error){await unlinkEntry(temporary).catch(()=>{});throw error;}
}
const chains=new Map<string,Promise<unknown>>();
/** Runs `work` after every earlier call for the same path has settled, so read-modify-write updates of one file never interleave. A rejection reaches only its own caller. */
export function serialized<T>(file:string,work:()=>Promise<T>):Promise<T>{
 const run=(chains.get(file)??Promise.resolve()).then(work,work);
 const tail=run.then(()=>{},()=>{});
 chains.set(file,tail);void tail.then(()=>{if(chains.get(file)===tail)chains.delete(file);});
 return run;
}
