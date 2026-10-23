import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { BigIntStats, Dirent } from 'node:fs';
import { APP_DATA_FOLDER, maybeLstat, storesFor, storeUnchanged, type Store } from './app-store';
import { APPLEDOUBLE_MAX_BYTES, inspectAppleDouble } from './appledouble';
import { assessReceipt, closeReceipts, IMPORTS, isLegacyReceiptName, leftoverReceipt, openReceipts, readSegment, receiptSegments, removeSegmentIfDone, STAGING, stagePattern as stageName } from './import-recovery';
import { deleteOrganizationRecovery, deletingPattern, endedJournal, isRecoveryName, journalTerminal, ORGANIZATIONS, POINTERS, removeTree, storeJournals, storePointerLeftover } from './recovery';
import { log, logDeletion } from '../logger';
import { LIBRARIES } from './destination-index';
import { checkAbort, code, contained, digest, sameStat } from './paths';

/** What a leftover is. resumable: a staged copy (and its receipt) that a re-import of its unchanged
 * source could continue; removing it only means copying that file again. kept: a staged copy not
 * proven dead (identity drift, no or unauthenticated receipt, card absent); only Clean up removes it.
 * recoverable: a complete staged copy whose card file changed or vanished: it may be the only copy, so
 * nothing removes it. partial: a staged copy whose authenticated receipt shows its source gone or changed.
 * receipt: an earlier version's receipt file, or (with `rid`) an open receipt to close. segment: a receipt log
 * segment every receipt of which is closed. journal: an ended organization's records, deleted whole.
 * sidecar: a macOS "._" file in the records folder holding only bookkeeping. */
export type ResidueKind='partial'|'resumable'|'kept'|'recoverable'|'receipt'|'index'|'organization'|'folder'|'temporary'|'segment'|'journal'|'sidecar';
export interface ResidueItem {path:string;kind:ResidueKind;bytes:number;/** The folder it was found under; it is removed only while still inside it. */root:string;stat?:BigIntStats;
 /** Records v5: the store it is in, and the receipt to close once it is handled. */store?:Store;rid?:string;
 /** An ended organization (kind 'journal'). */journal?:{root:string;id:string};}
export interface Residue {items:ResidueItem[];files:number;bytes:number;resumable:{files:number;bytes:number};/** Complete staged copies kept because their card file changed; folder is where the first was found. */recoverable:{files:number;bytes:number;folder?:string};}

// Only names this app creates: its prefix plus a random UUID (or mkdtemp's six characters).
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const legacyStage=new RegExp(`^(?:\\.import|photo-importer)-${UUID}\\.partial$`);
const legacyIndexTemporary=new RegExp(`^\\.?(?:photo-importer-index|photo-importer-duplicates)-${UUID}\\.tmp$`),uuid=new RegExp(`^${UUID}$`);
const storeIndexTemporary=new RegExp(`^(?:index|duplicates)-${UUID}\\.tmp$`);
const journalScratch=new RegExp(`^(?:stage-${UUID}\\.partial|incomplete-${UUID})$`);
const temporaryFolder=/^photo-importer-(?:camera|preview)-[A-Za-z0-9]{6}$/;
/** An index or duplicate-store temp file younger than this may belong to a flush still writing it. */
const TEMPORARY_AGE_MS=60*60*1000;

async function list(folder:string):Promise<Dirent[]> {
  try { return await fs.readdir(folder,{withFileTypes:true}); }
  catch(error) { if(['ENOENT','ENOTDIR','EACCES','EPERM'].includes(code(error)??'')) return []; throw error; }
}
async function regular(file:string):Promise<BigIntStats|undefined> {
  const stat=await fs.lstat(file,{bigint:true}).catch(()=>undefined);
  return stat?.isFile()?stat:undefined;
}
/** Bytes and files of a folder this app made; links are counted, not followed. */
async function folderBytes(folder:string,signal?:AbortSignal,onEntry?:(name:string)=>void):Promise<number> {
  let bytes=0;
  for(const entry of await list(folder)) {
    checkAbort(signal);
    const file=path.join(folder,entry.name);
    if(entry.isDirectory()) bytes+=await folderBytes(file,signal,onEntry);
    else {bytes+=Number((await fs.lstat(file,{bigint:true}).catch(()=>undefined))?.size??0n);onEntry?.(entry.name);}
  }
  return bytes;
}
/** A macOS "._" file that holds only bookkeeping (no resource fork, Finder info or comments). */
async function bookkeepingSidecar(file:string):Promise<BigIntStats|undefined>{
  const stat=await regular(file);if(!stat||stat.size>BigInt(APPLEDOUBLE_MAX_BYTES))return undefined;
  const bytes=await fs.readFile(file).catch(()=>undefined);
  return bytes&&inspectAppleDouble(bytes).safe?stat:undefined;
}

