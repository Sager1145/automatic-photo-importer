import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import {hostKeyConfigured,maybeLstat,openV5,renameChecked,requireHostKey,sealV5,storeFor,storesFor,writeNewFile} from './app-store';
import {isOldPointerName,isOldReceiptName,LEGACY_RECOVERY_FOLDER,OLD_JOURNAL_ID,RECOVERY_FOLDER} from './legacy-names';
import {beneath,syncDirectory} from './paths';
import {MessageError} from '../messages';

/** Records v5 left every earlier format behind. What an earlier version wrote on a drive is never read beyond
 * telling whether this Mac wrote it, never changed, never deleted and never organized: a notice names it, and
 * the user can acknowledge it. Only items that authenticate with this Mac's key are reported (anything else is
 * not convertible, so there is nothing to tell the user to convert). */
export interface OldRecord {path:string;dev:string;ino:string;size:string;mtimeNs:string;}
/** The largest manifest read to authenticate it; a larger one is not reported. */
const MAX_MANIFEST=64*1024*1024,MAX_POINTER=4096,MAX_RECEIPT=32768,MAX_HITS=10000;
export const REVIEWED='reviewed-leftovers.json';
const identityOf=(file:string,stat:BigIntStats):OldRecord=>({path:file,dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtimeNs:String(stat.mtimeNs)});
const keyOf=(item:OldRecord)=>JSON.stringify([item.path,item.dev,item.ino,item.size,item.mtimeNs]);

/** Old files an inventory met (a receipt beside a media file), by path; looked at again when asked about the library. */
const hits=new Set<string>();
export function noteOldReceipt(file:string):void{if(hits.size<MAX_HITS)hits.add(file);}

/** The earlier version's seal: an HMAC-SHA256 over the plain JSON text, with the host key. */
function sealedByThisMac(value:unknown):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const {seal,...unsigned}=value as Record<string,unknown>;
 if(typeof seal!=='string'||!/^[a-f0-9]{64}$/.test(seal))return false;
 const expected=createHmac('sha256',requireHostKey()).update(JSON.stringify(unsigned)).digest();
 return timingSafeEqual(Buffer.from(seal,'hex'),expected);
}
/** Authenticated results by what the file was (path, inode, size, date): a file that changed is judged again. */
const judged=new Map<string,boolean>();
/** One old file: whether this Mac sealed it. Read through one handle, so the identity returned is that of the bytes judged. */
async function authenticated(file:string,limit:number):Promise<OldRecord|undefined>{
 const before=await maybeLstat(file);
 if(!before?.isFile()||before.size>BigInt(limit))return undefined;
 const known=judged.get(keyOf(identityOf(file,before)));
 if(known!==undefined)return known?identityOf(file,before):undefined;
 let handle:fs.FileHandle|undefined;
 try{
  handle=await fs.open(file,'r');
  const stat=await handle.stat({bigint:true});
  if(!stat.isFile()||stat.dev!==before.dev||stat.ino!==before.ino||stat.size!==before.size)return undefined;
  let ok=false;try{ok=sealedByThisMac(JSON.parse(await handle.readFile('utf8')));}catch{ok=false;}
  const after=await handle.stat({bigint:true});
  if(after.size!==stat.size||after.mtimeNs!==stat.mtimeNs)return undefined;
  judged.set(keyOf(identityOf(file,stat)),ok);
  return ok?identityOf(file,stat):undefined;
 }catch{return undefined;}
 finally{await handle?.close().catch(()=>{});}
}
async function entries(folder:string):Promise<string[]>{
 const stat=await maybeLstat(folder).catch(()=>undefined);
 if(!stat?.isDirectory()||stat.isSymbolicLink())return [];
 return fs.readdir(folder).catch(()=>[] as string[]);
}
/** Every old record under `root` that this Mac sealed: the manifests of journals and the pointers in its record
 * folders (two O(1) folder checks, then one small file per journal), and the receipts inventories met beneath it. */
