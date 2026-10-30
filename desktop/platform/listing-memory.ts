import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ListingHint } from '../listing-estimate';
import { readCacheFile, serialized, writeCacheFile } from './user-caches';

/** The size of the last completed listing of each scope (source root plus selected folders), kept across
 * restarts only to estimate how far the next listing is. A wrong or missing entry just means a rougher estimate. */
interface Stored {version:1;scopes:Record<string,{files:number;bytes:number;at:string}>;}
const MAX_SCOPES=200,MAX_BYTES=1024*1024;
const memoryFile=(store:string)=>path.join(store,'listing-memory.json');
export const listingScope=(root:string,folders:string[]|undefined,backup:boolean)=>createHash('sha256').update(JSON.stringify([path.resolve(root),[...(folders??[])].sort(),backup])).digest('hex').slice(0,32);
async function read(store:string):Promise<Stored['scopes']> {
  const stored=await readCacheFile<Stored>(memoryFile(store),'listing',1,{maxBytes:MAX_BYTES});
  if(!stored||!stored.scopes||typeof stored.scopes!=='object') return {};
  return Object.fromEntries(Object.entries(stored.scopes).filter(([,value])=>Number.isSafeInteger(value?.files)&&value.files>0&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&typeof value.at==='string'));
}
export async function loadListingHint(store:string,root:string,folders:string[]|undefined,backup:boolean):Promise<ListingHint|undefined> {
  const known=(await read(store))[listingScope(root,folders,backup)];
  return known?{files:known.files,bytes:known.bytes}:undefined;
}
export function rememberListing(store:string,root:string,folders:string[]|undefined,backup:boolean,files:number,bytes:number):Promise<void> {
  if(!(files>0)) return Promise.resolve();
  return serialized(memoryFile(store),async()=>{
    const scopes=await read(store);
    scopes[listingScope(root,folders,backup)]={files,bytes,at:new Date().toISOString()};
    const kept=Object.entries(scopes).sort((a,b)=>b[1].at.localeCompare(a[1].at)).slice(0,MAX_SCOPES);
    await writeCacheFile(memoryFile(store),'listing',{scopes:Object.fromEntries(kept)});
  });
}