/** What a look has covered: entries seen, and units finished of the total (the share the interface bars by). */
export interface ResidueScan {looked:number;done:number;total:number;file:string;}
type Scan={state:ResidueScan;emit():void}|undefined;
const saw=(scan:Scan,count:number,file:string)=>{if(scan){scan.state.looked+=count;scan.state.file=file;scan.emit();}};

/** One store's leftovers. Receipts: an open stage receipt whose copy is dead (card present, source gone or changed)
 * and incomplete; one whose file is gone; a publication receipt whose file is complete (size and SHA-256). Staged
 * copies with no open receipt are kept (Clean up only); complete dead copies are recoverable (never removed).
 * Segments every receipt of which is closed, oldest first. Organization scratch, set-aside deletions and emptied
 * kept-original folders; pointers whose journal is gone, finished or not this folder's; index temp files over an
 * hour old; bookkeeping-only "._" files; and ended journals with no kept original, those that name them first. */
async function storeLeftovers(store:Store,items:ResidueItem[],signal?:AbortSignal,scan?:Scan):Promise<void> {
  await storeUnchanged(store);
  const root=store.path;
  // Receipts and staged copies.
  const open=await openReceipts(store,signal),owned=new Set<string>();
  saw(scan,open.size,IMPORTS);
  for(const [rid,record] of open){
    checkAbort(signal);
    let found;try{found=await assessReceipt(store,record);}catch{continue;}
    if(!found.owned)continue;
    owned.add(found.file);
    if(!found.present){items.push({path:found.file,kind:'receipt',bytes:0,root:record.kind==='stage'?root:record.root,store,rid});continue;}
    const stat=found.stat!,bytes=Number(stat.size),scope=record.kind==='stage'?root:record.root;
    if(record.kind==='publication'){
      // A complete publication: its receipt has nothing left to finish. Anything else is how a re-import finishes it.
      if(found.complete&&record.sha256&&await digest(found.file,signal).then(sha=>sha===record.sha256,()=>false))items.push({path:found.file,kind:'receipt',bytes:0,root:scope,stat,store,rid});
      continue;
    }
    const kind:ResidueKind=found.resumable?'resumable':found.stale&&found.complete?'recoverable':found.stale&&found.bound?'partial':'kept';
    if(found.stale)log('detailed','residue','classified',{file:found.file,kind,reason:kind==='recoverable'?'complete staged copy whose card file changed or vanished':kind==='partial'?'incomplete staged copy whose source changed':'staged copy not proven to be this receipt\'s'});
    items.push({path:found.file,kind,bytes,root:scope,stat,store,rid});
  }
  const staging=path.join(root,IMPORTS,STAGING);
  for(const entry of await list(staging)){
    checkAbort(signal);
    const file=path.join(staging,entry.name);
    if(!entry.isFile()||!stageName.test(entry.name)||owned.has(file))continue;
    const stat=await regular(file);if(stat)items.push({path:file,kind:'kept',bytes:Number(stat.size),root,stat});
  }
  // Segments: oldest first, while every receipt each opens is closed (later segments included), each closes only
  // what it opened, and none holds a line that is JSON but fails its seal.
  const segments=await receiptSegments(store),facts:{file:string;opened:Set<string>;closed:Set<string>;bad:boolean;bytes:number;stat:BigIntStats}[]=[];
  for(const file of segments){
    const fact={file,opened:new Set<string>(),closed:new Set<string>(),bad:false,bytes:0,stat:(await fs.lstat(file,{bigint:true}))};fact.bytes=Number(fact.stat.size);
    await readSegment(file,line=>{if(line?.op==='bad')fact.bad=true;else if(line?.op==='open')fact.opened.add(line.rid);else if(line?.op==='close')fact.closed.add(line.rid);},signal);
    facts.push(fact);
  }
  // The last segment is where appends go; a close in a segment matters only for a receipt opened in a later one.
  for(const [position,fact] of facts.slice(0,-1).entries()){
    const later=new Set(facts.slice(position+1).flatMap(item=>[...item.opened]));
    if(fact.bad||[...fact.closed].some(rid=>!fact.opened.has(rid)&&later.has(rid))||[...fact.opened].some(rid=>open.has(rid)))break;
    items.push({path:fact.file,kind:'segment',bytes:fact.bytes,root,stat:fact.stat,store});
  }
  // Organization records.
  const organizations=path.join(root,ORGANIZATIONS),folder=async(item:string)=>{const stat=await fs.lstat(item,{bigint:true}).catch(()=>undefined);if(stat)items.push({path:item,kind:'folder',bytes:0,root,stat});};
  const entries=await list(organizations);saw(scan,entries.length,ORGANIZATIONS);
  for(const entry of entries){
    checkAbort(signal);
    const job=path.join(organizations,entry.name);
    if(entry.isDirectory()&&deletingPattern.test(entry.name)){const stat=await fs.lstat(job,{bigint:true}).catch(()=>undefined);if(stat)items.push({path:job,kind:'organization',bytes:await folderBytes(job,signal,name=>saw(scan,1,name)),root,stat});continue;}
    if(!entry.isDirectory()||!uuid.test(entry.name))continue;
    for(const inner of await list(job)){
      const file=path.join(job,inner.name),stat=inner.isFile()&&journalScratch.test(inner.name)?await regular(file):undefined;
      if(stat)items.push({path:file,kind:'organization',bytes:Number(stat.size),root,stat});
    }
  }
  const journals=await storeJournals(store);
  for(const [position,{id,root:library}] of journals.entries()){
    // Empty slots of a pending journal are where its kept originals will go: only a finished journal's are leftovers.
    // Each journal read counts the records it reads, so the look keeps moving.
    if(!await journalTerminal(library,id,(read,total)=>saw(scan,1,`journal ${position+1} of ${journals.length} · ${read}/${total}`)))continue;
    const originals=path.join(organizations,id,'originals');let emptied=true,any=false;
    for(const index of await list(originals)){
      any=true;
      if(!index.isDirectory()||!/^\d+$/.test(index.name)){emptied=false;continue;}
      const indexPath=path.join(originals,index.name);let slots=0,empty=0;
      for(const slot of await list(indexPath)){
        slots++;
        const slotPath=path.join(indexPath,slot.name);
        if(slot.isDirectory()&&uuid.test(slot.name)&&!(await list(slotPath)).length){empty++;await folder(slotPath);}
      }
      if(slots===empty)await folder(indexPath);else emptied=false;
    }
    if(any&&emptied)await folder(originals);
  }
  // Ended journals with no kept original. One goes only after every journal that still names it, so the list is
  // built dependents first; one named by a journal that is not going stays.
  const candidates=new Map<string,{root:string;needs:string[]}>();
  for(const {id,root:library} of journals){checkAbort(signal);const needs=await endedJournal(library,id);if(needs)candidates.set(id,{root:library,needs});}
  const going:string[]=[];
  for(let grew=true;grew;){
    grew=false;
    for(const [id,{needs}] of candidates)if(!going.includes(id)&&needs.every(other=>going.includes(other))){going.push(id);grew=true;}
  }
  for(const id of going){
    const job=path.join(organizations,id),stat=await fs.lstat(job,{bigint:true}).catch(()=>undefined);
    if(stat)items.push({path:job,kind:'journal',bytes:await folderBytes(job,signal),root,stat,store,journal:{root:candidates.get(id)!.root,id}});
  }
  // Pointers.
  const pointers=path.join(root,POINTERS);
  for(const partition of await list(pointers)){
    if(!partition.isDirectory())continue;
    for(const entry of await list(path.join(pointers,partition.name))){
      checkAbort(signal);
      const file=path.join(pointers,partition.name,entry.name);
      if(!entry.isFile()||!entry.name.startsWith('journal-'))continue;
      const stat=await storePointerLeftover(store,file)?await regular(file):undefined;
      if(stat)items.push({path:file,kind:'organization',bytes:Number(stat.size),root,stat});
    }
  }
  // Index and duplicate-store temp files a flush left, once old enough that none is still writing them.
  const libraries=path.join(root,LIBRARIES);
  for(const partition of await list(libraries)){
    if(!partition.isDirectory())continue;
    for(const entry of await list(path.join(libraries,partition.name))){
      const file=path.join(libraries,partition.name,entry.name),stat=entry.isFile()&&storeIndexTemporary.test(entry.name)?await regular(file):undefined;
      if(stat&&Date.now()-Number(stat.mtimeNs/1000000n)>TEMPORARY_AGE_MS)items.push({path:file,kind:'index',bytes:Number(stat.size),root,stat});
    }
  }
  // macOS "._" files in the store, outside kept originals (theirs stay with the originals), and the one beside the store.
  const sidecars=async(directory:string):Promise<void>=>{
    for(const entry of await list(directory)){
      const file=path.join(directory,entry.name);
      if(entry.isDirectory()){if(!(entry.name==='originals'&&path.dirname(directory)===organizations))await sidecars(file);continue;}
      if(!entry.isFile()||!entry.name.startsWith('._'))continue;
      const stat=await bookkeepingSidecar(file);if(stat)items.push({path:file,kind:'sidecar',bytes:Number(stat.size),root,stat});
    }
  };
  await sidecars(root);
  const beside=path.join(store.base,`._${APP_DATA_FOLDER}`),besideStat=await bookkeepingSidecar(beside);
  if(besideStat)items.push({path:beside,kind:'sidecar',bytes:Number(besideStat.size),root:store.base,stat:besideStat});
}

