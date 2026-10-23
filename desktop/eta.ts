/** Time-remaining estimates for every stage of a job and for the whole job. See docs/eta-estimates.md. */
import type {AppState,Progress,Source} from './shared';
import {LISTING_KNEE,listingShare} from './listing-estimate';

export interface EtaSample {files:number;bytes:number;totalFiles:number;totalBytes:number;}
/** perFileBytes: the cost of one file in bytes, added to bytes (data stages); absent counts files only (metadata stages).
 * tau: throughput smoothing, ms. warmup: ms before the first estimate. stallHold: ms without progress before it lowers the rate. */
export interface EtaOptions {perFileBytes?:number;tau?:number;warmup?:number;stallHold?:number;}

/** Shown seconds count down with the clock and move toward each new estimate: quickly down, slowly up (Firefox's getTimeLeft). */
export class EtaSmoother {
 private value?:number;private at=0;
 next(raw:number|undefined,now:number,finished=false):number|undefined{
  if(raw===undefined){this.value=undefined;return undefined;}
  if(finished||raw<=0){this.value=0;this.at=now;return 0;}
  if(this.value===undefined)this.value=raw;
  else{
   const base=Math.max(0,this.value-(now-this.at)/1000);
   // A sudden jump up is clamped: one odd measurement cannot double the time left.
   const target=Math.min(raw,Math.max(base*2,base+60));
   this.value=raw<base/2?raw:base+(1-Math.exp(-Math.max(0,now-this.at)/(raw<base?3000:10000)))*(target-base);
  }
  this.at=now;this.value=Math.max(1,this.value);return this.value;
 }
}

/** One stage's estimate: EWMA of throughput with a time-based alpha and tqdm's bias correction. */
export class EtaEstimator {
 private readonly options:Required<Omit<EtaOptions,'perFileBytes'>>&{perFileBytes?:number};
 private first?:number;private last?:{at:number;work:number};private ewma=0;private weight=0;private intervals=0;private held?:number;
 private readonly smoother=new EtaSmoother();
 constructor(options:EtaOptions={}){this.options={tau:20000,warmup:3000,stallHold:15000,...options};}
 private work(sample:EtaSample):{done:number;total:number}|undefined{
  const perFile=this.options.perFileBytes;
  if(perFile!==undefined&&sample.totalBytes>0)return {done:sample.bytes+perFile*sample.files,total:sample.totalBytes+perFile*sample.totalFiles};
  return sample.totalFiles>0?{done:sample.files,total:sample.totalFiles}:undefined;
 }
 /** Work units per second, once measured. */
 get rate():number|undefined{return this.weight>0&&this.ewma>0?this.ewma/this.weight:undefined;}
 /** Seconds left (smoothed), 0 when finished, or undefined while estimating or when the total is unknown. */
 update(sample:EtaSample,now:number):number|undefined{
  const work=this.work(sample);
  if(!work)return undefined;
  if(work.done>=work.total)return this.smoother.next(0,now,true);
  if(!this.last||work.done<this.last.work){this.first=now;this.last={at:now,work:work.done};this.ewma=this.weight=this.intervals=0;this.held=undefined;return this.smoother.next(undefined,now);}
  const dt=now-this.last.at,progressed=work.done-this.last.work;
  // A brief stall keeps the last estimate; a long one counts as slow progress.
  if(dt>0&&(progressed>0||dt>=this.options.stallHold)){
   const alpha=1-Math.exp(-dt/this.options.tau);
   this.ewma=alpha*(progressed/(dt/1000))+(1-alpha)*this.ewma;this.weight=alpha+(1-alpha)*this.weight;
   if(progressed>0)this.intervals++;
   this.last={at:now,work:work.done};
   const rate=this.rate;
   this.held=rate&&this.intervals>=2&&now-this.first!>=this.options.warmup?(work.total-work.done)/rate:undefined;
  }
  return this.smoother.next(this.held,now);
 }
}

/** Bytes (or files) per second from successive totals: EWMA with a time-based alpha, so it follows a change within
 * seconds and falls during a stall (the state is republished every few seconds). Undefined for the first second. */
export class RateMeter {
 private last?:{at:number;value:number};private ewma?:number;private span=0;
 next(value:number,now:number):number|undefined{
  if(!this.last||value<this.last.value){this.last={at:now,value};this.ewma=undefined;this.span=0;return undefined;}
  const dt=now-this.last.at;
  if(dt>=250){
   const rate=(value-this.last.value)/(dt/1000),alpha=1-Math.exp(-dt/5000);
   this.ewma=this.ewma===undefined?rate:alpha*rate+(1-alpha)*this.ewma;this.span+=dt;this.last={at:now,value};
  }
  return this.span>=1000?this.ewma:undefined;
 }
}