async function candidates(root:string):Promise<OldRecord[]>{
 if(!hostKeyConfigured())return [];
 const found:OldRecord[]=[];
 for(const name of [RECOVERY_FOLDER,LEGACY_RECOVERY_FOLDER]){
  const folder=path.join(root,name);
  for(const entry of await entries(folder)){
   if(OLD_JOURNAL_ID.test(entry)){
    const job=path.join(folder,entry),stat=await maybeLstat(job).catch(()=>undefined);
    if(!stat?.isDirectory()||stat.isSymbolicLink())continue;
    const item=await authenticated(path.join(job,'manifest.json'),MAX_MANIFEST);if(item)found.push(item);
   }else if(isOldPointerName(entry)){
    const item=await authenticated(path.join(folder,entry),MAX_POINTER);if(item)found.push(item);
   }
  }
 }
 for(const file of [...hits]){
  if(!beneath(file,root)||!isOldReceiptName(path.basename(file)))continue;
  const item=await authenticated(file,MAX_RECEIPT);if(item)found.push(item);else if(!await maybeLstat(file).catch(()=>undefined))hits.delete(file);
 }
 return found;
}
/** What the stores `root` reads hold as reviewed: sealed by this Mac, exact identities. Anything else is ignored. */
async function reviewed(root:string):Promise<OldRecord[]>{
 const items:OldRecord[]=[];
 for(const store of await storesFor(root).catch(()=>[])){
  const file=path.join(store.path,REVIEWED),stat=await maybeLstat(file).catch(()=>undefined);
  if(!stat?.isFile()||stat.size>BigInt(MAX_MANIFEST))continue;
  try{
   const list=openV5('reviewed',JSON.parse(await fs.readFile(file,'utf8'))).items;
   if(!Array.isArray(list))continue;
   for(const item of list as OldRecord[])if(item&&['path','dev','ino','size','mtimeNs'].every(key=>typeof (item as unknown as Record<string,unknown>)[key]==='string'))items.push({path:item.path,dev:item.dev,ino:item.ino,size:item.size,mtimeNs:item.mtimeNs});
  }catch{/* Not this Mac's, or damaged: nothing is reviewed by it. */}
 }
 return items;
}
/** The old records under `root` that this Mac wrote and the user has not acknowledged. */
export async function findOldRecords(root:string):Promise<OldRecord[]>{
 const found=await candidates(root);
 if(!found.length)return [];
 const seen=new Set((await reviewed(root)).map(keyOf));
 return found.filter(item=>!seen.has(keyOf(item)));
}
/** The user has seen the notice: its items, with exactly the identities they have now, are written sealed to the
 * store `root` writes to, and the notice stops for them. Returns how many items were newly acknowledged. */
export async function acknowledgeOldRecords(root:string):Promise<number>{
 const fresh=await findOldRecords(root);
 if(!fresh.length)return 0;
 const store=await storeFor(root),target=path.join(store.path,REVIEWED);
 const mine=new Map<string,OldRecord>();
 // What this store already holds is kept; a file that is not this Mac's is replaced (it reviewed nothing).
 try{const stat=await maybeLstat(target);if(stat?.isFile()){const list=openV5('reviewed',JSON.parse(await fs.readFile(target,'utf8'))).items;if(Array.isArray(list))for(const item of list as OldRecord[])mine.set(keyOf(item),item);}}catch{/* replaced below */}
 for(const item of fresh)mine.set(keyOf(item),item);
 const temporary=path.join(store.path,`reviewed-${randomUUID()}.tmp`);
 await writeNewFile(temporary,JSON.stringify(sealV5('reviewed',{items:[...mine.values()]})));
 if(await maybeLstat(target)){await fs.rename(temporary,target);await syncDirectory(store.path);}
 else if(await renameChecked(temporary,target)!=='done')throw new Error(`Unable to write ${target}`);
 return fresh.length;
}
/** The drive's name as the notice shows it. */
export function driveName(root:string):string{
 const parts=path.resolve(root).split(path.sep);
 return parts[1]==='Volumes'&&parts[2]?parts[2]:path.basename(root)||root;
}
/** Organizing and Remove duplicates stop on a library whose old records were not acknowledged. */
export async function refuseOldRecords(root:string):Promise<void>{
 if((await findOldRecords(root)).length)throw new MessageError('error.oldRecords',{drive:driveName(root)});
}
