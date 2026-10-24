// Test-only access to the main process state for the automated Electron QA. main.ts creates it only for a
// --codex-test launch of an unpackaged build, and never exposes it to the renderer.
import type {Action,AppState,Job} from '../shared';

/** Ids of synthetic jobs start with this; nothing else uses it. */
export const SYNTHETIC='qa:';

export interface QaHooks {
 /** Test-only action observer/guard: false consumes a renderer action before the backend runs it. */
 beforeAction?:(action:Action)=>boolean|void;
 /** The live main process state. Read only: change it through the methods below. */
 peek():AppState;
 /** Puts synthetic jobs in front of the real ones (newest first, like real jobs) and publishes. Never queued ones: the queue would run them. */
 addJobs(jobs:Job[]):void;
 /** Changes synthetic jobs or fields set with set(), then publishes. */
 mutate(change:(state:AppState)=>void):void;
 /** Sets a top-level field, remembering its first previous value for clear(). */
 set<K extends keyof AppState>(key:K,value:AppState[K]):void;
 /** Removes every synthetic job and restores the fields set with set(). */
 clear():void;
 /** While held, every import that starts waits in its discovering phase until the returned release runs or the job is stopped. */
 hold():()=>void;
 /** Ids of jobs waiting at the gate. */
 held():ReadonlySet<string>;
 /** When set, what the metadata sheet gets instead of reading the file (fixture metadata). clear() removes it. */
 inspect?:(file:string)=>unknown;
 /** Called by a starting import: resolves at once unless held. */
 gate(jobId:string,signal:AbortSignal):Promise<void>;
}

export function createQaHooks(state:AppState,emit:()=>void):QaHooks {
 const saved=new Map<keyof AppState,unknown>();
 const waiting=new Set<string>();
 let release:Promise<void>|undefined,open:(()=>void)|undefined;
 const hooks:QaHooks={
  beforeAction:undefined,
  peek:()=>state,
  addJobs(jobs){
   if(jobs.some(job=>!job.id.startsWith(SYNTHETIC)||job.phase==='queued'))throw new Error('Synthetic jobs need a qa: id and must not be queued.');
   state.jobs.unshift(...jobs);emit();
  },
  mutate(change){change(state);emit();},
  set(key,value){if(!saved.has(key))saved.set(key,state[key]);state[key]=value;emit();},
  clear(){
   state.jobs=state.jobs.filter(job=>!job.id.startsWith(SYNTHETIC));
   for(const [key,value] of saved){if(value===undefined)delete state[key];else (state as unknown as Record<string,unknown>)[key]=value;}
   saved.clear();hooks.inspect=undefined;hooks.beforeAction=undefined;emit();
  },
  hold(){
   if(!release)release=new Promise(resolve=>{open=resolve;});
   return()=>{open?.();release=undefined;open=undefined;};
  },
  held:()=>waiting,
  async gate(jobId,signal){
   const current=release;if(!current)return;
   waiting.add(jobId);
   try{await new Promise<void>((resolve,reject)=>{const abort=()=>reject(signal.reason);if(signal.aborted)return abort();signal.addEventListener('abort',abort,{once:true});void current.then(()=>{signal.removeEventListener('abort',abort);resolve();});});}
   finally{waiting.delete(jobId);}
  },
 };
 return hooks;
}
