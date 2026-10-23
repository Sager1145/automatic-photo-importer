// Synthetic main process state for the QA injection hook: jobs in any phase, grouped errors in bulk and long file names.
import {MAX_GROUP_ITEMS,type Job,type JobIssueGroup,type Progress,type Source} from '../../shared';
import {SYNTHETIC} from '../hooks';

export const LONG_NAME='A very long file name from a camera card that keeps going on and on, '.repeat(4)+'DSC_0001.NEF';

export interface JobShape {phase:Job['phase'];completed?:number;total?:number;bytes?:number;totalBytes?:number;file?:string;step?:Progress['step'];progressPhase?:Progress['phase'];paused?:boolean;source?:Source;organization?:boolean}

/** A job of a synthetic (or given) source. Running ones carry progress; ids start with qa: so clear() removes them. */
export function syntheticJob(name:string,shape:JobShape):Job {
 const total=shape.total??400,completed=shape.completed??Math.round(total*.4),totalBytes=shape.totalBytes??total*24e6;
 const source:Source=shape.source??{id:`${SYNTHETIC}source:${name}`,name:`Synthetic card ${name}`,path:`/Volumes/QA synthetic/${name}`,transport:'folder'};
 const running=['discovering','verifying','copying'].includes(shape.phase)||shape.paused;
 const progressPhase=shape.progressPhase??(shape.phase==='verifying'?'verifying':shape.phase==='discovering'?'planning':'copying');
 return {id:`${SYNTHETIC}${name}`,source,phase:shape.phase,errors:[],backup:false,startedAt:new Date(Date.now()-90000).toISOString(),
  ...(shape.paused?{paused:true}:{}),...(shape.organization?{organization:true}:{}),
  ...(running?{progress:{phase:progressPhase,...(shape.step?{step:shape.step}:{}),completed,total,bytes:shape.bytes??completed*24e6,totalBytes,speed:progressPhase==='planning'?0:180e6,file:shape.file??`DCIM/100MSDCF/DSC_${String(completed).padStart(4,'0')}.ARW`,fileRate:12} satisfies Progress}:{})};
}

// The codes All errors merges into one row per job (error-log groupedCodes).
const codes:[string,JobIssueGroup['severity']][]=[['copy-failed','error'],['file-skipped','error'],['unreadable','warning'],['zero-byte','warning'],['staging-left','warning']];

/** Finished jobs whose grouped errors and warnings add up to `total`, each group carrying at most MAX_GROUP_ITEMS paths like the real state. */
export function groupedErrorJobs(total:number,jobs=25):Job[] {
 const out:Job[]=[];let left=total;
 for(let j=0;j<jobs&&left>0;j++){
  const share=Math.ceil(left/(jobs-j)),perGroup=Math.ceil(share/codes.length);
  const groups:JobIssueGroup[]=[];let rest=share;
  for(const [code,severity] of codes){if(rest<=0)break;const count=Math.min(perGroup,rest);rest-=count;groups.push({code,severity,count,items:Array.from({length:Math.min(count,MAX_GROUP_ITEMS)},(_,i)=>({path:`/Volumes/QA synthetic/errors-${j}/DCIM/${100+Math.floor(i/50)}MEDIA/IMG_${String(i).padStart(5,'0')}.CR3`,detail:'EIO: input/output error, read'}))});}
  left-=share-rest;
  out.push({...syntheticJob(`errors-${j}`,{phase:'error'}),groups,retryable:true,failedFiles:share-rest});
 }
 return out;
}

/** Many running jobs, each on its own synthetic source, with long file names. */
export function manyRunningJobs(count:number):Job[] {
 return Array.from({length:count},(_,i)=>syntheticJob(`busy-${i}`,{phase:i%3===0?'verifying':'copying',completed:i*7%400,file:`${LONG_NAME.slice(0,40+i%200)}-${i}.NEF`}));
}