/** A job's progress as the tracker needs it (the shape of Progress). */
export interface EtaInput {phase?:string;step?:string;share?:number;completed:number;total:number;bytes:number;totalBytes:number;}
/** listingTotalBytes: the used space of the drive being listed, when known. */
export interface EtaContext {kind:'import'|'organization'|'finalize'|'undo';destinations:number;verify:boolean;listingTotalBytes?:number;}
export interface JobEta {step?:number;job?:number;}

const MiB=1<<20;
/** Stages that move data count bytes plus a per-file cost; the others count files. */
const dataStages=new Set(['planning:reading','copying:','copying:moving','verifying:']);
/** Work units per second before a stage was measured this session: conservative for spinning drives. */
const defaultRates:Record<string,number>={'planning:checking':40,'planning:comparing':300,'planning:existing':100,'planning:reading':80e6,'copying:':60e6,'verifying:':100e6,
 'verifying:history':200,'verifying:earlier':200,'verifying:confirming':100,'copying:moving':200e6,'verifying:checking':100,'copying:releasing':50,'copying:restoring':50};
const pipelines:Record<EtaContext['kind'],string[]>={
 import:['planning:listing','planning:checking','planning:comparing','planning:existing','copying:','verifying:'],
 organization:['planning:listing','planning:checking','planning:reading','verifying:history','verifying:earlier','verifying:confirming','copying:moving'],
 finalize:['verifying:checking','copying:releasing'],
 undo:['verifying:checking','copying:restoring'],
};
/** Bytes a listing will find: the job's own estimate (an earlier listing of the scope), else the drive's used space; 0 when unknown. */
const listingTotal=(progress:EtaInput,context:EtaContext)=>progress.totalBytes>progress.bytes?progress.totalBytes:context.listingTotalBytes&&context.listingTotalBytes>progress.bytes?context.listingTotalBytes:0;
const SHARE_UNITS=10000;
/** Seconds: a listing never shows more time left than this. */
const MAX_LISTING_ETA=24*3600;
const stageKey=(progress:EtaInput)=>`${progress.phase??''}:${progress.step??''}`;
/** Stages whose total is an estimate (a share), not a count: a listing, and a look through folders for leftovers. */
const estimated=(key:string)=>key==='planning:listing'||key==='planning:scanning';
/** Stages that read or write data: they report bytes per second once bytes move, files per second until then. Every other stage counts files. */
const dataKeys=new Set(['planning:reading','planning:comparing','copying:','copying:moving','verifying:']);

interface Known {files?:number;bytes?:number;copyFiles?:number;copyBytes?:number;entries?:number;}
/** estimated: an earlier stage of this job had its own estimate, so the job total can bridge a warming stage. */
interface Tracked {key:string;estimator:EtaEstimator;smoother:EtaSmoother;known:Known;estimated:boolean;}

