import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

/** Records v5 for this Mac's own caches in the app's data folder: the same data, marked {v:5,kind} instead of a
 * version number. The earlier version's shape is read once more, and rewritten at startup by convertUserCaches. */
export type CacheKind='listing'|'scan'|'imported'|'placement'|'eta';
/** The stored value in the shape its loader checks (with `version` set to the earlier version's number), from either
 * shape; undefined for anything else. */
export function readCache<T>(value:unknown,kind:CacheKind,version:number):T|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 const record=value as Record<string,unknown>;
 if(record.v===5&&record.kind===kind){const {v:_v,kind:_kind,...rest}=record;return {...rest,version} as T;}
 return record.v===undefined&&record.version===version?record as T:undefined;
}
/** The value as this version writes it. */
export function cacheRecord(kind:CacheKind,value:Record<string,unknown>):Record<string,unknown>{const {version:_version,...rest}=value;return {v:5,kind,...rest};}
/** Rewrite every cache still in the earlier version's shape: written aside, then renamed over it. Returns how many. */
export async function convertUserCaches(store:string):Promise<number>{
 const files:{file:string;kind:CacheKind;version:number;gzip?:boolean}[]=[
  {file:path.join(store,'listing-memory.json'),kind:'listing',version:1},
  {file:path.join(store,'eta-priors.json'),kind:'eta',version:1},
 ];
 for(const name of await fs.readdir(path.join(store,'scan-memory')).catch(()=>[] as string[])){
  if(name.endsWith('.imported.json'))files.push({file:path.join(store,'scan-memory',name),kind:'imported',version:1});
  else if(/^[0-9a-f]{32}\.json$/.test(name))files.push({file:path.join(store,'scan-memory',name),kind:'scan',version:4});
 }
 for(const name of await fs.readdir(path.join(store,'placement-memory')).catch(()=>[] as string[]))
  if(/^[0-9a-f]{32}\.json\.gz$/.test(name))files.push({file:path.join(store,'placement-memory',name),kind:'placement',version:1,gzip:true});
 let converted=0;
 for(const {file,kind,version,gzip} of files){
  try{
   const bytes=await fs.readFile(file),value=JSON.parse((gzip?gunzipSync(bytes,{maxOutputLength:256*1024*1024}):bytes).toString('utf8')) as Record<string,unknown>;
   if(value?.v!==undefined||value?.version!==version)continue;
   const text=JSON.stringify(cacheRecord(kind,value)),temporary=`${file}.${randomUUID()}.tmp`;
   try{await fs.writeFile(temporary,gzip?gzipSync(text,{level:1}):text,{mode:0o600});await fs.rename(temporary,file);converted++;}
   catch(error){await fs.unlink(temporary).catch(()=>{});throw error;}
  }catch{/* Missing or unreadable: the cache is rebuilt as before. */}
 }
 return converted;
}
