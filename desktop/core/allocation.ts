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

/** Fill-first copy mode: the sources the first disk takes, family by family in plan order, while the
 * pending bytes plus the largest family still fit `available`; from the first family that does not,
 * every later family goes to the second disk. Paths on the second disk are planned afterwards, for
 * those families only, so no name there depends on a file that stayed on the first. */
export function fillFirst(first:TransferPlan,available:number):Set<string>{
 const families=new Map<string,PlanEntry[]>();
 for(const entry of destinationEntries(first)){const family=families.get(entry.family)??[];family.push(entry);families.set(entry.family,family);}
 const kept=new Set<string>();let assigned=0,largest=0;
 for(const family of families.values()){
  const bytes=family.reduce((sum,entry)=>sum+(entry.skip?0:entry.size),0);
  if(assigned+bytes+Math.max(largest,bytes)>available)break;
  assigned+=bytes;largest=Math.max(largest,bytes);for(const entry of family)kept.add(entry.source);
 }
 return kept;
}

/** The space each destination's plan needs, checked against its free space after other jobs'
 * reservations. Fill-first plans arrive already split by `fillFirst`. */
export function allocateDestinations(plans:TransferPlan[],available:number[],mode:Preferences['copyMode']):number[]{
 if(plans.length!==available.length||plans.length!==(mode==='single'?1:2))throw new MessageError('error.chooseDestinations');
 return plans.map((plan,index)=>{
  const space=destinationSpace(plan,available[index]);
  if(space.needed<=space.free)return space.needed;
  // The second disk of fill-first holds what the first could not.
  if(mode==='sequential'&&index===1)throw new MessageError('error.bothNeedSpace');
  throw new MessageError('error.destinationNeedsSpace',{index:index+1,needed:size(space.needed),free:size(space.free),existing:size(space.existing)});
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
