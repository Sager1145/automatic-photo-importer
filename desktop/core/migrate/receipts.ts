import * as fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import {FirstAidError,maybeLstat,renameChecked,renamedIdentity,storeFor,type Store} from '../app-store';
import {closeReceipts,isLegacyReceiptName,leftoverReceipt,openReceiptFor,openReceipts,stagingFolder} from '../import-recovery';
import {isRecoveryName} from '../recovery';
import {code,contained,digest,identity,sameStat,syncDirectory,unreliableIno} from '../paths';
import {hit,message,passThrough,type MigrationContext} from './common';

const legacyStage=/^(?:\.import|photo-importer)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.partial$/;
/** Remove a file only while it is still the one looked at. */
async function removeIfSame(file:string,stat:BigIntStats,scope:string):Promise<boolean>{
 await contained(file,scope);const now=await maybeLstat(file);
 if(!now?.isFile()||!sameStat(now,stat))return false;
 await fs.unlink(file);await syncDirectory(path.dirname(file));return true;
}
type Legacy=Awaited<ReturnType<typeof leftoverReceipt>>;
type Open=Awaited<ReturnType<typeof openReceipts>>;
/** The open receipts of each store this walk writes to: read once, then kept current with every append. */
class OpenSets {
 private sets=new Map<string,Promise<Open>>();
 get(store:Store):Promise<Open>{let set=this.sets.get(store.path);if(!set){set=openReceipts(store);this.sets.set(store.path,set);}return set;}
 async open(store:Store,record:Parameters<typeof openReceiptFor>[1]):Promise<string>{const rid=await openReceiptFor(store,record);(await this.get(store)).set(rid,record);return rid;}
 async close(store:Store,rids:string[]):Promise<void>{if(!rids.length)return;await closeReceipts(store,rids);const set=await this.get(store);for(const rid of rids)set.delete(rid);}
}
/** The earlier version's record as a v5 receipt record (the same fields, without its version). */
const asRecord=(record:Legacy['record'],changes:Partial<Legacy['record']>={})=>{const {version:_version,...rest}=record;return {...rest,...changes};};
const same=(a:{kind:string;source:string;destination:string;sha256:string},b:typeof a)=>a.kind===b.kind&&a.source===b.source&&a.destination===b.destination&&a.sha256===b.sha256;

/** R1–R3 for a staged copy: an open v5 receipt for a fresh name in the staging folder, naming the copy as it is now
 * (R1); the copy renamed there, both names checked, and rebound if its identity changed (R2); the old receipt
 * removed (R3). A stop after R1 leaves a v5 receipt naming an absent file (closed by the next run, which tries a new
 * name); a stop after R2 leaves an old receipt naming an absent file (removed by the next run). */
