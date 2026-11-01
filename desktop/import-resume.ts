import fs from 'node:fs/promises';
import type {TransferPlan} from './shared';
import type {DestinationOutcome} from './core/destinations';
import {destinationEntries} from './core/allocation';
import {pathKey,statKey} from './core/paths';
import {PausedCopies} from './core/index';

/** What a paused import keeps so Continue goes on from where it stopped: in memory, for this app session only. */
export interface PausedImport<Plan> {
 /** The plan it was running, reused while every source file is still as planned; absent, the job is planned again. */
 plan?:Plan;
 /** Its staged copies not yet verified and the files it verified at the destination (see core PausedCopies). */
 copies:PausedCopies;
 /** Every file outcome of the job so far (JobLedger). */
 outcomes:Map<string,DestinationOutcome>;
 /** The space it still held on each volume when it paused. */
 reserved?:{volume:string;bytes:number}[];
}

const outcomeKey=(outcome:Pick<DestinationOutcome,'root'|'source'>)=>`${pathKey(outcome.root)}\0${outcome.source}`;

/** One import's file outcomes across Pause and Continue. A file an earlier run of the job published is found at its
 * destination by the next run; it is still a file this job copied and verified, not one that was already in the backup. */
export class JobLedger {
 readonly outcomes:Map<string,DestinationOutcome>;
 private promoted=0;
 constructor(earlier?:ReadonlyMap<string,DestinationOutcome>){this.outcomes=new Map(earlier);}
 /** Records a run's outcome and returns it as the whole job's. */
 note(outcome:DestinationOutcome):DestinationOutcome{
  const key=outcomeKey(outcome),before=this.outcomes.get(key);
  let value=outcome;
  if(before?.disposition==='published'&&outcome.disposition==='existing'&&pathKey(before.destination)===pathKey(outcome.destination)){value={...outcome,disposition:'published'};this.promoted++;}
  this.outcomes.set(key,value);
  return value;
 }
 /** A run's counts as the whole job's: files published before a pause count as copied, not as already in the backup. */
 totals<T extends {copied:number;skipped:number}>(result:T):T{return {...result,copied:result.copied+this.promoted,skipped:Math.max(0,result.skipped-this.promoted)};}
}

/** Whether a paused job's plan still describes its sources: every planned file has the identity it was planned with. Reads no file. */
export async function sourcesUnchanged(plans:TransferPlan[]):Promise<boolean>{
 const seen=new Set<string>();
 for(const entry of plans.flatMap(destinationEntries)){
  if(seen.has(entry.source))continue;seen.add(entry.source);
  if(entry.sourceIdentity===undefined)return false;
  const stat=await fs.lstat(entry.source,{bigint:true}).catch(()=>undefined);
  if(!stat?.isFile()||statKey(stat)!==entry.sourceIdentity)return false;
 }
 return true;
}

export {PausedCopies};
