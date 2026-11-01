import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { PlanEntry, Progress, TransferPlan } from '../shared';
import { executeMany, keepBothDestination, type ExecutionOptions, type FileOutcome } from './index';
import { beginDuplicateRemoval, type OrganizationEntry } from './recovery';
import { checkAbort, contained, digest, isAbort, pathKey } from './paths';
import { log } from '../logger';

/** One same-name conflict the user chose to act on. `entry` is the file as the import planned it, its destination the
 * library file that already holds the same bytes (`existing`, SHA-256 `sha256`). */
export interface ConflictWork {id:string;choice:'keep'|'overwrite';entry:PlanEntry;existing:string;sha256:string;transfer:Pick<TransferPlan,'source'|'root'|'rootIdentity'>;}
/** copy: where the verified copy is (keep). journal: the duplicate removal journal whose Undo puts the replaced file back (overwrite). */
export interface ConflictOutcome {id:string;ok:boolean;copy?:string;journal?:string;error?:string;}

const failure=(error:unknown)=>error instanceof Error?error.message:String(error);

/** `file` under the name its folder lists it by: on a system that ignores case, a file found as dsc00003.jpg may be listed as
 * DSC00003.JPG, and that is the name shown, set aside and given back. `listings` caches each folder's names (one read per folder). */
export async function nameOnDisk(file:string,listings=new Map<string,Promise<string[]>>()):Promise<string> {
  const folder=path.dirname(file),name=path.basename(file);
  let names=listings.get(folder);
  if(!names){names=fs.readdir(folder).catch(()=>[]);listings.set(folder,names);}
  const listed=await names;
  if(listed.includes(name))return file;
  const same=listed.filter(other=>pathKey(other)===pathKey(name));
  return same.length===1?path.join(folder,same[0]!):file;
}

/** Apply Keep both and Overwrite to conflicts of a finished import. The source is only read, never changed (a camera or
 * its card included). Keep both copies the file, verified, under the conflict naming. Overwrite does the same first, then
 * reads the library file again (that one file only) and, while it still holds the same bytes, sets it aside in recovery
 * storage through a duplicate removal journal whose kept copy then takes its name: Undo of that journal puts it back.
 * Nothing is overwritten or deleted outright; each item's result is reported on its own. */
