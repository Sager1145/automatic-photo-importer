/** Time-remaining estimates for every stage of a job and for the whole job. See docs/eta-estimates.md. */
import {ACTIVE_PHASES,type AppState,type Job,type Progress} from './shared';
import {LISTING_KNEE} from './listing-estimate';
import {RateMeter} from './rate-meter';
import {FractionHold,JobModel,defaultBook,sharedDriveTotal,type JobKind,type PriorBook,type StepTotal} from './eta-model';
import {PriorTable,layeredBook,type DriveInfo,type PriorContext,type PriorStore} from './eta-priors';
import {log} from './logger';

/** A job's progress as the tracker needs it (the shape of Progress). */
export interface EtaInput {phase?:string;step?:string;share?:number;completed:number;total:number;bytes:number;totalBytes:number;work?:Progress['work'];matched?:number;matchedBytes?:number;}
/** shared: another running job writes to the same destination drive. */
export interface EtaContext {kind:JobKind;destinations:number;verify:boolean;shared?:boolean;}
export interface JobEta {step?:number;job?:number;/** The low and high end of `job` while the estimate is still wide. */low?:number;high?:number;}
/** What a job is, told by the code that starts it: its kind (never guessed from step names), the drives it reads and writes, and what it will do. */
export interface EtaPlan {kind:JobKind;source?:DriveInfo;destinations?:DriveInfo[];verify?:boolean;publish?:'link'|'copy';totals?:Record<string,StepTotal>;/** Backup copies a Delete originals run re-reads besides the source. */backups?:number;estimated?:boolean;/** Destinations expected to be written directly (each file checked in place as it is copied): no verify step is planned for them. */direct?:number;}
/** Where a job stands as a whole in the time-left model (logged with its progress; rows show their step's share). */
export interface JobView {fraction?:number;}

/** The share of an import's verify work still planned once the destinations written directly are left out. */
const verifyShare=(plan:EtaPlan)=>{const count=plan.destinations?.length??0;return count>0?Math.max(0,count-Math.min(count,plan.direct??0))/count:1;};
/** A plan's totals with the verify step's shrunk to the destinations that verify after copying. */
function plannedTotals(plan:EtaPlan):Record<string,StepTotal>|undefined{
 const verifying=plan.totals?.verifying,share=verifyShare(plan);
 return verifying&&share<1?{...plan.totals,verifying:{...verifying,files:verifying.files*share,bytes:verifying.bytes*share}}:plan.totals;
}
/** Files compared before their share found identical is trusted to stand for the rest. */
const COMPARED_SAMPLE=20;
/** Seconds: a listing never shows more time left than this. */
const MAX_LISTING_ETA=24*3600;
const stageKey=(progress:EtaInput)=>`${progress.phase??''}:${progress.step??''}`;
/** Stages whose total is an estimate (a share), not a count: a listing, and a look through folders for leftovers. */
const estimated=(key:string)=>key==='planning:listing'||key==='planning:scanning';
/** Stages that read or write data: they report bytes per second once bytes move, files per second until then. Every other stage counts files. */
const dataKeys=new Set(['planning:reading','planning:comparing','planning:index','copying:','copying:moving','verifying:']);
/** The model's name for what a progress is doing: a step of the job's plan, or the step itself for one outside it (a listing, a download). */
function modelStep(progress:EtaInput,kind:JobKind):string{
 const {phase,step}=progress;
 if(step==='deleting'&&kind==='originals')return 'originals:deleting';
 if(!step)return phase==='verifying'?'verifying':phase??'copying';
 if(step==='checking')return phase==='planning'?'checking':'verifying:checking';
 return step;
}
/** Steps that count data (bytes) even when the model has no byte total for them: the totals a step reports are used as given. */
const unknownBytes=new Set(['comparing','moving']);