async function convertStage(receipt:string,found:Legacy,walkRoot:string,context:MigrationContext,sets:OpenSets):Promise<void>{
 const record=found.record,file=found.file!;
 const {store,folder:staging}=await stagingFolder(record.root,path.dirname(file));
 // A v5 receipt an earlier run wrote for this copy: one whose staging name never got the file is closed; one whose
 // staging name is this very copy too (two names for one file) stops for First Aid, renaming and unlinking nothing.
 const before=await fs.lstat(file,{bigint:true}),stagingIdentity=await identity(staging);
 const stale=[...await sets.get(store)].filter(([,open])=>same(open,record)&&path.dirname(open.file)===staging).map(([rid,open])=>({rid,file:open.file}));
 const absent:string[]=[];
 for(const item of stale){
  const there=await maybeLstat(item.file);
  if(!there){absent.push(item.rid);continue;}
  if(there.dev===before.dev&&(unreliableIno(there)||unreliableIno(before)?there.birthtimeNs===before.birthtimeNs:there.ino===before.ino))throw new FirstAidError(`First Aid needed: ${file} and ${item.file} name the same staged copy`);
 }
 await sets.close(store,absent);
 for(let attempt=0;attempt<2;attempt++){
  const target=path.join(staging,`${randomUUID()}.partial`);
  const rid=await sets.open(store,asRecord(record,{file:target,parentIdentity:stagingIdentity}));
  await hit(context,'R1');
  if(await renameChecked(file,target,renamedIdentity(before))==='retry'){await sets.close(store,[rid]);continue;}
  await hit(context,'R2');
  const after=await fs.lstat(target,{bigint:true});
  if(after.dev!==before.dev||after.ino!==before.ino||after.birthtimeNs!==before.birthtimeNs){
   await sets.open(store,asRecord(record,{file:target,parentIdentity:stagingIdentity,fileIdentity:`${after.dev}:${after.ino}:${after.birthtimeNs}`}));
   await sets.close(store,[rid]);
  }
  await removeIfSame(receipt,found.journalStat,walkRoot);
  await hit(context,'R3');
  return;
 }
 throw new Error(`The staged copy could not be moved into the records folder: ${file}`);
}
/** One earlier-version receipt: converted, removed with what it proves dead, or kept for Clean up. */
async function convertReceipt(receipt:string,walkRoot:string,context:MigrationContext,sets:OpenSets):Promise<void>{
 let found:Legacy;
 // Unauthenticated or unreadable: it grants nothing, and only Clean up removes it.
 try{found=await leftoverReceipt(receipt,walkRoot);}catch(error){if(passThrough(error))throw error;return;}
 const record=found.record;
 if(found.kind==='stage'){
  if(!found.present){await removeIfSame(receipt,found.journalStat,walkRoot);return;}
  if(!found.owned||!found.file||!legacyStage.test(path.basename(found.file)))return;
  const stat=await fs.lstat(found.file,{bigint:true});
  if(stat.size===0n){if(await removeIfSame(found.file,stat,walkRoot))await removeIfSame(receipt,found.journalStat,walkRoot);return;}
  if(!found.bound)return;
  // A dead copy (card present, source gone or changed) that is incomplete goes with its receipt; a complete one may be the only copy.
  if(found.stale&&!found.complete){if(await removeIfSame(found.file,stat,walkRoot))await removeIfSame(receipt,found.journalStat,walkRoot);return;}
  await convertStage(receipt,found,walkRoot,context,sets);
  return;
 }
 // A publication receipt names a media path.
 const destination=record.file;
 const stat=typeof destination==='string'?await maybeLstat(destination):undefined;
 if(!stat){await removeIfSame(receipt,found.journalStat,walkRoot);return;}
 if(stat.isFile()&&record.sourceStat&&String(stat.size)===record.sourceStat.size&&record.sha256&&await digest(destination,context.signal).then(sha=>sha===record.sha256,()=>false)){await removeIfSame(receipt,found.journalStat,walkRoot);return;}
 // Any other file there: the receipt is how a re-import finishes or replaces it. Moved into the log, unless already there.
 const store=await storeFor(record.root);
 if(![...await sets.get(store)].some(([,open])=>same(open,record)&&open.file===destination&&open.fileIdentity===record.fileIdentity))await sets.open(store,asRecord(record));
 await hit(context,'R1');
 await removeIfSame(receipt,found.journalStat,walkRoot);
 await hit(context,'R3');
}
/** R: every earlier-version receipt in the folders under `root` (record folders and hidden folders aside), counted
 * by top-level folder. Returns how many receipt files were looked at. */
export async function convertReceipts(root:string,context:MigrationContext):Promise<number>{
 const top=(await fs.readdir(root,{withFileTypes:true}).catch(()=>[])).filter(entry=>entry.isDirectory()&&!entry.name.startsWith('.')&&!isRecoveryName(entry.name));
 const sets=new OpenSets();
 let done=0,seen=0;const total=top.length+1,report=(file:string)=>context.onProgress?.({step:'receipts',completed:done,total,file});
 const walk=async(folder:string):Promise<void>=>{
  context.signal?.throwIfAborted?.();
  const entries=await fs.readdir(folder,{withFileTypes:true}).catch(error=>{if(['ENOENT','ENOTDIR','EACCES','EPERM'].includes(code(error)??''))return [];throw error;});
  for(const entry of entries){
   if(!entry.isFile()||!isLegacyReceiptName(entry.name))continue;
   seen++;
   try{await convertReceipt(path.join(folder,entry.name),root,context,sets);}
   catch(error){if(passThrough(error))throw error;context.problems.push(`An earlier version's receipt was kept: ${path.join(folder,entry.name)} (${message(error)})`);}
  }
  for(const entry of entries)if(entry.isDirectory()&&!entry.name.startsWith('.')&&!isRecoveryName(entry.name))await walk(path.join(folder,entry.name));
 };
 report(path.basename(root));
 // The root's own files first, then each top-level folder in full.
 const own=await fs.readdir(root,{withFileTypes:true}).catch(()=>[]);
 for(const entry of own)if(entry.isFile()&&isLegacyReceiptName(entry.name)){seen++;try{await convertReceipt(path.join(root,entry.name),root,context,sets);}catch(error){if(passThrough(error))throw error;context.problems.push(`An earlier version's receipt was kept: ${path.join(root,entry.name)} (${message(error)})`);}}
 done++;report(path.basename(root));
 for(const entry of top){await walk(path.join(root,entry.name));done++;report(entry.name);}
 return seen;
}
