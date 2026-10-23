/** The time-left model: each step costs  a * files + b * gigabytes  seconds. Pure and deterministic: callers pass `now` (ms).
 * a (s/file) and b (s/GB) start from a prior (built-in defaults or saved history) and are fitted from the step's own progress.
 * See docs/eta-estimates.md. */

export interface Coef {a:number;b:number;}
export interface StepDefault extends Coef {/** The bytes of this step are not known beforehand (comparing, moves): the byte part follows the observed mix. */bytesUnknown?:boolean;}
const GB=1e9;
const finite=(value:number)=>Number.isFinite(value)&&value>0?value:0;

/** Seconds per file (a) and per gigabyte (b) before anything was measured. A step with b = 0 counts files only. */
const defaults:Record<string,StepDefault>={
 checking:{a:0.025,b:0},candidates:{a:0.01,b:0},comparing:{a:0.0033,b:12.5,bytesUnknown:true},existing:{a:0.01,b:0},reading:{a:0.005,b:12.5},removing:{a:0.02,b:0},
 copying:{a:0.02,b:16.7},'verifying:link':{a:0.05,b:10},'verifying:copy':{a:0.1,b:40},'publish:link':{a:0.05,b:0},'publish:copy':{a:0.1,b:30},
 history:{a:0.005,b:0},earlier:{a:0.005,b:0},confirming:{a:0.01,b:0},'verifying:checking':{a:0.01,b:0},moving:{a:0.02,b:16.7,bytesUnknown:true},stashing:{a:0.02,b:16.7},tidying:{a:0.01,b:0},
 releasing:{a:0.02,b:0},restoring:{a:0.02,b:0},deleting:{a:0.005,b:0},'originals:deleting':{a:0.02,b:10},
};
/** backups: how many backup copies a Delete originals run re-reads besides the source. */
export function stepDefault(step:string,backups=1):StepDefault{
 const found=defaults[step]??{a:0.02,b:0};
 return step==='originals:deleting'?{...found,b:found.b*(1+Math.max(0,backups))}:found;
}

export type PriorLevel='default'|'class'|'exact';
/** Where a step's starting coefficients came from, and how much to trust them. T0: the prior's weight in seconds. */
export interface PriorChoice {coef:Coef;T0:number;level:PriorLevel;runs:number;}
export interface PriorBook {lookup(step:string):PriorChoice;}
export const defaultBook=(backups=1):PriorBook=>({lookup:step=>{const found=stepDefault(step,backups);return {coef:{a:found.a,b:found.b},T0:20,level:'default',runs:0};}});
/** History with at least two runs counts for more than the built-in defaults. */
export const priorWeight=(level:PriorLevel,runs:number)=>level!=='default'&&runs>=2?60:20;

/** Relative uncertainty of an estimate: 0.15 once measured (>= 60 s), 0.35 while warming up, else by where the prior came from. */
export function levelUncertainty(level:PriorLevel,runs:number){return level==='exact'?(runs>=2?0.3:0.5):level==='class'?0.6:1;}
export function stepUncertainty(input:{observed:number;level:PriorLevel;runs?:number}){
 return input.observed>=60?0.15:input.observed>0?Math.max(0.35,levelUncertainty(input.level,input.runs??0)*(1-input.observed/60)):levelUncertainty(input.level,input.runs??0);
}

const REGULARIZATION=10;
const MINIMUM=0.05;
const WINDOW=5;
const SLEEP=60;