/** What the checking step found, to shrink the later steps as identical files are matched. */
interface Known {files?:number;bytes?:number;}
interface JobState {
 plan:EtaPlan;model:JobModel;book:PriorBook;context?:PriorContext;known:Known;fixed:Set<string>;
 first?:number;last?:number;key?:string;fractions:FractionHold;
 shared:Map<string,{shared:number;total:number}>;view:JobView;current?:string;
 /** The later steps' totals assume every file checked is copied: comparing has not yet measured how many are new, so the job's time is not claimed. */assumed?:boolean;
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
  if(state)state.plan=merged;
  if(state&&(plan.source||plan.destinations)){
   state.context=this.contextOf(merged);
   state.book=this.bookOf(merged,state.context);
   state.model.setBook(state.book);
  }
  if(state){if(plan.publish)state.model.setPublish(plan.publish);for(const [step,total] of Object.entries(plannedTotals(merged)??{}))if(plan.totals?.[step]){state.model.setTotal(step,total);state.fixed.add(state.model.resolve(step));}if(plan.totals?.copying)state.assumed=false;}
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
 /** How many of these destinations an import writes directly (exFAT on macOS, as the copy decides): each file is checked in place, with no verify step after. */
 predictDirect(destinations:DriveInfo[],platform:string=process.platform):number{
  return platform==='darwin'?destinations.filter(item=>(item.fsType??'').toLowerCase()==='exfat').length:0;
 }
 private create(id:string,context:EtaContext):JobState{
  const plan=this.plans.get(id)??{kind:context.kind};
  const prior=this.contextOf(plan),book=this.bookOf(plan,prior);
  const model=new JobModel({kind:plan.kind,book,totals:plannedTotals(plan),verify:plan.verify??context.verify,publish:plan.publish,estimated:plan.estimated});
  const state:JobState={plan,model,book,context:prior,known:{},fixed:new Set(Object.keys(plan.totals??{}).map(step=>model.resolve(step))),fractions:new FractionHold(),shared:new Map(),view:{}};
  this.jobs.set(id,state);
  return state;
 }
 /** The totals of the steps still ahead, from what the job has shown so far, for any the plan did not set. */
 private learn(state:JobState,step:string,total:{files:number;bytes:number},context:EtaContext,progress?:EtaInput){
  const {model,fixed}=state,copies=Math.max(1,context.destinations),verify=verifyShare(state.plan),set=(name:string,value:StepTotal)=>{if(!fixed.has(model.resolve(name)))model.setTotal(name,value);};
  switch(state.plan.kind){
   case 'import':
    if(step==='checking'){
     state.known.files=total.files;state.known.bytes=total.bytes;
     set('comparing',{files:total.files*copies,bytes:total.bytes*copies,bytesKnown:false});set('existing',{files:total.files*copies,bytes:0});
     set('copying',{files:total.files*copies,bytes:total.bytes*copies});set('verifying',{files:total.files*copies*verify,bytes:total.bytes*copies*verify});
     if(!fixed.has(model.resolve('copying')))state.assumed=true;
    }
    // Files that turned out identical at the destination are not copied or verified: the later steps shrink as they are found. Once enough
    // are compared, the share found identical stands for the files still to compare, and the job's time can be claimed.
    if(step==='comparing'&&progress?.matched!==undefined&&state.known.files!==undefined){
     const knownFiles=state.known.files*copies,knownBytes=(state.known.bytes??0)*copies,matched=progress.matched,matchedBytes=progress.matchedBytes??0;
     const measured=progress.completed>=COMPARED_SAMPLE||progress.total>0&&progress.completed>=progress.total;
     const fileShare=progress.total>0?Math.min(1,progress.completed/progress.total):1,byteShare=progress.totalBytes>0&&progress.bytes>0?Math.min(1,progress.bytes/progress.totalBytes):fileShare;
     const projected=measured&&fileShare>0?Math.min(knownFiles,matched/fileShare):matched,projectedBytes=measured&&byteShare>0?Math.min(knownBytes,matchedBytes/byteShare):matchedBytes;
     const files=Math.max(0,knownFiles-projected),bytes=Math.max(0,knownBytes-projectedBytes);
     set('copying',{files,bytes});set('verifying',{files:files*verify,bytes:bytes*verify});
     if(measured)state.assumed=false;
    }
    if(step==='existing'||step==='copying'||step==='verifying')state.assumed=false;
    if(step==='copying'){
     // Files copied directly are checked in place as they copy: only the rest are verified afterwards, and with none left there is no verify step.
     const direct=progress?.work?.direct,planned=state.plan.totals?.verifying??total;
     if(direct)model.setTotal('verifying',{files:Math.max(0,planned.files-direct.files),bytes:Math.max(0,planned.bytes-direct.bytes)});
     else set('verifying',{files:total.files,bytes:total.bytes});
    }
    break;
   case 'organization':
    if(step==='checking'){set('reading',{files:total.files,bytes:total.bytes});set('moving',{files:total.files,bytes:0,bytesKnown:false});}
    break;
   case 'finalize':if(step==='verifying:checking')set('releasing',{files:total.files,bytes:0});break;
   case 'undo':if(step==='verifying:checking')set('restoring',{files:total.files,bytes:0});break;
   default:break;
  }
 }
 /** Feed the job's latest progress (repeat it when nothing changed: time passing matters). Seconds are the model's, unrounded:
  * how they are held and rounded for display is the renderer's (eta-format). */
 observe(id:string,progress:EtaInput,context:EtaContext,now:number):JobEta{
  this.lastNow=now;
  const key=stageKey(progress);
  let state=this.jobs.get(id)??this.create(id,context);
  state.first??=now;
  const step=modelStep(progress,state.plan.kind);
  // The step's own counts: what the main process says it works on, else the progress counters.
  const work=progress.work;
  let done={files:work?.files??progress.completed,bytes:work?.bytes??progress.bytes},total:StepTotal={files:work?.totalFiles??progress.total,bytes:work?.totalBytes??progress.totalBytes};
  if(!work&&step==='verifying'&&total.files>0)done={files:done.files,bytes:total.bytes*Math.min(1,done.files/total.files)};
  if(work?.publishCopy){state.model.setPublish('copy');for(const id_ of this.destinationsOf(id))this.copyPublishing.add(id_);}
  // A listing's total is what its share implies; past the knee the estimate is being stretched and the time left cannot be trusted.
  const share=progress.share,guessed=estimated(key),trusted=!guessed||(share!==undefined&&share>0&&!(key==='planning:listing'&&share>LISTING_KNEE));
  if(guessed)total=trusted?{files:done.files/share!,bytes:done.bytes/share!}:{files:0,bytes:0};
  else if(unknownBytes.has(step)&&!(step==='comparing'&&total.bytes>0))total={...total,bytesKnown:false};
  if(state.key!==key){
   if(state.key!==undefined&&state.current!==undefined)this.record(state,now);
   state.key=key;state.current=state.model.resolve(step);
  }
  this.learn(state,state.model.resolve(step),total,context,progress);
  const resolved=state.model.resolve(step),span=state.shared.get(resolved)??{shared:0,total:0};
  if(state.last!==undefined){const dt=Math.max(0,now-state.last);span.total+=dt;if(context.shared)span.shared+=dt;}
  state.shared.set(resolved,span);state.last=now;
  const snapshot=state.model.update(now,step,done,total);
  for(const ended of state.model.drain())this.save(state,ended,now);
  // Nothing of the job's own steps measured yet (a listing or a download so far): no share of the job is claimed.
  state.view={fraction:state.fractions.next(snapshot.cost.total>0?snapshot.fraction:undefined)};
  if(!trusted||guessed&&(snapshot.step??0)>MAX_LISTING_ETA)return {};
  // The job's first seconds are spent estimating.
  const job=now-state.first>=10000&&!state.assumed?snapshot.job:undefined;
  return {...(snapshot.step===undefined?{}:{step:snapshot.step}),...(job===undefined?{}:{job}),...(job&&snapshot.low!==undefined&&snapshot.high!==undefined?{low:snapshot.low,high:snapshot.high}:{})};
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
 const active=state.jobs.filter(job=>ACTIVE_PHASES.includes(job.phase)&&job.progress);
 for(const job of active)for(const destination of new Set(tracker.destinationsOf(job.id)))writing.set(destination,(writing.get(destination)??0)+1);
 for(const job of state.jobs){
  if(!ACTIVE_PHASES.includes(job.phase)||!job.progress){
   delete job.eta;delete job.etaRange;if(job.progress)delete job.progress.eta;
   if(job.phase==='complete')job.fraction=1;
   continue;
  }
  live.push(job.id);
  const kind=tracker.kind(job.id)??(job.organization?'organization':'import');
  const destinations=job.organization||state.preferences.copyMode==='single'?1:Math.max(1,state.preferences.destinations.length);
  const shared=tracker.destinationsOf(job.id).some(destination=>(writing.get(destination)??0)>1);
  const eta=tracker.observe(job.id,job.progress,{kind,destinations,verify,shared},now);
  const view=tracker.view(job.id);
  job.progress.eta=eta.step;
  if(job.stopping){delete job.eta;delete job.etaRange;}
  else{job.eta=eta.job;if(eta.low!==undefined&&eta.high!==undefined)job.etaRange={low:eta.low,high:eta.high};else delete job.etaRange;}
  if(view.fraction!==undefined)job.fraction=view.fraction;
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
 for(const [id,listing] of Object.entries(state.scanProgress??{})){listing.eta=stepOnly('scan:'+id,{phase:'planning',step:'listing',completed:listing.files,total:0,bytes:listing.bytes,totalBytes:0,...(listing.share!==undefined?{share:listing.share}:{})},{kind:'import',destinations:1,verify});listing.startedAt=since('start:scan:'+id);listing.fileRate=tracker.measure('speed:scan:'+id,'listing',listing.files,now);live.push('speed:scan:'+id);}
 for(const [id,info] of Object.entries(state.sourceCameraInfo??{})){
  if(info.status!=='reading'){info.eta=info.fileRate=info.startedAt=undefined;continue;}
  info.eta=stepOnly('camera:'+id,{phase:'planning',step:'checking',completed:info.checked,total:info.total,bytes:0,totalBytes:0},{kind:'import',destinations:1,verify});
  info.startedAt=since('start:scan:'+id);info.fileRate=tracker.measure('speed:camera:'+id,'camera',info.checked,now);live.push('speed:camera:'+id);
 }
 state.etaTotal=overviewEta(running.map(item=>item.job),tracker);
 if(!state.etaTotal)delete state.etaTotal;
 // Time left per destination drive: the jobs writing to it, sharing its speed (undefined while any is still estimating).
 const destinationEta:Record<string,number>={};
 for(const destination of writing.keys()){const eta=overviewEta(running.map(item=>item.job).filter(job=>tracker.destinationsOf(job.id).includes(destination)),tracker)?.eta;if(eta!==undefined)destinationEta[destination]=eta;}
 if(Object.keys(destinationEta).length)state.destinationEta=destinationEta;else delete state.destinationEta;
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
