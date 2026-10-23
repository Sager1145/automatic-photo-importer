import type {AppState} from './shared';
import {message as makeMessage,text,type Message} from './messages';

export type ErrorKind='app'|'source'|'destination'|'organization'|'metadata';
/** An error failed or stopped something. A warning is informational: nothing was left undone. */
export type Severity='error'|'warning';
/** Message keys that are only ever warnings. Every other key is an error. */
const warningKeys=new Set<string>(['error.userSkipped','error.folderCleanup','job.appleDouble','inventory.emptyFile','inventory.emptySkipped','inventory.emptyPrimaryFile','inventory.emptyPrimarySkipped']);
/** The severity a message has by itself: informational notes are warnings, anything that failed or stopped a job is an error.
 * A file skipped on purpose (by the user) is a warning; a file skipped because it failed is an error. Metadata problems (kind 'metadata') are warnings: the file is still handled. */
export function severityOf(value:Message,kind?:ErrorKind):Severity{
 if(warningKeys.has(value.key)||value.params?.severity==='warning')return 'warning';
 if(value.key==='error.fileSkipped'){const reason=value.params?.error;return reason&&typeof reason==='object'&&!Array.isArray(reason)&&reason.key==='error.userSkipped'?'warning':'error';}
 return kind==='metadata'?'warning':'error';
}
/** Codes for messages that carry none of their own, derived from the message key. Raw text keeps the code 'text'. */
const keyCodes:Record<string,string>={'error.fileSkipped':'file-skipped','error.userSkipped':'user-skipped','error.folderCleanup':'folder-cleanup','inventory.emptyFile':'zero-byte','inventory.emptySkipped':'zero-byte','inventory.emptyPrimaryFile':'zero-byte','inventory.emptyPrimarySkipped':'zero-byte','error.residueCleanup':'residue-cleanup'};
/** The stable code of a message: the one it carries, else one derived from its key. */
export function codeOf(value:Message):string{const own=value.params?.code;return typeof own==='string'&&own?own:keyCodes[value.key]??value.key;}
/** The path a message names, when it carries one. */
export function pathOf(value:Message):string|undefined{const own=value.params?.path;return typeof own==='string'&&own?own:undefined;}
/** Codes shown as one row per job however many entries there are. Other entries keep a row each. */
export const groupedCodes=new Set<string>(['staging-left','unreadable','zero-byte','copy-failed','file-skipped']);
/** One problem shown in All errors. id is stable while the problem lasts; source groups it, drive names the volume it came from. */
export interface LoggedError {/** Stable code of the kind of problem, see codeOf. */code:string;/** A grouped entry stands for this many problems; items are the first of them. */count?:number;items?:{path:string;detail?:string}[];id:string;source:string;drive:string;message:Message;kind:ErrorKind;severity:Severity;sourceId?:string;/** The job a job error belongs to. */jobId?:string;}
/** When each shown error first appeared (ISO), and the ids the user cleared while they last. */
export interface ErrorLogState {at:Record<string,string>;cleared:string[];}

/** "/Volumes/A006/photobackup" → "A006"; anything not on a mounted volume keeps its source name. */
export function driveName(location:string,fallback:string):string{return /^\/Volumes\/([^/]+)/.exec(location)?.[1]??fallback;}

// FNV-1a: short ids that main and renderer compute alike.
function hash(value:string):string{let result=0x811c9dc5;for(let index=0;index<value.length;index++){result^=value.charCodeAt(index);result=Math.imul(result,0x01000193);}return (result>>>0).toString(36)+value.length.toString(36);}

/** Every problem the state carries. A job's errors belong to that job, so the same failure in a later import is a new error. */
export function gatherErrors(state:AppState):LoggedError[]{
 const result:LoggedError[]=[],ids=new Set<string>();
 const add=(scope:string,source:string,location:string,message:Message|undefined,kind:ErrorKind,sourceId?:string,jobId?:string)=>{
  if(!message)return;const id=hash(`${scope}|${source}|${JSON.stringify(message)}`);if(ids.has(id))return;ids.add(id);
  result.push({id,code:codeOf(message),source,drive:location?driveName(location,source):'',message,kind,severity:severityOf(message,kind),...(sourceId?{sourceId}:{}),...(jobId?{jobId}:{})});
 };
 const raw=(value?:string)=>value?text(value):undefined;
 const issue=(item:{path:string;message:string}):Message=>({key:'text',params:{text:`${item.path}: ${item.message}`,code:'unreadable',path:item.path}});
 add('app','','',state.error,'app');
 for(const job of state.jobs){
  const kind:ErrorKind=job.organization?'organization':'source',id=job.organization?undefined:job.source.id,{name,path}=job.source;
  const skipped=(code:string)=>!!job.acknowledged&&(job.acknowledged.all||job.acknowledged.codes.includes(code));
  for(const error of job.errors)if(!skipped(codeOf(error)))add('job:'+job.id,name,path,error,kind,id,job.id);
  for(const item of job.inventory?.issues??[])add('issue:'+job.source.id,name,path,issue(item),'metadata',id);
  for(const group of job.groups??[]){
   if(skipped(group.code))continue;
   const groupId=hash(`group|${job.id}|${group.code}|${group.severity}`);if(ids.has(groupId))continue;ids.add(groupId);
   result.push({id:groupId,code:group.code,source:name,drive:driveName(path,name),message:makeMessage('issue.group',{code:group.code,count:group.count}),kind,severity:group.severity,count:group.count,items:group.items,...(id?{sourceId:id}:{}),jobId:job.id});
  }
  if(job.phase==='error'&&!job.errors.length&&!job.acknowledged&&!(job.groups??[]).some(group=>group.severity==='error'))add('job:'+job.id,name,path,job.detail,kind,id);
 }
 for(const [id,info] of Object.entries(state.sourceCameraInfo??{})){
  const source=state.sources.find(item=>item.id===id),name=source?.name??id,location=source?.path??'';
  if(info.issues?.length)for(const item of info.issues)add('issue:'+id,name,location,issue(item),'metadata',id);else add('camera:'+id,name,location,raw(info.error),'metadata',id);
 }
 for(const recovery of state.organizationRecovery??[])add('recovery:'+recovery.id,recovery.root,recovery.root,raw(recovery.error),'organization');
 for(const destination of state.destinationStatus??[])add('destination',destination.path,destination.path,raw(destination.detail),'destination');
 for(const source of state.sources)for(const item of state.sourceInventories?.[source.id]?.issues??[])add('issue:'+source.id,source.name,source.path,issue(item),'metadata',source.id);
 return result;
}

