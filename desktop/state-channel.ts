import type {AppState,Inventory,Job,Review} from './shared';

type StateFields=Omit<AppState,'jobs'|'sourceInventories'|'review'|'errorLog'|'history'>;
type JobUpdate=Omit<Job,'inventory'|'errors'|'problemFiles'>&{inventoryRef?:string;errorsRef:string;problemFilesRef?:string};
/** Large details cross IPC only when their reference changes. Job errors grow in place, so their length is part of the reference. */
export interface StateUpdate {
 revision:number;
 reset?:boolean;
 state:StateFields;
 jobs:JobUpdate[];
 sourceInventories:Record<string,string>;
 errorLogRef?:string;
 historyRef:string;
 details:Record<string,unknown>;
 review?:Review|null;
}
export function createStateChannel(send:(update:StateUpdate)=>void){
 let revision=0,nextDetail=0;
 const ids=new WeakMap<object,{id:string;version:number}>();
 let retained=new Set<string>(),previousReview:Review|undefined;
 function update(state:AppState,reset=false):StateUpdate{
  const details:Record<string,unknown>={},current=new Set<string>();
  function reference(value:object,version=0):string{
   let known=ids.get(value);if(!known||known.version!==version){known={id:String(++nextDetail),version};ids.set(value,known);}
   current.add(known.id);if(reset||!retained.has(known.id))details[known.id]=value;return known.id;
  }
  const {jobs,sourceInventories,review,errorLog,history,...fields}=state;
  const jobUpdates=jobs.map(({inventory,errors,problemFiles,...job})=>({...job,errorsRef:reference(errors,errors.length),...(inventory?{inventoryRef:reference(inventory)}:{}),...(problemFiles?{problemFilesRef:reference(problemFiles)}:{})}));
  const sourceRefs=Object.fromEntries(Object.entries(sourceInventories??{}).map(([id,inventory])=>[id,reference(inventory)]));
  const result:StateUpdate={revision:++revision,...(reset?{reset:true}:{}),state:fields,jobs:jobUpdates,sourceInventories:sourceRefs,
   ...(errorLog?{errorLogRef:reference(errorLog)}:{}),historyRef:reference(history),details,
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
   if(update.reset)details=new Map();
   for(const [id,value] of Object.entries(update.details))details.set(id,value);
   const used=new Set<string>();
   function detail<T>(id:string):T{
    if(!details.has(id))throw new Error('State update references an unavailable detail.');
    used.add(id);return details.get(id) as T;
   }
   const jobs=update.jobs.map(({inventoryRef,errorsRef,problemFilesRef,...job})=>({...job,errors:detail<Job['errors']>(errorsRef),...(inventoryRef?{inventory:detail<Inventory>(inventoryRef)}:{}),...(problemFilesRef?{problemFiles:detail<NonNullable<Job['problemFiles']>>(problemFilesRef)}:{})}));
   const sources=Object.fromEntries(Object.entries(update.sourceInventories).map(([source,id])=>[source,detail<Inventory>(id)]));
   current={...update.state,jobs,sourceInventories:sources,history:detail<AppState['history']>(update.historyRef),
    ...(update.errorLogRef?{errorLog:detail<NonNullable<AppState['errorLog']>>(update.errorLogRef)}:{}),
    review:Object.hasOwn(update,'review')?update.review??undefined:current?.review};
   for(const id of details.keys())if(!used.has(id))details.delete(id);
   revision=update.revision;
   const waiting=pending;pending=[];for(const next of waiting)apply(next);
   return current;
 }
 return {apply,snapshot(){return current;}};
}
