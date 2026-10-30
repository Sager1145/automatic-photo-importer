import type {AppState} from './shared';
import {isLive,isRunning} from './shared';
import type {MessageKey} from './messages';

/** What only the main process knows about the work it holds. */
export interface InternalWork {/** Jobs are running. */active:boolean;/** A Remove duplicates scan or removal holds the drives. */duplicateScan:boolean;/** A backup folder check is running. */misplacedCheck:boolean;/** Interrupted organizations are being resumed. */resuming:boolean;}
export type GatedAction='scan'|'review'|'organize'|'backupCheck'|'duplicates';
/** The actions that must wait, each with the message that says why. One rule set for the screens (they disable the button) and for main (it refuses). */
export function blockedActions(state:AppState,internal:InternalWork):Partial<Record<GatedAction,MessageKey>>{
 const reviewing=!!state.review||!!state.busyReview,running=state.jobs.some(job=>isRunning(job)),scanning=!!state.scanningSources?.length;
 const duplicatesWork=state.duplicates?.status==='scanning'||state.duplicates?.status==='removing';
 const blocked:Partial<Record<GatedAction,MessageKey>>={};
 if(internal.active||internal.duplicateScan||reviewing||running||scanning)blocked.scan='error.busyScan';
 if(internal.active||internal.duplicateScan||reviewing||running||scanning||duplicatesWork)blocked.review='error.busyReview';
 if(reviewing||scanning||state.jobs.some(job=>job.organization&&isLive(job)))blocked.organize=reviewing?'error.reviewOpen':scanning?'blocked.organizeScan':'error.organizationRunning';
 if(Object.keys(state.misplacedProgress??{}).length||internal.misplacedCheck)blocked.backupCheck='blocked.checkRunning';
 else if(internal.active||internal.resuming||internal.duplicateScan||reviewing||scanning||duplicatesWork||state.jobs.some(job=>isRunning(job)||job.phase==='queued'))blocked.backupCheck='blocked.checkWait';
 if(internal.active||internal.duplicateScan||duplicatesWork||reviewing||state.jobs.some(isLive))blocked.duplicates='error.busy';
 return blocked;
}
