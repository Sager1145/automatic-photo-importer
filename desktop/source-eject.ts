import {isLive} from './shared';
import type {AppState,Job,Preferences,Source} from './shared';
import {errorTotal} from './job-issues';
import {within} from './core/paths';
import {MessageError,type Message} from './messages';

/** What ejecting needs to know about the app: no Electron, no file system. */
export type EjectView=Pick<AppState,'sources'|'jobs'>&{review?:AppState['review'];busyReview?:boolean;reviewSourceId?:string;scanningSources?:readonly string[];
 /** Remove duplicates: the library being looked through; in use while it scans or removes. */
 duplicates?:{root?:string;status:string};
 /** Other folders being read right now (backup folder check, residue cleanup), whatever source they belong to. */
 busyPaths?:readonly string[];
 /** Ids of sources being ejected right now: nothing may start on them. */
 ejecting?:readonly string[]};
/** Drives and folders can be ejected or removed; a USB camera is not offered it. */
export const ejectable=(source:Pick<Source,'transport'>):boolean=>source.transport==='storage'||source.transport==='folder';
/** Two paths overlap when one is the other or lies inside it (a folder on a card, or a card holding a folder). Empty paths never overlap. */
export const overlaps=(first:string|undefined,second:string|undefined):boolean=>!!first&&!!second&&(within(first,second)||within(second,first));
const pathOf=(view:Pick<EjectView,'sources'>,id:string|undefined)=>view.sources.find(item=>item.id===id)?.path;

/** True while the source is being used: a live, queued or paused job, a scan, an open or building review, Delete originals,
 * a duplicates scan or removal, or a folder check, on the source or on any path inside it (or holding it). */
export function sourceInUse(view:EjectView,source:Pick<Source,'id'>&Partial<Pick<Source,'path'>>):boolean {
 const where=source.path??pathOf(view,source.id);
 const uses=(other:string|undefined)=>overlaps(other,where);
 return view.jobs.some(job=>(job.source.id===source.id||uses(job.source.path))&&(isLive(job)||!!job.deletingOriginals||(job.phase==='stopped'&&job.paused===true)))
  ||!!view.scanningSources?.some(id=>id===source.id||uses(pathOf(view,id)))
  ||!!view.review&&(view.review.source.id===source.id||uses(view.review.source.path))
  ||(!!view.busyReview&&(view.reviewSourceId===source.id||uses(pathOf(view,view.reviewSourceId))))
  ||(!!view.duplicates&&(view.duplicates.status==='scanning'||view.duplicates.status==='removing')&&uses(view.duplicates.root))
  ||!!view.busyPaths?.some(uses);
}

/** The source (or one of its folders) that is being ejected and holds this path, for refusing a start on it. */
export function ejectingSource(view:Pick<EjectView,'sources'|'ejecting'>,target:{id?:string;path?:string}):Source|undefined {
 return view.sources.find(source=>!!view.ejecting?.includes(source.id)&&(source.id===target.id||overlaps(source.path,target.path)));
}

/** The latest import (not organization) job of a source. Jobs are listed newest first. */
export const latestImport=(view:Pick<EjectView,'jobs'>,source:Pick<Source,'id'>):Job|undefined=>view.jobs.find(job=>job.source.id===source.id&&!job.organization);

/** Connected drives and folders whose latest import finished clean (complete, no errors) and that nothing uses, which Eject all done ejects or removes. */
export function doneSources(view:EjectView,holdsBackup:(source:Source)=>boolean=()=>false):Source[] {
 return view.sources.filter(source=>{
  if(!ejectable(source)||holdsBackup(source)||sourceInUse(view,source)||ejectingSource(view,source))return false;
  const job=latestImport(view,source);
  return !!job&&job.phase==='complete'&&!job.failedFiles&&errorTotal(job)===0;
 });
}

/** Delete originals is offered after an import from a folder (when enabled) or from a card or drive (when enabled); never for a camera. */
export function offersOriginals(source:Pick<Source,'transport'>,preferences:Pick<Preferences,'deleteOriginalsFolders'|'deleteOriginalsCards'>):boolean {
 return source.transport==='folder'?preferences.deleteOriginalsFolders!==false:source.transport==='storage'?preferences.deleteOriginalsCards===true:false;
}

/** Delete originals is wanted before ejecting: still running, stopped, or originals remain. The user decides, so auto-eject waits. */
const originalsPending=(job:Job)=>!!job.deletingOriginals||!!job.originalsDeleted?.stopped||!!job.verifiedOriginals;

