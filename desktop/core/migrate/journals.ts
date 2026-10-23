import * as fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {bothNames,FirstAidError,maybeLstat,renameChecked,storeFolder,writeNewFile,type Store} from '../app-store';
import {journalConversion,JOURNAL,ORGANIZATIONS,RECOVERY_FOLDER,type ConversionTarget,type LegacyJournal} from '../recovery';
import {code,contained,syncDirectory} from '../paths';
import {bookkeepingOnly,deleted,hit,message,passThrough,pool,type MigrationContext} from './common';

const temporaryName=/^journal-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
/** Names the earlier version wrote in a journal folder; only these are removed from it. */
const legacyJournalFile=/^(?:manifest\.json|event-log\.jsonl|event-[a-f0-9-]+\.json|stage-[0-9a-f-]{36}\.partial|incomplete-[0-9a-f-]{36})$/;

/** A folder for a kept original inside the store: made if needed; one that already exists must hold nothing but
 * Finder's bookkeeping (a stop between making it and moving the original in). */
async function originalFolder(store:Store,folder:string):Promise<void>{
 await contained(folder,store.path);
 try{await fs.mkdir(folder,{mode:0o700});await syncDirectory(path.dirname(folder));return;}
 catch(error){if(code(error)!=='EEXIST')throw error;}
 const stat=await fs.lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink())throw new FirstAidError(`Unexpected item at ${folder}`);
}
/** Convert one earlier-version journal of `root` into the store, in steps that each finish from what is on disk:
 * N1 read it with the earlier version's reader; N2 make its folder in the store; N3 write the converted journal
 * aside; N4 read that back with the v5 reader and require the same state; N5 rename it into place (both names
 * checked): from here the store's copy is the journal; N6 move each kept original into the store, one by one,
 * each recorded once moved; N7 record that the conversion is complete; N8 remove the earlier version's files
 * (known names only); N9 forget what this session cached. Returns whether it finished. */
