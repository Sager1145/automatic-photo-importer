import {executeMany,executeReorganization,type OrganizationStrategy} from './index';
import {requiredTransferSpace} from './allocation';
import type {Progress,TransferPlan} from '../shared';

/** Execute independent destination copies; one unavailable disk must not cancel the
 * other. Copies to several destinations share one read of each source file. */
export async function executeDestinations(plans:TransferPlan[],options:{
 signal:AbortSignal;reorganize:boolean;strategy?:OrganizationStrategy;verify?:boolean;keepSourceFolders?:boolean;
 onVerified?:(source:string,sha256:string,identity:string)=>void;
 validate(index:number):Promise<void>;
 progress(index:number,value:Progress,pendingBytes:number):void;
 settled(index:number):void;
}) {
 const pending=plans.map(plan=>plan.entries.reduce((sum,entry)=>sum+(entry.skip?0:entry.size),0));
 const initialPending=[...pending],workspace=plans.map((plan,index)=>requiredTransferSpace(plan)-pending[index]);
 const fullWorkspace=plans.map(plan=>{const all={...plan,entries:plan.entries.map(entry=>({...entry,skip:false}))};return requiredTransferSpace(all)-all.entries.reduce((sum,entry)=>sum+entry.size,0);});
 const total=plans.reduce((sum,plan)=>sum+plan.entries.length,0),latest=plans.map(()=>({bytes:0,completed:0}));
 const result={copied:0,skipped:0,moved:0,retained:0,retainedBytes:0,removed:0,errors:[] as string[],notes:[] as string[]};
 const report=(index:number,value:Progress)=>{
  const required=Math.max(pending[index],value.totalBytes,value.bytes);pending[index]=required;latest[index]={bytes:value.bytes,completed:value.completed};
  const sum=(key:'bytes'|'completed')=>latest.reduce((value,item)=>value+item[key],0);
  options.progress(index,{...value,total,totalBytes:pending.reduce((a,b)=>a+b,0),bytes:sum('bytes'),completed:sum('completed')},Math.max(0,pending[index]-value.bytes)+(required>initialPending[index]?fullWorkspace[index]:workspace[index]));
 };
 const failed=(index:number,error:unknown)=>result.errors.push(`Destination ${index+1}: ${error instanceof Error?error.message:String(error)}`);
 if(options.reorganize){
  // Library organization always targets one destination.
  for(let index=0;index<plans.length;index++){
   options.signal.throwIfAborted();
   try{
    await options.validate(index);
    const moved=await executeReorganization(plans[index],options.signal,value=>report(index,value),{strategy:options.strategy,keepSourceFolders:options.keepSourceFolders});
    result.copied+=moved.copied;result.skipped+=moved.skipped;result.moved+=Number(moved.moved);result.retained+=Number(moved.retained);result.retainedBytes+=moved.retainedBytes;result.notes.push(...moved.notes??[]);
    result.errors.push(...moved.errors.map(error=>`Destination ${index+1}: ${error}`));
   }catch(error){if(options.signal.aborted)throw error;failed(index,error);}
   finally{options.settled(index);}
  }
  return result;
 }
 const ready:number[]=[];let settledUntil=0;
 try{
  for(let index=0;index<plans.length;index++){
   options.signal.throwIfAborted();
   try{await options.validate(index);ready.push(index);}
   catch(error){if(options.signal.aborted)throw error;failed(index,error);options.settled(index);}
  }
  const results=await executeMany(ready.map(index=>plans[index]),options.signal,(slot,value)=>report(ready[slot],value),{verify:options.verify,onVerified:options.onVerified},slot=>{settledUntil=slot+1;options.settled(ready[slot]);});
  results.forEach((value,slot)=>{
   const index=ready[slot];
   if(value instanceof Error){failed(index,value);return;}
   result.copied+=value.copied;result.skipped+=value.skipped;result.removed+=value.removed??0;
   result.errors.push(...value.errors.map(error=>`Destination ${index+1}: ${error}`));
  });
 }finally{for(const index of ready.slice(settledUntil))options.settled(index);}
 return result;
}