/** One step's fit. observe() takes cumulative files and bytes; a window of at least 5 s with progress becomes one observation. */
export class StepFit {
 private level={T:0,F:0,G:0};
 private total={T:0,F:0,G:0};
 private szz:[number,number,number]=[0,0,0];private szy:[number,number]=[0,0];
 private window?:{start:number;files:number;gb:number};private last?:{at:number;files:number;gb:number};
 private R=0;private split:[number,number]=[0,0];
 private seen=0;private closed=0;
 constructor(readonly prior:Coef,readonly T0=20){}
 /** Seconds of progress observed (closed windows). */
 get observed(){return this.seen;}
 /** Closed windows so far. */
 get windows(){return this.closed;}
 observe(now:number,files:number,bytes:number){
  if(!Number.isFinite(now)||!Number.isFinite(files)||!Number.isFinite(bytes))return;
  const gb=Math.max(0,bytes)/GB;files=Math.max(0,files);
  if(!this.last||files<this.last.files||gb<this.last.gb-1e-9){this.last={at:now,files,gb};this.window={start:now,files:0,gb:0};return;}
  let gap=now-this.last.at;
  const window=this.window!;
  // A long gap with no calls is a suspended computer, not a slow transfer: the window starts again after it.
  if(gap/1000>SLEEP){window.start+=gap;gap=0;}
  window.files+=files-this.last.files;window.gb+=gb-this.last.gb;
  this.last={at:now,files,gb};
  // Before the step's counter has first moved (a journal read, a long start) the clock does not run: the rate is measured from first movement.
  if(this.closed===0&&window.files===0&&window.gb===0)window.start=now;
  const age=(now-window.start)/1000;
  if(age>=WINDOW&&(window.files>0||window.gb>0)){this.close(age,window.files,window.gb);this.window={start:now,files:0,gb:0};}
 }
 private close(y:number,f:number,g:number){
  const tau=Math.min(300,Math.max(30,0.05*this.R)),k=Math.exp(-y/tau),ks=Math.exp(-y/600);
  this.level={T:this.level.T*k+y,F:this.level.F*k+f,G:this.level.G*k+g};
  this.total={T:this.total.T+y,F:this.total.F+f,G:this.total.G+g};
  this.seen+=y;this.closed++;
  const z1=this.prior.a*f,z2=this.prior.b*g;
  this.szz=[this.szz[0]*ks+z1*z1,this.szz[1]*ks+z1*z2,this.szz[2]*ks+z2*z2];
  this.szy=[this.szy[0]*ks+z1*y,this.szy[1]*ks+z2*y];
 }
 /** Seconds per file and per GB: the prior, corrected by what was seen (ridge fit on multipliers, then a shift along the observed mix). */
 theta():Coef{
  const {a:a0,b:b0}=this.prior,K=REGULARIZATION;
  const [p,q,r]=[this.szz[0]+K,this.szz[1],this.szz[2]+K],[u,v]=[this.szy[0]+K,this.szy[1]+K],det=p*r-q*q;
  let m1=(r*u-q*v)/det,m2=(p*v-q*u)/det;
  if(!Number.isFinite(m1)||!Number.isFinite(m2)){m1=m2=1;}
  m1=Math.max(MINIMUM,m1);m2=Math.max(MINIMUM,m2);
  const c1=a0*this.level.F,c2=b0*this.level.G,cc=c1*c1+c2*c2;
  if(cc>0&&this.level.T>0){
   const s=this.seen/(this.seen+this.T0),d=s*(this.level.T-(c1*m1+c2*m2))/cc;
   m1+=d*c1;m2+=d*c2;
   if(m1<MINIMUM){m1=MINIMUM;if(c2>0)m2=Math.max(MINIMUM,m2+s*(this.level.T-(c1*m1+c2*m2))/c2);}
   if(m2<MINIMUM){m2=MINIMUM;if(c1>0)m1=Math.max(MINIMUM,m1+s*(this.level.T-(c1*m1+c2*m2))/c1);}
  }
  return {a:a0*m1,b:b0*m2};
 }
 /** Seconds still to go for rf files and rbytes bytes. Without a byte total, bytes follow the mix seen so far (once 20 files were seen). */
 remaining(rf:number,rbytes?:number):number{
  rf=finite(rf);
  const {a,b}=this.theta();
  const rg=rbytes===undefined?(this.total.F>=20?rf*this.total.G/this.total.F:0):finite(rbytes)/GB;
  this.split=[a*rf,b*rg];
  this.R=this.split[0]+this.split[1];
  return this.R;
 }
 /** Relative uncertainty of the last remaining(): each coefficient is trusted by how much of it was observed. */
 uncertainty(level:PriorLevel,runs=0):number{
  const base=levelUncertainty(level,runs),K=REGULARIZATION;
  const floor=this.seen>=60?0.15:this.closed>0?0.35:0;
  const one=(information:number,prior:number)=>Math.max(0.15,floor,this.closed>0?prior*Math.sqrt(K/(K+information)):prior);
  const [ra,rb]=this.split,sum=ra+rb,ua=one(this.szz[0],base),ub=one(this.szz[2],base);
  return sum>0?(ra*ua+rb*ub)/sum:one(Math.max(this.szz[0],this.szz[2]),base);
 }
 /** The step's coefficients with the level set to the whole step's time: what a later run starts from. */
 summary(){
  const {a,b}=this.theta(),modeled=a*this.total.F+b*this.total.G,scale=modeled>0&&this.total.T>0?this.total.T/modeled:1;
  return {a:a*scale,b:b*scale,T:this.total.T,F:this.total.F,G:this.total.G,observed:this.seen,windows:this.closed};
 }
}

