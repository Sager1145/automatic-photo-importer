import fs from 'node:fs/promises';
import path from 'node:path';
import type {Message} from './messages';
import {sourceInsideBackup} from './platform/destination-roots';
import type {Source} from './shared';

/** Turns the folders chosen in one dialog into sources to add. Each folder is checked on its own,
 * so one folder inside a backup is rejected without dropping the others. A folder already added
 * in the same mode, or picked twice, is skipped; a connected drive or a folder added in the other
 * mode is reused so it can switch mode. */
export async function resolveFolderSources(paths:string[],context:{sources:Source[];registered:ReadonlyMap<string,{backup:boolean}>;destinations:string[];backupFolders:string[];backup:boolean}):Promise<{sources:Source[];rejected:Message[]}> {
 const sources:Source[]=[],rejected:Message[]=[],seen=new Set<string>();
 for(const file of paths){
  const root=await fs.realpath(file);
  if(seen.has(root))continue;seen.add(root);
  const inside=sourceInsideBackup(root,context.destinations,context.backupFolders);
  if(inside){rejected.push(inside);continue;}
  const existing=context.sources.find(source=>source.path===root);
  if(existing&&context.registered.get(existing.id)?.backup===context.backup)continue;
  sources.push(existing??{id:`folder:${root}`,name:path.basename(root),path:root,transport:'folder'});
 }
 return {sources,rejected};
}
