/** Time-remaining estimates for every stage of a job and for the whole job. See docs/eta-estimates.md. */
import type {AppState,Job,Progress,Source} from './shared';
import {LISTING_KNEE,listingShare} from './listing-estimate';
import {DisplayHold,remainingRange} from './eta-format';
import {FractionHold,JobModel,defaultBook,sharedDriveTotal,type JobKind,type PriorBook,type StepTotal} from './eta-model';
import {PriorTable,layeredBook,type DriveInfo,type PriorContext,type PriorStore} from './eta-priors';
import {log} from './logger';

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

/** Seconds of history a rate is measured over, and the least history it needs before it is shown. */
const RATE_WINDOW=5000,RATE_MIN_SPAN=2000;
/** Bytes (or files) per second from successive totals: the change over the last 5 s, found by interpolating the running total at the
 * window's start, so every moment in it counts for its length and a burst or a pause of one file moves it little. Undefined until
 * 2 s of history; a stall reads 0 once the window holds nothing but the stall; a total that goes down starts a new measure. */
export class RateMeter {
 private samples:{at:number;value:number}[]=[];
 next(value:number,now:number):number|undefined{
  const samples=this.samples,last=samples[samples.length-1];
  if(last&&(value<last.value||now<last.at)){samples.length=0;}
  const latest=samples[samples.length-1];
  if(latest&&now===latest.at)latest.value=value;else samples.push({at:now,value});
  while(samples.length>2&&samples[1]!.at<=now-RATE_WINDOW)samples.shift();
  if(samples.length<2)return undefined;
  const first=samples[0]!;
  let base=first.value,from=first.at;
  if(first.at<now-RATE_WINDOW){const second=samples[1]!,share=(now-RATE_WINDOW-first.at)/(second.at-first.at);base=first.value+share*(second.value-first.value);from=now-RATE_WINDOW;}
  const span=now-from;
  return span>=RATE_MIN_SPAN?(value-base)/(span/1000):undefined;
 }
}

/** A job's progress as the tracker needs it (the shape of Progress). */
export interface EtaInput {phase?:string;step?:string;share?:number;completed:number;total:number;bytes:number;totalBytes:number;work?:Progress['work'];matched?:number;matchedBytes?:number;}
/** listingTotalBytes: the used space of the drive being listed, when known. shared: another running job writes to the same destination drive. */
export interface EtaContext {kind:JobKind;destinations:number;verify:boolean;listingTotalBytes?:number;shared?:boolean;}
export interface JobEta {step?:number;job?:number;/** The low and high end of `job` while the estimate is still wide. */low?:number;high?:number;}
/** What a job is, told by the code that starts it: its kind (never guessed from step names), the drives it reads and writes, and what it will do. */
export interface EtaPlan {kind:JobKind;source?:DriveInfo;destinations?:DriveInfo[];verify?:boolean;publish?:'link'|'copy';totals?:Record<string,StepTotal>;/** Backup copies a Delete originals run re-reads besides the source. */backups?:number;estimated?:boolean;}
/** Where a job stands as a whole, for the bars and the overview. */
export interface JobView {fraction?:number;cost?:{done:number;total:number};}

const MiB=1<<20;
/** Stages whose legacy (non-model) estimate counts bytes plus a per-file cost; the others count files. */
const dataStages=new Set(['planning:reading','copying:','copying:moving','verifying:']);
const SHARE_UNITS=10000;
/** Seconds: a listing never shows more time left than this. */
const MAX_LISTING_ETA=24*3600;
const stageKey=(progress:EtaInput)=>`${progress.phase??''}:${progress.step??''}`;
/** Stages whose total is an estimate (a share), not a count: a listing, and a look through folders for leftovers. */
const estimated=(key:string)=>key==='planning:listing'||key==='planning:scanning';
/** Stages that read or write data: they report bytes per second once bytes move, files per second until then. Every other stage counts files. */
const dataKeys=new Set(['planning:reading','planning:comparing','planning:index','copying:','copying:moving','verifying:']);
/** Bytes a listing will find: the job's own estimate (an earlier listing of the scope), else the drive's used space; 0 when unknown. */
const listingTotal=(progress:EtaInput,context:EtaContext)=>progress.totalBytes>progress.bytes?progress.totalBytes:context.listingTotalBytes&&context.listingTotalBytes>progress.bytes?context.listingTotalBytes:0;
/** The model's name for what a progress is doing; undefined for steps it does not model (listing, downloading, scanning). */
function modelStep(progress:EtaInput,kind:JobKind):string|undefined{
 const {phase,step}=progress;
 if(step==='deleting'&&kind==='originals')return 'originals:deleting';
 if(!step)return phase==='copying'?'copying':phase==='verifying'?'verifying':undefined;
 if(step==='checking')return phase==='planning'?'checking':'verifying:checking';
 return ['comparing','existing','reading','removing','history','earlier','confirming','moving','stashing','tidying','releasing','restoring','deleting'].includes(step)?step:undefined;
}
/** Steps that count data (bytes) even when the model has no byte total for them: the totals a step reports are used as given. */
const unknownBytes=new Set(['comparing','moving']);

