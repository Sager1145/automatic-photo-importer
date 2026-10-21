import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MirrorRemoval, PlanEntry, TransferPlan } from '../shared';
import { ignoredName } from './inventory';
import type { DestinationIndex } from './destination-index';
import { beneath, checkAbort, code, contained, makeParent, pathKey, safeComponent, statKey, syncDirectory, syncParents } from './paths';

export const DRIVE_BACKUPS='Drive backups';
const marker='.photo-importer-drive.json', holding='.mirror-removed';
export interface Drive {name:string;identity:string;mirror:boolean;}
/** A removal is bound to the exact inode and timestamps seen during review. */
export interface ReviewedRemoval extends MirrorRemoval {stat:string;}
/** undefined: no folder yet; null: a folder this app did not create. */
async function owner(folder:string):Promise<string|null|undefined> {
  let stat;
  try { stat=await fs.lstat(folder); } catch(error) { if(code(error)==='ENOENT') return undefined; throw error; }
  if(!stat.isDirectory()) return null;
  try { const recorded=JSON.parse(await fs.readFile(path.join(folder,marker),'utf8')); return typeof recorded?.identity==='string'?recorded.identity:null; }
  catch { return null; }
}
/** Each drive owns one folder on a destination: the numbered folder it already
 * claimed, else the first name that neither another drive nor the user holds. */
export async function driveFolder(root:string,drive:Drive):Promise<string> {
  const name=safeComponent(drive.name.trim()||'Drive'),parent=path.join(root,DRIVE_BACKUPS);
  await contained(parent,root);
  const existing=new Set(await fs.readdir(parent).catch(error=>{if(code(error)==='ENOENT')return [] as string[];throw error;}));
  let free:string|undefined;
  for(let index=1;index<1000;index++) {
    const candidate=index===1?name:`${name} ${index}`;
    if(!existing.has(candidate)) {free??=candidate;continue;}
    await contained(path.join(parent,candidate),root);
    if(await owner(path.join(parent,candidate))===drive.identity) return candidate;
  }
  if(free) return free;
  throw new Error(`Too many backup folders named ${name}.`);
}
/** Compare the drive's folder on one destination with the planned copies.
 * `known` lets allocation reuse these hashes: true is a verified copy, false
 * is a file the reviewed mirror moves away before copying. */
export async function mirrorChanges(root:string,folder:string,pending:PlanEntry[],resolve:(entry:PlanEntry)=>Promise<string>,index:DestinationIndex,signal?:AbortSignal):Promise<{removals:ReviewedRemoval[];known:Map<string,boolean>}> {
  const planned=new Map(pending.map(entry=>[pathKey(entry.destination),entry])),removals:ReviewedRemoval[]=[],known=new Map<string,boolean>();
  const base=path.join(root,DRIVE_BACKUPS,folder);await contained(base,root);
  async function walk(current:string):Promise<void> {
    checkAbort(signal);
    let entries;
    try { entries=await fs.readdir(current,{withFileTypes:true}); } catch(error) { if(code(error)==='ENOENT') return; throw error; }
    for(const entry of entries) {
      if(ignoredName(entry.name) || (current===base && entry.name===marker) || entry.isSymbolicLink()) continue;
      const file=path.join(current,entry.name);await contained(file,root);
      if(entry.isDirectory()) {await walk(file);continue;}
      if(!entry.isFile()) continue;
      const before=await fs.lstat(file,{bigint:true}),key=pathKey(file),expected=planned.get(key);
      if(expected===undefined) removals.push({path:file,size:Number(before.size),reason:'missing',stat:statKey(before)});
      else if(before.size===BigInt(expected.size) && await index.digestOf(file,signal)===await resolve(expected)) known.set(key,true);
      else {known.set(key,false);removals.push({path:file,size:Number(before.size),reason:'changed',stat:statKey(before)});}
    }
  }
  await walk(base);
  return {removals,known};
}
export async function claimDriveFolder(root:string,drive:NonNullable<TransferPlan['drive']>):Promise<void> {
  const file=path.join(root,DRIVE_BACKUPS,drive.folder,marker);await contained(file,root);
  const recorded=await owner(path.dirname(file));
  if(recorded===drive.identity) return;
  if(recorded!==undefined) throw new Error(`This backup folder was created without this drive's marker or belongs to another drive; review again: ${path.dirname(file)}`);
  await makeParent(file,root);
  try {
    const handle=await fs.open(file,'wx',0o600);
    try { await handle.writeFile(JSON.stringify({identity:drive.identity,name:drive.name})); await handle.sync(); } finally { await handle.close(); }
    await syncParents(file,root);
  } catch(error) {
    if(code(error)!=='EEXIST') throw error;
    if(await owner(path.dirname(file))!==drive.identity) throw new Error(`This backup folder belongs to another drive; review again: ${path.dirname(file)}`);
  }
}
/** Move reviewed extras into a dated holding folder on the same destination.
 * Every file is checked before the first move; nothing is deleted. */
export async function moveMirrorRemovals(root:string,drive:NonNullable<TransferPlan['drive']>,removals:ReviewedRemoval[],signal?:AbortSignal):Promise<number> {
  const base=path.join(root,DRIVE_BACKUPS,drive.folder);
  for(const removal of removals) {
    checkAbort(signal);await contained(removal.path,root);
    const stat=await fs.lstat(removal.path,{bigint:true}).catch(error=>{if(code(error)==='ENOENT')return undefined;throw error;});
    if(!beneath(removal.path,base) || !stat?.isFile() || statKey(stat)!==removal.stat) throw new Error(`Destination file changed after review; review again: ${removal.path}`);
  }
  const held=path.join(root,DRIVE_BACKUPS,holding,`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`,drive.folder),parents=new Set<string>();
  for(const removal of removals) {
    checkAbort(signal);
    const target=path.join(held,path.relative(base,removal.path));await makeParent(target,root);
    if(await fs.lstat(target).then(()=>true,error=>{if(code(error)==='ENOENT')return false;throw error;})) throw new Error(`Mirror holding path already exists: ${target}`);
    await fs.rename(removal.path,target);
    await syncDirectory(path.dirname(removal.path));await syncParents(target,root);
    parents.add(path.dirname(removal.path));
  }
  // Mirror the source's folder layout: drop folders the moves left empty.
  for(const folder of [...parents].sort((a,b)=>b.length-a.length))
    for(let current=folder;beneath(current,base);current=path.dirname(current)) {
      try { await fs.rmdir(current); } catch { break; }
    }
  return removals.length;
}
