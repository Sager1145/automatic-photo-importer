import * as fs from 'node:fs/promises';
import path from 'node:path';
import { beneath, code, contained, syncDirectory, within } from './paths';
import { destinationEntries, destinationParts } from './allocation';
import type { TransferPlan } from '../shared';
import { logDeletion } from '../logger';

/** Files the operating system creates that are not user content. The app's own recovery
 * files (.import-*, photo-importer-*, .photo-importer-*) are deliberately absent: they are never removed here. */
const serviceNames=new Set(['.ds_store','thumbs.db','desktop.ini','icon\r']);
/** An OS bookkeeping file name other than a `._` sidecar (those need their contents judged). */
export const isServiceName=(name:string)=>serviceNames.has(name.toLowerCase());
const serviceFile=(name:string)=>name.startsWith('._')||serviceNames.has(name.toLowerCase());

/** Remove folders under the chosen source folders that hold nothing but service files once
 * their media has moved. A folder with any user file, link or app recovery data is kept, as is
 * everything inside a kept folder (the backup). Returns how many folders were removed. */
export async function removeRedundantFolders(library:string,folders:string[],keep:string[]):Promise<number> {
  const root=await fs.realpath(library),kept=keep.map(folder=>path.resolve(folder));
  let removed=0;
  async function sweep(folder:string):Promise<boolean> {
    await contained(path.join(folder,'.sweep-check'),root);
    const stat=await fs.lstat(folder);
    if(!stat.isDirectory()||stat.isSymbolicLink()) return false;
    let removable=!kept.some(item=>within(item,folder));
    const service:string[]=[];
    for(const entry of await fs.readdir(folder,{withFileTypes:true})) {
      const child=path.join(folder,entry.name);
      if(entry.isSymbolicLink()) removable=false;
      else if(entry.isDirectory()) {
        if(kept.some(item=>within(child,item))||['.photo-importer-recovery','photo importer recovery'].includes(entry.name.toLowerCase())) removable=false;
        else if(!await sweep(child)) removable=false;
      } else if(entry.isFile()&&serviceFile(entry.name)) service.push(child);
      else removable=false;
    }
    if(!removable) return false;
    for(const file of service) {await fs.unlink(file).catch(error=>{if(code(error)!=='ENOENT')throw error;});logDeletion('folders',file,'operating-system service file in a folder whose media all moved','the folder holds only service files, no links, no user files and no app recovery data; inside the chosen folders and outside the kept backup',{folder});}
    try { await fs.rmdir(folder); } catch(error) { if(['ENOTEMPTY','EEXIST'].includes(code(error)??''))return false; throw error; }
    logDeletion('folders',folder,'folder left with no user files after organizing','rmdir succeeded, which only removes empty folders; every entry was a service file or an already-swept subfolder',{serviceFiles:service.length});await syncDirectory(path.dirname(folder));removed++;
    return true;
  }
  for(const chosen of folders) {
    const folder=path.resolve(chosen);
    if(folder===root) throw new Error('Choose folders inside the library, not the library root itself.');
    if(!beneath(folder,root)) throw new Error(`Only folders inside the library can be cleaned up: ${folder}`);
    if(kept.some(item=>within(folder,item))) throw new Error(`The backup folder is never cleaned up: ${folder}`);
    if(await fs.lstat(folder).then(()=>true,()=>false)) await sweep(folder);
  }
  return removed;
}

/** Cleanup after an organization of `source` that produced `plans`. Chosen `sourceFolders`
 * outside the backup are swept whole. A backup folder organized in place (the source itself, or
 * both folders of the video-root layout, which are named as source folders) has the top-level
 * folders inside it that files moved out of swept; the backup folder itself always stays. */
export async function removeOrganizedFolders(source:string,plans:TransferPlan[],sourceFolders:string[]=[]):Promise<number> {
  const roots=plans.flatMap(plan=>destinationParts(plan).map(part=>part.root)),chosen=sourceFolders.map(folder=>path.join(source,folder));
  const outside=chosen.filter(folder=>!roots.includes(folder)),inPlace=roots.filter(root=>root===source||chosen.includes(root));
  let removed=outside.length?await removeRedundantFolders(source,outside,roots):0;
  for(const root of inPlace) {
    const moved=new Set(plans.flatMap(plan=>destinationEntries(plan)).filter(entry=>beneath(entry.source,root)).map(entry=>path.relative(root,entry.source).split(path.sep)).filter(parts=>parts.length>1).map(parts=>path.join(root,parts[0]!)));
    if(moved.size) removed+=await removeRedundantFolders(root,[...moved],[]);
  }
  return removed;
}
