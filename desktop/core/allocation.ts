import type {DestinationSpace,PlanEntry,Preferences,TransferPlan} from '../shared';
import {MessageError} from '../messages';

/** A destination's plans: its backup folder and, in the video-root layout, its video folder. */
export function destinationParts(plan:TransferPlan):TransferPlan[]{return plan.videos?[plan,plan.videos]:[plan];}
/** What an import found already in the backup under older folder rules: for the report, one line per file (source, where it is, where the rules wanted it). */
export function olderRulesPaths(plans:TransferPlan[]):{source:string;existing:string;routed:string}[]{
 const seen=new Set<string>();
 return plans.flatMap(plan=>destinationEntries(plan)).flatMap(entry=>{
  if(entry.routed===undefined||seen.has(entry.destination))return [];
  seen.add(entry.destination);return [{source:entry.source,existing:entry.destination,routed:entry.routed}];
 });
}
/** Every entry written to one destination disk. */
export function destinationEntries(plan:TransferPlan):PlanEntry[]{return destinationParts(plan).flatMap(part=>part.entries);}
/** Files an import placed where the rules wanted them: entries found elsewhere under older rules (`routed`) are not. */
export function placedEntries(plan:TransferPlan):PlanEntry[]{return destinationEntries(plan).filter(entry=>entry.routed===undefined);}

/** Staging holds all pending bytes; linkless publication temporarily needs one
 * additional related family before that family's staging can be released. No
 * hard-link capability is assumed merely from the host operating system.
 */
export function requiredTransferSpace(plan:TransferPlan):number{
 let bytes=0,largest=0;const families=new Map<string,number>();
 for(const entry of destinationEntries(plan)){const size=entry.skip?0:entry.size;bytes+=size;const family=(families.get(entry.family)??0)+size;families.set(entry.family,family);largest=Math.max(largest,family);}
 return bytes+largest;
}

/** Sizes in space errors; the renderer formats the same figures for display. */
const size=(bytes:number)=>bytes>=1e9?`${(bytes/1e9).toFixed(1)} GB`:bytes>=1e6?`${(bytes/1e6).toFixed(1)} MB`:bytes>=1e3?`${(bytes/1e3).toFixed(1)} KB`:`${bytes} B`;
/** What an import needs on one destination once duplicates are known: only files the plan writes count. */
export function destinationSpace(plan:TransferPlan,free:number,sameDrive=false):DestinationSpace{
 let existing=0,existingFiles=0,newFiles=0;
 for(const entry of destinationEntries(plan)){if(entry.skip){existing+=entry.size;existingFiles++;}else newFiles++;}
 return {needed:requiredTransferSpace(plan),free,existing,existingFiles,newFiles,...(sameDrive?{sameDrive:true}:{})};
}

/** Allocate against free space after other jobs' reservations. Sequential mode
 * filters plans only after the entire assignment, including workspace, fits.
 */
export function allocateDestinations(plans:TransferPlan[],available:number[],mode:Preferences['copyMode']):number[]{
 if(plans.length!==available.length||plans.length!==(mode==='single'?1:2))throw new MessageError('error.chooseDestinations');
 if(mode==='sequential'){
  const secondaryBytes=new Map<string,number>();
  for(const entry of destinationEntries(plans[1])){const source=entry.source;secondaryBytes.set(source,(secondaryBytes.get(source)??0)+(entry.skip?0:entry.size));}
  const groups=new Map<string,TransferPlan['entries']>();
  for(const entry of destinationEntries(plans[0])){const group=groups.get(entry.family)??[];group.push(entry);groups.set(entry.family,group);}
  const assignments=[new Set<string>(),new Set<string>()],assigned=[0,0],largest=[0,0];let destination=0;
  for(const group of groups.values()){
   const sources=new Set(group.map(entry=>entry.source));
   let bytes=group.reduce((sum,entry)=>sum+(entry.skip?0:entry.size),0);
   if(destination===0&&assigned[0]+bytes+Math.max(largest[0],bytes)>available[0])destination=1;
   if(destination===1)bytes=[...sources].reduce((sum,source)=>sum+(secondaryBytes.get(source)??0),0);
   if(assigned[destination]+bytes+Math.max(largest[destination],bytes)>available[destination])throw new MessageError('error.bothNeedSpace');
   assigned[destination]+=bytes;largest[destination]=Math.max(largest[destination],bytes);for(const source of sources)assignments[destination].add(source);
  }
  plans.forEach((plan,index)=>{for(const part of destinationParts(plan))part.entries=part.entries.filter(entry=>assignments[index].has(entry.source));});
 }
 return plans.map((plan,index)=>{
  const space=destinationSpace(plan,available[index]);
  if(space.needed>space.free)throw new MessageError('error.destinationNeedsSpace',{index:index+1,needed:size(space.needed),free:size(space.free),existing:size(space.existing)});
  return space.needed;
 });
}

/** Organizing on one drive moves files with rename(2), which needs no space. Only an entry
 * that falls back to a verified copy (an empty file, a cross-device move) is staged and then
 * published, one at a time: room for the largest file twice covers it. */
export function requiredOrganizationSpace(plan:TransferPlan):number{
 return 2*destinationEntries(plan).reduce((largest,entry)=>Math.max(largest,entry.size),0);
}

/** Free space per destination volume after the space other jobs have claimed on it. A source on a
 * destination's own drive claims nothing extra: its files already sit in the used space, and the
 * copy draws on the same free space every other job writing to that drive shares. */
export function freeAfterReservations(owner:string,infos:{free?:number;volumeId?:string;path:string}[],reservations:ReadonlyMap<string,readonly {volume:string;bytes:number}[]>):number[]{
 return infos.map(info=>{let free=info.free??0;for(const [id,held] of reservations)if(id!==owner)for(const item of held)if(item.volume===(info.volumeId??info.path))free-=item.bytes;return Math.max(0,free);});
}
