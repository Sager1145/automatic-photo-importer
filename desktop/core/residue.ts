import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { BigIntStats, Dirent } from 'node:fs';
import { INDEX_PREFIX } from './destination-index';
import { leftoverReceipt } from './import-recovery';
import { deletingPattern, isRecoveryName, journalTerminal, pointerLeftover } from './recovery';
import { checkAbort, code, contained, sameStat } from './paths';

/** What a leftover is. resumable: a staged copy (and its receipt) that a re-import of its unchanged
 * source could continue; removing it only means copying that file again. kept: a staged copy not
 * proven dead (identity drift, no or unauthenticated receipt, card absent); only Clean up removes it.
 * partial: an incomplete staged copy whose authenticated receipt shows its source gone or changed.
 * recoverable: a complete staged copy whose source on the connected card changed or vanished; it may
 * be the only copy left, so neither the automatic check nor Clean up removes it. */
export type ResidueKind='partial'|'recoverable'|'resumable'|'kept'|'receipt'|'index'|'organization'|'folder'|'temporary';
export interface ResidueItem {path:string;kind:ResidueKind;bytes:number;/** The folder it was found under; it is removed only while still inside it. */root:string;stat:BigIntStats;}
export interface Residue {items:ResidueItem[];files:number;bytes:number;resumable:{files:number;bytes:number};/** Complete staged copies kept because their card file changed; folder is where the first was found. */recoverable:{files:number;bytes:number;folder?:string};}

// Only names this app creates: its prefix plus a random UUID (or mkdtemp's six characters).
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const stagePattern=new RegExp(`^(?:\\.import|photo-importer)-${UUID}\\.partial$`),receiptPattern=new RegExp(`^(?:\\.import|photo-importer)-(?:stage|intent)-${UUID}\\.json$`);
const indexTemporary=new RegExp(`^\\.?(?:${INDEX_PREFIX}|photo-importer-duplicates)-${UUID}\\.tmp$`),uuid=new RegExp(`^${UUID}$`);
const journalScratch=new RegExp(`^(?:stage-${UUID}\\.partial|incomplete-${UUID})$`);
const temporaryFolder=/^photo-importer-(?:camera|preview)-[A-Za-z0-9]{6}$/;

async function list(folder:string):Promise<Dirent[]> {
  try { return await fs.readdir(folder,{withFileTypes:true}); }
  catch(error) { if(['ENOENT','ENOTDIR','EACCES','EPERM'].includes(code(error)??'')) return []; throw error; }
}
async function regular(file:string):Promise<BigIntStats|undefined> {
  const stat=await fs.lstat(file,{bigint:true}).catch(()=>undefined);
  return stat?.isFile()?stat:undefined;
}
/** Bytes of a folder this app made in the temporary folder; links are counted, not followed. */
async function folderBytes(folder:string,signal?:AbortSignal):Promise<number> {
  let bytes=0;
  for(const entry of await list(folder)) {
    checkAbort(signal);
    const file=path.join(folder,entry.name);
    if(entry.isDirectory()) bytes+=await folderBytes(file,signal);
    else bytes+=Number((await fs.lstat(file,{bigint:true}).catch(()=>undefined))?.size??0n);
  }
  return bytes;
}

/** Staged copies, receipts and index files in one folder. A staged copy is the app's by its
 * name alone; a receipt only when it authenticates with this host's key. */
async function importLeftovers(folder:string,entries:Dirent[],root:string,items:ResidueItem[],signal?:AbortSignal):Promise<void> {
  const resumable=new Set<string>(),dead=new Set<string>(),recoverable=new Set<string>(),pending:{file:string;stat:BigIntStats;target?:string;resumable:boolean}[]=[];
  for(const entry of entries) {
    if(!entry.isFile()||!receiptPattern.test(entry.name)) continue;
    checkAbort(signal);
    const file=path.join(folder,entry.name),stat=await regular(file);
    if(!stat) continue;
    let receipt;
    // A receipt that cannot be read or authenticated (cut short by a kill, or altered) names nothing
    // reliably: it is listed as kept, so automatic cleanup leaves it and only Clean up removes it.
    try { receipt=await leftoverReceipt(file,root); } catch { items.push({path:file,kind:'kept',bytes:Number(stat.size),root,stat});continue; }
    // A publication receipt names a media path: while that file is there, the receipt is how a
    // re-import finishes it, and it is kept even when it no longer binds the file.
    if(receipt.kind==='publication'&&receipt.present) continue;
    if(receipt.resumable&&receipt.file) resumable.add(receipt.file);
    if(receipt.kind==='stage'&&receipt.owned&&receipt.stale&&receipt.file) (receipt.complete?recoverable:dead).add(receipt.file);
    pending.push({file,stat,resumable:receipt.resumable,...(receipt.kind==='stage'&&receipt.owned&&receipt.present&&receipt.file?{target:receipt.file}:{})});
  }
  // A receipt goes with its copy: kept while the copy is kept, removed once the copy is dead or gone.
  for(const {file,stat,target,resumable:binds} of pending)
    items.push({path:file,kind:binds?'resumable':target&&recoverable.has(target)?'recoverable':target&&!dead.has(target)?'kept':'receipt',bytes:Number(stat.size),root,stat});
  for(const entry of entries) {
    if(!entry.isFile()) continue;
    const file=path.join(folder,entry.name),staged=stagePattern.test(entry.name);
    if(!staged&&!indexTemporary.test(entry.name)) continue;
    const stat=await regular(file);
    if(stat) items.push({path:file,kind:!staged?'index':resumable.has(file)?'resumable':recoverable.has(file)?'recoverable':dead.has(file)?'partial':'kept',bytes:Number(stat.size),root,stat});
  }
}
/** In each organization journal: staged and preserved incomplete copies (never read again; the
 * original stays at its path or among the retained originals), and folders emptied when retained
 * originals were released. Journals and retained originals are never listed. */
