import type {AppState,Job,JobIssueGroup} from './shared';
import {message as makeMessage,text,type Message} from './messages';

export type ErrorKind='app'|'source'|'destination'|'organization'|'metadata'|'format';
/** An error failed or stopped something. A warning is informational: nothing was left undone. */
export type Severity='error'|'warning';
/** Message keys that are only ever warnings. Every other key is an error. */
const warningKeys=new Set<string>(['error.userSkipped','job.appleDouble','inventory.emptyFile','inventory.emptySkipped','inventory.emptyPrimaryFile','inventory.emptyPrimarySkipped']);
/** The severity a message has by itself: informational notes are warnings, anything that failed or stopped a job is an error.
 * A file skipped on purpose (by the user) is a warning; a file skipped because it failed is an error. Metadata problems (kind 'metadata') are warnings: the file is still handled. */
export function severityOf(value:Message,kind?:ErrorKind):Severity{
 if(warningKeys.has(value.key)||value.params?.severity==='warning')return 'warning';
 if(value.key==='error.fileSkipped'){const reason=value.params?.error;return reason&&typeof reason==='object'&&!Array.isArray(reason)&&'key' in reason&&reason.key==='error.userSkipped'?'warning':'error';}
 return kind==='metadata'?'warning':'error';
}
/** Codes for messages that carry none of their own, derived from the message key. Raw text keeps the code 'text'. */
const keyCodes:Record<string,string>={'error.fileSkipped':'file-skipped','error.userSkipped':'user-skipped','inventory.emptyFile':'zero-byte','inventory.emptySkipped':'zero-byte','inventory.emptyPrimaryFile':'zero-byte','inventory.emptyPrimarySkipped':'zero-byte','error.residueCleanup':'residue-cleanup'};
/** The stable code of a message: the one it carries, else one derived from its key. */
export function codeOf(value:Message):string{const own=value.params?.code;return typeof own==='string'&&own?own:keyCodes[value.key]??value.key;}
/** The path a message names, when it carries one. */
export function pathOf(value:Message):string|undefined{const own=value.params?.path;return typeof own==='string'&&own?own:undefined;}
/** Codes shown as one row per job however many entries there are. Other entries keep a row each. */
export const groupedCodes=new Set<string>(['staging-left','unreadable','zero-byte','copy-failed','file-skipped']);
/** One problem shown in All errors. id is stable while the problem lasts; source groups it, drive names the volume it came from. */
export interface LoggedError {/** Stable code of the kind of problem, see codeOf. */code:string;/** A grouped entry stands for this many problems; items are the first of them. */count?:number;items?:{path:string;detail?:string}[];/** A group's problems per reason. */reasons?:Record<string,number>;id:string;source:string;drive:string;message:Message;kind:ErrorKind;severity:Severity;sourceId?:string;/** The job a job error belongs to. */jobId?:string;/** The source whose unknown file formats await a rule (kind 'format'). */formatSourceId?:string;/** Old records of an earlier version on this drive: the row offers Acknowledge, and Clear does not apply. */oldDrive?:string;}
/** Every shown error with when it first appeared (ISO); errors the user cleared are left out. */
export interface ErrorLogState {entries:(LoggedError&{at:string})[];}

/** "/Volumes/A006/photobackup" → "A006"; anything not on a mounted volume keeps its source name. */
export function driveName(location:string,fallback:string):string{return /^\/Volumes\/([^/]+)/.exec(location)?.[1]??fallback;}

// FNV-1a: short ids that main and renderer compute alike.
function hash(value:string):string{let result=0x811c9dc5;for(let index=0;index<value.length;index++){result^=value.charCodeAt(index);result=Math.imul(result,0x01000193);}return (result>>>0).toString(36)+value.length.toString(36);}

/** A job error's or issue group's id, kept with the entry: computed when it is recorded (see job-issues), so gathering only reads it.
 * The renderer gets its own copies over the wire and computes the same id once per copy. Messages and groups are never edited into another problem. */
