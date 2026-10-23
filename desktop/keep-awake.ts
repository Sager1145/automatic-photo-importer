import {isLive,type Job} from './shared';

/** The part of Electron's powerSaveBlocker this uses, so the policy can be tested without Electron. */
export interface Blocker {start(type:'prevent-display-sleep'):number;stop(id:number):void;isStarted(id:number):boolean;}
/** Keeps the display (and so the Mac) awake while any job is queued or running or deletes its originals, and lets it sleep once all have settled. */
export function keepAwake(blocker:Blocker):(jobs:readonly Job[])=>void {
 let id:number|undefined;
 return jobs=>{
  const busy=jobs.some(job=>isLive(job)||!!job.deletingOriginals);
  if(busy&&(id===undefined||!blocker.isStarted(id)))id=blocker.start('prevent-display-sleep');
  else if(!busy&&id!==undefined){if(blocker.isStarted(id))blocker.stop(id);id=undefined;}
 };
}
