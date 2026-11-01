import {currentJob} from '../logger';

/** What one job's runs wrote that Clean up may later remove: the library roots it wrote receipts or journals in, the
 * organization journals it started or worked on, and the temporary folders it made. Kept in memory only, like the
 * jobs themselves; a receipt also carries its job id on disk (import-recovery), which is the proof cleanup checks. */
export interface RunTrace {roots:string[];journals:{root:string;id:string}[];temporary:string[];}
const traces=new Map<string,RunTrace>();
const traceOf=(job:string)=>{let trace=traces.get(job);if(!trace){trace={roots:[],journals:[],temporary:[]};traces.set(job,trace);}return trace;};
const add=<T>(list:T[],value:T,same:(a:T)=>boolean)=>{if(!list.some(same))list.push(value);};

export function traceRoot(job:string,root:string):void{add(traceOf(job).roots,root,item=>item===root);}
export function traceJournal(job:string,root:string,id:string):void{const trace=traceOf(job);add(trace.journals,{root,id},item=>item.root===root&&item.id===id);add(trace.roots,root,item=>item===root);}
export function traceTemporary(job:string,folder:string):void{add(traceOf(job).temporary,folder,item=>item===folder);}
/** The same, for the job whose work is running now; nothing outside a job. */
export function noteRoot(root:string):void{const job=currentJob();if(job)traceRoot(job,root);}
export function noteJournal(root:string,id:string):void{const job=currentJob();if(job)traceJournal(job,root,id);}
export function noteTemporary(folder:string):void{const job=currentJob();if(job)traceTemporary(job,folder);}
export function runTrace(job:string):RunTrace|undefined{const trace=traces.get(job);return trace&&{roots:[...trace.roots],journals:[...trace.journals],temporary:[...trace.temporary]};}
/** Jobs no longer listed leave nothing to clean up from here. */
export function forgetTraces(keep:(job:string)=>boolean):void{for(const job of [...traces.keys()])if(!keep(job))traces.delete(job);}
