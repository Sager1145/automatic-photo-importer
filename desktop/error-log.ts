import type {AppState} from './shared';
import {text,type Message} from './messages';

export type ErrorKind='app'|'source'|'destination'|'organization'|'metadata';
/** An error failed or stopped something. A warning is informational: nothing was left undone. */
export type Severity='error'|'warning';
/** Message keys that are only ever warnings. Every other key is an error. */
const warningKeys=new Set<string>(['error.userSkipped','error.folderCleanup','inventory.emptyFile','inventory.emptySkipped','inventory.emptyPrimaryFile','inventory.emptyPrimarySkipped']);
/** The severity a message has by itself: informational notes are warnings, anything that failed or stopped a job is an error.
 * A file skipped on purpose (by the user) is a warning; a file skipped because it failed is an error. Metadata problems (kind 'metadata') are warnings: the file is still handled. */
export function severityOf(value:Message,kind?:ErrorKind):Severity{
 if(warningKeys.has(value.key))return 'warning';
 if(value.key==='error.fileSkipped'){const reason=value.params?.error;return reason&&typeof reason==='object'&&!Array.isArray(reason)&&reason.key==='error.userSkipped'?'warning':'error';}
 return kind==='metadata'?'warning':'error';
}
/** One problem shown in All errors. id is stable while the problem lasts; source groups it, drive names the volume it came from. */
export interface LoggedError {id:string;source:string;drive:string;message:Message;kind:ErrorKind;severity:Severity;sourceId?:string;/** The job a job error belongs to. */jobId?:string;}
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
  result.push({id,source,drive:location?driveName(location,source):'',message,kind,severity:severityOf(message,kind),...(sourceId?{sourceId}:{}),...(jobId?{jobId}:{})});
 };
 const raw=(value?:string)=>value?text(value):undefined;
 const issue=(item:{path:string;message:string})=>text(`${item.path}: ${item.message}`);
 add('app','','',state.error,'app');
 for(const job of state.jobs){
  const kind:ErrorKind=job.organization?'organization':'source',id=job.organization?undefined:job.source.id,{name,path}=job.source;
  for(const error of job.errors)add('job:'+job.id,name,path,error,kind,id,job.id);
  for(const item of job.inventory?.issues??[])add('issue:'+job.source.id,name,path,issue(item),'metadata',id);
  if(job.phase==='error'&&!job.errors.length)add('job:'+job.id,name,path,job.detail,kind,id);
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
export function migrateLoggedError<T extends Omit<LoggedError,'severity'>&{severity?:Severity}>(entry:T):T&{severity:Severity}{
 return {...entry,severity:entry.severity==='error'||entry.severity==='warning'?entry.severity:severityOf(entry.message,entry.kind)};
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
 clear(ids:string[]){for(const id of ids)this.cleared.add(id);}
}

/** Clears one error, or all of one severity (all of both when none is given). Clearing warnings never clears errors, and the reverse.
 * Jobs keep their errors; only the shared app error is reset at its source. */
export function clearErrors(log:ErrorLog,state:AppState,id?:string,severity?:Severity){
 const errors=gatherErrors(state).filter(error=>!severity||error.severity===severity),app=errors.find(error=>error.kind==='app');
 log.clear(id?errors.filter(error=>error.id===id).map(error=>error.id):errors.map(error=>error.id));
 if(app&&(!id||id===app.id))state.error=undefined;
}
