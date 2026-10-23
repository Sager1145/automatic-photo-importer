import type {AppState,Progress} from '../shared';

/** "Everything must update": watches the state a QA run receives and records any running job, listing or recheck
 * whose progress ({completed, bytes, file, share}) stays exactly the same for more than `limitMs` while it is not in a final state. */
export interface Stall {what:string;since:number;heldMs:number;progress:Pick<Progress,'completed'|'bytes'|'file'|'share'|'step'>;}
export function createStallWatch(options:{limitMs?:number;now?:()=>number}={}){
 const limit=options.limitMs??10_000,clock=options.now??(()=>Date.now());
 const seen=new Map<string,{signature:string;since:number;progress:Stall['progress']}>(),stalls=new Map<string,Stall>();
 const track=(at:number,live:Set<string>,what:string,progress:Progress|undefined)=>{
  if(!progress)return;
  live.add(what);
  const signature=JSON.stringify([progress.step,progress.completed,progress.bytes,progress.file,progress.share]),known=seen.get(what);
  if(!known||known.signature!==signature){seen.set(what,{signature,since:at,progress:{step:progress.step,completed:progress.completed,bytes:progress.bytes,file:progress.file,share:progress.share}});return;}
  if(at-known.since>limit)stalls.set(what,{what,since:known.since,heldMs:at-known.since,progress:known.progress});
 };
 return {
  /** Feed every state received (the state channel's updates or a poll). */
  observe(state:AppState,at=clock()):void{
   const live=new Set<string>();
   for(const job of state.jobs)if(['discovering','verifying','copying'].includes(job.phase))track(at,live,`${job.organization?'recheck':'job'} ${job.id}`,job.progress);
   // The organization listing, while it runs (a paused one is waiting for a job, not stuck).
   if(state.organizationRecoveryLoading&&!state.organizationRecoveryPaused)track(at,live,'organization listing',state.organizationRecoveryProgress);
   for(const [destination,progress] of Object.entries(state.misplacedProgress??{}))track(at,live,`backup check ${destination}`,progress);
   if(state.residue?.checking)track(at,live,'leftovers',state.residue.progress);
   if(state.busyReview)track(at,live,'review',state.reviewProgress);
   if(state.duplicates&&['scanning','removing'].includes(state.duplicates.status))track(at,live,'duplicates',state.duplicates.progress);
   if(state.recoverySize&&state.recoverySize.files===undefined&&!state.recoverySize.error)track(at,live,'recovery size',state.recoverySize.progress);
   // Whatever is no longer running is in a final state: forgotten.
   for(const key of [...seen.keys()])if(!live.has(key))seen.delete(key);
  },
  stalls():Stall[]{return [...stalls.values()];},
  /** Throws, naming each stalled item, if any was seen. */
  assertNone():void{
   if(!stalls.size)return;
   throw new Error(`Progress stood still for more than ${limit/1000} s: ${[...stalls.values()].map(stall=>`${stall.what} at ${JSON.stringify(stall.progress)} for ${Math.round(stall.heldMs/1000)} s`).join('; ')}`);
  },
 };
}
