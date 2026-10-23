import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {AsyncLocalStorage} from 'node:async_hooks';

/** How much the diagnostic log records. off: nothing; normal: phases, settings, deletions, errors; detailed: every file's steps and decisions; trace: also each routing decision and journal entry. */
import type {LogLevel} from './shared';
export type {LogLevel};
export const logLevels:readonly LogLevel[]=['off','normal','detailed','trace'];
export const defaultLogLevel:LogLevel='normal';
const rank:Record<LogLevel,number>={off:0,normal:1,detailed:2,trace:3};

export const LOG_FILE_BYTES=50*1024*1024;
export const LOG_KEEP_FILES=10;
export const LOG_KEEP_BYTES=500*1024*1024;
export const EXCERPT_BYTES=20*1024*1024;
const FLUSH_MS=500;
/** Lines waiting for the next flush beyond this are dropped (and counted), so a stuck disk never grows memory. */
const MAX_PENDING_BYTES=32*1024*1024;

/** One open log file. Replaceable so tests can simulate a full or unwritable disk. */
export interface LogSink {write(data:string):Promise<unknown>;close():Promise<void>;}
export interface LoggerOptions {dir:string;level?:LogLevel;maxFileBytes?:number;maxFiles?:number;maxTotalBytes?:number;flushMs?:number;maxPendingBytes?:number;now?:()=>Date;open?:(file:string)=>Promise<LogSink>;}
export interface LogStats {dir:string;latest?:string;/** Bytes of every log file, as of the last write. */bytes:number;dropped:number;failures:number;}

type Fields=Record<string,unknown>;
type Lazy=Fields|(()=>Fields);

const secretKey=/^(hmac|hmackey|seal|seals|secret|password|token|keybytes|recoverykey|content|contents|filecontents|payload|buffer)$/i;
const secretCache=new Map<string,boolean>();
function secret(key:string):boolean{let known=secretCache.get(key);if(known===undefined){known=secretKey.test(key);if(secretCache.size<500)secretCache.set(key,known);}return known;}
function clean(value:unknown,key:string,depth:number):unknown{
 if(key&&secret(key))return '[redacted]';
 if(value===null||value===undefined)return value;
 switch(typeof value){
  case 'string':return value.length>2000?value.slice(0,2000)+'…':value;
  case 'number':return Number.isFinite(value)?value:String(value);
  case 'boolean':return value;
  case 'bigint':return value.toString();
  case 'function':case 'symbol':return undefined;
 }
 if(value instanceof Error){const code=(value as NodeJS.ErrnoException).code;return {name:value.name,message:value.message,...(code?{code}:{})};}
 if(value instanceof Uint8Array)return `[${value.byteLength} bytes]`;
 if(value instanceof Date)return value.toISOString();
 if(depth>=4)return '[…]';
 if(Array.isArray(value)){const items=value.slice(0,50).map(item=>clean(item,'',depth+1));if(value.length>50)items.push(`[+${value.length-50} more]`);return items;}
 const result:Fields={};let count=0;
 for(const [name,item] of Object.entries(value as Fields)){if(count++>=60){result['…']=`+${Object.keys(value as Fields).length-60} more`;break;}const next=clean(item,name,depth+1);if(next!==undefined)result[name]=next;}
 return result;
}

