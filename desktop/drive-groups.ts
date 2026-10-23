import type {DestinationStatus,Source} from './shared';

/** Where a chosen folder stands among the other sources: the drive it is on, whether other folders
 * share that drive (one of them shows the drive's capacity, the rest point to it), and whether a
 * connected destination is on the same volume. */
export interface DriveContext {name:string;/** Other sources on the same volume. */shared:number;/** The source on this volume with the first path; its card shows the capacity, wherever the cards are moved. */leader:Source;showsCapacity:boolean;onDestination:boolean;}

/** A source that is not a chosen folder (a card, a camera) has no drive context. */
export function driveContext(source:Source,sources:Source[],destinations?:Pick<DestinationStatus,'volumeId'|'available'>[]):DriveContext|undefined {
  const drive=source.drive;
  if(!drive) return undefined;
  const group=sources.filter(item=>item.drive?.volumeId===drive.volumeId);
  const leader=group.reduce<Source|undefined>((first,item)=>!first||item.path<first.path?item:first,undefined)??source;
  const onDestination=!!destinations?.some(item=>item.available&&item.volumeId===drive.volumeId);
  return {name:drive.name,shared:Math.max(0,group.length-1),leader,showsCapacity:leader.id===source.id,onDestination};
}