interface Known {files?:number;bytes?:number;copyFiles?:number;copyBytes?:number;entries?:number;}
/** The legacy estimator of one stage: used for a listing and for steps the model does not cover. */
interface Legacy {key:string;estimator:EtaEstimator;smoother:EtaSmoother;}
interface JobState {
 plan:EtaPlan;model:JobModel;book:PriorBook;context?:PriorContext;known:Known;fixed:Set<string>;
 first?:number;last?:number;key?:string;legacy?:Legacy;
 stepSmoother:EtaSmoother;jobSmoother:EtaSmoother;hold:DisplayHold;fractions:FractionHold;
 shared:Map<string,{shared:number;total:number}>;view:JobView;current?:string;
}

/** Per-job estimates. What each finished step measured is remembered for later jobs of this app session (and, with a store, across restarts). */
export class EtaTracker {
 private readonly jobs=new Map<string,JobState>();
 private readonly plans=new Map<string,EtaPlan>();
 private readonly meters=new Map<string,{key:string;meter:RateMeter}>();
 private readonly starts=new Map<string,string>();
 private readonly session=new PriorTable('session');
 private lastNow=0;
 private readonly copyPublishing=new Set<string>();
 constructor(private store?:PriorStore){}
 /** Save what finished steps measured in this file from now on. */
 attach(store:PriorStore){this.store=store;}
 /** Read speed of a job's step (or a scan's), measured from its running total; a new step measures afresh. */
 measure(id:string,key:string,value:number,now:number):number|undefined{
  let tracked=this.meters.get(id);
  if(!tracked||tracked.key!==key){tracked={key,meter:new RateMeter()};this.meters.set(id,tracked);}
  return tracked.meter.next(value,now);
 }
 /** ISO time something shown with progress (a review, a scan) was first seen; kept until it stops. */
 since(id:string,now:number):string{let start=this.starts.get(id);if(!start){start=new Date(now).toISOString();this.starts.set(id,start);}return start;}
 /** Tell the tracker what a job is. Call when it starts (and again with `totals` once its plans are known). */
 plan(id:string,plan:EtaPlan){
  const old=this.plans.get(id);
  const merged={...old,...plan,totals:{...old?.totals,...plan.totals}};
  this.plans.set(id,merged);
  const state=this.jobs.get(id);
  if(state&&(plan.source||plan.destinations)){
   state.context=this.contextOf(merged);
   state.book=this.bookOf(merged,state.context);
   state.model.setBook(state.book);
  }
  if(state){if(plan.publish)state.model.setPublish(plan.publish);for(const [step,total] of Object.entries(plan.totals??{})){state.model.setTotal(step,total);state.fixed.add(state.model.resolve(step));}}
 }
 kind(id:string):JobKind|undefined{return this.plans.get(id)?.kind;}
 /** The destination drive ids a job writes to (from its plan). */
 destinationsOf(id:string):string[]{return (this.plans.get(id)?.destinations??[]).flatMap(item=>item.id?[item.id]:[]);}
 view(id:string):JobView{return this.jobs.get(id)?.view??{};}
 /** A step's saved seconds per GB for this job's drives, when one run or more measured it. */
 soloSecondsPerGB(id:string,step:string):number|undefined{
  const state=this.jobs.get(id);if(!state?.context)return undefined;
  const choice=state.book.lookup(step);
  return choice.level==='exact'&&choice.coef.b>0?choice.coef.b:undefined;
 }
 private contextOf(plan:EtaPlan):PriorContext|undefined{return plan.source||plan.destinations?.length?{source:plan.source,destinations:plan.destinations??[]}:undefined;}
 private bookOf(plan:EtaPlan,context:PriorContext|undefined):PriorBook{
  const fallback=defaultBook(plan.backups??1);
  return context?layeredBook(context,this.session,this.store?.table??new PriorTable('none'),fallback):fallback;
 }
 /** Whether files are expected to be published by copying on these destinations: one did before (this session or in saved history), or its file system has no hard links. */
 predictPublish(destinations:DriveInfo[]):'link'|'copy'{
  const slow=new Set(['exfat','msdos','fat32','vfat','ntfs','fat']);
  return destinations.some(item=>(item.id&&this.copyPublishing.has(item.id))||slow.has((item.fsType??'').toLowerCase()))?'copy':'link';
 }
 private create(id:string,context:EtaContext):JobState{
  const plan=this.plans.get(id)??{kind:context.kind};
  const prior=this.contextOf(plan),book=this.bookOf(plan,prior);
  const model=new JobModel({kind:plan.kind,book,totals:plan.totals,verify:plan.verify??context.verify,publish:plan.publish,estimated:plan.estimated});
  const state:JobState={plan,model,book,context:prior,known:{},fixed:new Set(Object.keys(plan.totals??{}).map(step=>model.resolve(step))),stepSmoother:new EtaSmoother(),jobSmoother:new EtaSmoother(),hold:new DisplayHold(),fractions:new FractionHold(),shared:new Map(),view:{}};
  this.jobs.set(id,state);
  return state;
 }
 private sample(key:string,progress:EtaInput,context:EtaContext):EtaSample{
  // A listing is measured by its share (an estimate that grows with what is found), never by a total that moves with it.
  // Past the knee the estimate is being stretched, so the time left cannot be trusted: none is shown.
  if(estimated(key)){
   const share=progress.share??(context.listingTotalBytes&&progress.bytes>0?listingShare(progress.bytes,context.listingTotalBytes):undefined);
   const reliable=share!==undefined&&!(key==='planning:listing'&&share>LISTING_KNEE);
   return reliable?{files:Math.round(share*SHARE_UNITS),bytes:progress.bytes,totalFiles:SHARE_UNITS,totalBytes:0}:{files:0,bytes:progress.bytes,totalFiles:0,totalBytes:0};
  }
  return {files:progress.completed,bytes:progress.bytes,totalFiles:progress.total,totalBytes:progress.totalBytes};
 }
 /** The totals of the steps still ahead, from what the job has shown so far, for any the plan did not set. */
 private learn(state:JobState,step:string,total:{files:number;bytes:number},context:EtaContext,progress?:EtaInput){
  const {model,fixed}=state,copies=Math.max(1,context.destinations),set=(name:string,value:StepTotal)=>{if(!fixed.has(model.resolve(name)))model.setTotal(name,value);};
  switch(state.plan.kind){
   case 'import':
    if(step==='checking'){
     state.known.files=total.files;state.known.bytes=total.bytes;
     set('comparing',{files:total.files*copies,bytes:total.bytes*copies,bytesKnown:false});set('existing',{files:total.files*copies,bytes:0});
     set('copying',{files:total.files*copies,bytes:total.bytes*copies});set('verifying',{files:total.files*copies,bytes:total.bytes*copies});
    }
    // Files that turned out identical at the destination are not copied or verified: the later steps shrink as they are found.
    if(step==='comparing'&&progress?.matched!==undefined&&state.known.files!==undefined){
     const files=Math.max(0,state.known.files*copies-progress.matched),bytes=Math.max(0,(state.known.bytes??0)*copies-(progress.matchedBytes??0));
     set('copying',{files,bytes});set('verifying',{files,bytes});
    }
    if(step==='copying')set('verifying',{files:total.files,bytes:total.bytes});
    break;
   case 'organization':
    if(step==='checking'){set('reading',{files:total.files,bytes:total.bytes});set('moving',{files:total.files,bytes:0,bytesKnown:false});}
    break;
   case 'finalize':if(step==='verifying:checking')set('releasing',{files:total.files,bytes:0});break;
   case 'undo':if(step==='verifying:checking')set('restoring',{files:total.files,bytes:0});break;
   default:break;
  }
 }
 /** Feed the job's latest progress (repeat it when nothing changed: time passing matters). */
 observe(id:string,progress:EtaInput,context:EtaContext,now:number):JobEta{
  this.lastNow=now;
  const key=stageKey(progress);
  let state=this.jobs.get(id)??this.create(id,context);
  state.first??=now;
  const step=modelStep(progress,state.plan.kind);
  if(!step||!state.model.covers(step))return this.legacy(state,key,progress,context,now);
  // The step's own counts: what the main process says it works on, else the progress counters.
  const work=progress.work;
  let done={files:work?.files??progress.completed,bytes:work?.bytes??progress.bytes},total={files:work?.totalFiles??progress.total,bytes:work?.totalBytes??progress.totalBytes};
  if(!work&&step==='verifying'&&total.files>0)done={files:done.files,bytes:total.bytes*Math.min(1,done.files/total.files)};
  if(work?.publishCopy){state.model.setPublish('copy');for(const id_ of this.destinationsOf(id))this.copyPublishing.add(id_);}
  const bytesUnknown=unknownBytes.has(step)&&!(step==='comparing'&&total.bytes>0);
  if(state.key!==key){
   if(state.key!==undefined&&state.current!==undefined)this.record(state,now);
   state.key=key;state.current=state.model.resolve(step);state.legacy=undefined;state.stepSmoother=new EtaSmoother();
  }
  this.learn(state,state.model.resolve(step),total,context,progress);
  const resolved=state.model.resolve(step),span=state.shared.get(resolved)??{shared:0,total:0};
  if(state.last!==undefined){const dt=Math.max(0,now-state.last);span.total+=dt;if(context.shared)span.shared+=dt;}
  state.shared.set(resolved,span);state.last=now;
  const snapshot=state.model.update(now,step,done,{...total,...(bytesUnknown?{bytesKnown:false}:{})});
  for(const ended of state.model.drain())this.save(state,ended,now);
  state.view={cost:snapshot.cost,fraction:state.fractions.next(snapshot.fraction)};
  const finished=snapshot.job===0;
  const stepEta=state.stepSmoother.next(snapshot.step,now,finished&&snapshot.step===0);
  // The job's first seconds are spent estimating.
  const warm=now-state.first>=10000;
  const rawJob=warm?snapshot.job:undefined;
  const smooth=state.jobSmoother.next(rawJob,now,rawJob===0);
  if(smooth===undefined){state.hold.reset();return stepEta===undefined?{}:{step:stepEta};}
  if(smooth===0)return stepEta===undefined?{job:0}:{step:stepEta,job:0};
  const held=state.hold.next(smooth,now)!;
  const job=Math.max(1,held,stepEta??0);
  // The range around the time shown keeps the proportions of the model's.
  const ratio=snapshot.job?job/snapshot.job:1;
  return {...(stepEta===undefined?{}:{step:stepEta}),job,...(snapshot.low!==undefined&&snapshot.high!==undefined?{low:snapshot.low*ratio,high:snapshot.high*ratio}:{})};
 }
 /** A step the model does not cover (a listing, a scan, a review's steps): its own estimator, for the step only. */
 private legacy(state:JobState,key:string,progress:EtaInput,context:EtaContext,now:number):JobEta{
  if(state.key!==key){if(state.key!==undefined&&state.current!==undefined){this.record(state,now);state.current=undefined;}state.key=key;}
  if(!state.legacy||state.legacy.key!==key)state.legacy={key,estimator:new EtaEstimator(dataStages.has(key)?{perFileBytes:MiB}:estimated(key)?{perFileBytes:0}:{}),smoother:new EtaSmoother()};
  state.view={fraction:state.fractions.next(0),cost:{done:0,total:0}};
  const measured=state.legacy.estimator.update(this.sample(key,progress,context),now);
  // A listing that claims more than a day left is guessing.
  const step=estimated(key)&&measured!==undefined&&measured>MAX_LISTING_ETA?undefined:measured;
  return step===undefined?{}:{step,job:step};
 }
 /** A finished step's fit joins the session's history, and the saved one when it is long and unshared enough. */
 private record(state:JobState,now:number){
  state.model.finish();
  for(const ended of state.model.drain())this.save(state,ended,now);
 }
 private save(state:JobState,ended:ReturnType<JobModel['drain']>[number],now:number){
  if(!state.context)return;
  const span=state.shared.get(ended.step),shared=span&&span.total>0?span.shared/span.total:0,day=new Date(now).toISOString().slice(0,10);
  const result={a:ended.a,b:ended.b,T:ended.T,F:ended.F,G:ended.G,observed:ended.observed,shared};
  log('trace','eta','fit',{kind:state.plan.kind,step:ended.step,a:ended.a,b:ended.b,T:ended.T,F:ended.F,G:ended.G,observed:ended.observed,sharedShare:Math.round(shared*100)/100,destinations:state.context.destinations.length});
  this.session.update(ended.step,state.context,result,day);
  this.store?.table.update(ended.step,state.context,result,day);
 }
 /** Write the saved priors if something changed and it is time. Never throws. */
 async saveIfDue(now:number){await this.store?.maybeSave(now);}
 /** Drop jobs no longer running (their last step is remembered); a resumed job starts measuring afresh. */
 forget(live:Iterable<string>){
  const keep=new Set(live);
  for(const [id,state] of this.jobs)if(!keep.has(id)){if(state.current!==undefined)this.record(state,this.lastNow);this.jobs.delete(id);}
  for(const map of [this.meters,this.starts,this.plans])for(const id of map.keys())if(!keep.has(id))map.delete(id);
 }
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
 // Until the window holds 2 s of history no speed is shown: the transfer's own lifetime average is not used, it counts time spent before the data moved.
 const speeds=(id:string,progress:Progress)=>{
  const key=stageKey(progress);live.push(id+':bytes',id+':files');
  // Verification speed counts the bytes hashed so far (they move as each file is read); a report without that counts the bytes of the files
  // published, and without those, follows the share of files verified.
  const total=key==='verifying:'&&progress.hashedBytes!==undefined?progress.hashedBytes:key==='verifying:'&&progress.work?progress.work.bytes:key==='verifying:'&&progress.total?progress.totalBytes*Math.min(1,progress.completed/progress.total):progress.bytes;
  const measured=tracker.measure(id+':bytes',key,total,now),files=tracker.measure(id+':files',key,progress.completed,now);
  let speed=0;
  if(dataKeys.has(key)){speed=measured??0;if(!(speed>0))speed=0;}
  progress.speed=speed;
  // Metadata checking reads headers, not the files: it shows files per second only (its bytes are the size of the files covered, not data moved).
  if(files!==undefined)progress.fileRate=files;else delete progress.fileRate;
 };
 /** An operation that is not a job: time left, when it began, and its speed. */
 const alone=(name:string,progress:Progress)=>{progress.eta=stepOnly(name,progress,{kind:'import',destinations:1,verify});progress.startedAt=since('start:'+name);speeds('speed:'+name,progress);};
 const running:{job:Job;id:string}[]=[];
 // Jobs writing to the same destination drive at once: whether another is, decided before any is observed.
 const writing=new Map<string,number>();
 const active=state.jobs.filter(job=>['discovering','verifying','copying'].includes(job.phase)&&job.progress);
 for(const job of active)for(const destination of new Set(tracker.destinationsOf(job.id)))writing.set(destination,(writing.get(destination)??0)+1);
 for(const job of state.jobs){
  if(!['discovering','verifying','copying'].includes(job.phase)||!job.progress){
   delete job.eta;delete job.etaRange;if(job.progress)delete job.progress.eta;
   if(job.phase==='complete'&&job.cost)job.cost={done:job.cost.total,total:job.cost.total};
   if(job.phase==='complete')job.fraction=1;
   continue;
  }
  live.push(job.id);
  const kind=tracker.kind(job.id)??(job.organization?'organization':'import');
  const destinations=job.organization||state.preferences.copyMode==='single'?1:Math.max(1,state.preferences.destinations.length);
  const shared=tracker.destinationsOf(job.id).some(destination=>(writing.get(destination)??0)>1);
  const eta=tracker.observe(job.id,job.progress,{kind,destinations,verify,shared,listingTotalBytes:job.organization?undefined:used(job.source)},now);
  const view=tracker.view(job.id);
  job.progress.eta=eta.step;
  if(job.stopping){delete job.eta;delete job.etaRange;}
  else{job.eta=eta.job;if(eta.low!==undefined&&eta.high!==undefined)job.etaRange={low:eta.low,high:eta.high};else delete job.etaRange;}
  if(view.fraction!==undefined)job.fraction=view.fraction;
  if(view.cost)job.cost=view.cost;
  speeds('speed:'+job.id,job.progress);
  running.push({job,id:job.id});
 }
 // Delete originals: re-reads the source and every backup copy of each file.
 for(const job of state.jobs){
  const deleting=job.deletingOriginals;
  if(!deleting){continue;}
  const id='originals:'+job.id;live.push(id);
  const eta=tracker.observe(id,{phase:'copying',step:'deleting',completed:deleting.completed,total:deleting.total,bytes:deleting.bytes??0,totalBytes:deleting.totalBytes??0},{kind:'originals',destinations:1,verify},now);
  deleting.eta=eta.job??eta.step;deleting.startedAt=since('start:'+id);
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
 state.etaTotal=overviewEta(running.map(item=>item.job),tracker);
 if(!state.etaTotal)delete state.etaTotal;
 tracker.forget(live);
 void tracker.saveIfDue(now);
}

/** Steps that read and write the destination drive: jobs doing these at once on one drive share its speed. */
const heavy=(job:Job)=>{const progress=job.progress;return !!progress&&(progress.phase==='copying'&&!progress.step||progress.phase==='verifying'&&!progress.step);};
/** Time left for all running jobs together: the longest one, except that jobs sharing a destination drive which is the bottleneck
 * speed each other up as they finish (processor sharing). Each job's own time stays as measured. Undefined while any job is estimating. */
export function overviewEta(jobs:Job[],tracker:EtaTracker):{eta:number;low?:number;high?:number}|undefined{
 if(!jobs.length||jobs.some(job=>job.eta===undefined||job.stopping))return undefined;
 // Jobs that share a destination are one group.
 const group=jobs.map((_job,index)=>index),find=(index:number):number=>group[index]===index?index:(group[index]=find(group[index]!));
 const owner=new Map<string,number>();
 jobs.forEach((job,index)=>{for(const destination of tracker.destinationsOf(job.id)){const other=owner.get(destination);if(other===undefined)owner.set(destination,index);else group[find(index)]=find(other);}});
 const groups=new Map<number,Job[]>();
 jobs.forEach((job,index)=>{const root=find(index);groups.set(root,[...(groups.get(root)??[]),job]);});
 let total=0,leader=jobs[0]!;
 for(const members of groups.values()){
  const etas=members.map(job=>job.eta!);
  let value=Math.max(...etas);
  if(members.length>1&&members.every(heavy)){
   // The drive is the bottleneck when the jobs together move at least 0.7 of what it did alone.
   const solo=members.map(job=>tracker.soloSecondsPerGB(job.id,job.progress!.phase==='copying'?'copying':'verifying:copy')).filter((item):item is number=>item!==undefined);
   const rate=members.reduce((sum,job)=>sum+(job.progress?.speed??0),0),alone=solo.length?1e9/Math.min(...solo):undefined;
   if(alone!==undefined&&rate>=0.7*alone)value=sharedDriveTotal(etas,true);
  }
  if(value>=total){total=value;leader=members.reduce((best,job)=>job.eta!>best.eta!?job:best,members[0]!);}
 }
 const ratio=leader.eta?total/leader.eta:1;
 return {eta:total,...(leader.etaRange?{low:leader.etaRange.low*ratio,high:leader.etaRange.high*ratio}:{})};
}