async function journalLeftovers(storage:string,root:string,items:ResidueItem[],signal?:AbortSignal):Promise<void> {
  const folder=async(item:string)=>{const stat=await fs.lstat(item,{bigint:true}).catch(()=>undefined);if(stat)items.push({path:item,kind:'folder',bytes:0,root,stat});};
  // Pointers to journals in other backup folders that are finished, undone or gone, and their crash leftovers.
  for(const entry of await list(storage)) {
    if(!entry.isFile()||!entry.name.startsWith('journal-')) continue;
    checkAbort(signal);
    const file=path.join(storage,entry.name),stat=await pointerLeftover(path.dirname(storage),entry.name)?await regular(file):undefined;
    if(stat) items.push({path:file,kind:'organization',bytes:Number(stat.size),root,stat});
  }
  // A journal folder set aside by a deletion that stopped before it was gone.
  for(const entry of await list(storage)) {
    if(!entry.isDirectory()||!deletingPattern.test(entry.name)) continue;
    const aside=path.join(storage,entry.name),stat=await fs.lstat(aside,{bigint:true}).catch(()=>undefined);
    if(stat) items.push({path:aside,kind:'organization',bytes:await folderBytes(aside,signal),root,stat});
  }
  for(const job of await list(storage)) {
    if(!job.isDirectory()||!uuid.test(job.name)) continue;
    const jobPath=path.join(storage,job.name);
    for(const entry of await list(jobPath)) {
      checkAbort(signal);
      const file=path.join(jobPath,entry.name),stat=entry.isFile()&&journalScratch.test(entry.name)?await regular(file):undefined;
      if(stat) items.push({path:file,kind:'organization',bytes:Number(stat.size),root,stat});
    }
    // Empty slots of a pending journal are where its retained originals will go: only a finished journal's are leftovers.
    if(!await journalTerminal(path.dirname(storage),job.name)) continue;
    const originals=path.join(jobPath,'originals');let emptied=true,any=false;
    for(const index of await list(originals)) {
      any=true;
      if(!index.isDirectory()||!/^\d+$/.test(index.name)) {emptied=false;continue;}
      const indexPath=path.join(originals,index.name);let slots=0,empty=0;
      for(const slot of await list(indexPath)) {
        slots++;
        const slotPath=path.join(indexPath,slot.name);
        if(slot.isDirectory()&&uuid.test(slot.name)&&!(await list(slotPath)).length) {empty++;await folder(slotPath);}
      }
      if(slots===empty) await folder(indexPath); else emptied=false;
    }
    if(any&&emptied) await folder(originals);
  }
}
/** What a look through the backup folders has covered: entries seen, and top-level folders finished of the total
 * (the share the interface bars by). */
export interface ResidueScan {looked:number;done:number;total:number;file:string;}
async function walk(folder:string,root:string,items:ResidueItem[],signal?:AbortSignal,scan?:{state:ResidueScan;emit():void},top=false):Promise<void> {
  checkAbort(signal);
  const entries=await list(folder);
  if(scan){scan.state.looked+=entries.length;scan.state.file=path.relative(root,folder)||path.basename(root);scan.emit();}
  await importLeftovers(folder,entries,root,items,signal);
  if(scan&&top){scan.state.done++;scan.emit();}
  for(const entry of entries) {
    if(!entry.isDirectory()) continue;
    const child=path.join(folder,entry.name);
    if(isRecoveryName(entry.name)) await journalLeftovers(child,root,items,signal);
    // Other hidden folders (.Trashes, .Spotlight-V100, .mirror-removed…) are not this app's to clean.
    else if(!entry.name.startsWith('.')) await walk(child,root,items,signal,scan);
    if(scan&&top){scan.state.done++;scan.state.file=path.relative(root,child);scan.emit();}
  }
}

/** Folders in the temporary folder being used now; asked again right before each removal. */
type InUse=()=>string[];
const used=async(folder:string,inUse?:InUse)=>!!inUse&&(await Promise.all(inUse().map(item=>fs.realpath(item).catch(()=>item)))).includes(folder);
/** Read-only: the app's leftovers under each backup folder in `roots`, and its camera and preview
 * folders in `temporary` (the system temporary folder) other than those `inUse`. User files are
 * never listed, whatever their names. */
