import type {AppState,Job,JobLeftovers} from './shared';
import {isLive} from './shared';

/** Clean up is offered on a job that was stopped or paused after it started running (so it may have written something),
 * is not winding down or deleting originals, and has not been cleaned up since. */
export function cleanupOffered(job:Job):boolean{
 return job.phase==='stopped'&&!!job.startedAt&&!job.stopping&&!job.deletingOriginals&&!job.leftovers?.cleaned;
}
/** Locked while anything could adopt or write what it would remove: a job running or queued, or a review being built. */
export function cleanupLocked(state:Pick<AppState,'jobs'|'busyReview'>):boolean{
 return state.jobs.some(isLive)||!!state.busyReview;
}
/** What Clean up removes: every group but the recoverable copies, which are only listed. Receipts are records, not files. */
export function leftoverTotal(leftovers:Pick<JobLeftovers,'direct'|'staged'|'organization'|'temporary'>):{files:number;bytes:number}{
 const groups=[leftovers.direct,leftovers.staged,leftovers.organization,leftovers.temporary];
 return {files:groups.reduce((sum,item)=>sum+item.files,0),bytes:groups.reduce((sum,item)=>sum+item.bytes,0)};
}
/** Whether the measurement found anything to do: files to remove or receipts to close. */
export const cleanupWork=(leftovers:JobLeftovers)=>leftoverTotal(leftovers).files>0||leftovers.receipts>0;
/** A job once cleaned up is stopped: a paused import starts over with Start (verified copies are recognised and not copied
 * again); a paused organization is no longer continued from its card (its journal stays in Organization recovery). */
export function markCleaned(job:Job):void{job.paused=false;}
