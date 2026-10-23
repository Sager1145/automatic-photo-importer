import fs from 'node:fs/promises';
import path from 'node:path';
import {storeFolder,storeFor,storesFor} from '../../core/app-store';
import {assessReceipt,closeReceipts,IMPORTS,openReceipts,receiptSegments,STAGING,type Receipt} from '../../core/import-recovery';
/** The staging folder imports into `root` use (Photo Importer Data/Imports/Staging in the store `root` writes to), made if needed. */
export async function stagingFor(root:string):Promise<string>{return storeFolder(await storeFor(root),IMPORTS,STAGING);}
/** A fresh staged-copy path in that folder, named as the app names them. */
export async function stagePathFor(root:string,uuid:string):Promise<string>{return path.join(await stagingFor(root),`${uuid}.partial`);}
/** Every open receipt (rid → record) in every store readers consult for `root`. */
export async function openReceiptsFor(root:string):Promise<Map<string,{kind:string;file:string;[key:string]:unknown}>>{
 const all=new Map();for(const store of await storesFor(root))for(const [rid,record] of await openReceipts(store))all.set(rid,record);return all;
}
/** Whether a receipt returned by recordPartial/recordCreation is still open. */
export async function receiptOpen(receipt:Pick<Receipt,'rid'|'store'>):Promise<boolean>{return (await openReceipts(receipt.store)).has(receipt.rid);}
/** What the cleanup and the converter judge about a receipt now (bound, resumable, stale, complete…). */
export async function receiptState(receipt:Pick<Receipt,'store'|'record'>){return assessReceipt(receipt.store,receipt.record);}
/** Close a receipt (what removing an old per-file receipt used to do). */
export async function closeReceipt(receipt:Pick<Receipt,'rid'|'store'>):Promise<void>{await closeReceipts(receipt.store,[receipt.rid]);}
/** The receipt log segment files of the store `root` writes to. */
export async function segmentsFor(root:string):Promise<string[]>{return receiptSegments(await storeFor(root));}
/** What imports leave in the data folder of `root`: staged copies (their paths, macOS ._ files aside) and open receipts ('receipt:' and the id). */
export async function leftoversFor(root:string):Promise<string[]>{
 const staging=await stagingFor(root);
 const found=(await fs.readdir(staging)).filter(name=>!name.startsWith('._')).map(name=>path.join(staging,name));
 for(const rid of (await openReceiptsFor(root)).keys())found.push(`receipt:${rid}`);
 return found;
}
