import * as fs from 'node:fs/promises';
import path from 'node:path';
import {deletingPattern,LEGACY_RECOVERY_FOLDER,RECOVERY_FOLDER} from '../recovery';
import {code,contained,syncDirectory} from '../paths';
import {bookkeepingOnly,hit,type MigrationContext} from './common';

/** F: the earlier version's record folders in `folder`, once nothing of its records is left: Finder's bookkeeping
 * files and set-aside deletions removed, then the folder (never recursively), then its own "._" file when it only
 * holds bookkeeping. A folder with anything else stays, and is reported. */
export async function removeOldFolders(folder:string,context:MigrationContext):Promise<void>{
 for(const name of [RECOVERY_FOLDER,LEGACY_RECOVERY_FOLDER]){
  const storage=path.join(folder,name);
  const stat=await fs.lstat(storage).catch(()=>undefined);
  if(!stat)continue;
  if(!stat.isDirectory()||stat.isSymbolicLink()){context.problems.push(`Kept: ${storage} is not a folder this app made.`);continue;}
  await contained(storage,folder);
  const left:string[]=[];
  for(const entry of await fs.readdir(storage,{withFileTypes:true})){
   const item=path.join(storage,entry.name);
   if(entry.isFile()&&(entry.name==='.DS_Store'||entry.name.startsWith('._')&&await bookkeepingOnly(item)))await fs.unlink(item);
   // A journal folder set aside by a deletion that stopped: removed whole, as the cleanup always did.
   else if(entry.isDirectory()&&deletingPattern.test(entry.name))await fs.rm(item,{recursive:true,force:true});
   else left.push(entry.name);
  }
  await syncDirectory(storage);
  if(left.length){context.problems.push(`Kept ${storage}: it still holds ${left.length} item${left.length===1?'':'s'} (${left.slice(0,3).join(', ')}).`);continue;}
  try{await fs.rmdir(storage);await syncDirectory(folder);}
  catch(error){if(!['ENOTEMPTY','EEXIST'].includes(code(error)??''))throw error;context.problems.push(`Kept ${storage}: it is not empty.`);continue;}
  const side=path.join(folder,`._${name}`);
  if(await bookkeepingOnly(side)){await fs.unlink(side);await syncDirectory(folder);}
  await hit(context,'F');
 }
}