/** Per-job estimates. Rates measured in a stage are remembered for later jobs of this app session. */
export class EtaTracker {
 private readonly jobs=new Map<string,Tracked>();
 private readonly rates=new Map<string,number>();
 private readonly meters=new Map<string,{key:string;meter:RateMeter}>();
 private readonly starts=new Map<string,string>();
 /** Read speed of a job's step (or a scan's), measured from its running total; a new step measures afresh. */
 measure(id:string,key:string,value:number,now:number):number|undefined{
  let tracked=this.meters.get(id);
  if(!tracked||tracked.key!==key){tracked={key,meter:new RateMeter()};this.meters.set(id,tracked);}
  return tracked.meter.next(value,now);
 }
 /** ISO time something shown with progress (a review, a scan) was first seen; kept until it stops. */
 since(id:string,now:number):string{let start=this.starts.get(id);if(!start){start=new Date(now).toISOString();this.starts.set(id,start);}return start;}
 private rate(key:string){return this.rates.get(key)??defaultRates[key];}
 private sample(key:string,progress:EtaInput,context:EtaContext):EtaSample{
  // A listing is measured by its share (an estimate that grows with what is found), never by a total that moves with it.
  // Past the knee the estimate is being stretched, so the time left cannot be trusted: none is shown.
  if(estimated(key)){
   const share=progress.share??(context.listingTotalBytes&&progress.bytes>0?listingShare(progress.bytes,context.listingTotalBytes):undefined);
   const reliable=share!==undefined&&!(key==='planning:listing'&&share>LISTING_KNEE);
   return reliable?{files:Math.round(share*SHARE_UNITS),bytes:progress.bytes,totalFiles:SHARE_UNITS,totalBytes:0}:{files:0,bytes:progress.bytes,totalFiles:0,totalBytes:0};
  }
  // Verification reports files; its bytes follow the share of files verified.
  const bytes=key==='verifying:'&&progress.total?progress.totalBytes*Math.min(1,progress.completed/progress.total):progress.bytes;
  return {files:progress.completed,bytes,totalFiles:progress.total,totalBytes:progress.totalBytes};
 }
 private learn(key:string,progress:EtaInput,context:EtaContext,known:Known){
  const listed=listingTotal(progress,context);
  if(key==='planning:listing'&&progress.bytes>0&&listed>progress.bytes){known.bytes=listed;known.files=Math.round(progress.completed*listed/progress.bytes);}
  if(key==='planning:checking'){known.files=progress.total;known.bytes=progress.totalBytes;}
  if(key==='copying:'||key==='verifying:'){known.copyFiles=progress.total;known.copyBytes=progress.totalBytes;}
  if(key==='verifying:confirming'||key==='verifying:checking')known.entries=progress.total;
 }
 /** Work a stage still ahead will take, from what the job has shown so far; undefined when unknown. */
 private ahead(key:string,known:Known,context:EtaContext):number|undefined{
  const copies=Math.max(1,context.destinations);
  const files=key==='planning:checking'?known.files:key==='planning:comparing'&&known.files!==undefined?known.files*copies
   :key==='copying:'||key==='verifying:'?known.copyFiles??(known.files!==undefined?known.files*copies:undefined)
   :key==='copying:moving'||key==='copying:releasing'||key==='copying:restoring'?known.entries:undefined;
  if(files===undefined)return undefined;
  if(!dataStages.has(key))return files;
  const bytes=known.copyBytes??(known.bytes!==undefined?known.bytes*copies:undefined);
  return key==='copying:moving'?files*MiB:bytes===undefined?undefined:bytes+files*MiB;
 }
 /** Feed the job's latest progress (repeat it when nothing changed: time passing matters). */
 observe(id:string,progress:EtaInput,context:EtaContext,now:number):JobEta{
  const key=stageKey(progress);
  let tracked=this.jobs.get(id);
  if(!tracked||tracked.key!==key){
   const known=tracked?.known??{};
   tracked={key,estimator:new EtaEstimator(dataStages.has(key)?{perFileBytes:MiB}:estimated(key)?{perFileBytes:0}:{}),smoother:tracked?.smoother??new EtaSmoother(),known,estimated:tracked?.estimated??false};
   this.jobs.set(id,tracked);
  }
  this.learn(key,progress,context,tracked.known);
  const sample=this.sample(key,progress,context),measured0=tracked.estimator.update(sample,now),measured=tracked.estimator.rate;
  // A listing that claims more than a day left is guessing.
  const step=estimated(key)&&measured0!==undefined&&measured0>MAX_LISTING_ETA?undefined:measured0;
  if(measured&&!estimated(key))this.rates.set(key,measured);
  // While a stage warms up, its remaining work at the remembered rate stands in for the job total.
  let current=step;
  if(step!==undefined)tracked.estimated=true;
  else if(tracked.estimated){
   const rate=this.rate(key),total=dataStages.has(key)?sample.totalBytes+MiB*sample.totalFiles:sample.totalFiles,done=dataStages.has(key)?sample.bytes+MiB*sample.files:sample.files;
   if(rate&&total>0&&!estimated(key))current=Math.max(0,total-done)/rate;
  }
  if(current===undefined)return tracked.smoother.next(undefined,now),{};
  const pipeline=context.kind==='import'&&!context.verify?pipelines.import.filter(item=>item!=='verifying:'):pipelines[context.kind];
  const position=pipeline.indexOf(key);
  let rest=0;
  if(position>=0)for(const later of pipeline.slice(position+1)){const work=this.ahead(later,tracked.known,context),rate=this.rate(later);if(work!==undefined&&rate)rest+=work/rate;}
  const job=tracked.smoother.next(current+rest,now,false);
  return step===undefined?{job}:{step,job:Math.max(job??0,step)};
 }
 /** Drop jobs no longer running; a resumed job starts measuring afresh. */
 forget(live:Iterable<string>){const keep=new Set(live);for(const map of [this.jobs,this.meters,this.starts])for(const id of map.keys())if(!keep.has(id))map.delete(id);}
}

/** Stamps estimates (seconds) on everything the interface shows progress for: each running job and its stage,
 * the review being prepared, the backup folder check, and source scans. Call as the state is published. */
