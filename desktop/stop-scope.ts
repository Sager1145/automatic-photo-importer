import type {Action,Job,Source} from './shared';
import {isLive} from './shared';
import {message} from './messages';

type StopAction=Extract<Action,{type:'stop'}>;
/** Source scans, open reviews and originals cleanup are independent operations. Only Stop all
 * owns those global cancellations; a targeted Stop owns that job and its originals cleanup. */
export function planStop(input:StopAction,jobs:readonly Job[],organizationJobIds:ReadonlySet<string>=new Set()){
 if(input.scope!==undefined&&input.scope!=='imports'||input.jobId!==undefined&&(typeof input.jobId!=='string'||!input.jobId.trim())||input.scope!==undefined&&input.jobId!==undefined)throw new Error('Invalid stop scope or job');
 const all=input.jobId===undefined&&input.scope===undefined;
 return {all,jobs:jobs.filter(job=>input.jobId!==undefined?job.id===input.jobId:all||(!job.organization&&!organizationJobIds.has(job.id)&&(isLive(job)||job.paused===true))),originals:input.scope==='imports'?'none' as const:all?'all' as const:'target' as const,jobId:input.jobId};
}
export interface StopOperations {
 jobs:Job[];sources:Source[];organizationJobIds?:ReadonlySet<string>;active:ReadonlyMap<string,AbortController>;originalsControls:ReadonlyMap<string,AbortController>;scanControls:ReadonlyMap<string,AbortController>;pausing:Set<string>;seen:Set<string>;discardReview:()=>Promise<void>;
}
/** The validated stop dispatch, shared with behavior tests so no Electron process or file operations are needed. */
export async function stopOperations(input:StopAction,operations:StopOperations):Promise<void>{
 const plan=planStop(input,operations.jobs,operations.organizationJobIds);
 if(plan.all){await operations.discardReview();for(const control of operations.scanControls.values())control.abort();}
 for(const [id,control] of operations.originalsControls)if(plan.originals==='all'||plan.originals==='target'&&id===plan.jobId)control.abort();
 for(const job of plan.jobs){
  operations.pausing.delete(job.id);
  if(job.phase==='queued'||job.paused){job.phase='stopped';job.paused=false;job.detail=message('job.removedFromQueue');}
  if(operations.active.has(job.id))job.stopping='stop';
  operations.active.get(job.id)?.abort();
 }
 // Prevent automatic imports immediately undoing a global stop. A scoped or targeted Stop
 // must not suppress automatic handling of unrelated connected sources.
 if(plan.all)for(const source of operations.sources)operations.seen.add(source.id);
}
