import type {DestinationSpace,PlanEntry,Preferences,TransferPlan} from '../shared';
import {MessageError} from '../messages';
import {volumeOf} from '../platform/volumes';

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
/** What an import needs on one destination once duplicates are known: only files the plan writes count. */
export function destinationSpace(plan:TransferPlan,free:number,sameDrive=false):DestinationSpace{
 let existing=0,existingFiles=0,newFiles=0;
 for(const entry of destinationEntries(plan)){if(entry.skip){existing+=entry.size;existingFiles++;}else newFiles++;}
 return {needed:requiredTransferSpace(plan),free,existing,existingFiles,newFiles,...(sameDrive?{sameDrive:true}:{})};
}

/** Fill-first copy mode: the sources the first disk takes, family by family in plan order, while the
 * pending bytes plus the largest family still fit `available`; from the first family that does not,
 * every later family goes to the second disk. Paths on the second disk are planned afterwards, for
 * those families only, so no name there depends on a file that stayed on the first. `bytes`: the space
 * the first disk then needs (`requiredTransferSpace` of what it keeps). With `videoAvailable` the first
 * destination's video folder is on a volume of its own: what goes there must fit that instead, and
 * `videoBytes` is what that volume then needs. */
export function fillFirst(first:TransferPlan,available:number,videoAvailable?:number):{kept:Set<string>;bytes:number;videoBytes:number}{
 const families=new Map<string,PlanEntry[]>(),videoEntries=new Set(videoAvailable===undefined?[]:first.videos?.entries??[]);
 for(const entry of destinationEntries(first)){const family=families.get(entry.family)??[];family.push(entry);families.set(entry.family,family);}
 const kept=new Set<string>(),sides=[{available,assigned:0,largest:0},{available:videoAvailable??0,assigned:0,largest:0}];
 for(const family of families.values()){
  const bytes=[0,0];for(const entry of family)bytes[videoEntries.has(entry)?1:0]+=entry.skip?0:entry.size;
  if(sides.some((side,index)=>(index===0||videoAvailable!==undefined)&&side.assigned+bytes[index]!+Math.max(side.largest,bytes[index]!)>side.available))break;
  sides.forEach((side,index)=>{side.assigned+=bytes[index]!;side.largest=Math.max(side.largest,bytes[index]!);});for(const entry of family)kept.add(entry.source);
 }
 return {kept,bytes:sides[0]!.assigned+sides[0]!.largest,videoBytes:sides[1]!.assigned+sides[1]!.largest};
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
  throw new MessageError('error.destinationNeedsSpace',{index:index+1,needed:{bytes:space.needed},free:{bytes:space.free},existing:{bytes:space.existing}});
 });
}

/** The space each video folder on a volume of its own (`apart`) needs, checked against that volume's free space after
 * other jobs' reservations; undefined where the video folder shares its photo folder's volume and was counted with it. */
export function allocateVideoFolders(plans:TransferPlan[],available:number[],apart:boolean[]):(number|undefined)[]{
 return plans.map((plan,index)=>{
  if(!apart[index])return undefined;
  const space=destinationSpace(plan.videos??{...plan,entries:[],videos:undefined},available[index]??0);
  if(space.needed<=space.free)return space.needed;
  throw new MessageError('error.videoFolderNeedsSpace',{index:index+1,needed:{bytes:space.needed},free:{bytes:space.free},existing:{bytes:space.existing}});
 });
}

/** Organizing on one drive moves files with rename(2), which needs no space. Only an entry
 * that falls back to a verified copy (an empty file, a cross-device move) is staged and then
 * published, one at a time: room for the largest file twice covers it. */
export function requiredOrganizationSpace(plan:TransferPlan):number{
 return 2*destinationEntries(plan).reduce((largest,entry)=>Math.max(largest,entry.size),0);
}

/** The key space is reserved under: the mounted volume of the snapshot that holds `target`, so every folder on one
 * physical volume, with a UUID or without, draws on the same free space. A path outside every listed mount is its own. */
export function reservationVolume(volumes:readonly {path:string}[],target:string):string{return volumeOf(volumes,target)?.path??target;}
/** Free space per destination volume after the space other jobs have claimed on it. A source on a
 * destination's own drive claims nothing extra: its files already sit in the used space, and the
 * copy draws on the same free space every other job writing to that drive shares. */
export function freeAfterReservations(owner:string,infos:{free?:number;path:string}[],volumes:readonly {path:string}[],reservations:ReadonlyMap<string,readonly {volume:string;bytes:number}[]>):number[]{
 return infos.map(info=>{const volume=reservationVolume(volumes,info.path);let free=info.free??0;for(const [id,held] of reservations)if(id!==owner)for(const item of held)if(item.volume===volume)free-=item.bytes;return Math.max(0,free);});
}
