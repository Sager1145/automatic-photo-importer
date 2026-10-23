import {MAX_GROUP_ITEMS,type ExecutionIssue,type Job,type JobIssueGroup} from './shared';
import {codeOf,severityOf} from './error-log';
import type {AppleDoubleReport} from './core/appledouble';
import type {NoMetadataSummary} from './shared';

/** Per job: group lookup by `${severity}|${code}` and every path by code. Appending is O(1): no scan, sort or formatting beyond the capped samples. */
interface Index {groups:Map<string,JobIssueGroup>;full:Map<string,string[]>;}
const indexes=new WeakMap<Job,Index>();
const indexOf=(job:Job):Index=>{
 let index=indexes.get(job);
 if(!index){index={groups:new Map(),full:new Map()};for(const group of job.groups??[])index.groups.set(group.severity+'|'+group.code,group);indexes.set(job,index);}
 return index;
};
/** Folds one structured issue into the job's groups: a count and the first MAX_GROUP_ITEMS paths per (code, severity). */
export function recordIssue(job:Job,issue:ExecutionIssue){
 const index=indexOf(job),key=issue.severity+'|'+issue.code;
 let group=index.groups.get(key);
 if(!group){group={code:issue.code,severity:issue.severity,count:0,items:[]};index.groups.set(key,group);(job.groups??=[]).push(group);}
 group.count++;
 if(group.items.length<MAX_GROUP_ITEMS){
  const detail=issue.destination?issue.detail?`Destination ${issue.destination}: ${issue.detail}`:`Destination ${issue.destination}`:issue.detail;
  group.items.push(detail?{path:issue.path,detail}:{path:issue.path});
 }
 const list=index.full.get(issue.code);if(list)list.push(issue.path);else index.full.set(issue.code,[issue.path]);
}
export function recordIssues(job:Job,issues:Iterable<ExecutionIssue>){for(const issue of issues)recordIssue(job,issue);}
/** Every path recorded for a code, for Copy all paths. */
export function issuePaths(job:Job,code:string):string[]{return indexes.get(job)?.full.get(code)??[];}
/** Records issues as they happen. Each addition only asks for a (throttled) emit; the state is never rebuilt per error. */
export function createIssueSink(job:Job,schedule:()=>void){
 return {add(issue:ExecutionIssue){recordIssue(job,issue);schedule();}};
}
/** What actually failed: error entries and error groups. Warnings (leftovers, notes) never count, so they never fail a job. */
export function errorTotal(job:Pick<Job,'errors'|'groups'|'acknowledged'>):number{
 let total=0;
 const skipped=(code:string)=>!!job.acknowledged&&(job.acknowledged.all||job.acknowledged.codes.includes(code));
 for(const error of job.errors)if(severityOf(error)==='error'&&!skipped(codeOf(error)))total++;
 for(const group of job.groups??[])if(group.severity==='error'&&!skipped(group.code))total+=group.count;
 return total;
}

/** summary.json: passed reflects real failures only; leftovers and other warnings are counted next to it. */
export function reportSummary(errors:string[],warnings:ExecutionIssue[],failedCount:number){
 const warningCodes:Record<string,number>={};
 for(const issue of warnings)warningCodes[issue.code]=(warningCodes[issue.code]??0)+1;
 return {passed:errors.length===0&&failedCount===0,failedCount,warningCount:warnings.length,warningCodes};
}
/** Runs `emit` at most once per interval (leading edge). Error bursts ask for emits through this, never directly. */
export function throttled(emit:()=>void,interval:number|(()=>number)=100,now:()=>number=Date.now){
 let last=-Infinity;
 return ()=>{const time=now();if(time-last>(typeof interval==='function'?interval():interval)){last=time;emit();}};
}

/** Unknown files an import did not copy / an organization left (kept-no-metadata) or filed under the unknown folder (filed-no-metadata): warnings, never failures. */
export function noMetadataIssues(summary:NoMetadataSummary):ExecutionIssue[]{
 const code=summary.handling==='keep'?'kept-no-metadata':'filed-no-metadata',why={noDate:'No capture date',noCamera:'No camera',unreadable:'Metadata could not be read'};
 return summary.files.map((file):ExecutionIssue=>({code,severity:'warning',path:file.path,detail:why[file.reason]}));
}

/** The "._" files an import or organization kept, and those (or folders) it could not look at or remove, as warnings: they never fail a job. */
export function appleDoubleIssues(report:AppleDoubleReport|undefined):ExecutionIssue[]{
 if(!report)return [];
 return [
  ...report.keptFiles.map((path):ExecutionIssue=>({code:'appledouble-kept',severity:'warning',path,detail:'May hold tags or other data, so it was kept'})),
  ...report.failures.map((failure):ExecutionIssue=>({code:'appledouble-failed',severity:'warning',path:failure.path,detail:failure.folder?`Folder could not be read: ${failure.detail}`:failure.detail}))
 ];
}
