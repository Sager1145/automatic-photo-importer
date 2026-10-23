import * as fs from 'node:fs/promises';
import path from 'node:path';
import {deletingPattern,LEGACY_RECOVERY_FOLDER,RECOVERY_FOLDER} from '../recovery';
import {code,contained,syncDirectory} from '../paths';
import {bookkeepingOnly,deleted,hit,type MigrationContext} from './common';

const journalName=/^(?:manifest\.json|event-log\.jsonl|event-[a-f0-9-]+\.json|stage-[0-9a-f-]{36}\.partial|incomplete-[0-9a-f-]{36})$/;
/** Whether a set-aside deletion holds only what the app wrote in a journal folder: journal records and staging
 * leftovers, Finder's bookkeeping, and kept-original folders with no file left in them. */
async function provenDeletion(folder:string):Promise<boolean>{
 const finder=async(file:string,name:string)=>name==='.DS_Store'||name.startsWith('._')&&await bookkeepingOnly(file);
 const empty=async(directory:string):Promise<boolean>=>{
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
   const item=path.join(directory,entry.name);
   if(entry.isDirectory()){if(!await empty(item))return false;}
   else if(!entry.isFile()||!await finder(item,entry.name))return false;
  }
  return true;
 };
 for(const entry of await fs.readdir(folder,{withFileTypes:true})){
  const item=path.join(folder,entry.name);
  if(entry.isDirectory()&&entry.name==='originals'){if(!await empty(item))return false;}
  else if(!entry.isFile()||!journalName.test(entry.name)&&!await finder(item,entry.name))return false;
 }
 return true;
}
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
   if(entry.isFile()&&(entry.name==='.DS_Store'||entry.name.startsWith('._')&&await bookkeepingOnly(item))){await fs.unlink(item);deleted(item,'Finder bookkeeping in an earlier version\'s records folder','.DS_Store or a bookkeeping-only "._" file');}
   // A journal folder set aside by a deletion that stopped: removed whole only while it holds nothing but what a
   // journal folder holds and no kept original; otherwise it stays (below) and is reported.
   else if(entry.isDirectory()&&deletingPattern.test(entry.name)&&await provenDeletion(item)){await fs.rm(item,{recursive:true,force:true});deleted(item,'journal folder set aside by a deletion that stopped','holds only journal files and no kept original');}
   else left.push(entry.name);
  }
  await syncDirectory(storage);
  if(left.length){context.problems.push(`Kept ${storage}: it still holds ${left.length} item${left.length===1?'':'s'} (${left.slice(0,3).join(', ')}).`);continue;}
  try{await fs.rmdir(storage);deleted(storage,'earlier version\'s records folder, everything in it converted','empty (non-recursive removal)');await syncDirectory(folder);}
  catch(error){if(!['ENOTEMPTY','EEXIST'].includes(code(error)??''))throw error;context.problems.push(`Kept ${storage}: it is not empty.`);continue;}
  const side=path.join(folder,`._${name}`);
  if(await bookkeepingOnly(side)){await fs.unlink(side);deleted(side,'"._" file of a removed records folder','holds only bookkeeping');await syncDirectory(folder);}
  await hit(context,'F');
 }
}