/** Entries saved before severities existed have none: they get the default for their message key. */
export function migrateLoggedError<T extends Omit<LoggedError,'severity'|'code'>&{severity?:Severity;code?:string}>(entry:T):T&{severity:Severity;code:string}{
 return {...entry,code:typeof entry.code==='string'&&entry.code?entry.code:codeOf(entry.message),severity:entry.severity==='error'||entry.severity==='warning'?entry.severity:severityOf(entry.message,entry.kind)};
}

/** Remembers when errors appeared and which ones the user cleared. Both are forgotten once an error is gone, so it shows again if it returns. */
export class ErrorLog{
 private at=new Map<string,string>();private cleared=new Set<string>();
 /** Picks up a saved state (timestamps and cleared ids keep working across versions; ids are severity-independent). */
 constructor(saved?:Partial<ErrorLogState>){
  for(const [id,when] of Object.entries(saved?.at??{}))if(typeof when==='string')this.at.set(id,when);
  for(const id of saved?.cleared??[])if(typeof id==='string')this.cleared.add(id);
 }
 update(errors:LoggedError[],now=new Date()):ErrorLogState{
  const live=new Set(errors.map(error=>error.id));
  for(const id of this.at.keys())if(!live.has(id))this.at.delete(id);
  for(const id of this.cleared)if(!live.has(id))this.cleared.delete(id);
  for(const id of live)if(!this.at.has(id))this.at.set(id,now.toISOString());
  return {at:Object.fromEntries([...this.at].filter(([id])=>!this.cleared.has(id))),cleared:[...this.cleared]};
 }
 /** Bumps whenever something is cleared, so a cache keyed on the state also notices clears. */
 revision=0;
 clear(ids:string[]){for(const id of ids)this.cleared.add(id);this.revision++;}
}

/** Clears the listed errors in one go (a whole group), never touching the other severity when one is given. */
export function clearErrorIds(log:ErrorLog,state:AppState,ids:string[],severity?:Severity){
 const wanted=new Set(ids),errors=gatherErrors(state).filter(error=>wanted.has(error.id)&&(!severity||error.severity===severity)),app=errors.find(error=>error.kind==='app');
 log.clear(errors.map(error=>error.id));
 if(app)state.error=undefined;
}
/** Clears one error, or all of one severity (all of both when none is given). Clearing warnings never clears errors, and the reverse.
 * Jobs keep their errors; only the shared app error is reset at its source. */
export function clearErrors(log:ErrorLog,state:AppState,id?:string,severity?:Severity){
 const errors=gatherErrors(state).filter(error=>!severity||error.severity===severity),app=errors.find(error=>error.kind==='app');
 log.clear(id?errors.filter(error=>error.id===id).map(error=>error.id):errors.map(error=>error.id));
 if(app&&(!id||id===app.id))state.error=undefined;
}

/** A cheap fingerprint of everything gatherErrors reads: counts and short strings, never the paths. Equal fingerprints mean equal errors. */
export function errorSignature(state:AppState):string{
 const parts:(string|number)[]=[state.error?JSON.stringify(state.error):''];
 for(const job of state.jobs){
  let grouped=0;for(const group of job.groups??[])grouped+=group.count;
  parts.push(job.id,job.errors.length,grouped,job.acknowledged?job.acknowledged.at:'',job.inventory?.issues?.length??0,job.phase==='error'&&!job.errors.length?JSON.stringify(job.detail??''):'');
 }
 for(const [id,info] of Object.entries(state.sourceCameraInfo??{}))parts.push(id,info.issues?.length??0,info.error??'');
 for(const recovery of state.organizationRecovery??[])parts.push(recovery.id,recovery.error??'');
 for(const destination of state.destinationStatus??[])parts.push(destination.path,destination.detail??'');
 for(const source of state.sources)parts.push(source.id,state.sourceInventories?.[source.id]?.issues?.length??0);
 return parts.join('\u0001');
}
/** Rebuilds the error log only when the errors (or a clear) changed since the last emit. */
export function createErrorLogCache(log:ErrorLog){
 let signature:string|undefined,value:ErrorLogState|undefined;
 return {builds:0,refresh(this:{builds:number},state:AppState,now=new Date()):ErrorLogState{
  const next=errorSignature(state)+'\u0002'+log.revision;
  if(value&&next===signature)return value;
  signature=next;this.builds++;value=log.update(gatherErrors(state),now);return value;
 }};
}
