import * as fs from 'node:fs/promises';
import path from 'node:path';
import {maybeLstat,openV5,sealV5,storesFor,writeNewFile} from '../app-store';
import {indexLocations,indexTarget} from '../destination-index';
import {journalConversion,RECOVERY_FOLDER} from '../recovery';
import {beneath,syncDirectory} from '../paths';
import {convertCaches} from './caches';
import {removeOldFolders} from './folders';
import {convertJournal} from './journals';
import {convertPointers} from './pointers';
import {convertReceipts} from './receipts';
import {message,passThrough,type MigrationContext} from './common';
export {SimulatedCrash,type CrashPoint,type MigrationProgress,type MigrationStep} from './common';

/** Records v5, Step A: converts what earlier versions wrote on a drive into its "Photo Importer Data" store. Every
 * step finishes from what is on disk, so a stop, a crash or an unplugged drive is picked up on the next run. */
const MARKER='converted.json';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Whether `root`'s earlier-version receipts were all looked at by a finished walk. */
async function receiptsConverted(root:string):Promise<boolean>{
 for(const file of await indexLocations(root,MARKER))try{if(openV5('cache',JSON.parse(await fs.readFile(file,'utf8'))).converted===5)return true;}catch{/* Absent or not this Mac's. */}
 return false;
}
async function markReceiptsConverted(root:string):Promise<void>{
 const target=await indexTarget(root,MARKER);if(await maybeLstat(target))return;
 const temporary=path.join(path.dirname(target),`converted-${Date.now()}.tmp`);
 await writeNewFile(temporary,JSON.stringify(sealV5('cache',{converted:5,library:root})));
 await fs.rename(temporary,target);await syncDirectory(path.dirname(target));
}
/** Cheap: whether `root` still holds anything an earlier version wrote that the converter handles (record folders,
 * index or duplicate files, an unwalked library). */
export async function needsConversion(root:string,walked=true):Promise<boolean>{
 for(const name of [RECOVERY_FOLDER,'.photo-importer-recovery','photo-importer-index.json','.photo-importer-index.json','photo-importer-duplicates.json'])if(await maybeLstat(path.join(root,name)))return true;
 return walked&&!await receiptsConverted(root);
}
export interface ConversionResult {/** Journals converted (or finished) this run. */converted:number;/** Earlier-version journals still not converted. */pending:number;problems:string[];}
/** Convert everything earlier versions wrote under `roots` (a drive's destinations, backup folders and organized
 * folders): journals with their kept originals, then pointers (in those folders and in every folder a converted
 * journal leaves pointers in), import receipts and staged copies, caches, and finally the old record folders. */
export async function migrateDrive(roots:string[],options:Omit<MigrationContext,'problems'>&{/** The folders whose receipts are walked (default: `roots`). */walk?:string[]}={}):Promise<ConversionResult>{
 const context:MigrationContext={...options,problems:[]};
 const report=(step:'looking'|'cleanup'|'caches',completed:number,total:number,file:string)=>context.onProgress?.({step,completed,total,file});
 const unique:string[]=[];
 for(const root of roots){const real=await fs.realpath(root).catch(()=>undefined);if(real&&!unique.includes(real))unique.push(real);}
 // Looking: the hidden folder becomes the visible one, then each folder's journals are listed.
 const jobs:{root:string;id:string}[]=[];
 for(const [position,root] of unique.entries()){
  report('looking',position,unique.length,path.basename(root));
  try{
   await journalConversion.adopt(root);
   // A journal in both the hidden and the visible folder (adopting leaves the hidden copy): which one is real is the user's call.
   const hidden=(await fs.readdir(path.join(root,'.photo-importer-recovery')).catch(()=>[] as string[])).filter(name=>uuid.test(name));
   if(hidden.length)context.problems.push(`${root}: ${hidden.length} organization record${hidden.length===1?' is':'s are'} in both the hidden .photo-importer-recovery folder and Photo Importer Recovery; the hidden copies were left as they are. Use First Aid.`);
   const names=await fs.readdir(path.join(root,RECOVERY_FOLDER)).catch(()=>[] as string[]);
   for(const id of names.filter(name=>uuid.test(name)).sort())jobs.push({root,id});
  }catch(error){if(passThrough(error))throw error;context.problems.push(`${root}: ${message(error)}`);}
 }
 report('looking',unique.length,unique.length,'');
 let converted=0;
 for(const {root,id} of jobs){
  context.signal?.throwIfAborted?.();
  if(await convertJournal(root,id,context))converted++;
 }
 // Pointers: in each folder, and in every folder a journal of these folders leaves pointers in.
 const folders=[...unique];
 for(const root of unique)for(const store of await storesFor(root).catch(()=>[])){
  for(const {id,root:library} of await journalConversion.storeJournals(store).catch(()=>[])){
   const m=await journalConversion.readManifest(library,id).catch(()=>undefined);
   for(const folder of m?journalConversion.pointerFolders(m):[])if(!folders.includes(folder))folders.push(folder);
  }
 }
 for(const [position,folder] of folders.entries()){report('cleanup',position,folders.length,path.basename(folder));await convertPointers(folder,context);}
 // Receipts: one walk per top folder (a folder inside another is walked with it), once.
 const walk:string[]=[];for(const root of options.walk??roots){const real=await fs.realpath(root).catch(()=>undefined);if(real&&!walk.includes(real))walk.push(real);}
 for(const root of walk.filter(root=>!walk.some(other=>beneath(root,other)))){
  context.signal?.throwIfAborted?.();
  if(await receiptsConverted(root))continue;
  const before=context.problems.length;
  try{await convertReceipts(root,context);if(context.problems.length===before)await markReceiptsConverted(root);}
  catch(error){if(passThrough(error))throw error;context.problems.push(`${root}: ${message(error)}`);}
 }
 for(const [position,root] of unique.entries()){report('caches',position,unique.length,path.basename(root));await convertCaches(root,context);}
 for(const [position,folder] of folders.entries()){
  report('cleanup',position,folders.length,path.basename(folder));
  try{await removeOldFolders(folder,context);}catch(error){if(passThrough(error))throw error;context.problems.push(`${folder}: ${message(error)}`);}
 }
 report('cleanup',folders.length,folders.length,'');
 let pending=0;for(const root of unique)pending+=(await journalConversion.legacyIds(root)).length;
 return {converted,pending,problems:context.problems};
}