/** The earlier version's leftovers in one folder (Clean up only): staged copies, receipts and index files. A staged
 * copy is the app's by its name alone; a receipt only when it authenticates with this host's key. */
async function legacyImportLeftovers(folder:string,entries:Dirent[],root:string,items:ResidueItem[],signal?:AbortSignal):Promise<void> {
  const resumable=new Set<string>(),dead=new Set<string>(),recoverable=new Set<string>(),pending:{file:string;stat:BigIntStats;target?:string;resumable:boolean}[]=[];
  for(const entry of entries) {
    if(!entry.isFile()||!isLegacyReceiptName(entry.name)) continue;
    checkAbort(signal);
    const file=path.join(folder,entry.name),stat=await regular(file);
    if(!stat) continue;
    let receipt;
    // A receipt that cannot be read or authenticated (cut short by a kill, or altered) names nothing reliably: kept.
    try { receipt=await leftoverReceipt(file,root); } catch { items.push({path:file,kind:'kept',bytes:Number(stat.size),root,stat});continue; }
    // A publication receipt names a media path: while that file is there, the receipt is how a re-import finishes it.
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
    const file=path.join(folder,entry.name),staged=legacyStage.test(entry.name);
    if(!staged&&!legacyIndexTemporary.test(entry.name)) continue;
    const stat=await regular(file);
    if(stat) items.push({path:file,kind:!staged?'index':resumable.has(file)?'resumable':recoverable.has(file)?'recoverable':dead.has(file)?'partial':'kept',bytes:Number(stat.size),root,stat});
  }
}
/** The earlier version's import leftovers under a backup folder (Clean up only). Record folders, old and new, are
 * skipped: the converter owns the old ones, and the store is looked at on its own. */