const stamp=(date:Date)=>{const p=(n:number,w=2)=>String(n).padStart(w,'0');return `${date.getFullYear()}${p(date.getMonth()+1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;};
const isLogFile=(name:string)=>/^importer-\d{8}-\d{6}(-\d+)?\.jsonl$/.test(name);
/** Oldest first: the start time, then the counter of files started in the same second. */
export const byAge=(a:string,b:string)=>{const key=(name:string)=>name.replace(/\.jsonl$/,'').replace(/^(importer-\d{8}-\d{6})$/,'$1-0000').replace(/-(\d+)$/,(_,n:string)=>'-'+n.padStart(4,'0'));return key(a)<key(b)?-1:key(a)>key(b)?1:0;};
const defaultOpen=async(file:string):Promise<LogSink>=>{const handle=await fsp.open(file,'a',0o600);return {write:data=>handle.write(data),close:()=>handle.close()};};

/** Structured JSON-lines logger. log() only queues a line in memory; a timer writes the queue every 500 ms.
 * Nothing in here throws into a caller: a failed write drops the lines and is counted. */
export class Logger {
 private level:LogLevel;
 private pending:string[]=[];private pendingBytes=0;private timer:NodeJS.Timeout|undefined;
 private chain:Promise<void>=Promise.resolve();
 private sink:LogSink|undefined;private file:string|undefined;private size=0;private total=0;private sequence=0;private ready=false;
 private dropped=0;private failures=0;private reportedDrops=0;private closed=false;
 private readonly options:Required<Pick<LoggerOptions,'dir'|'maxFileBytes'|'maxFiles'|'maxTotalBytes'|'flushMs'|'maxPendingBytes'>>&Pick<LoggerOptions,'now'|'open'>;
 constructor(options:LoggerOptions){
  this.level=options.level??defaultLogLevel;
  this.options={dir:options.dir,maxFileBytes:options.maxFileBytes??LOG_FILE_BYTES,maxFiles:options.maxFiles??LOG_KEEP_FILES,maxTotalBytes:options.maxTotalBytes??LOG_KEEP_BYTES,flushMs:options.flushMs??FLUSH_MS,maxPendingBytes:options.maxPendingBytes??MAX_PENDING_BYTES,now:options.now,open:options.open};
 }
 get directory(){return this.options.dir;}
 getLevel(){return this.level;}
 setLevel(level:LogLevel){this.level=logLevels.includes(level)?level:defaultLogLevel;}
 enabled(level:Exclude<LogLevel,'off'>){return rank[level]<=rank[this.level];}
 private lastMs=0;private lastIso='';
 private stamp():string{
  if(this.options.now)return this.options.now().toISOString();
  const ms=Date.now();if(ms!==this.lastMs){this.lastMs=ms;this.lastIso=new Date(ms).toISOString();}return this.lastIso;
 }
 /** Queue one line. `fields` may be a function so nothing is built for a level that is not recorded. */
 log(level:Exclude<LogLevel,'off'>,area:string,event:string,fields?:Lazy,jobId?:string){
  if(rank[level]>rank[this.level]||this.closed)return;
  try{
   const line:Fields={t:this.stamp(),level,area,event};
   const job=jobId??jobStore.getStore();if(job)line.jobId=job;
   const extra=typeof fields==='function'?fields():fields;
   if(extra)for(const name in extra){if(name in line)continue;const raw=extra[name],kind=typeof raw;const value=(kind==='number'||kind==='boolean')&&!secret(name)&&(kind==='boolean'||Number.isFinite(raw as number))?raw:(kind==='string'&&(raw as string).length<=2000&&!secret(name))?raw:clean(raw,name,0);if(value!==undefined)line[name]=value;}
   const text=JSON.stringify(line)+'\n',bytes=Buffer.byteLength(text);
   if(this.pendingBytes+bytes>this.options.maxPendingBytes){this.dropped++;return;}
   this.pending.push(text);this.pendingBytes+=bytes;
   if(!this.timer){this.timer=setTimeout(()=>{this.timer=undefined;void this.flush();},this.options.flushMs);this.timer.unref();}
  }catch{this.failures++;}
 }
 /** Write everything queued so far. Resolves even when the disk refuses. */
 flush():Promise<void>{
  if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
  this.chain=this.chain.then(()=>this.drain()).catch(()=>{this.failures++;});
  return this.chain;
 }
 private async drain(){
  if(!this.pending.length)return;
  const lines=this.pending,bytes=this.pendingBytes;this.pending=[];this.pendingBytes=0;
  if(this.dropped>this.reportedDrops){const count=this.dropped-this.reportedDrops;this.reportedDrops=this.dropped;const text=JSON.stringify({t:new Date().toISOString(),level:'normal',area:'logger',event:'dropped',count})+'\n';lines.unshift(text);}
  try{
   if(!this.ready){await fsp.mkdir(this.options.dir,{recursive:true,mode:0o700});await this.scan();this.ready=true;}
   if(!this.sink)await this.rotate();
   if(this.size+bytes<=this.options.maxFileBytes){await this.put(lines.join(''));return;}
   // The batch crosses the size limit: fill this file, then continue in new ones.
   let batch:string[]=[],batchBytes=0;
   for(const line of lines){
    const length=Buffer.byteLength(line);
    if(this.size+batchBytes+length>this.options.maxFileBytes&&(batch.length||this.size>0)){if(batch.length)await this.put(batch.join(''));batch=[];batchBytes=0;await this.rotate();}
    batch.push(line);batchBytes+=length;
   }
   if(batch.length)await this.put(batch.join(''));
  }catch{
   // Disk full, permission lost, folder removed: drop these lines, start fresh next time.
   this.failures++;await this.sink?.close().catch(()=>{});this.sink=undefined;this.file=undefined;this.ready=false;
  }
 }
 private async put(text:string){const length=Buffer.byteLength(text);await this.sink!.write(text);this.size+=length;this.total+=length;}
 /** Existing files count towards the size limits; the newest is not reopened (each run starts its own file). */
 private async scan(){
  let total=0;for(const name of await fsp.readdir(this.options.dir))if(isLogFile(name))total+=(await fsp.stat(path.join(this.options.dir,name)).catch(()=>undefined))?.size??0;
  this.total=total;
 }
 private async rotate(){
  await this.sink?.close().catch(()=>{});this.sink=undefined;
  const now=this.options.now?.()??new Date(),base=`importer-${stamp(now)}`;let name=`${base}.jsonl`;
  // Files started in the same second get a counter; names sort in creation order.
  while(await fsp.stat(path.join(this.options.dir,name)).then(()=>true,()=>false))name=`${base}-${String(++this.sequence).padStart(4,'0')}.jsonl`;
  const file=path.join(this.options.dir,name);
  this.sink=await (this.options.open??defaultOpen)(file);this.file=file;this.size=0;
  await this.prune();
 }
 /** Keep the newest files: at most maxFiles and maxTotalBytes in all (the file in use always stays). */
 private async prune(){
  const names=(await fsp.readdir(this.options.dir)).filter(isLogFile).sort(byAge),sizes=new Map<string,number>();
  for(const name of names)sizes.set(name,(await fsp.stat(path.join(this.options.dir,name)).catch(()=>undefined))?.size??0);
  let total=[...sizes.values()].reduce((sum,size)=>sum+size,0),count=names.length;
  const current=this.file?path.basename(this.file):'',removed:{name:string;bytes:number}[]=[];
  for(const name of names){
   if(name===current||(count<=this.options.maxFiles&&total<=this.options.maxTotalBytes))continue;
   try{await fsp.unlink(path.join(this.options.dir,name));}catch{continue;}
   count--;total-=sizes.get(name)!;removed.push({name,bytes:sizes.get(name)!});
  }
  this.total=total;
  for(const item of removed)this.log('normal','logger','file-deleted',{path:path.join(this.options.dir,item.name),bytes:item.bytes,reason:'log retention',proof:`newest ${this.options.maxFiles} files, ${Math.round(this.options.maxTotalBytes/1048576)} MB`});
 }
 stats():LogStats{return {dir:this.options.dir,...(this.file?{latest:this.file}:{}),bytes:this.total+Buffer.byteLength(this.pending.join('')),dropped:this.dropped,failures:this.failures};}
 /** The newest log file: the one in use, else the last on disk. */
 async latest():Promise<string|undefined>{
  await this.flush();if(this.file)return this.file;
  const names=(await fsp.readdir(this.options.dir).catch(()=>[] as string[])).filter(isLogFile).sort(byAge);
  return names.length?path.join(this.options.dir,names.at(-1)!):undefined;
 }
 /** Total size of the log files on disk, queued lines included. */
 async diskBytes():Promise<number>{await this.flush();let total=0;for(const name of await fsp.readdir(this.options.dir).catch(()=>[] as string[]))if(isLogFile(name))total+=(await fsp.stat(path.join(this.options.dir,name)).catch(()=>undefined))?.size??0;return total;}
 /** Write this job's lines (already filtered by the level they were logged at) to `destination`, at most `cap` bytes. */
 async excerpt(jobId:string,destination:string,options:{cap?:number;since?:number}={}):Promise<{lines:number;bytes:number;truncated:boolean}>{
  const cap=options.cap??EXCERPT_BYTES;await this.flush();
  const names=(await fsp.readdir(this.options.dir).catch(()=>[] as string[])).filter(isLogFile).sort(byAge);
  const out=await fsp.open(destination,'wx',0o600);let lines=0,bytes=0,truncated=false;const needle=`"jobId":"${jobId}"`;
  try{
   for(const name of names){
    const file=path.join(this.options.dir,name);
    if(options.since&&(await fsp.stat(file).catch(()=>undefined))?.mtimeMs!<options.since)continue;
    const reader=readline.createInterface({input:fs.createReadStream(file,{encoding:'utf8'}),crlfDelay:Infinity});
    try{
     for await(const line of reader){
      if(!line.includes(needle))continue;
      try{if(JSON.parse(line).jobId!==jobId)continue;}catch{continue;}
      const length=Buffer.byteLength(line)+1;
      if(bytes+length>cap){truncated=true;break;}
      await out.write(line+'\n');lines++;bytes+=length;
     }
    }finally{reader.close();}
    if(truncated)break;
   }
   if(truncated)await out.write(JSON.stringify({t:new Date().toISOString(),level:'normal',area:'logger',event:'excerpt-truncated',jobId,cap})+'\n');
   await out.sync();
  }finally{await out.close();}
  return {lines,bytes,truncated};
 }
 /** Synchronous last write for process exit, when the timer may never fire again. */
 flushSync(){
  if(!this.pending.length||!this.ready||!this.file)return;
  try{fs.appendFileSync(this.file,this.pending.join(''));this.pending=[];this.pendingBytes=0;}catch{this.failures++;}
 }
 async close(){await this.flush();this.closed=true;await this.sink?.close().catch(()=>{});this.sink=undefined;}
}

const jobStore=new AsyncLocalStorage<string>();
/** Everything logged while `work` runs (and in what it starts) carries this job id. */
export function withJob<T>(jobId:string,work:()=>T):T{return jobStore.run(jobId,work);}
export function currentJob():string|undefined{return jobStore.getStore();}

let active:Logger|undefined;
/** Start logging into `options.dir`; replaces any earlier logger. Until then every log call is a no-op. */
export function configureLogger(options:LoggerOptions):Logger{active=new Logger(options);return active;}
export function activeLogger():Logger|undefined{return active;}
export function resetLogger(){active=undefined;}
export function log(level:Exclude<LogLevel,'off'>,area:string,event:string,fields?:Lazy,jobId?:string):void{active?.log(level,area,event,fields,jobId);}
/** True when `level` lines are being recorded; guard expensive field building with it. */
export function logEnabled(level:Exclude<LogLevel,'off'>):boolean{return !!active&&active.enabled(level);}
export function setLogLevel(level:LogLevel){active?.setLevel(level);}
/** Log a file the app is deleting, with why and what proved it safe. Always at normal. */
export function logDeletion(area:string,file:string,reason:string,proof:string,fields:Fields={}):void{log('normal',area,'file-deleted',{path:file,reason,proof,...fields});}