export type JobKind='import'|'organization'|'duplicates'|'finalize'|'undo'|'originals';
export interface StepTotal {files:number;bytes:number;/** false: bytes are not known beforehand (they follow the observed mix). */bytesKnown?:boolean;}
export interface JobModelOptions {kind:JobKind;book:PriorBook;totals?:Record<string,StepTotal>;verify?:boolean;publish?:'link'|'copy';/** Totals come from a listing estimate. */estimated?:boolean;}
export interface JobSnapshot {step?:number;job?:number;low?:number;high?:number;uncertainty:number;/** Model-seconds of work done / in all, and their ratio. */cost:{done:number;total:number};fraction:number;stepFraction:number;/** For each step in order, the share of the whole job done once it and every step before it are counted (cumulative, 0 to 1). */shares?:{step:string;share:number}[];}
export interface StepSummary extends Coef {step:string;T:number;F:number;G:number;observed:number;windows:number;}

interface StepState {total?:StepTotal;done:{files:number;bytes:number};fit?:StepFit;choice?:PriorChoice;status:'ahead'|'active'|'done'|'skipped';coef?:Coef;/** The current step's coefficients when it began: the work done is counted with these, so it never goes backwards as the fit moves. */start?:Coef;}
const empty:JobSnapshot={uncertainty:1,cost:{done:0,total:0},fraction:0,stepFraction:0};

/** The steps of a job in order. 'verifying' stands for the import's last step, named by whether it verifies and how it publishes. */
export function stepOrder(options:Pick<JobModelOptions,'kind'|'verify'|'publish'>):string[]{
 switch(options.kind){
  case 'import':return ['checking','candidates','comparing','existing','removing','copying',`${options.verify===false?'publish':'verifying'}:${options.publish??'link'}`];
  case 'organization':return ['checking','reading','history','earlier','confirming','moving','stashing','tidying','verifying:checking','releasing'];
  case 'duplicates':return ['verifying:checking','history','earlier','confirming','moving','stashing','tidying'];
  case 'finalize':return ['verifying:checking','releasing'];
  case 'undo':return ['verifying:checking','restoring'];
  default:return ['originals:deleting'];
 }
}