export async function applyConflictChoices(work:ConflictWork[],options:{signal?:AbortSignal;onProgress?:(progress:Progress)=>void;execution?:Omit<ExecutionOptions,'onFileOutcome'|'paused'>}={}):Promise<ConflictOutcome[]> {
  const {signal}=options,results=new Map<string,ConflictOutcome>();
  const fail=(item:ConflictWork,error:unknown)=>{results.set(item.id,{id:item.id,ok:false,error:failure(error)});log('normal','conflicts','failed',{source:item.entry.source,existing:item.existing,choice:item.choice,error:failure(error)});};
  // Each file copies under its conflict name, as a family of its own; files of one source and library copy together.
  const copies=new Map<string,{transfer:TransferPlan;items:Map<string,ConflictWork>}>();
  for(let item of work) {
    checkAbort(signal);
    try {
      item={...item,existing:await nameOnDisk(item.existing)};
      await contained(item.existing,item.transfer.root);
      // Overwrite copies beside the library file, numbered, so the copy takes its name in the same folder (and Undo puts it back there).
      const entry=item.choice==='overwrite'?{...item.entry,allocation:{destination:item.existing,folder:path.dirname(item.existing),conflictNaming:'number' as const}}:item.entry;
      const destination=await keepBothDestination(entry,item.sha256,item.transfer.root,item.existing),key=`${item.transfer.source}\0${item.transfer.root}`;
      let group=copies.get(key);
      if(!group){group={transfer:{...item.transfer,entries:[]},items:new Map()};copies.set(key,group);}
      const id=`conflict:${item.id}`;
      group.transfer.entries.push({...entry,id,family:id,destination,skip:false,digest:item.sha256,routed:undefined});
      group.items.set(id,item);
    } catch(error) { if(isAbort(error))throw error; fail(item,error); }
  }
  const groups=[...copies.values()],placed=new Map<string,FileOutcome>();
  if(groups.length) {
    const executed=await executeMany(groups.map(group=>group.transfer),signal,(_index,progress)=>options.onProgress?.(progress),{...options.execution,onFileOutcome:outcome=>placed.set(outcome.entryId,outcome)});
    for(const [index,group] of groups.entries()) {
      const result=executed[index]!,error=result instanceof Error?result.message:result.errors[0];
      for(const [id,item] of group.items) {
        const outcome=placed.get(id);
        // The copy must hold exactly the bytes the conflict was confirmed with: the card file did not change since.
        if(!outcome)fail(item,error??'The file was not copied');
        else if(outcome.sha256!==item.sha256)fail(item,`The source changed since it was compared: ${item.entry.source}`);
        else if(item.choice==='keep'){results.set(item.id,{id:item.id,ok:true,copy:outcome.destination});log('normal','conflicts','kept-both',{source:item.entry.source,existing:item.existing,copy:outcome.destination,sha256:outcome.sha256});}
      }
    }
  }
  // Overwrite: the library file, read again now, goes to recovery storage and the verified copy takes its name.
  const replacing=new Map<string,{root:string;rootIdentity:string;entries:OrganizationEntry[];items:{item:ConflictWork;copy:string}[]}>();
  for(const group of groups) for(const [id,item] of group.items) {
    if(item.choice!=='overwrite'||results.has(item.id))continue;
    const copy=placed.get(id)!.destination;
    try {
      checkAbort(signal);
      if(pathKey(copy)===pathKey(item.existing))throw new Error(`The copy landed on the library file itself: ${copy}`);
      const stat=await fs.lstat(item.existing,{bigint:true});
      if(!stat.isFile()||stat.size!==BigInt(item.entry.size))throw new Error(`The library file changed since it was compared: ${item.existing}`);
      if(await digest(item.existing,signal)!==item.sha256||(await fs.lstat(item.existing,{bigint:true})).mtimeNs!==stat.mtimeNs)throw new Error(`The library file changed since it was compared: ${item.existing}`);
      let batch=replacing.get(item.transfer.root);
      if(!batch){batch={root:item.transfer.root,rootIdentity:item.transfer.rootIdentity,entries:[],items:[]};replacing.set(item.transfer.root,batch);}
      batch.entries.push({source:item.existing,destination:copy,digest:item.sha256,size:item.entry.size,stat,move:true,kept:{digest:item.sha256,size:item.entry.size},replace:true});
      batch.items.push({item,copy});
    } catch(error) { if(isAbort(error))throw error; fail(item,error); }
  }
  for(const batch of replacing.values()) {
    checkAbort(signal);
    try {
      const {id,result}=await beginDuplicateRemoval({root:batch.root,rootIdentity:batch.rootIdentity},batch.entries,signal,options.onProgress);
      for(const {item,copy} of batch.items) {
        // Done only when the copy is at the library file's name and its own name is free again: what the journal does last.
        const there=await fs.lstat(item.existing,{bigint:true}).catch(()=>undefined),left=await fs.lstat(copy).then(()=>true,()=>false);
        if(!there||left)fail(item,result.errors[0]??`The replacement did not finish: ${item.existing}`);
        else {results.set(item.id,{id:item.id,ok:true,journal:id});log('normal','conflicts','overwritten',{source:item.entry.source,existing:item.existing,journal:id,sha256:item.sha256,recovery:'the replaced file is in recovery storage; Undo puts it back'});}
      }
    } catch(error) { if(isAbort(error))throw error; for(const {item} of batch.items)fail(item,error); }
  }
  return work.map(item=>results.get(item.id)??{id:item.id,ok:false,error:'Not applied'});
}