async function legacyWalk(folder:string,root:string,items:ResidueItem[],signal?:AbortSignal,scan?:Scan,top=false):Promise<void> {
  checkAbort(signal);
  const entries=await list(folder);
  saw(scan,entries.length,path.relative(root,folder)||path.basename(root));
  await legacyImportLeftovers(folder,entries,root,items,signal);
  if(scan&&top){scan.state.done++;scan.emit();}
  for(const entry of entries) {
    if(!entry.isDirectory()) continue;
    const child=path.join(folder,entry.name);
    // Other hidden folders (.Trashes, .Spotlight-V100, .mirror-removed…) are not this app's to clean.
    if(!isRecoveryName(entry.name)&&!entry.name.startsWith('.')) await legacyWalk(child,root,items,signal,scan);
    if(scan&&top){scan.state.done++;scan.state.file=path.relative(root,child);scan.emit();}
  }
}

/** Folders in the temporary folder being used now; asked again right before each removal. */
type InUse=()=>string[];
const used=async(folder:string,inUse?:InUse)=>!!inUse&&(await Promise.all(inUse().map(item=>fs.realpath(item).catch(()=>item)))).includes(folder);
/** Read-only: the app's leftovers in the records folders of the backup folders in `roots` (every store readers
 * consult for them), and its camera and preview folders in `temporary` (the system temporary folder) other than
 * those `inUse`. With `legacy` (Clean up), also what the earlier version left in the backup folders themselves.
 * User files are never listed, whatever their names. */
