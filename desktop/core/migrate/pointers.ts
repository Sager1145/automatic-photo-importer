import * as fs from 'node:fs/promises';
import path from 'node:path';
import {journalConversion,RECOVERY_FOLDER} from '../recovery';
import {code,contained,syncDirectory} from '../paths';
import {hit,message,passThrough,type MigrationContext} from './common';

/** P1: the earlier version's sibling pointers in `folder` (Photo Importer Recovery/journal-<id>.json). One whose
 * journal is converted and still live is written again in the store `folder` writes to, then removed; one whose
 * journal is gone, finished or superseded, one copied from another folder, and a crash's temp file are removed. One
 * whose journal is not converted yet stays for a later run; a damaged one stays and is reported. */
export async function convertPointers(folder:string,context:MigrationContext):Promise<void>{
 const storage=path.join(folder,RECOVERY_FOLDER);
 const names=await fs.readdir(storage).catch(error=>{if(['ENOENT','ENOTDIR'].includes(code(error)??''))return [] as string[];throw error;});
 const remove=async(name:string)=>{const file=path.join(storage,name);await contained(file,folder);await fs.unlink(file).catch(error=>{if(code(error)!=='ENOENT')throw error;});await syncDirectory(storage);};
 for(const name of names){
  context.signal?.throwIfAborted?.();
  if(journalConversion.isPointerTemporary(name)){await remove(name);continue;}
  if(!journalConversion.isPointerName(name))continue;
  try{
   const pointer=await journalConversion.legacyPointer(folder,name);
   if(pointer==='inert'){await remove(name);await hit(context,'P1');continue;}
   const standing=await journalConversion.standing(pointer.root,pointer.id);
   if(standing==='converting')continue;
   if(standing==='live'){await journalConversion.writePointer(folder,pointer);await hit(context,'P1:written');}
   await remove(name);await hit(context,'P1');
  }catch(error){if(passThrough(error))throw error;context.problems.push(`An earlier version's pointer was kept: ${path.join(storage,name)} (${message(error)})`);}
 }
}
