import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MirrorRemoval, PlanEntry, TransferPlan } from '../shared';
import { ignoredName } from './inventory';
import type { DestinationIndex } from './destination-index';
import { beneath, checkAbort, code, contained, makeParent, pathKey, readdirIfPresent, statKey, syncDirectory, syncParents } from './paths';
import { hostKeyConfigured, openV5, renameChecked, sealV5 } from './app-store';
import { removeEmptiedFolders } from './redundant-folders';
import { safeComponent } from '../folder-template';
import { log } from '../logger';

export const DRIVE_BACKUPS='Drive backups';
export const DRIVE_MARKER='photo-importer-drive.json';
const marker=DRIVE_MARKER, holding='Removed by mirror';
export interface Drive {name:string;identity:string;mirror:boolean;}
/** A removal is bound to the exact inode and timestamps seen during review. */
export interface ReviewedRemoval extends MirrorRemoval {stat:string;}
/** undefined: no folder yet; null: a folder this app did not create. */
async function owner(folder:string):Promise<string|null|undefined> {
  let stat;
  try { stat=await fs.lstat(folder); } catch(error) { if(code(error)==='ENOENT') return undefined; throw error; }
  if(!stat.isDirectory()) return null;
  let text;
  try { text=await fs.readFile(path.join(folder,marker),'utf8'); } catch { return null; }
  try { return markerIdentity(JSON.parse(text)); } catch { return null; }
}
/** A marker's drive identity: the marker must carry this Mac's seal. */
export function markerIdentity(recorded:unknown):string|null {
  try { const opened=openV5('drive',recorded); return typeof opened.identity==='string'?opened.identity:null; } catch { return null; }
}
/** The marker this version writes: sealed when the host key is configured (always in the app). */
export const markerText=(drive:{identity:string;name:string})=>JSON.stringify(hostKeyConfigured()?sealV5('drive',{identity:drive.identity,name:drive.name}):{identity:drive.identity,name:drive.name});
/** Each drive owns one folder on a destination: the numbered folder it already
 * claimed, else the first name that neither another drive nor the user holds. */
