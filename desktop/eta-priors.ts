/** What earlier runs taught the time-left model, kept per pair of drives (and per class of drive) so the next run starts from them.
 * Saved in userData/eta-priors.json, never in preferences or reports. It holds no paths, names or raw ids: volume ids appear only as a
 * truncated keyed hash. Pure apart from PriorStore's file; callers pass the day and the clock. See docs/eta-estimates.md. */
import {createHmac} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Coef,PriorBook,PriorChoice} from './eta-model';
import {priorWeight} from './eta-model';

export interface DriveInfo {id?:string;transport?:string;fsType?:string;external?:boolean;}
export interface PriorContext {source?:DriveInfo;destinations:DriveInfo[];}
export interface PriorSummary {T:number;F:number;G:number;day:string;}
export interface PriorEntry extends Coef {runs:number;seconds:number;updated:string;summaries:PriorSummary[];}
export interface PriorFile {version:1;salt:string;entries:Record<string,PriorEntry>;}
/** One finished step: the fit rescaled to the whole step's time, the totals it covered and the share of its time the drive was shared. */
export interface StepResult extends Coef {T:number;F:number;G:number;observed:number;shared:number;}

const MAX_ENTRIES=200,MAX_SUMMARIES=8,MIN_SECONDS=30,MIN_FILES=20,MIN_GB=1,MAX_SHARED=0.2,SAVE_EVERY=30_000;
const clean=(text:string|undefined,fallback:string)=>(text??'').toLowerCase().replace(/[^a-z0-9_-]/g,'')||fallback;
/** "usb:exfat:ext": transport, file system, external or internal. */
export function driveClass(info:DriveInfo):string{return `${clean(info.transport,'unknown')}:${clean(info.fsType,'unknown')}:${info.external?'ext':'int'}`;}

const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
function valid(entry:unknown):entry is PriorEntry{
 const value=entry as PriorEntry;
 return !!value&&typeof value==='object'&&positive(value.a)&&positive(value.b)&&positive(value.runs)&&positive(value.seconds)&&typeof value.updated==='string'&&Array.isArray(value.summaries)
  &&value.summaries.every(item=>!!item&&positive(item.T)&&positive(item.F)&&positive(item.G)&&typeof item.day==='string');
}
const blend=(old:number,fresh:number,w:number)=>old>0&&fresh>0?Math.exp((1-w)*Math.log(old)+w*Math.log(fresh)):fresh;

/** Least squares of T = a F + b G over the summaries, each weighted 1/T, with a and b not below zero. */
function refit(summaries:PriorSummary[]):Coef|undefined{
 let ff=0,fg=0,gg=0,ft=0,gt=0;
 for(const {T,F,G} of summaries){if(!(T>0))continue;const w=1/T;ff+=w*F*F;fg+=w*F*G;gg+=w*G*G;ft+=w*F*T;gt+=w*G*T;}
 const det=ff*gg-fg*fg;
 if(!(det>1e-12*ff*gg)||!Number.isFinite(det))return undefined;
 let a=(gg*ft-fg*gt)/det,b=(ff*gt-fg*ft)/det;
 if(a<0){a=0;b=gg>0?Math.max(0,gt/gg):0;}
 else if(b<0){b=0;a=ff>0?Math.max(0,ft/ff):0;}
 return Number.isFinite(a)&&Number.isFinite(b)?{a,b}:undefined;
}