export function stampEstimates(state:AppState,tracker:EtaTracker,now:number){
 const live:string[]=[],verify=state.preferences.verifyCopies!==false;
 const used=(source:Source)=>source.transport!=='folder'&&source.total!==undefined&&source.free!==undefined?source.total-source.free:undefined;
 const stepOnly=(id:string,progress:EtaInput,context:EtaContext)=>{live.push(id);return tracker.observe(id,progress,context,now).step;};
 const since=(id:string)=>{live.push(id);return tracker.since(id,now);};
 // Every step shows how fast it goes: bytes per second where data is read or written (once bytes move), otherwise files per second
 // (renames, checks, deletes, listings, metadata). Both come from a rolling window over the step's running totals.
 // Copying and moving keep the average the transfer itself reported until the window has a measure.
 const speeds=(id:string,progress:Progress)=>{
  const key=stageKey(progress);live.push(id+':bytes',id+':files');
  // Verification reports files; its bytes follow the share of files verified.
  const total=key==='verifying:'&&progress.total?progress.totalBytes*Math.min(1,progress.completed/progress.total):progress.bytes;
  const measured=tracker.measure(id+':bytes',key,total,now),files=tracker.measure(id+':files',key,progress.completed,now);
  let speed=0;
  if(dataKeys.has(key)){speed=measured??(total>0?progress.speed:0);if(!(speed>0))speed=0;}
  progress.speed=speed;
  // Metadata checking shows both: files per second and the bytes of the files it has covered, per second.
  if(key==='planning:checking'){progress.speed=measured&&measured>0?measured:0;if(files!==undefined)progress.fileRate=files;else delete progress.fileRate;}
  else if(speed>0)delete progress.fileRate;else if(files!==undefined)progress.fileRate=files;else delete progress.fileRate;
 };
 /** An operation that is not a job: time left, when it began, and its speed. */
 const alone=(name:string,progress:Progress)=>{progress.eta=stepOnly(name,progress,{kind:'import',destinations:1,verify});progress.startedAt=since('start:'+name);speeds('speed:'+name,progress);};
 for(const job of state.jobs){
  if(!['discovering','verifying','copying'].includes(job.phase)||!job.progress){delete job.eta;if(job.progress)delete job.progress.eta;continue;}
  live.push(job.id);
  const step=job.progress.step,kind:EtaContext['kind']=!job.organization?'import':step==='restoring'?'undo':step==='checking'&&job.progress.phase!=='planning'||step==='releasing'||step==='deleting'?'finalize':'organization';
  const destinations=job.organization||state.preferences.copyMode==='single'?1:Math.max(1,state.preferences.destinations.length);
  const eta=tracker.observe(job.id,job.progress,{kind,destinations,verify,listingTotalBytes:job.organization?undefined:used(job.source)},now);
  job.progress.eta=eta.step;job.eta=eta.job;
  speeds('speed:'+job.id,job.progress);
 }
 if(state.reviewProgress)alone('review',state.reviewProgress);
 if(state.duplicates?.progress)alone('duplicates',state.duplicates.progress);
 for(const [destination,progress] of Object.entries(state.misplacedProgress??{}))alone('misplaced:'+destination,progress);
 if(state.residue?.progress)alone('residue',state.residue.progress);
 if(state.organizationRecoveryProgress)alone('recovery-listing',state.organizationRecoveryProgress);
 // A scan lists the files, then reads their metadata: one clock for both.
 for(const [id,listing] of Object.entries(state.scanProgress??{})){const source=state.sources.find(item=>item.id===id);listing.eta=source&&stepOnly('scan:'+id,{phase:'planning',step:'listing',completed:listing.files,total:0,bytes:listing.bytes,totalBytes:0,...(listing.topShare!==undefined&&!used(source)?{share:listing.topShare}:{})},{kind:'import',destinations:1,verify,listingTotalBytes:used(source)});listing.startedAt=since('start:scan:'+id);listing.fileRate=tracker.measure('speed:scan:'+id,'listing',listing.files,now);live.push('speed:scan:'+id);}
 for(const [id,info] of Object.entries(state.sourceCameraInfo??{})){
  if(info.status!=='reading'){info.eta=info.fileRate=info.startedAt=undefined;continue;}
  info.eta=stepOnly('camera:'+id,{phase:'planning',step:'checking',completed:info.checked,total:info.total,bytes:0,totalBytes:0},{kind:'import',destinations:1,verify});
  info.startedAt=since('start:scan:'+id);info.fileRate=tracker.measure('speed:camera:'+id,'camera',info.checked,now);live.push('speed:camera:'+id);
 }
 tracker.forget(live);
}