export async function findResidue(roots:string[],options:{temporary?:string;inUse?:InUse;signal?:AbortSignal;legacy?:boolean;/** Hears how far the look has come, as it goes (the caller throttles). */onProgress?:(scan:ResidueScan)=>void}={}):Promise<Residue> {
  const items:ResidueItem[]=[];
  // Canonical paths, as removal checks every item is still inside its root (macOS /var is /private/var).
  const canonical=(folder:string)=>fs.realpath(folder).catch(()=>undefined);
  const reals:string[]=[];
  for(const root of roots){const real=await canonical(root);if(real&&!reals.includes(real))reals.push(real);}
  const stores=new Map<string,Store>();
  for(const real of reals)for(const store of await storesFor(real).catch(()=>[] as Store[]))stores.set(store.path,store);
  const temporary=options.temporary&&await canonical(options.temporary);
  const temporaryNames=temporary?(await list(temporary)).filter(entry=>entry.isDirectory()&&temporaryFolder.test(entry.name)).map(entry=>entry.name):[];
  // Units: each store, (with legacy) each backup folder's own files and each folder directly inside it, each leftover folder in the temporary folder.
  const top=options.legacy?await Promise.all(reals.map(async real=>1+(await list(real)).filter(entry=>entry.isDirectory()).length)):[];
  const state:ResidueScan={looked:0,done:0,total:stores.size+top.reduce((sum,count)=>sum+count,0)+temporaryNames.length,file:''};
  const scan=options.onProgress&&{state,emit:()=>options.onProgress!({...state})};
  scan?.emit();
  for(const store of stores.values()){
    await storeLeftovers(store,items,options.signal,scan).catch(error=>{if((error as Error)?.name==='AbortError')throw error;/* A store that changed or cannot be read is looked at again next time. */});
    state.done++;state.file=path.basename(store.base);scan?.emit();
  }
  if(options.legacy)for(const real of reals)await legacyWalk(real,real,items,options.signal,scan,true);
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
const keptKinds=new Set<ResidueKind>(['resumable','kept','recoverable']);
const residueReason=(kind:string)=>kind==='resumable'?'interrupted copy a re-import could continue (Clean up)':kind==='kept'?'kept copy, removed by Clean up':kind==='temporary'?'leftover temporary folder of an earlier run':kind==='folder'?'empty leftover folder':kind==='sidecar'?'macOS "._" file in the records folder holding only bookkeeping':kind==='segment'?'receipt log segment whose receipts are all closed':'leftover of an interrupted run (staging file, receipt or scratch file)';
function summary(items:ResidueItem[]):Residue {
  // A receipt to close is not a file the user has; it is still done by the next cleanup.
  const counted=items.filter(item=>!(item.kind==='receipt'&&item.rid));
  const resumable=counted.filter(item=>item.kind==='resumable'||item.kind==='kept'),recoverable=counted.filter(item=>item.kind==='recoverable');
  const sum=(list:ResidueItem[])=>list.reduce((total,item)=>total+item.bytes,0);
  return {items,files:counted.length,bytes:sum(counted),resumable:{files:resumable.length,bytes:sum(resumable)},recoverable:{files:recoverable.length,bytes:sum(recoverable),...(recoverable[0]?{folder:path.dirname(recoverable[0].path)}:{})}};
}

/** Remove what findResidue listed, each only while it is still the very file or folder found. Folders go only
 * when empty. keepResumable leaves copies a re-import could continue and those not proven dead. Recoverable copies
 * are never removed. Receipts are closed after their file is gone, a store's together in one append. */
export async function cleanResidue(residue:Residue,options:{keepResumable?:boolean;inUse?:InUse;signal?:AbortSignal;/** Hears each item as it is handled: items done of the total, bytes removed of the bytes to remove. */onProgress?:(done:number,total:number,bytes:number,totalBytes:number,file:string)=>void}={}):Promise<{removed:{files:number;bytes:number};left:Residue}> {
  const removed={files:0,bytes:0},left:ResidueItem[]=[];
  const keeps=(item:ResidueItem)=>item.kind==='recoverable'||(options.keepResumable===true&&keptKinds.has(item.kind));
  // Only what this run removes counts toward the total: kept copies are not work.
  const doomed=residue.items.filter(item=>!keeps(item)),doomedBytes=doomed.reduce((sum,item)=>sum+item.bytes,0);
  let handled=0,handledBytes=0;
  const closes=new Map<string,{store:Store;rids:string[]}>(),close=(item:ResidueItem)=>{if(item.store&&item.rid){const entry=closes.get(item.store.path)??{store:item.store,rids:[]};entry.rids.push(item.rid);closes.set(item.store.path,entry);}};
  options.onProgress?.(0,doomed.length,0,doomedBytes,'');
  // Ended journals last, dependents first (the order they were listed in).
  const ordered=[...residue.items.filter(item=>item.kind!=='journal'),...residue.items.filter(item=>item.kind==='journal')];
  for(const item of ordered) {
    checkAbort(options.signal);
    left.push(item);
    if(keeps(item)) {log('detailed','residue','kept',{path:item.path,kind:item.kind,bytes:item.bytes,reason:item.kind==='recoverable'?'complete staged copy whose card file changed or vanished; never removed':'copy a re-import could continue'});continue;}
    handled++;handledBytes+=item.bytes;
    try {
      if(item.kind==='journal'&&item.journal){
        await deleteOrganizationRecovery(item.journal.root,item.journal.id,options.signal,undefined,{automatic:true});
        left.pop();removed.files++;removed.bytes+=item.bytes;
      } else if(item.kind==='segment'&&item.store){
        if(await removeSegmentIfDone(item.store,item.path,options.signal)){logDeletion('residue',item.path,residueReason(item.kind),'oldest segment, not the one appends go to; read again while no append could start: every receipt it opens is closed, none it closes is opened later, no line fails its seal',{kind:item.kind,bytes:item.bytes});left.pop();removed.files++;removed.bytes+=item.bytes;}
      } else if(item.kind==='receipt'&&item.rid){
        // Close only while what made it closable still holds: its file gone, or the complete file found unchanged.
        const now=await maybeLstat(item.path);
        if(item.stat?now&&sameStat(now,item.stat):!now){close(item);left.pop();log('detailed','residue','receipt-closed',{rid:item.rid,file:item.path,reason:item.stat?'its file is complete (size and SHA-256) and unchanged':'its file is gone'});}
      } else {
        await contained(item.path,item.root);
        const now=await fs.lstat(item.path,{bigint:true});
        if(item.kind==='folder'||item.kind==='temporary'||item.stat?.isDirectory()) {
          if(!now.isDirectory()||now.dev!==item.stat?.dev||now.ino!==item.stat?.ino||item.kind==='temporary'&&await used(item.path,options.inUse)) continue;
          // Only folders found empty, or this app's own temporary and set-aside journal folders, are removed whole.
          if(item.kind==='folder') await fs.rmdir(item.path); else await removeTree(item.path,options.signal,()=>options.onProgress?.(handled,doomed.length,handledBytes,doomedBytes,path.basename(item.path)));
          logDeletion('residue',item.path,residueReason(item.kind),item.kind==='folder'?'directory is still the one found by the scan (same device and inode) and rmdir only removes empty folders':`directory is still the one found by the scan (same device and inode) and is this app's own ${item.kind==='temporary'?'temporary':'set-aside'} folder, not in use`,{kind:item.kind,bytes:item.bytes,folder:true});
        } else {
          if(!now.isFile()||!item.stat||!sameStat(now,item.stat)) continue;
          if(item.kind==='sidecar'&&!await bookkeepingSidecar(item.path)) continue;
          await fs.unlink(item.path);
          logDeletion('residue',item.path,residueReason(item.kind),item.kind==='sidecar'?'still the file found (same device, inode, size and times) and holds only bookkeeping':'file is still the one found by the scan: same device, inode, size and modification time',{kind:item.kind,bytes:item.bytes});
        }
        close(item);
        left.pop();removed.files++;removed.bytes+=item.bytes;
      }
    } catch(error) { if((error as Error)?.name==='AbortError') throw error; log('detailed','residue','left',{path:item.path,kind:item.kind,error}); /* Gone, changed, in use or unavailable: left for a later check. */ }
    options.onProgress?.(handled,doomed.length,handledBytes,doomedBytes,path.basename(item.path));
  }
  for(const {store,rids} of closes.values())await closeReceipts(store,rids).catch(()=>{/* Closed by a later check: its file is gone. */});
  return {removed,left:summary(left)};
}
