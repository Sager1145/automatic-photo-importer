import fs from 'node:fs/promises';
import path from 'node:path';
import {codeOf,isAcknowledged,severityOf,type Severity} from './error-log';
import type {Acknowledged,Job} from './shared';

/** The problems a job still holds, by code: its error entries and its groups. Counting only; no path is read. */
export function jobProblems(job:Pick<Job,'errors'|'groups'>):{code:string;severity:Severity;count:number}[]{
 const found=new Map<string,{code:string;severity:Severity;count:number}>();
 const add=(code:string,severity:Severity,count:number)=>{const key=severity+'|'+code,item=found.get(key);if(item)item.count+=count;else found.set(key,{code,severity,count});};
 for(const error of job.errors)add(codeOf(error),severityOf(error),1);
 for(const group of job.groups??[])add(group.code,group.severity,group.count);
 return [...found.values()];
}
/** Marks problems as skipped. Nothing is changed or deleted: only the status. With no codes everything is skipped and the job ends as complete.
 * Throws a plain Error for a job that is still running or codes the job does not have. */
export function acknowledgeJob(job:Job,codes?:string[],now=new Date()):Acknowledged{
 if(!['complete','error','stopped'].includes(job.phase))throw new Error('The job is still running.');
 const all=jobProblems(job),problems=all.filter(item=>item.severity==='error');
 const known=new Set(all.map(item=>item.code));
 if(codes&&(!codes.length||codes.some(code=>!known.has(code))))throw new Error('Those issues are not part of this job.');
 const wanted=codes?new Set(codes):undefined,pick=problems.filter(item=>!wanted||wanted.has(item.code));
 const previous=job.acknowledged;
 const merged=new Map<string,{code:string;severity:Severity;count:number}>();
 for(const item of [...(previous?.groups??[]),...pick])merged.set(item.severity+'|'+item.code,item);
 const record:Acknowledged={at:now.toISOString(),all:!codes||!!previous?.all,codes:[...new Set([...(previous?.codes??[]),...(codes??[])])],groups:[...merged.values()],errorCount:[...merged.values()].reduce((sum,item)=>sum+item.count,0)};
 job.acknowledged=record;
 const remaining=problems.some(item=>!isAcknowledged(job,item.code));
 if(job.phase!=='complete'&&(!codes||!remaining)){job.phase='complete';delete job.retryable;delete job.skippablePath;}
 return record;
}
/** Rewrites summary.json in place: passed becomes true and the skipped issues are recorded. execution.json and every other report stay as they were. */
export async function acknowledgeSummary(directory:string,record:Acknowledged):Promise<void>{
 const file=path.join(directory,'summary.json');
 let summary:Record<string,unknown>={};
 try{summary=JSON.parse(await fs.readFile(file,'utf8'));}catch{/* A job that never wrote one gets a minimal summary. */}
 const temporary=file+'.'+process.pid+'.new';
 await fs.mkdir(directory,{recursive:true});
 await fs.writeFile(temporary,JSON.stringify({...summary,passed:true,acknowledged:record},null,2),{mode:0o600});
 await fs.rename(temporary,file);
}