export async function driveFolder(root:string,drive:Drive):Promise<string> {
  const name=safeComponent(drive.name.trim()||'Drive'),parent=path.join(root,DRIVE_BACKUPS);
  await contained(parent,root);
  const existing=new Set(await readdirIfPresent(parent));
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
export async function mirrorChanges(root:string,folder:string,pending:PlanEntry[],resolve:(entry:PlanEntry)=>Promise<string>,index:DestinationIndex,signal?:AbortSignal,/** Files compared so far, files found so far (the walk finds more as it goes) and the file. */onProgress?:(compared:number,found:number,file:string)=>void):Promise<{removals:ReviewedRemoval[];known:Map<string,boolean>}> {
  let found=0,compared=0;
  const planned=new Map(pending.map(entry=>[pathKey(entry.destination),entry])),removals:ReviewedRemoval[]=[],known=new Map<string,boolean>();
  const base=path.join(root,DRIVE_BACKUPS,folder);await contained(base,root);
  async function walk(current:string):Promise<void> {
    checkAbort(signal);
    let entries;
    try { entries=await fs.readdir(current,{withFileTypes:true}); } catch(error) { if(code(error)==='ENOENT') return; throw error; }
    found+=entries.filter(entry=>entry.isFile()&&!ignoredName(entry.name)&&!(current===base&&entry.name===marker)).length;onProgress?.(compared,found,path.relative(base,current)||folder);
    for(const entry of entries) {
      if(ignoredName(entry.name) || (current===base && entry.name===marker) || entry.isSymbolicLink()) continue;
      const file=path.join(current,entry.name);await contained(file,root);
      if(entry.isDirectory()) {await walk(file);continue;}
      if(!entry.isFile()) continue;
      const before=await fs.lstat(file,{bigint:true}),key=pathKey(file),expected=planned.get(key);
      if(expected===undefined) removals.push({path:file,size:Number(before.size),reason:'missing',stat:statKey(before)});
      else if(before.size===BigInt(expected.size) && await index.digestOf(file,signal)===await resolve(expected)) known.set(key,true);
      else {known.set(key,false);removals.push({path:file,size:Number(before.size),reason:'changed',stat:statKey(before)});}
      onProgress?.(++compared,found,entry.name);
    }
  }
  await walk(base);
  return {removals,known};
}
export async function claimDriveFolder(root:string,drive:NonNullable<TransferPlan['drive']>,rootIdentity?:string):Promise<void> {
  const file=path.join(root,DRIVE_BACKUPS,drive.folder,marker);await contained(file,root);
  const recorded=await owner(path.dirname(file));
  if(recorded===drive.identity) return;
  if(recorded!==undefined) throw new Error(`This backup folder was created without this drive's marker or belongs to another drive; review again: ${path.dirname(file)}`);
  await makeParent(file,root,rootIdentity);
  try {
    const handle=await fs.open(file,'wx',0o600);
    try { await handle.writeFile(markerText(drive)); await handle.sync(); } finally { await handle.close(); }
    await syncParents(file,root);
  } catch(error) {
    if(code(error)!=='EEXIST') throw error;
    if(await owner(path.dirname(file))!==drive.identity) throw new Error(`This backup folder belongs to another drive; review again: ${path.dirname(file)}`);
  }
}
/** Move reviewed extras into a dated holding folder on the same destination.
 * Every file is checked before the first move; nothing is deleted. */
export async function moveMirrorRemovals(root:string,drive:NonNullable<TransferPlan['drive']>,removals:ReviewedRemoval[],signal?:AbortSignal,rootIdentity?:string,/** Hears each file as it is set aside: files done, bytes done, and the file's name. */onProgress?:(completed:number,bytes:number,file:string)=>void):Promise<number> {
  const base=path.join(root,DRIVE_BACKUPS,drive.folder);
  for(const removal of removals) {
    checkAbort(signal);await contained(removal.path,root);
    const stat=await fs.lstat(removal.path,{bigint:true}).catch(error=>{if(code(error)==='ENOENT')return undefined;throw error;});
    if(!beneath(removal.path,base) || !stat?.isFile() || statKey(stat)!==removal.stat) throw new Error(`Destination file changed after review; review again: ${removal.path}`);
  }
  // Earlier versions held removals in a hidden folder; make it visible before adding to it.
  const legacy=path.join(root,DRIVE_BACKUPS,'.mirror-removed'),visible=path.join(root,DRIVE_BACKUPS,holding);
  if(await fs.lstat(legacy).then(stat=>stat.isDirectory()&&!stat.isSymbolicLink(),error=>{if(code(error)==='ENOENT')return false;throw error;})&&!await fs.lstat(visible).then(()=>true,error=>{if(code(error)==='ENOENT')return false;throw error;})){await contained(legacy,root);await fs.rename(legacy,visible);await syncDirectory(path.dirname(visible));}
  const held=path.join(root,DRIVE_BACKUPS,holding,`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`,drive.folder),parents=new Set<string>();
  let movedBytes=0;onProgress?.(0,0,'');
  for(const [position,removal] of removals.entries()) {
    checkAbort(signal);
    const target=path.join(held,path.relative(base,removal.path));await makeParent(target,root,rootIdentity);
    if(await fs.lstat(target).then(()=>true,error=>{if(code(error)==='ENOENT')return false;throw error;})) throw new Error(`Mirror holding path already exists: ${target}`);
    // The file that arrives is the one reviewed (its ctime moves with the rename, so the rest of its identity is compared).
    const unchanged=(key:string)=>key.slice(0,key.lastIndexOf(':'));
    if(await renameChecked(removal.path,target,after=>after.isFile()&&unchanged(statKey(after))===unchanged(removal.stat))!=='done') throw new Error(`Destination file could not be moved aside: ${removal.path}`);
    log('normal','mirror','moved-aside',{from:removal.path,to:target,bytes:removal.size,reason:'file no longer on the mirrored drive',proof:'reviewed removal whose stat was unchanged since review'});
    await syncParents(target,root);
    parents.add(path.dirname(removal.path));
    movedBytes+=removal.size;onProgress?.(position+1,movedBytes,path.basename(removal.path));
  }
  // Mirror the source's folder layout: drop folders the moves left empty.
  const emptied=new Set<string>();
  for(const folder of parents) for(let current=folder;beneath(current,base);current=path.dirname(current)) emptied.add(current);
  await removeEmptiedFolders(root,emptied,{bookkeeping:false,area:'mirror',after:'mirror removals moved their files aside'});
  return removals.length;
}