const ids=new WeakMap<Message|JobIssueGroup,string>();
export function entryId(job:Pick<Job,'id'|'source'>,entry:Message|JobIssueGroup):string{
 let id=ids.get(entry);
 if(id===undefined){id='key' in entry?hash(`job:${job.id}|${job.source.name}|${JSON.stringify(entry)}`):hash(`group|${job.id}|${entry.code}|${entry.severity}`);ids.set(entry,id);}
 return id;
}
/** True when the user skipped this code for the job. */
export function isAcknowledged(job:Pick<Job,'acknowledged'>,code:string):boolean{return !!job.acknowledged&&(job.acknowledged.all||job.acknowledged.codes.includes(code));}

/** Change counts of the lists that grow in place: a job's errors, its groups (a new group or a count) and a group's paths.
 * Writers (job-issues) mark each change; a list replaced whole is a new object and starts at 0. */
const versions=new WeakMap<object,number>();
export function markChanged(list:object){versions.set(list,(versions.get(list)??0)+1);}
export function versionOf(list:object):number{return versions.get(list)??0;}

/** Every problem the state carries. A job's errors belong to that job, so the same failure in a later import is a new error. */
export function gatherErrors(state:AppState):LoggedError[]{
 const result:LoggedError[]=[],seen=new Set<string>();
 const added=(id:string,source:string,location:string,message:Message,kind:ErrorKind,sourceId?:string,jobId?:string)=>{
  if(seen.has(id))return;seen.add(id);
  result.push({id,code:codeOf(message),source,drive:location?driveName(location,source):'',message,kind,severity:severityOf(message,kind),...(sourceId?{sourceId}:{}),...(jobId?{jobId}:{})});
 };
 const add=(scope:string,source:string,location:string,message:Message|undefined,kind:ErrorKind,sourceId?:string)=>{if(message)added(hash(`${scope}|${source}|${JSON.stringify(message)}`),source,location,message,kind,sourceId);};
 const raw=(value?:string)=>value?text(value):undefined;
 const issue=(item:{path:string;message:string}):Message=>({key:'text',params:{text:`${item.path}: ${item.message}`,code:'unreadable',path:item.path}});
 add('app','','',state.error,'app');
 for(const job of state.jobs){
  const kind:ErrorKind=job.organization?'organization':'source',id=job.organization?undefined:job.source.id,{name,path}=job.source;
  for(const error of job.errors)if(!isAcknowledged(job,codeOf(error)))added(entryId(job,error),name,path,error,kind,id,job.id);
  for(const item of job.inventory?.issues??[])add('issue:'+job.source.id,name,path,issue(item),'metadata',id);
  for(const group of job.groups??[]){
   if(isAcknowledged(job,group.code))continue;
   const groupId=entryId(job,group);if(seen.has(groupId))continue;seen.add(groupId);
   result.push({id:groupId,code:group.code,source:name,drive:driveName(path,name),message:makeMessage('issue.group',{code:group.code,count:group.count}),kind,severity:group.severity,count:group.count,items:group.items,...(group.reasons?{reasons:group.reasons}:{}),...(id?{sourceId:id}:{}),jobId:job.id});
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
 // With "ask" as the default for unknown file formats, a source holding formats without a rule awaits a choice (backups never ask).
 if(state.preferences.unknownDefault==='ask'){
  const known={...state.preferences.unknownRules,...state.sessionUnknownRules},sources=new Map(state.sources.map(source=>[source.id,source]));
  for(const job of state.jobs)if(!job.organization&&!sources.has(job.source.id))sources.set(job.source.id,job.source);
  for(const source of sources.values()){
   const job=state.jobs.find(item=>!item.organization&&item.source.id===source.id),inventory=state.sourceInventories?.[source.id]??job?.inventory;
   if(!inventory||job?.backup||!Object.keys(inventory.unknownExtensions).some(extension=>!Object.hasOwn(known,extension)))continue;
   const id=hash('format|'+source.id);if(seen.has(id))continue;seen.add(id);
   result.push({id,code:'unknown-formats',source:source.name,drive:driveName(source.path,source.name),message:makeMessage('issue.unknownFormats'),kind:'format',severity:'warning',sourceId:source.id,formatSourceId:source.id});
  }
 }
 // Records of an earlier version that this Mac wrote: nothing was changed. The row's Acknowledge stops the notice.
 for(const drive of state.oldRecords??[]){
  const name=drive.split(/[\\/]+/).filter(Boolean).pop()??drive;
  result.push({id:'old-records:'+drive,code:'error.oldRecords',source:name,drive:driveName(drive,drive),message:makeMessage('error.oldRecords',{drive:name}),kind:'destination',severity:'warning',oldDrive:drive});
 }
 return result;
}

/** Remembers when errors appeared and which ones the user cleared. Both are forgotten once an error is gone, so it shows again if it returns. */
export class ErrorLog{
 private at=new Map<string,string>();private cleared=new Set<string>();
 update(errors:LoggedError[],now=new Date()):ErrorLogState{
  const live=new Set(errors.map(error=>error.id));
  for(const id of this.at.keys())if(!live.has(id))this.at.delete(id);
  for(const id of this.cleared)if(!live.has(id))this.cleared.delete(id);
  for(const id of live)if(!this.at.has(id))this.at.set(id,now.toISOString());
  return {entries:errors.filter(error=>!this.cleared.has(error.id)).map(error=>({...error,at:this.at.get(error.id)!}))};
 }
 /** Bumps whenever something is cleared, so a cache keyed on the state also notices clears. */
 revision=0;
 clear(ids:string[]){for(const id of ids)this.cleared.add(id);this.revision++;}
}

/** Clears the listed errors (one, or a whole group), or every error when no ids are given; with a severity, only those of it.
 * Clearing warnings never clears errors, and the reverse. Jobs keep their errors; only the shared app error is reset at its source. */
export function clearErrors(log:ErrorLog,state:AppState,{ids,severity}:{ids?:string[];severity?:Severity}={}){
 const wanted=ids&&new Set(ids),errors=gatherErrors(state).filter(error=>error.kind!=='format'&&!error.oldDrive&&(!wanted||wanted.has(error.id))&&(!severity||error.severity===severity));
 log.clear(errors.map(error=>error.id));
 if(errors.some(error=>error.kind==='app'))state.error=undefined;
}

/** What the log is built from: the change count of each list that grows in place, the identity of values only ever replaced whole,
 * and the fields read from lists main rebuilds with the same contents on every emit or poll (sources, destinations, recoveries). */
function errorInputs(state:AppState,log:ErrorLog):unknown[]{
 const inputs:unknown[]=[log.revision,state.error,state.preferences.unknownDefault,JSON.stringify([state.preferences.unknownRules,state.sessionUnknownRules])];
 for(const job of state.jobs){
  inputs.push(job,job.errors,versionOf(job.errors),job.groups,job.groups&&versionOf(job.groups),job.acknowledged,job.inventory,job.backup,job.phase==='error'&&job.detail);
 }
 for(const [id,info] of Object.entries(state.sourceCameraInfo??{}))inputs.push(id,info.issues,info.error);
 for(const source of state.sources)inputs.push(source.id,source.name,source.path,state.sourceInventories?.[source.id]);
 for(const recovery of state.organizationRecovery??[])inputs.push(recovery.id,recovery.root,recovery.error);
 for(const destination of state.destinationStatus??[])inputs.push(destination.path,destination.detail);
 inputs.push(JSON.stringify(state.oldRecords??[]));
 return inputs;
}
/** Rebuilds the error log only when the errors (or a clear) changed since the last emit. */
export function createErrorLogCache(log:ErrorLog){
 let inputs:unknown[]=[],value:ErrorLogState|undefined;
 return {builds:0,refresh(this:{builds:number},state:AppState,now=new Date()):ErrorLogState{
  const next=errorInputs(state,log);
  if(value&&next.length===inputs.length&&next.every((item,index)=>item===inputs[index]))return value;
  inputs=next;this.builds++;value=log.update(gatherErrors(state),now);return value;
 }};
}
