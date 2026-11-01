import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ConflictChoice, ConflictSummary, ImportConflict, PlanEntry, Progress, TransferPlan } from './shared';
import type { FileOutcome } from './core';
import type { ConflictOutcome, ConflictWork } from './core/name-conflicts';

/** What a conflict needs to be acted on later: the file as planned and the plan part it came from. */
interface Held {entry:PlanEntry;transfer:Pick<TransferPlan,'source'|'root'|'rootIdentity'>;}

/** One import's same-name conflicts: the files whose planned name the library already holds with the same bytes. They are
 * collected while the import runs (from what each file actually came to), never wait on the user, and keep their
 * choices across Pause and Continue. Choices made while the import runs are applied after it ends; later ones at once. */
export class ConflictBook {
  private items=new Map<string,ImportConflict>();
  private held=new Map<string,Held>();
  private revision=0;
  private stopped=false;
  /** The conflict `note` added last. */
  lastId?:string;
  applying=false;
  progress?:Progress;

  /** A file outcome of the import: a file found already there under the name it was planned at (not where older folder rules
   * filed it, which is no name conflict) becomes a conflict, once per source file and library. Returns whether it was new. */
  note(outcome:FileOutcome,entry:PlanEntry|undefined,transfer:Pick<TransferPlan,'source'|'root'|'rootIdentity'>,destinationIndex:number,camera?:string):boolean {
    if(outcome.disposition!=='existing'||!entry||entry.routed!==undefined)return false;
    const id=conflictId(outcome.root,outcome.source);
    if(this.items.has(id))return false;
    this.lastId=id;
    this.items.set(id,{id,source:outcome.source,relative:path.relative(transfer.source,outcome.source).split(path.sep).join('/'),existing:outcome.destination,root:outcome.root,destinationIndex,size:outcome.size,sha256:outcome.sha256,...(entry.captureTimeMs!==undefined?{captureTimeMs:entry.captureTimeMs}:{}),...(camera?{camera}:{}),choice:'skip',state:'waiting'});
    this.held.set(id,{entry:{...entry,destination:outcome.destination},transfer:{source:transfer.source,root:transfer.root,rootIdentity:transfer.rootIdentity}});
    this.revision++;
    return true;
  }
  /** The library file's name as its folder lists it (see nameOnDisk). */
  retarget(id:string,existing:string):boolean {
    const item=this.items.get(id),held=this.held.get(id);
    if(!item||!held||item.existing===existing)return false;
    item.existing=existing;held.entry={...held.entry,destination:existing};this.revision++;
    return true;
  }
  /** Choose for these conflicts (every one when `ids` is absent). Only those not applied yet change; an overwrite that was undone can be chosen again. */
  choose(choice:ConflictChoice,ids?:string[]):number {
    let changed=0;
    for(const item of ids?ids.map(id=>this.items.get(id)).filter((item):item is ImportConflict=>!!item):this.items.values()) {
      if(item.state==='applying'||item.state==='done')continue;
      if(item.choice===choice&&item.state==='waiting')continue;
      item.choice=choice;item.state='waiting';delete item.error;changed++;
    }
    if(changed){this.stopped=false;this.revision++;}
    return changed;
  }
  /** Stop all: every conflict not applied yet is skipped. */
  stopAll():void {
    for(const item of this.items.values())if(item.state==='waiting'||item.state==='failed'){item.choice='skip';item.state='waiting';delete item.error;}
    this.stopped=true;this.revision++;
  }
  /** The keeps and overwrites still to apply, marked as being applied. */
  take():ConflictWork[] {
    const work:ConflictWork[]=[];
    for(const item of this.items.values()) {
      if(item.state!=='waiting'||item.choice==='skip')continue;
      const held=this.held.get(item.id)!;
      item.state='applying';
      work.push({id:item.id,choice:item.choice,entry:held.entry,existing:item.existing,sha256:item.sha256,transfer:held.transfer});
    }
    if(work.length)this.revision++;
    return work;
  }
  /** Results of applying; anything left applying (a stop) waits again with its choice. */
  settle(outcomes:ConflictOutcome[]):void {
    for(const outcome of outcomes) {
      const item=this.items.get(outcome.id);if(!item)continue;
      if(outcome.ok){item.state='done';delete item.error;delete item.undone;if(outcome.copy)item.copy=outcome.copy;if(outcome.journal)item.journal=outcome.journal;}
      else {item.state='failed';item.error=outcome.error;}
    }
    // Not reached (a stop): it waits again with its choice, or is skipped after Stop all.
    for(const item of this.items.values())if(item.state==='applying'){item.state='waiting';if(this.stopped)item.choice='skip';}
    this.revision++;
  }
  /** After Undo of an overwrite's journal: its files are back in the library, and nothing more is chosen for them. */
  undone(journal:string):number {
    let count=0;
    for(const item of this.items.values())if(item.journal===journal&&item.state==='done'){item.state='waiting';item.choice='skip';item.undone=true;delete item.journal;count++;}
    if(count)this.revision++;
    return count;
  }
  /** The library and journal of an undoable overwrite. */
  journalRoot(journal:string):string|undefined {
    for(const item of this.items.values())if(item.journal===journal&&item.state==='done')return item.root;
    return undefined;
  }
  hasWork():boolean {for(const item of this.items.values())if(item.state==='waiting'&&item.choice!=='skip')return true;return false;}
  list():ImportConflict[] {return [...this.items.values()].map(item=>({...item}));}
  get size():number {return this.items.size;}
  summary():ConflictSummary|undefined {
    if(!this.items.size)return undefined;
    const summary:ConflictSummary={count:this.items.size,skip:0,overwrite:0,keep:0,done:0,failed:0,waiting:0,undoable:0,revision:this.revision};
    for(const item of this.items.values()) {
      summary[item.choice]++;
      if(item.state==='done')summary.done++;
      if(item.state==='failed')summary.failed++;
      if((item.state==='waiting'||item.state==='applying')&&item.choice!=='skip')summary.waiting++;
      if(item.state==='done'&&item.journal)summary.undoable++;
    }
    if(this.applying){summary.applying=true;if(this.progress)summary.progress=this.progress;}
    if(this.stopped)summary.stopped=true;
    return summary;
  }
}
/** A conflict's id: its library and source file, stable across Pause and Continue. */
export const conflictId=(root:string,source:string)=>createHash('sha256').update(JSON.stringify([root,source])).digest('hex').slice(0,24);
