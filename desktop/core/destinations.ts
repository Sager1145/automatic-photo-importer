import {executeMany,executeReorganization,type OrganizationStrategy} from './index';
import {destinationEntries,destinationParts,requiredTransferSpace} from './allocation';
import type {Progress,TransferPlan} from '../shared';
import {addAppleDoubleReport,emptyAppleDoubleReport} from './appledouble';

/** Execute independent destination copies; one unavailable disk must not cancel the
 * other. Copies to several destinations share one read of each source file. A destination's
 * video folder (video-root layout) runs as its own plan but is validated, reported and
 * settled as part of that destination. */
export async function executeDestinations(plans:TransferPlan[],options:{
 signal:AbortSignal;reorganize:boolean;strategy?:OrganizationStrategy;verify?:boolean;removeAppleDouble?:boolean;keepSourceFolders?:boolean;releaseDuplicates?:boolean;
 onVerified?:(source:string,sha256:string,identity:string)=>void;
 validate(index:number):Promise<void>;
 progress(index:number,value:Progress,pendingBytes:number):void;
 settled(index:number):void;
}) {
 // Slots: every plan to run, with the destination it belongs to.
 const slots=plans.flatMap((plan,index)=>destinationParts(plan).map(part=>({part,index})));
 const bytesOf=(plan:TransferPlan,all=false)=>destinationEntries(plan).reduce((sum,entry)=>sum+(entry.skip&&!all?0:entry.size),0);
 const pending=slots.map(({part})=>bytesOf({...part,videos:undefined}));
 const initialPending=[...pending];
 // Publication workspace is one related family per destination, as requiredTransferSpace reserved it.
 const workspace=plans.map(plan=>requiredTransferSpace(plan)-bytesOf(plan));
 const fullWorkspace=plans.map(plan=>{const all=(part:TransferPlan):TransferPlan=>({...part,entries:part.entries.map(entry=>({...entry,skip:false})),...(part.videos?{videos:all(part.videos)}:{})});return requiredTransferSpace(all(plan))-bytesOf(plan,true);});
 const total=slots.reduce((sum,{part})=>sum+part.entries.length,0),latest=slots.map(()=>({bytes:0,completed:0})),existing=slots.map(()=>0);
 const result={copied:0,skipped:0,moved:0,retained:0,retainedBytes:0,removed:0,errors:[] as string[],notes:[] as string[]} as {copied:number;skipped:number;moved:number;retained:number;retainedBytes:number;released?:number;releasedBytes?:number;removed:number;errors:string[];notes:string[];appleDouble?:import('./appledouble').AppleDoubleReport};
 if(options.removeAppleDouble)result.appleDouble=emptyAppleDoubleReport();
 const report=(slot:number,value:Progress)=>{
  // Checks before anything is written (an organization's journal and files, a copy's existing files) count records or files, not the plan's work.
  if(value.step==='existing')existing[slot]=value.completed;
  if(value.step==='earlier'||value.step==='confirming'||value.step==='existing'||value.step==='removing'||value.step==='stashing'||value.step==='tidying'||value.step==='releasing'||value.step==='checking'&&value.phase==='verifying'){const index=slots[slot].index;options.progress(index,value.step==='existing'?{...value,total,completed:existing.reduce((a,b)=>a+b,0)}:value,slots.reduce((rest,item,other)=>item.index===index?rest+Math.max(0,pending[other]-latest[other].bytes):rest,0)+workspace[index]);return;}
  const required=Math.max(pending[slot],value.totalBytes,value.bytes);pending[slot]=required;latest[slot]={bytes:value.bytes,completed:value.completed};
  const sum=(key:'bytes'|'completed')=>latest.reduce((value,item)=>value+item[key],0),index=slots[slot].index,own=slots.flatMap((item,other)=>item.index===index?[other]:[]);
  const grown=own.some(other=>pending[other]>initialPending[other]);
  options.progress(index,{...value,total,totalBytes:pending.reduce((a,b)=>a+b,0),bytes:sum('bytes'),completed:sum('completed')},own.reduce((rest,other)=>rest+Math.max(0,pending[other]-latest[other].bytes),0)+(grown?fullWorkspace[index]:workspace[index]));
 };
 const failed=(index:number,error:unknown)=>result.errors.push(`Destination ${index+1}: ${error instanceof Error?error.message:String(error)}`);
 if(options.reorganize){
  // Library organization always targets one destination.
  for(let index=0;index<plans.length;index++){
   options.signal.throwIfAborted();
   try{
    await options.validate(index);
    for(const [slot,{part}] of slots.entries())if(slots[slot].index===index){
     const moved=await executeReorganization(part,options.signal,value=>report(slot,value),{strategy:options.strategy,keepSourceFolders:options.keepSourceFolders,releaseDuplicates:options.releaseDuplicates,removeAppleDouble:options.removeAppleDouble});
     addAppleDoubleReport(result.appleDouble!,moved.appleDouble);
     result.copied+=moved.copied;result.skipped+=moved.skipped;result.moved+=Number(moved.moved);result.retained+=Number(moved.retained);result.retainedBytes+=moved.retainedBytes;if(moved.released){result.released=(result.released??0)+moved.released;result.releasedBytes=(result.releasedBytes??0)+(moved.releasedBytes??0);}result.notes.push(...moved.notes??[]);
     result.errors.push(...moved.errors.map(error=>`Destination ${index+1}: ${error}`));
    }
   }catch(error){if(options.signal.aborted)throw error;failed(index,error);}
   finally{options.settled(index);}
  }
  return result;
 }
 const ready:number[]=[],settled=new Set<number>();
 // A destination settles once each of its plans has.
 const settle=(index:number)=>{if(!settled.has(index)){settled.add(index);options.settled(index);}};
 const finished=new Set<number>();
 try{
  for(let index=0;index<plans.length;index++){
   options.signal.throwIfAborted();
   try{await options.validate(index);ready.push(...slots.flatMap((slot,position)=>slot.index===index?[position]:[]));}
   catch(error){if(options.signal.aborted)throw error;failed(index,error);settle(index);}
  }
  const results=await executeMany(ready.map(slot=>slots[slot].part),options.signal,(position,value)=>report(ready[position],value),{verify:options.verify,onVerified:options.onVerified,removeAppleDouble:options.removeAppleDouble},position=>{finished.add(ready[position]);const index=slots[ready[position]].index;if(slots.every((slot,other)=>slot.index!==index||finished.has(other)))settle(index);});
  results.forEach((value,position)=>{
   const index=slots[ready[position]].index;
   if(value instanceof Error){failed(index,value);return;}
   result.copied+=value.copied;result.skipped+=value.skipped;result.removed+=value.removed??0;addAppleDoubleReport(result.appleDouble!,value.appleDouble);
   result.errors.push(...value.errors.map(error=>`Destination ${index+1}: ${error}`));
  });
 }finally{for(const slot of ready)settle(slots[slot].index);}
 return result;
}
