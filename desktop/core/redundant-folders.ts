import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { beneath, code, contained, identity, sameStat, syncDirectory } from './paths';
import { APPLEDOUBLE_MAX_BYTES, inspectAppleDouble } from './appledouble';
import { log, logDeletion } from '../logger';

/** Files the operating system creates that are not user content. The app's own recovery
 * files (.import-*, photo-importer-*, .photo-importer-*) are deliberately absent: they are never removed here. */
const serviceNames=new Set(['.ds_store','thumbs.db','desktop.ini','icon\r']);
/** An OS bookkeeping file name other than a `._` sidecar (those need their contents judged). */
export const isServiceName=(name:string)=>serviceNames.has(name.toLowerCase());

/** Why a folder entry is OS bookkeeping, or undefined when it is anything else (so the folder stays). */
async function bookkeeping(file:string,name:string,root:string):Promise<string|undefined> {
  if(isServiceName(name)) return 'operating-system service file';
  if(!name.startsWith('._')||name.length<3) return undefined;
  const before=await fs.lstat(file,{bigint:true});
  if(!before.isFile()||before.size>BigInt(APPLEDOUBLE_MAX_BYTES)) return undefined;
  await contained(file,root);
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try {
    const opened=await handle.stat({bigint:true});
    if(!opened.isFile()||!sameStat(before,opened)) return undefined;
    if(!inspectAppleDouble(await handle.readFile()).safe) return undefined;
  } finally { await handle.close(); }
  return 'AppleDouble sidecar holding only bookkeeping (no resource fork, tags, label or comment)';
}
/** Removes those of `folders` (inside `root`) that now hold nothing but OS bookkeeping, deepest first, on `root`'s
 * device, links never followed. Bookkeeping files go first, then a non-recursive rmdir that fails (and keeps the
 * folder) if anything else appeared. `root`, `protect` and everything outside `root` are never touched; a folder
 * whose identity differs from the one in `identities` is kept. Returns how many folders were removed. */
export async function removeEmptiedFolders(root:string,folders:Iterable<string>,options:{signal?:AbortSignal;protect?:string[];/** Folders looked at so far of all the candidates. */onFolders?:(done:number,total:number,folder:string)=>void;
  /** Folder identities (`dev:ino`) recorded when the run began. */identities?:ReadonlyMap<string,string>;/** false: bookkeeping keeps a folder too, so only folders already empty go. */bookkeeping?:boolean;
  /** Log area, and what emptied the folders ("Delete originals"). */area:string;after:string}):Promise<number> {
  const protect=(options.protect??[]).map(item=>path.resolve(item));
  const candidates=[...new Set([...folders].map(folder=>path.resolve(folder)))].filter(folder=>beneath(folder,root)&&!protect.includes(folder)).sort((a,b)=>b.length-a.length);
  if(!candidates.length||options.signal?.aborted) return 0;
  let device:bigint;
  try { device=(await fs.lstat(root,{bigint:true})).dev; } catch { return 0; }
  let removed=0,done=0;
  options.onFolders?.(0,candidates.length,'');
  for(const folder of candidates) {
    if(options.signal?.aborted) break;
    options.onFolders?.(++done,candidates.length,folder);
    try {
      await contained(path.join(folder,'.x'),root);
      // Already gone (an earlier pass of the same run, or a recheck): nothing to keep or remove.
      const stat=await fs.lstat(folder,{bigint:true}).catch(error=>{if(code(error)==='ENOENT')return undefined;throw error;});
      if(!stat||!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==device) continue;
      const expected=options.identities?.get(folder);
      if(expected!==undefined&&await identity(folder)!==expected) {log('normal',options.area,'folder-kept',{path:folder,code:'replaced',reason:'not the folder recorded when the run began'});continue;}
      const found:[string,string][]=[];
      let empty=true;
      for(const entry of await fs.readdir(folder,{withFileTypes:true})) {
        const file=path.join(folder,entry.name),why=options.bookkeeping!==false&&entry.isFile()?await bookkeeping(file,entry.name,root).catch(()=>undefined):undefined;
        if(why) found.push([file,why]); else {empty=false;break;}
      }
      if(!empty) continue;
      for(const [file,why] of found) {
        await fs.unlink(file).catch(error=>{if(code(error)!=='ENOENT')throw error;});
        logDeletion(options.area,file,`${why} in a folder emptied by ${options.after}`,'the folder held nothing else; the file is bookkeeping, not user content',{folder});
      }
      // Anything that appeared since the listing keeps the folder; rmdir refuses a folder that is not empty.
      if((await fs.readdir(folder)).length) continue;
      try { await fs.rmdir(folder); } catch(error) { if(['ENOTEMPTY','EEXIST','ENOENT'].includes(code(error)??'')) continue; throw error; }
      logDeletion(options.area,folder,`folder left with no files after ${options.after}`,'rmdir succeeded, which only removes empty folders; every entry was OS bookkeeping or an already-removed subfolder',{bookkeeping:found.length});
      await syncDirectory(path.dirname(folder));
      removed++;
    } catch(error) { if(options.signal?.aborted) break; log('normal',options.area,'folder-kept',{path:folder,code:code(error)??'error',error}); }
  }
  return removed;
}