export class PriorTable {
 private readonly entries=new Map<string,PriorEntry>();
 private changed=false;
 constructor(readonly salt:string,entries:Record<string,PriorEntry>={}){for(const [key,entry] of Object.entries(entries))if(valid(entry))this.entries.set(key,entry);}
 get size(){return this.entries.size;}
 get dirty(){return this.changed;}
 markSaved(){this.changed=false;}
 private hash(id:string){return createHmac('sha256',this.salt).update(id).digest('hex').slice(0,16);}
 /** The keys a step is stored under: the exact drive pair (when every drive has an id and the source is not a folder) and the drive classes. */
 keys(step:string,context:PriorContext):{exact?:string;class:string}{
  const source=context.source??{},destinations=context.destinations;
  const classKey=`${step}|c:${driveClass(source)}>${destinations.map(driveClass).join(',')}`;
  const identified=source.transport!=='folder'&&!!source.id&&destinations.length>0&&destinations.every(item=>!!item.id);
  return {class:classKey,...(identified?{exact:`${step}|d:${this.hash(source.id!)}>${destinations.map(item=>this.hash(item.id!)).join(',')}`}:{})};
 }
 lookup(step:string,context:PriorContext,level:'exact'|'class'):PriorEntry|undefined{
  const keys=this.keys(step,context),key=level==='exact'?keys.exact:keys.class;
  return key?this.entries.get(key):undefined;
 }
 /** Fold a finished step in, when it ran long enough, covered enough work and was not mostly shared. */
 update(step:string,context:PriorContext,result:StepResult,day:string){
  if(!(result.observed>=MIN_SECONDS)||!(result.F>=MIN_FILES||result.G>=MIN_GB)||!(result.shared<=MAX_SHARED)||!positive(result.a)||!positive(result.b))return;
  const keys=this.keys(step,context);
  for(const key of [keys.exact,keys.class]){if(key)this.fold(key,result,day);}
  this.trim();
  this.changed=true;
 }
 private fold(key:string,result:StepResult,day:string){
  const old=this.entries.get(key),runs=old?.runs??0,w=Math.max(0.25,1/(runs+1));
  const summaries=[...(old?.summaries??[]),{T:result.T,F:result.F,G:result.G,day}].slice(-MAX_SUMMARIES);
  let a=old?blend(old.a,result.a,w):result.a,b=old?blend(old.b,result.b,w):result.b;
  const ratios=summaries.filter(item=>item.F>0).map(item=>item.G/item.F),low=Math.min(...ratios),high=Math.max(...ratios);
  if(ratios.length>=2&&high>0&&(low===0||high/low>=2)){
   const fit=refit(summaries);
   if(fit){a=fit.a;b=fit.b;}
  }
  this.entries.set(key,{a,b,runs:runs+1,seconds:(old?.seconds??0)+result.observed,updated:day,summaries});
 }
 private trim(){
  if(this.entries.size<=MAX_ENTRIES)return;
  const order=[...this.entries].sort((x,y)=>x[1].updated<y[1].updated?-1:x[1].updated>y[1].updated?1:x[0]<y[0]?-1:1);
  for(const [key] of order.slice(0,this.entries.size-MAX_ENTRIES))this.entries.delete(key);
 }
 toJSON():PriorFile{return {version:1,salt:this.salt,entries:Object.fromEntries(this.entries)};}
 static from(data:unknown,fallbackSalt:()=>string):PriorTable{
  const file=data as PriorFile;
  if(!file||typeof file!=='object'||file.version!==1||typeof file.salt!=='string'||!file.salt||!file.entries||typeof file.entries!=='object'||Array.isArray(file.entries))return new PriorTable(fallbackSalt());
  return new PriorTable(file.salt,file.entries);
 }
}

/** The saved table's file. Reads never throw (any problem gives empty defaults); writes are atomic and at most one per 30 s. */
export class PriorStore {
 table:PriorTable;
 private saved=-Infinity;
 constructor(private readonly file:string,private readonly newSalt:()=>string){this.table=new PriorTable(newSalt());}
 async load(){
  try{this.table=PriorTable.from(JSON.parse(await fs.readFile(this.file,'utf8')),this.newSalt);}
  catch{this.table=new PriorTable(this.newSalt());}
 }
 /** Write the table: to a private temporary file in the same folder, then renamed over the old one. */
 async save(){
  const temporary=`${this.file}.${process.pid}.tmp`;
  try{
   await fs.mkdir(path.dirname(this.file),{recursive:true});
   await fs.writeFile(temporary,JSON.stringify(this.table.toJSON()),{mode:0o600});
   await fs.rename(temporary,this.file);
   this.table.markSaved();
  }catch(error){await fs.rm(temporary,{force:true}).catch(()=>{});throw error;}
 }
 /** Save if something changed and the last save was 30 s ago or more. Returns whether it wrote; never throws. */
 async maybeSave(now:number):Promise<boolean>{
  if(!this.table.dirty||now-this.saved<SAVE_EVERY)return false;
  this.saved=now;
  try{await this.save();return true;}catch{return false;}
 }
}

/** Starting coefficients for a step, in order: this session's exact drive pair, the saved exact pair, the session's drive class, the saved class, the defaults. */
export function layeredBook(context:PriorContext,session:PriorTable,saved:PriorTable,fallback:PriorBook):PriorBook{
 return {lookup(step):PriorChoice{
  for(const level of ['exact','class'] as const)for(const table of [session,saved]){
   const entry=table.lookup(step,context,level);
   if(entry)return {coef:{a:entry.a,b:entry.b},T0:priorWeight(level,entry.runs),level,runs:entry.runs};
  }
  return fallback.lookup(step);
 }};
}