export async function convertJournal(root:string,id:string,context:MigrationContext):Promise<boolean>{
 return journalConversion.locked(root,id,async()=>{
  const report=(step:'converting'|'originals'|'removing',completed:number,total:number,file:string)=>context.onProgress?.({step,completed,total,file});
  const problem=(text:string)=>{context.problems.push(text);return false;};
  // Converted and complete already (a run stopped while removing the earlier version's files): only N8 and N9 are left.
  const folder=path.join(root,RECOVERY_FOLDER,id);
  try{
   // Where an earlier run committed it, even if the store its library writes to has changed since.
   const holders=await journalConversion.holders(root,id),committed=holders[0]!;
   if(holders.length===1&&(await journalConversion.convertedFromOf(committed))?.path===folder&&(await journalConversion.replay(committed,committed.journal,root,id)).state.migrationComplete){
    const kept=await removeLegacyJournal(folder,root,context);await hit(context,'N8');journalConversion.forget(id);return kept;
   }
  }catch(error){if(passThrough(error))throw error;/* Read in full below, which reports what is wrong. */}
  // N1
  let legacy:LegacyJournal;
  try{legacy=await journalConversion.read(root,id,(read,total,name)=>report('converting',read,total,name??id));}
  catch(error){if(passThrough(error))throw error;return problem(`Organization ${id} in ${root} could not be read, so it was left as it is: ${message(error)}`);}
  await hit(context,'N1');
  // Each step below counts what it does, so a slow drive never shows a frozen counter.
  const records=legacy.records.length,step=(done:number,file:string)=>report('converting',done,records,file);
  step(records,id);
  // N2
  let target:ConversionTarget;
  try{
   const holders=await journalConversion.holders(root,id);
   if(holders.length>1)return problem(`Organization ${id} in ${root} has records in more than one place; nothing was changed. Use First Aid.`);
   // Committed by an earlier run: finished where it is (the store its library writes to may have changed since).
   target=holders[0]??await journalConversion.target(root,id);
   if(holders.length&&(await journalConversion.convertedFromOf(target))?.path!==legacy.folder)return problem(`Organization ${id} in ${root} has records in more than one place; nothing was changed. Use First Aid.`);
   if(!holders.length){
    await storeFolder(target.store,ORGANIZATIONS,id);
    // A converted journal written aside by a run that stopped before committing it is written again.
    for(const name of await fs.readdir(target.folder))if(temporaryName.test(name)){const file=path.join(target.folder,name);await contained(file,target.store.path);await fs.unlink(file);deleted(file,'converted journal of a stopped run, written again','temporary name in the store, no journal committed');}
    await syncDirectory(target.folder);
    await hit(context,'N2');
    // N3
    let text:string;try{text=journalConversion.text(legacy);}catch(error){return problem(message(error));}
    const temporary=path.join(target.folder,`journal-${randomUUID()}.tmp`);
    step(records,path.basename(temporary));await writeNewFile(temporary,text);
    await hit(context,'N3');
    // N4
    let replayed;
    try{replayed=await journalConversion.replay(target,temporary,root,id,(read,total)=>report('converting',read,total,path.basename(temporary)));}
    catch(error){if(passThrough(error))throw error;await fs.unlink(temporary).then(()=>deleted(temporary,'converted journal that could not be read back','written by this run'),()=>{});return problem(`Organization ${id} in ${root} could not be converted: ${message(error)}`);}
    if(!journalConversion.same(replayed.state,legacy.state)){await fs.unlink(temporary).then(()=>deleted(temporary,'converted journal that reads differently','written by this run'),()=>{});return problem(`Organization ${id} in ${root} reads differently once converted, so it was left as it is.`);}
    await hit(context,'N4');
    // N5
    step(records,JOURNAL);if(await renameChecked(temporary,target.journal)!=='done')return problem(`Organization ${id} in ${root}: the converted journal could not be put in place.`);
    await hit(context,'N5');
   }else{
    // Committed by an earlier run. A converted journal left aside beside it is spare, unless it is the same file.
    for(const name of await fs.readdir(target.folder)){
     if(!temporaryName.test(name))continue;
     const file=path.join(target.folder,name);
     if(await bothNames(file,target.journal)==='both-same')return problem(`First Aid needed: ${file} and ${target.journal} name the same file.`);
     await contained(file,target.store.path);await fs.unlink(file);deleted(file,'spare converted journal','temporary name beside the committed journal, not the same file');
    }
   }
  }catch(error){if(passThrough(error))throw error;return problem(`Organization ${id} in ${root} could not be converted: ${message(error)}`);}
  // N6
  try{
   const {manifest:converted,state}=await journalConversion.replay(target,target.journal,root,id,(read,total)=>report('converting',read,total,JOURNAL));
   if(!journalConversion.same(state,legacy.state))return problem(`Organization ${id} in ${root} differs from its converted copy; nothing more was changed. Use First Aid.`);
   if(!state.migrationComplete){
    const slots=[...legacy.state.slots].flatMap(([index,list])=>list.map(slot=>({index,slot}))).filter(({index,slot})=>!state.migrationMoved.has(`${index}/${slot}`));
    let done=0;report('originals',0,slots.length,'');
    for(const {index,slot} of slots){
     context.signal?.throwIfAborted?.();
     const source=journalConversion.originalOf(legacy.manifest,index,slot),destination=journalConversion.originalOf(converted,index,slot);
     const where=await bothNames(source,destination);
     if(where==='both-same')return problem(`First Aid needed: ${source} and ${destination} name the same file.`);
     if(where==='both')return problem(`A kept original of organization ${id} is in both places; nothing was changed: ${source}`);
     if(where==='source'){
      const before=await fs.lstat(source,{bigint:true});
      if(!journalConversion.isOriginal(before,legacy.manifest,index))return problem(`A kept original of organization ${id} changed, so it was left where it is: ${source}`);
      const originals=path.join(target.folder,'originals');
      for(const folder of [originals,path.join(originals,String(index)),path.dirname(destination)])await originalFolder(target.store,folder);
      if(await renameChecked(source,destination,stat=>journalConversion.isOriginal(stat,converted,index))!=='done')return problem(`A kept original of organization ${id} could not be moved: ${source}`);
      await hit(context,'N6:moved');
     }else if(where==='target'){
      // Moved by a run that stopped before recording it.
      if(!journalConversion.isOriginal(await fs.lstat(destination,{bigint:true}),converted,index))return problem(`A kept original of organization ${id} changed after it was moved: ${destination}`);
     }
     if(where!=='none'){
      // Its "._" file normally moves with it (the kernel renames it along, design r2 T1); one left behind is an
      // orphan: only bookkeeping is removed, anything else goes along beside it.
      const side=path.join(path.dirname(source),'._'+path.basename(source)),besideTarget=path.join(path.dirname(destination),'._'+path.basename(destination));
      if(await maybeLstat(side)){
       if(await bookkeepingOnly(side)){await fs.unlink(side);deleted(side,'orphaned "._" file of a moved kept original','holds only bookkeeping');await syncDirectory(path.dirname(side));}
       else if(!await maybeLstat(besideTarget))await renameChecked(side,besideTarget);
       else return problem(`Two "._" files for one kept original of organization ${id}: ${side}`);
      }
      await journalConversion.record(converted,'migration-moved',index,{slot});
      await hit(context,'N6:logged');
     }
     done++;report('originals',done,slots.length,path.basename(destination));
    }
    // N7: every kept original is in the store, or was in neither place to begin with.
    for(const [index,list] of legacy.state.slots)for(const slot of list)if(await maybeLstat(journalConversion.originalOf(legacy.manifest,index,slot)))return problem(`A kept original of organization ${id} is still in the earlier version's folder.`);
    await journalConversion.record(converted,'migration-complete');
    await hit(context,'N7');
   }
  }catch(error){if(passThrough(error))throw error;return problem(`Organization ${id} in ${root}: ${message(error)}`);}
  // N8
  const kept=await removeLegacyJournal(legacy.folder,root,context).catch(error=>{if(passThrough(error))throw error;return problem(`Organization ${id} in ${root}: its earlier version's files could not all be removed: ${message(error)}`);});
  await hit(context,'N8');
  // N9
  journalConversion.forget(id);
  return kept;
 });
}
/** N8: the earlier version's journal folder goes, name by name: its manifest first (so nothing reads it as a journal
 * again), then its event records, staging leftovers, emptied kept-original folders and Finder's bookkeeping files.
 * Anything else stays, with the folder, and is reported. */
