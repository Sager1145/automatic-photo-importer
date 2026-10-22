import type {AppState} from './shared';
import {text,type Message} from './messages';

export type ErrorKind='app'|'source'|'destination'|'organization'|'metadata';
/** One problem shown in All errors. id is stable while the problem lasts; source groups it, drive names the volume it came from. */
export interface LoggedError {id:string;source:string;drive:string;message:Message;kind:ErrorKind;sourceId?:string;}
/** When each shown error first appeared (ISO), and the ids the user cleared while they last. */
export interface ErrorLogState {at:Record<string,string>;cleared:string[];}

/** "/Volumes/A006/photobackup" → "A006"; anything not on a mounted volume keeps its source name. */
export function driveName(location:string,fallback:string):string{return /^\/Volumes\/([^/]+)/.exec(location)?.[1]??fallback;}

// FNV-1a: short ids that main and renderer compute alike.
function hash(value:string):string{let result=0x811c9dc5;for(let index=0;index<value.length;index++){result^=value.charCodeAt(index);result=Math.imul(result,0x01000193);}return (result>>>0).toString(36)+value.length.toString(36);}

/** Every problem the state carries. A job's errors belong to that job, so the same failure in a later import is a new error. */
export function gatherErrors(state:AppState):LoggedError[]{
 const result:LoggedError[]=[],ids=new Set<string>();
 const add=(scope:string,source:string,location:string,message:Message|undefined,kind:ErrorKind,sourceId?:string)=>{
  if(!message)return;const id=hash(`${scope}|${source}|${JSON.stringify(message)}`);if(ids.has(id))return;ids.add(id);
  result.push({id,source,drive:location?driveName(location,source):'',message,kind,...(sourceId?{sourceId}:{})});
 };
 const raw=(value?:string)=>value?text(value):undefined;
 const issue=(item:{path:string;message:string})=>text(`${item.path}: ${item.message}`);
 add('app','','',state.error,'app');
 for(const job of state.jobs){
  const kind:ErrorKind=job.organization?'organization':'source',id=job.organization?undefined:job.source.id,{name,path}=job.source;
  for(const error of job.errors)add('job:'+job.id,name,path,error,kind,id);
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

/** Remembers when errors appeared and which ones the user cleared. Both are forgotten once an error is gone, so it shows again if it returns. */
export class ErrorLog{
 private at=new Map<string,string>();private cleared=new Set<string>();
 update(errors:LoggedError[],now=new Date()):ErrorLogState{
  const live=new Set(errors.map(error=>error.id));
  for(const id of this.at.keys())if(!live.has(id))this.at.delete(id);
  for(const id of this.cleared)if(!live.has(id))this.cleared.delete(id);
  for(const id of live)if(!this.at.has(id))this.at.set(id,now.toISOString());
  return {at:Object.fromEntries([...this.at].filter(([id])=>!this.cleared.has(id))),cleared:[...this.cleared]};
 }
 clear(ids:string[]){for(const id of ids)this.cleared.add(id);}
}

/** Clears one error, or all of them. Jobs keep their errors; only the shared app error is reset at its source. */
export function clearErrors(log:ErrorLog,state:AppState,id?:string){
 const errors=gatherErrors(state),app=errors.find(error=>error.kind==='app');
 log.clear(id?[id]:errors.map(error=>error.id));
 if(app&&(!id||id===app.id))state.error=undefined;
}
