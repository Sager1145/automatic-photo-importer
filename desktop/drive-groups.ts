import type {DestinationStatus,Source} from './shared';

/** Where a chosen folder stands among the other sources: the drive it is on, whether other folders
 * share that drive (the first of them shows the drive's capacity, the rest point to it), and
 * whether the drive also holds a backup destination. */
export interface DriveContext {name:string;/** Other sources on the same volume. */shared:number;/** The earliest source on this volume; its card shows the capacity. */leader:Source;showsCapacity:boolean;onDestination:boolean;}

/** A source that is not a chosen folder (a card, a camera) has no drive context. */
export function driveContext(source:Source,sources:Source[],destinations?:Pick<DestinationStatus,'volumeId'|'available'>[]):DriveContext|undefined {
  const drive=source.drive;
  if(!drive) return undefined;
  const group=sources.filter(item=>item.drive?.volumeId===drive.volumeId);
  const leader=group[0]??source;
  // Live destination state wins over the flag stored when the folder was added.
  const known=destinations?.filter(item=>item.available&&item.volumeId);
  const onDestination=known?.length?known.some(item=>item.volumeId===drive.volumeId):drive.sameAsDestination;
  return {name:drive.name,shared:Math.max(0,group.length-1),leader,showsCapacity:leader.id===source.id,onDestination};
}
