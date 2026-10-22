import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { BigIntStats, Dirent } from 'node:fs';
import { INDEX_PREFIX } from './destination-index';
import { leftoverReceipt } from './import-recovery';
import { RECOVERY_STORAGE } from './recovery';
import { checkAbort, code, contained, sameStat } from './paths';

/** What a leftover is. resumable: a staged copy (and its receipt) that a re-import of its unchanged
 * source could continue; removing it only means copying that file again. */
export type ResidueKind='partial'|'resumable'|'receipt'|'index'|'organization'|'folder'|'temporary';
export interface ResidueItem {path:string;kind:ResidueKind;bytes:number;/** The folder it was found under; it is removed only while still inside it. */root:string;stat:BigIntStats;}
export interface Residue {items:ResidueItem[];files:number;bytes:number;resumable:{files:number;bytes:number};}

// Only names this app creates: its prefix plus a random UUID (or mkdtemp's six characters).
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const stagePattern=new RegExp(`^\\.import-${UUID}\\.partial$`),receiptPattern=new RegExp(`^\\.import-(?:stage|intent)-${UUID}\\.json$`);
const indexTemporary=new RegExp(`^${INDEX_PREFIX.replace(/\./g,'\\.')}-${UUID}\\.tmp$`),uuid=new RegExp(`^${UUID}$`);
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
  const resumable=new Set<string>();
  for(const entry of entries) {
    if(!entry.isFile()||!receiptPattern.test(entry.name)) continue;
    checkAbort(signal);
    const file=path.join(folder,entry.name),stat=await regular(file);
    if(!stat) continue;
    let receipt;
    try { receipt=await leftoverReceipt(file,root); } catch { continue; }
    // A publication receipt names a media path: while that file is there, the receipt is how a
    // re-import finishes it, and it is kept even when it no longer binds the file.
    if(receipt.kind==='publication'&&receipt.present) continue;
    if(receipt.resumable&&receipt.file) resumable.add(receipt.file);
    items.push({path:file,kind:receipt.resumable?'resumable':'receipt',bytes:Number(stat.size),root,stat});
  }
  for(const entry of entries) {
    if(!entry.isFile()) continue;
    const file=path.join(folder,entry.name),staged=stagePattern.test(entry.name);
    if(!staged&&!indexTemporary.test(entry.name)) continue;
    const stat=await regular(file);
    if(stat) items.push({path:file,kind:!staged?'index':resumable.has(file)?'resumable':'partial',bytes:Number(stat.size),root,stat});
  }
}
/** In each organization journal: staged and preserved incomplete copies (never read again; the
 * original stays at its path or among the retained originals), and folders emptied when retained
 * originals were released. Journals and retained originals are never listed. */
async function journalLeftovers(storage:string,root:string,items:ResidueItem[],signal?:AbortSignal):Promise<void> {
  const folder=async(item:string)=>{const stat=await fs.lstat(item,{bigint:true});items.push({path:item,kind:'folder',bytes:0,root,stat});};
  for(const job of await list(storage)) {
    if(!job.isDirectory()||!uuid.test(job.name)) continue;
    const jobPath=path.join(storage,job.name);
    for(const entry of await list(jobPath)) {
      checkAbort(signal);
      const file=path.join(jobPath,entry.name),stat=entry.isFile()&&journalScratch.test(entry.name)?await regular(file):undefined;
      if(stat) items.push({path:file,kind:'organization',bytes:Number(stat.size),root,stat});
    }
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
async function walk(folder:string,root:string,items:ResidueItem[],signal?:AbortSignal):Promise<void> {
  checkAbort(signal);
  const entries=await list(folder);
  await importLeftovers(folder,entries,root,items,signal);
  for(const entry of entries) {
    if(!entry.isDirectory()) continue;
    const child=path.join(folder,entry.name);
    if(entry.name===RECOVERY_STORAGE) await journalLeftovers(child,root,items,signal);
    // Other hidden folders (.Trashes, .Spotlight-V100, .mirror-removed…) are not this app's to clean.
    else if(!entry.name.startsWith('.')) await walk(child,root,items,signal);
  }
}

/** Read-only: the app's leftovers under each backup folder in `roots`, and its camera and preview
 * folders in `temporary` (the system temporary folder) other than those `inUse`. User files are
 * never listed, whatever their names. */
export async function findResidue(roots:string[],options:{temporary?:string;inUse?:string[];signal?:AbortSignal}={}):Promise<Residue> {
  const items:ResidueItem[]=[];
  // Canonical paths, as removal checks every item is still inside its root (macOS /var is /private/var).
  const canonical=(folder:string)=>fs.realpath(folder).catch(()=>undefined);
  for(const root of roots){const real=await canonical(root);if(real)await walk(real,real,items,options.signal);}
  const temporary=options.temporary&&await canonical(options.temporary),inUse=new Set(await Promise.all((options.inUse??[]).map(canonical)));
  if(temporary) for(const entry of await list(temporary)) {
    checkAbort(options.signal);
    const folder=path.join(temporary,entry.name);
    if(!entry.isDirectory()||!temporaryFolder.test(entry.name)||inUse.has(folder)) continue;
    const stat=await fs.lstat(folder,{bigint:true});
    items.push({path:folder,kind:'temporary',bytes:await folderBytes(folder,options.signal),root:temporary,stat});
  }
  return summary(items);
}
function summary(items:ResidueItem[]):Residue {
  const resumable=items.filter(item=>item.kind==='resumable');
  const sum=(list:ResidueItem[])=>list.reduce((total,item)=>total+item.bytes,0);
  return {items,files:items.length,bytes:sum(items),resumable:{files:resumable.length,bytes:sum(resumable)}};
}

/** Remove what findResidue listed, each only while it is still the very file or folder found.
 * Folders go only when empty. keepResumable leaves copies a re-import could continue. */
export async function cleanResidue(residue:Residue,options:{keepResumable?:boolean;signal?:AbortSignal}={}):Promise<{removed:{files:number;bytes:number};left:Residue}> {
  const removed={files:0,bytes:0},left:ResidueItem[]=[];
  for(const item of residue.items) {
    checkAbort(options.signal);
    left.push(item);
    if(options.keepResumable&&item.kind==='resumable') continue;
    try {
      await contained(item.path,item.root);
      const now=await fs.lstat(item.path,{bigint:true});
      if(item.kind==='folder'||item.kind==='temporary') {
        if(!now.isDirectory()||now.dev!==item.stat.dev||now.ino!==item.stat.ino) continue;
        if(item.kind==='folder') await fs.rmdir(item.path); else await fs.rm(item.path,{recursive:true});
      } else {
        if(!now.isFile()||!sameStat(now,item.stat)) continue;
        await fs.unlink(item.path);
      }
      left.pop();removed.files++;removed.bytes+=item.bytes;
    } catch { /* Gone, changed, in use or unavailable: left for a later check. */ }
  }
  return {removed,left:summary(left)};
}
