import type {AppState,Inventory,Job,JobIssueGroup,Review} from './shared';
import {versionOf} from './error-log';

type StateFields=Omit<AppState,'jobs'|'sourceInventories'|'review'|'errorLog'|'history'|'duplicates'>&{duplicates?:Omit<NonNullable<AppState['duplicates']>,'earlier'>};
type GroupUpdate=Omit<JobIssueGroup,'items'>&{itemsRef:string};
type JobUpdate=Omit<Job,'inventory'|'errors'|'problemFiles'|'groups'>&{inventoryRef?:string;errorsRef:string;problemFilesRef?:string;groups?:GroupUpdate[]};
/** Large details cross IPC only when their reference changes. Job errors and group paths grow in place, so their change count (versionOf) is part of the reference;
 * a group's count crosses as a number, so counting never resends its paths. */
export interface StateUpdate {
 revision:number;
 reset?:boolean;
 state:StateFields;
 jobs:JobUpdate[];
 sourceInventories:Record<string,string>;
 errorLogRef?:string;
 historyRef:string;
 duplicatesEarlierRef?:string;
 details:Record<string,unknown>;
 review?:Review|null;
}
export function createStateChannel(send:(update:StateUpdate)=>void){
 let revision=0,nextDetail=0;
 const ids=new WeakMap<object,{id:string;version:number}>();
 /** Inventory.listing is for main's reuse only; the stripped copy is built once per inventory. */
 const stripped=new WeakMap<Inventory,Inventory>();
 function outbound(value:object){
  if(!('listing' in value))return value;
  let copy=stripped.get(value as Inventory);if(!copy){const {listing:_listing,...rest}=value as Inventory;copy=rest;stripped.set(value as Inventory,copy);}
  return copy;
 }
 let retained=new Set<string>(),previousReview:Review|undefined;
 function update(state:AppState,reset=false):StateUpdate{
  const details:Record<string,unknown>={},current=new Set<string>();
  function reference(value:object,version=0):string{
   let known=ids.get(value);if(!known||known.version!==version){known={id:String(++nextDetail),version};ids.set(value,known);}
   current.add(known.id);if(reset||!retained.has(known.id))details[known.id]=outbound(value);return known.id;
  }
  const {jobs,sourceInventories,review,errorLog,history,duplicates,...rest}=state;
  const {earlier,...duplicateFields}=duplicates??{} as NonNullable<AppState['duplicates']>;
  const fields:StateFields={...rest,...(duplicates?{duplicates:duplicateFields as NonNullable<StateFields['duplicates']>}:{})};
  const jobUpdates=jobs.map(({inventory,errors,problemFiles,groups,...job})=>({...job,errorsRef:reference(errors,versionOf(errors)),
   ...(groups?{groups:groups.map(({items,...group})=>({...group,itemsRef:reference(items,versionOf(items))}))}:{}),...(inventory?{inventoryRef:reference(inventory)}:{}),...(problemFiles?{problemFilesRef:reference(problemFiles)}:{})}));
  const sourceRefs=Object.fromEntries(Object.entries(sourceInventories??{}).map(([id,inventory])=>[id,reference(inventory)]));
  const result:StateUpdate={revision:++revision,...(reset?{reset:true}:{}),state:fields,jobs:jobUpdates,sourceInventories:sourceRefs,
   ...(errorLog?{errorLogRef:reference(errorLog)}:{}),historyRef:reference(history),...(earlier?{duplicatesEarlierRef:reference(earlier)}:{}),details,
   ...(reset||review!==previousReview?{review:review??null}:{})};
  if(!reset){retained=current;previousReview=review;}return result;
 }
 return {publish(state:AppState){send(update(state));},snapshot(state:AppState){return update(state,true);}};
}

/** Renderer owns the only full-state cache after updates cross the context bridge. */
export function createStateReceiver(){
 let revision=0,current:AppState|undefined;
 let details=new Map<string,unknown>();
 let pending:StateUpdate[]=[];
 function apply(update:StateUpdate):AppState|undefined{
   if(update.revision<=revision)return current;
   if(!current&&!update.reset){pending.push(update);return undefined;}
   // Resolved against a candidate table: an update with a missing reference throws before anything received is replaced.
   const known=new Map(update.reset?[]:details);
   for(const [id,value] of Object.entries(update.details))known.set(id,value);
   const used=new Map<string,unknown>();
   function detail<T>(id:string):T{
    if(!known.has(id))throw new Error('State update references an unavailable detail.');
    used.set(id,known.get(id));return known.get(id) as T;
   }
   const jobs=update.jobs.map(({inventoryRef,errorsRef,problemFilesRef,groups,...job})=>({...job,errors:detail<Job['errors']>(errorsRef),
    ...(groups?{groups:groups.map(({itemsRef,...group})=>({...group,items:detail<JobIssueGroup['items']>(itemsRef)}))}:{}),...(inventoryRef?{inventory:detail<Inventory>(inventoryRef)}:{}),...(problemFilesRef?{problemFiles:detail<NonNullable<Job['problemFiles']>>(problemFilesRef)}:{})}));
   const sources=Object.fromEntries(Object.entries(update.sourceInventories).map(([source,id])=>[source,detail<Inventory>(id)]));
   const duplicates=update.state.duplicates?{...update.state.duplicates,...(update.duplicatesEarlierRef?{earlier:detail<string[]>(update.duplicatesEarlierRef)}:{})}:undefined;
   current={...update.state,...(duplicates?{duplicates}:{}),jobs,sourceInventories:sources,history:detail<AppState['history']>(update.historyRef),
    ...(update.errorLogRef?{errorLog:detail<NonNullable<AppState['errorLog']>>(update.errorLogRef)}:{}),
    review:Object.hasOwn(update,'review')?update.review??undefined:current?.review};
   details=used;revision=update.revision;
   const waiting=pending;pending=[];for(const next of waiting)apply(next);
   return current;
 }
 return {apply,snapshot(){return current;}};
}
