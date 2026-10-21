import type {AppState,Inventory,Job,Review} from './shared';

type StateFields=Omit<AppState,'jobs'|'sourceInventories'|'review'>;
type JobUpdate=Omit<Job,'inventory'>&{inventoryRef?:string};
/** Large immutable details cross IPC only when their reference changes. */
export interface StateUpdate {
 revision:number;
 reset?:boolean;
 state:StateFields;
 jobs:JobUpdate[];
 sourceInventories:Record<string,string>;
 inventories:Record<string,Inventory>;
 review?:Review|null;
}
export function createStateChannel(send:(update:StateUpdate)=>void){
 let revision=0,nextInventory=0;
 const ids=new WeakMap<Inventory,string>();
 let retained=new Set<string>(),previousReview:Review|undefined;
 function update(state:AppState,reset=false):StateUpdate{
  const inventories:Record<string,Inventory>={},current=new Set<string>();
  function reference(inventory:Inventory):string{
   let id=ids.get(inventory);if(!id){id=String(++nextInventory);ids.set(inventory,id);}
   current.add(id);if(reset||!retained.has(id))inventories[id]=inventory;return id;
  }
  const {jobs,sourceInventories,review,...fields}=state;
  const jobUpdates=jobs.map(({inventory,...job})=>({...job,...(inventory?{inventoryRef:reference(inventory)}:{})}));
  const sourceRefs=Object.fromEntries(Object.entries(sourceInventories??{}).map(([id,inventory])=>[id,reference(inventory)]));
  const result:StateUpdate={revision:++revision,...(reset?{reset:true}:{}),state:fields,jobs:jobUpdates,sourceInventories:sourceRefs,inventories,
   ...(reset||review!==previousReview?{review:review??null}:{})};
  if(!reset){retained=current;previousReview=review;}return result;
 }
 return {publish(state:AppState){send(update(state));},snapshot(state:AppState){return update(state,true);}};
}

/** Renderer owns the only full-state cache after updates cross the context bridge. */
export function createStateReceiver(){
 let revision=0,current:AppState|undefined;
 let inventories=new Map<string,Inventory>();
 let pending:StateUpdate[]=[];
 function apply(update:StateUpdate):AppState|undefined{
   if(update.revision<=revision)return current;
   if(!current&&!update.reset){pending.push(update);return undefined;}
   if(update.reset)inventories=new Map();
   for(const [id,inventory] of Object.entries(update.inventories))inventories.set(id,inventory);
   const used=new Set<string>();
   function inventory(id:string):Inventory{
    const value=inventories.get(id);if(!value)throw new Error('State update references an unavailable inventory.');
    used.add(id);return value;
   }
   const jobs=update.jobs.map(({inventoryRef,...job})=>({...job,...(inventoryRef?{inventory:inventory(inventoryRef)}:{})}));
   const sources=Object.fromEntries(Object.entries(update.sourceInventories).map(([source,id])=>[source,inventory(id)]));
   current={...update.state,jobs,sourceInventories:sources,review:Object.hasOwn(update,'review')?update.review??undefined:current?.review};
   for(const id of inventories.keys())if(!used.has(id))inventories.delete(id);
   revision=update.revision;
   const waiting=pending;pending=[];for(const next of waiting)apply(next);
   return current;
 }
 return {apply,snapshot(){return current;}};
}
