// Every long step must show a moving counter. The heartbeat samples the main process state and flags any running
// step whose counter ({completed, bytes, file, share}, or its phase and step) stays the same for longer than the limit.
import type {AppState,Progress} from '../../shared';
import {SYNTHETIC} from '../hooks';

export interface Pulse {key:string;value:string}
export interface Freeze {key:string;frozenMs:number;value:string;at:string;during?:string}

const activeJob=['discovering','verifying','copying'];
const beat=(p?:Partial<Progress>&{files?:number})=>JSON.stringify([p?.phase,p?.step,p?.completed??p?.files,p?.bytes,p?.file,p?.share]);

/** The counters of every real step that is running now, keyed by what runs it. Jobs in `held` wait at the QA gate on purpose. */
export function pulses(state:AppState,held:ReadonlySet<string>=new Set()):Pulse[]{
 const out:Pulse[]=[];
 for(const job of state.jobs){
  // Synthetic jobs injected by checks stand still on purpose.
  if(job.id.startsWith(SYNTHETIC))continue;
  if(activeJob.includes(job.phase)&&!job.stopping&&!held.has(job.id))out.push({key:`job ${job.source.name} (${job.id})`,value:job.phase+beat(job.progress)});
  if(job.deletingOriginals)out.push({key:`delete originals ${job.id}`,value:JSON.stringify([job.deletingOriginals.completed,job.deletingOriginals.bytes])});
 }
 if(state.busyReview)out.push({key:'review',value:beat(state.reviewProgress)});
 for(const id of state.scanningSources??[]){const scan=state.scanProgress?.[id],info=state.sourceCameraInfo?.[id];out.push({key:`scan ${id}`,value:JSON.stringify([scan?.files,scan?.bytes,scan?.file,scan?.share,info?.checked,info?.status])});}
 if(state.duplicates&&(state.duplicates.status==='scanning'||state.duplicates.status==='removing'))out.push({key:'duplicates',value:state.duplicates.status+beat(state.duplicates.progress)});
 if(state.residue?.checking)out.push({key:'leftover files',value:beat(state.residue.progress)});
 for(const [destination,progress] of Object.entries(state.misplacedProgress??{}))out.push({key:`backup folder check ${destination}`,value:beat(progress)});
 // A paused listing is waiting for a job, not stuck.
 if(state.organizationRecoveryLoading&&!state.organizationRecoveryPaused)out.push({key:'recovery list',value:beat(state.organizationRecoveryProgress)});
 if(state.recoverySize&&state.recoverySize.files===undefined&&!state.recoverySize.error)out.push({key:'recovery size',value:beat(state.recoverySize.progress)});
 return out;
}

/** Tracks when each counter last moved. The sampler runs on the main process, so a gap between samples is a stretch in
 * which the main thread was blocked: it counts as frozen time like any other, because the counter could not move then
 * either. Gaps longer than `stallMs` are also totalled in `starved` for the report. */
export class Heartbeat {
 private last=new Map<string,{value:string;since:number;frozen:number}>();
 private previous?:number;
 readonly freezes:Freeze[]=[];
 samples=0;starved=0;
 constructor(private limitMs=10000,private stallMs=1500){}
 sample(items:Pulse[],now:number,during?:string){
  this.samples++;
  const gap=this.previous===undefined?0:now-this.previous;this.previous=now;
  if(gap>this.stallMs)this.starved+=gap;
  const seen=new Set<string>();
  for(const {key,value} of items){
   seen.add(key);
   const entry=this.last.get(key);
   if(!entry||entry.value!==value){this.last.set(key,{value,since:now,frozen:0});continue;}
   const before=entry.frozen;entry.frozen+=gap;
   if(before<=this.limitMs&&entry.frozen>this.limitMs)this.freezes.push({key,frozenMs:entry.frozen,value,at:new Date(now).toISOString(),...(during?{during}:{})});
  }
  for(const key of [...this.last.keys()])if(!seen.has(key))this.last.delete(key);
 }
}
