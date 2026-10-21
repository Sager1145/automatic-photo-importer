import type {Preferences,TransferPlan} from '../shared';

/** Staging holds all pending bytes; linkless publication temporarily needs one
 * additional related family before that family's staging can be released. No
 * hard-link capability is assumed merely from the host operating system.
 */
export function requiredTransferSpace(plan:TransferPlan):number{
 let bytes=0,largest=0;const families=new Map<string,number>();
 for(const entry of plan.entries){const size=entry.skip?0:entry.size;bytes+=size;const family=(families.get(entry.family)??0)+size;families.set(entry.family,family);largest=Math.max(largest,family);}
 return bytes+largest;
}

/** Allocate against free space after other jobs' reservations. Sequential mode
 * filters plans only after the entire assignment, including workspace, fits.
 */
export function allocateDestinations(plans:TransferPlan[],available:number[],mode:Preferences['copyMode']):number[]{
 if(plans.length!==available.length||plans.length!==(mode==='single'?1:2))throw new Error('Choose the required backup destinations first.');
 if(mode==='sequential'){
  const secondaryBytes=new Map<string,number>();
  for(const entry of plans[1].entries){const source=entry.source;secondaryBytes.set(source,(secondaryBytes.get(source)??0)+(entry.skip?0:entry.size));}
  const groups=new Map<string,TransferPlan['entries']>();
  for(const entry of plans[0].entries){const group=groups.get(entry.family)??[];group.push(entry);groups.set(entry.family,group);}
  const assignments=[new Set<string>(),new Set<string>()],assigned=[0,0],largest=[0,0];let destination=0;
  for(const group of groups.values()){
   const sources=new Set(group.map(entry=>entry.source));
   let bytes=group.reduce((sum,entry)=>sum+(entry.skip?0:entry.size),0);
   if(destination===0&&assigned[0]+bytes+Math.max(largest[0],bytes)>available[0])destination=1;
   if(destination===1)bytes=[...sources].reduce((sum,source)=>sum+(secondaryBytes.get(source)??0),0);
   if(assigned[destination]+bytes+Math.max(largest[destination],bytes)>available[destination])throw new Error('Both destinations need more free space for the next related file group and publication workspace.');
   assigned[destination]+=bytes;largest[destination]=Math.max(largest[destination],bytes);for(const source of sources)assignments[destination].add(source);
  }
  plans.forEach((plan,index)=>{plan.entries=plan.entries.filter(entry=>assignments[index].has(entry.source));});
 }
 return plans.map((plan,index)=>{
  const bytes=requiredTransferSpace(plan);
  if(bytes>available[index])throw new Error(`Destination ${index+1} needs more free space, including publication workspace.`);
  return bytes;
 });
}

/** Organizing on one drive moves files with rename(2), which needs no space. Only an entry
 * that falls back to a verified copy (an empty file, a cross-device move) is staged and then
 * published, one at a time: room for the largest file twice covers it. */
export function requiredOrganizationSpace(plan:TransferPlan):number{
 return 2*plan.entries.reduce((largest,entry)=>Math.max(largest,entry.size),0);
}