/** A job: its steps in order, the current one fitted from its progress and the rest from the book. */
export class JobModel {
 private order:string[];
 private book:PriorBook;
 private readonly states=new Map<string,StepState>();
 private current?:string;
 private publish:'link'|'copy';
 private readonly ended:StepSummary[]=[];
 constructor(private readonly options:JobModelOptions){
  this.publish=options.publish??'link';this.book=options.book;
  this.order=stepOrder({...options,publish:this.publish});
  for(const [step,total] of Object.entries(options.totals??{}))this.setTotal(step,total);
 }
 /** The name this model uses for a step: the import's 'verifying' is the verify or publish step it resolves to. */
 resolve(step:string){return step==='verifying'&&this.options.kind==='import'?`${this.options.verify===false?'publish':'verifying'}:${this.publish}`:step;}
 private state(step:string):StepState{let found=this.states.get(step);if(!found){found={done:{files:0,bytes:0},status:'ahead'};this.states.set(step,found);}return found;}
 setTotal(step:string,total:StepTotal){
  const files=finite(total.files),bytes=finite(total.bytes);
  this.state(this.resolve(step)).total={files,bytes,...(total.bytesKnown===false?{bytesKnown:false}:{})};
 }
 /** Files published by copying instead of linking (exFAT and the like): the verify step costs more. */
 setPublish(mode:'link'|'copy'){
  if(mode===this.publish||this.options.kind!=='import')return;
  const before=this.resolve('verifying');this.publish=mode;const after=this.resolve('verifying');
  const old=this.states.get(before);
  if(old){this.states.delete(before);const existing=this.states.get(after);this.states.set(after,{...old,total:old.total??existing?.total,choice:old.status==='ahead'?undefined:old.choice});}
  if(this.current===before)this.current=after;
  this.order=this.order.map(step=>step===before?after:step);
 }
/** Whether this model has the step (otherwise the caller estimates it some other way). */
 covers(step:string){return this.order.includes(this.resolve(step));}
 /** End the current step (the job ended or stopped): its fit joins the steps to save. */
 finish(){
  if(this.current===undefined)return;
  const state=this.states.get(this.current);
  if(state&&state.status==='active')this.finish_(this.current,state);
 }
 /** Steps that ended since the last call, with their final fits (for saving as priors). */
 drain():StepSummary[]{return this.ended.splice(0);}
 private choice(step:string,state:StepState){return state.choice??(state.choice=this.book.lookup(step));}
 /** Use other starting coefficients for the steps not yet reached (the drives became known). */
 setBook(book:PriorBook){this.book=book;for(const state of this.states.values())if(state.status==='ahead')state.choice=undefined;}
 private finish_(step:string,state:StepState){
  if(state.status==='active'&&state.fit){
   state.coef=state.fit.theta();
   const summary=state.fit.summary();
   if(summary.windows>0)this.ended.push({step,...summary});
  }
  if(state.total)state.done={files:state.total.files,bytes:state.total.bytes};
  state.status='done';
 }
 /** Feed the current step's cumulative progress; total is the step's own total when it reports one. */
 update(now:number,step:string,done:{files:number;bytes:number},total?:{files:number;bytes:number;bytesKnown?:boolean}):JobSnapshot{
  const key=this.resolve(step),index=this.order.indexOf(key);
  if(index<0)return this.snapshot();
  if(this.current!==key){
   if(this.current!==undefined){const before=this.states.get(this.current);if(before&&before.status==='active')this.finish_(this.current,before);}
   for(const [position,other] of this.order.entries()){
    const state=this.state(other);
    if(position<index&&state.status==='ahead'){state.status='skipped';state.total={files:0,bytes:0};state.done={files:0,bytes:0};}
   }
   const state=this.state(key),choice=this.choice(key,state);
   state.status='active';state.fit=new StepFit(choice.coef,choice.T0);
   state.coef=undefined;state.start=choice.coef;this.current=key;
  }
  const state=this.state(key);
  if(total&&(finite(total.files)>0||finite(total.bytes)>0))state.total={files:finite(total.files),bytes:finite(total.bytes),...(total.bytesKnown===false?{bytesKnown:false}:{})};
  const files=finite(done.files),bytes=finite(done.bytes);
  state.done={files,bytes};
  if(state.total){state.total={...state.total,files:Math.max(state.total.files,files),bytes:state.total.bytesKnown===false?state.total.bytes:Math.max(state.total.bytes,bytes)};}
  state.fit!.observe(now,files,bytes);
  return this.snapshot();
 }
 /** The current estimate without new progress. */
 snapshot():JobSnapshot{
  const current=this.current?this.states.get(this.current):undefined;
  if(!current||!this.current)return empty;
  let seconds=0,uncertain=0,stepSeconds:number|undefined,done=0,all=0,stepDone=0,stepAll=0,missing=false;
  const cumulative:{step:string;done:number}[]=[];let previous:string|undefined;
  for(const step of this.order){
   const state=this.states.get(step);
   if(!state||state.status==='skipped')continue;
   if(previous!==undefined)cumulative.push({step:previous,done});
   previous=step;
   const total=state.total,known=!!total&&(total.files>0||total.bytes>0);
   const choice=this.choice(step,state),isCurrent=step===this.current;
   const coef=isCurrent&&state.fit?state.fit.theta():state.coef??choice.coef;
   // A step's share of the job is counted with the coefficients it began with (also once it has finished), so the work done never
   // goes backwards as the fit moves; the time left uses the live fit.
   const counted=state.start??coef;
   const costOf=(c:Coef)=>(files:number,bytes:number)=>c.a*files+c.b*(total?.bytesKnown===false?0:bytes)/GB;
   const cost=costOf(coef),counting=costOf(counted);
   if(state.status==='done'){const final=total?counting(total.files,total.bytes):counting(state.done.files,state.done.bytes);done+=final;all+=final;continue;}
   if(!known){if(isCurrent)missing=true;continue;}
   all+=counting(total!.files,total!.bytes);done+=counting(Math.min(state.done.files,total!.files),Math.min(state.done.bytes,total!.bytes));
   const rf=Math.max(0,total!.files-state.done.files),rb=total!.bytesKnown===false?undefined:Math.max(0,total!.bytes-state.done.bytes);
   let remaining:number,u:number;
   if(isCurrent&&state.fit){
    remaining=state.fit.remaining(rf,rb);u=state.fit.uncertainty(choice.level,choice.runs);
    stepAll=counting(total!.files,total!.bytes);stepDone=counting(Math.min(state.done.files,total!.files),Math.min(state.done.bytes,total!.bytes));
    if(state.fit.windows>0)stepSeconds=remaining>0?Math.max(1,remaining):0;
   }else{
    remaining=coef.a*rf+(rb===undefined?0:coef.b*rb/GB);u=stepUncertainty({observed:0,level:choice.level,runs:choice.runs});
   }
   seconds+=remaining;uncertain+=remaining*u;
  }
  if(previous!==undefined)cumulative.push({step:previous,done});
  const shares=cumulative.map(item=>({step:item.step,share:all>0?Math.min(1,item.done/all):0}));
  const total=this.options.estimated?0.3:0;
  if(missing)return {uncertainty:1,cost:{done,total:all},fraction:all>0?Math.min(1,done/all):0,stepFraction:0,shares};
  const u=(seconds>0?uncertain/seconds:0.15)+total;
  const job=seconds>0?Math.max(1,seconds,stepSeconds??0):0;
  return {...(stepSeconds===undefined?{}:{step:stepSeconds}),job,low:job/(1+u),high:job*(1+u),uncertainty:u,cost:{done,total:all},fraction:all>0?Math.min(1,done/all):0,stepFraction:stepAll>0?Math.min(1,stepDone/stepAll):0,shares};
 }
}

/** The time for jobs that share one destination drive. etas are each job's time left as measured (while sharing). When the drive is the
 * bottleneck, a job that finishes frees its share: processor sharing, t_k = sum (E_i - E_(i-1)) (n-i+1)/n. Otherwise the longest sets the time. */
export function sharedDriveTotal(etas:number[],bottleneck:boolean):number{
 const sorted=etas.filter(value=>Number.isFinite(value)&&value>0).sort((x,y)=>x-y),n=sorted.length;
 if(!n)return 0;
 if(!bottleneck)return sorted[n-1]!;
 let total=0,previous=0;
 sorted.forEach((value,i)=>{total+=(value-previous)*(n-i)/n;previous=value;});
 return total;
}

/** The fraction a job's bar shows: never lower than before, and below 100% until the job is finished. */
export class FractionHold {
 private shown=0;
 next(value:number|undefined,finished=false):number|undefined{
  if(finished){this.shown=1;return 1;}
  if(value===undefined||!Number.isFinite(value))return this.shown>0?this.shown:undefined;
  this.shown=Math.max(this.shown,Math.min(0.99,Math.max(0,value)));
  return this.shown;
 }
}