async function removeLegacyJournal(folder:string,root:string,context:MigrationContext):Promise<boolean>{
 await contained(folder,root);
 const stat=await maybeLstat(folder);if(!stat)return true;
 if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error(`Unsafe earlier version's folder: ${folder}`);
 const manifest=path.join(folder,'manifest.json');
 if((await maybeLstat(manifest))?.isFile()){await fs.unlink(manifest);deleted(manifest,'earlier version\'s journal converted','migration-complete recorded in the converted journal');await syncDirectory(folder);}
 const names=(await fs.readdir(folder)).filter(name=>legacyJournalFile.test(name));
 let done=0;const total=names.length,report=(file:string)=>context.onProgress?.({step:'removing',completed:done,total,file});
 report('');
 await pool(names,8,async name=>{
  context.signal?.throwIfAborted?.();
  await fs.unlink(path.join(folder,name)).catch(error=>{if(code(error)!=='ENOENT')throw error;});
  done++;if(done%64===0||done===total)report(name);
 });
 if(total)deleted(folder,'earlier version\'s journal records converted','migration-complete recorded in the converted journal; names this version wrote',{files:total});
 await hit(context,'N8:partial');
 // Emptied kept-original folders, deepest first (each holds at most Finder's bookkeeping).
 const unexpected:string[]=[];
 const prune=async(directory:string):Promise<void>=>{
  for(const entry of await fs.readdir(directory,{withFileTypes:true}).catch(()=>[])){
   const item=path.join(directory,entry.name);report(entry.name);
   if(entry.isDirectory())await prune(item);
   else if(entry.name==='.DS_Store'||entry.name.startsWith('._')&&await bookkeepingOnly(item)){await fs.unlink(item);deleted(item,'Finder bookkeeping in an emptied kept-original folder','.DS_Store or a bookkeeping-only "._" file');}
   else unexpected.push(item);
  }
  await fs.rmdir(directory).then(()=>deleted(directory,'emptied kept-original folder','empty (non-recursive removal)'),()=>{});
 };
 if((await maybeLstat(path.join(folder,'originals')))?.isDirectory())await prune(path.join(folder,'originals'));
 for(const entry of await fs.readdir(folder,{withFileTypes:true})){
  const item=path.join(folder,entry.name);report(entry.name);
  if(entry.isFile()&&(entry.name==='.DS_Store'||entry.name.startsWith('._')&&await bookkeepingOnly(item))){await fs.unlink(item);deleted(item,'Finder bookkeeping in a converted journal folder','.DS_Store or a bookkeeping-only "._" file');}
  else unexpected.push(item);
 }
 await syncDirectory(folder);
 if(unexpected.length){context.problems.push(`The earlier version's folder ${folder} was kept: it holds ${unexpected.length} item${unexpected.length===1?'':'s'} this app did not write there (${unexpected.slice(0,3).map(item=>path.basename(item)).join(', ')}).`);return false;}
 await fs.rmdir(folder);deleted(folder,'earlier version\'s journal folder converted','empty (non-recursive removal)');await syncDirectory(path.dirname(folder));
 return true;
}