/** Whether Delete originals may start for a job whose source root is `root`: nothing live, queued or scanning may be using a path inside it. */
export function originalsBlocked(view:Pick<EjectView,'jobs'|'sources'|'scanningSources'>,job:Pick<Job,'id'|'source'>,root:string):boolean {
 return view.jobs.some(item=>item.id!==job.id&&isLive(item)&&(item.source.id===job.source.id||overlaps(item.source.path,root)))
  ||!!view.scanningSources?.some(id=>id===job.source.id||overlaps(pathOf(view,id),root));
}
/** The volume recorded when the job ran is no longer the one mounted at its source: a different card, whatever the mount point. */
export const originalsVolumeChanged=(recorded:string|undefined,current:string|undefined):boolean=>!!recorded&&recorded!==current;

/** What auto-eject does when an import job ends: eject now, wait (the user still decides about originals), busy (in use, so
 * it was not ejected and the user should know), or do nothing. */
export function autoEjectDecision(view:EjectView,job:Job,source:Source|undefined,preferences:Pick<Preferences,'autoEject'|'deleteOriginalsCards'|'verifyCopies'>,holdsBackup:(source:Source)=>boolean=()=>false):'eject'|'wait'|'busy'|'no' {
 if(preferences.autoEject!==true||!source||source.transport!=='storage'||job.organization||job.source.id!==source.id)return 'no';
 if(job.phase!=='complete'||job.failedFiles||errorTotal(job)!==0)return 'no';
 if(latestImport(view,source)?.id!==job.id)return 'no';
 // Verified: the copies were read back, or nothing needed copying because every file was already verified in the backup.
 if(preferences.verifyCopies===false&&!job.alreadyImported)return 'no';
 if(holdsBackup(source))return 'no';
 // Delete originals is offered (or running) for this job: wait until it finishes or the user ejects.
 if(preferences.deleteOriginalsCards===true&&originalsPending(job))return 'wait';
 if(sourceInUse(view,source)||ejectingSource(view,source))return 'busy';
 return 'eject';
}

export interface EjectDeps {
 view:()=>EjectView;
 holdsBackup:(source:Source)=>boolean;
 /** Marks the source as being ejected (or clears it), so nothing starts on it meanwhile. Optional for tests. */
 setEjecting?:(source:Source,ejecting:boolean)=>void;
 /** Ejects the volume at a mount path. Never called for a folder. */
 ejectVolume:(mountPath:string)=>Promise<unknown>;
 /** Drops the source (and its finished jobs) from the app after a successful eject or removal. */
 forget:(source:Source)=>void;
}
const named=(source:Source)=>({name:source.name});

/** Ejects a drive (volume eject, then forgotten) or removes a folder (only forgotten, the file system is never touched).
 * Refused with a MessageError while the source is in use, holds the backup, or is a camera. */
export async function ejectSource(deps:EjectDeps,source:Source):Promise<'ejected'|'removed'> {
 if(!ejectable(source))throw new MessageError('error.ejectUnsupported');
 if(sourceInUse(deps.view(),source)||ejectingSource(deps.view(),source))throw new MessageError('error.ejectInUse',named(source));
 if(source.transport==='folder'){deps.forget(source);return 'removed';}
 if(deps.holdsBackup(source))throw new MessageError('error.ejectHoldsBackup',named(source));
 // No await between the check above and the mark: nothing can start on the drive in between.
 deps.setEjecting?.(source,true);
 try{
  await deps.ejectVolume(source.path);
  deps.forget(source);
 }finally{deps.setEjecting?.(source,false);}
 return 'ejected';
}

export interface EjectDoneResult {ejected:number;removed:number;skipped:number;failed:{name:string;error:Message}[]}
/** Eject all done: each finished drive is ejected and each finished folder removed, one at a time. A source that became busy is skipped, not failed. */
export async function ejectDone(deps:EjectDeps):Promise<EjectDoneResult> {
 const result:EjectDoneResult={ejected:0,removed:0,skipped:0,failed:[]};
 for(const source of doneSources(deps.view(),deps.holdsBackup)){
  try{
   // The state may have moved while the previous drive ejected.
   if(!doneSources(deps.view(),deps.holdsBackup).some(item=>item.id===source.id)){result.skipped++;continue;}
   if(await ejectSource(deps,source)==='ejected')result.ejected++;else result.removed++;
  }catch(error){
   const key=error instanceof MessageError?error.key:undefined;
   if(key==='error.ejectInUse'||key==='error.ejectBusy'||key==='error.ejectHoldsBackup')result.skipped++;
   else result.failed.push({name:source.name,error:error instanceof MessageError?{key:error.key,...(error.params?{params:error.params}:{})}:{key:'text',params:{text:error instanceof Error?error.message:String(error)}}});
  }
 }
 return result;
}