export async function findResidue(roots:string[],options:{temporary?:string;inUse?:InUse;signal?:AbortSignal;/** Hears how far the look has come, as it goes (the caller throttles). */onProgress?:(scan:ResidueScan)=>void}={}):Promise<Residue> {
  const items:ResidueItem[]=[];
  // Canonical paths, as removal checks every item is still inside its root (macOS /var is /private/var).
  const canonical=(folder:string)=>fs.realpath(folder).catch(()=>undefined);
  // Units: each backup folder's own files, each folder directly inside it, each leftover folder in the temporary folder.
  const reals:string[]=[];
  for(const root of roots){const real=await canonical(root);if(real)reals.push(real);}
  const temporary=options.temporary&&await canonical(options.temporary);
  const temporaryNames=temporary?(await list(temporary)).filter(entry=>entry.isDirectory()&&temporaryFolder.test(entry.name)).map(entry=>entry.name):[];
  const top=await Promise.all(reals.map(async real=>1+(await list(real)).filter(entry=>entry.isDirectory()).length));
  const state:ResidueScan={looked:0,done:0,total:top.reduce((sum,count)=>sum+count,0)+temporaryNames.length,file:''};
  const scan=options.onProgress&&{state,emit:()=>options.onProgress!({...state})};
  scan?.emit();
  for(const real of reals)await walk(real,real,items,options.signal,scan,true);
  if(temporary) for(const entry of await list(temporary)) {
    checkAbort(options.signal);
    const folder=path.join(temporary,entry.name);
    if(!entry.isDirectory()||!temporaryFolder.test(entry.name)||await used(folder,options.inUse)) continue;
    // A preview removes its own folder when it finishes.
    const stat=await fs.lstat(folder,{bigint:true}).catch(()=>undefined);
    if(stat) items.push({path:folder,kind:'temporary',bytes:await folderBytes(folder,options.signal),root:temporary,stat});
    state.done++;state.looked++;state.file=entry.name;scan?.emit();
  }
  return summary(items);
}
function summary(items:ResidueItem[]):Residue {
  const resumable=items.filter(item=>item.kind==='resumable'||item.kind==='kept');
  const sum=(list:ResidueItem[])=>list.reduce((total,item)=>total+item.bytes,0);
  // Counted by staged copy; the receipts that go with them are kept too but are not copies.
  const kept=items.filter(item=>item.kind==='recoverable'&&stagePattern.test(path.basename(item.path)));
  return {items,files:items.length,bytes:sum(items),resumable:{files:resumable.length,bytes:sum(resumable)},recoverable:{files:kept.length,bytes:sum(kept),...(kept[0]?{folder:path.dirname(kept[0].path)}:{})}};
}

/** Remove what findResidue listed, each only while it is still the very file or folder found.
 * Folders go only when empty. keepResumable leaves copies a re-import could continue and those not
 * proven dead. Recoverable copies are always left. */
export async function cleanResidue(residue:Residue,options:{keepResumable?:boolean;inUse?:InUse;signal?:AbortSignal;/** Hears each item as it is handled: items done of the total, bytes removed of the bytes to remove. */onProgress?:(done:number,total:number,bytes:number,totalBytes:number,file:string)=>void}={}):Promise<{removed:{files:number;bytes:number};left:Residue}> {
  const removed={files:0,bytes:0},left:ResidueItem[]=[];
  // Only what this run removes counts toward the total: kept copies are not work.
  const doomed=residue.items.filter(item=>item.kind!=='recoverable'&&!(options.keepResumable&&(item.kind==='resumable'||item.kind==='kept'))),doomedBytes=doomed.reduce((sum,item)=>sum+item.bytes,0);
  let handled=0,handledBytes=0;
  options.onProgress?.(0,doomed.length,0,doomedBytes,'');
  for(const item of residue.items) {
    checkAbort(options.signal);
    left.push(item);
    if(item.kind==='recoverable'||options.keepResumable&&(item.kind==='resumable'||item.kind==='kept')) continue;
    handled++;handledBytes+=item.bytes;
    try {
      await contained(item.path,item.root);
      const now=await fs.lstat(item.path,{bigint:true});
      if(item.kind==='folder'||item.kind==='temporary'||item.stat.isDirectory()) {
        if(!now.isDirectory()||now.dev!==item.stat.dev||now.ino!==item.stat.ino||item.kind==='temporary'&&await used(item.path,options.inUse)) continue;
        // Only folders found empty, or this app's own temporary and set-aside journal folders, are removed whole.
        if(item.kind==='folder') await fs.rmdir(item.path); else await fs.rm(item.path,{recursive:true});
      } else {
        if(!now.isFile()||!sameStat(now,item.stat)) continue;
        await fs.unlink(item.path);
      }
      left.pop();removed.files++;removed.bytes+=item.bytes;
    } catch { /* Gone, changed, in use or unavailable: left for a later check. */ }
    options.onProgress?.(handled,doomed.length,handledBytes,doomedBytes,path.basename(item.path));
  }
  return {removed,left:summary(left)};
}
